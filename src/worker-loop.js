'use strict';

const { spawn } = require('child_process');
const logger = require('./logger');
const {
  recoverOrphanedRunningBatchesOnce,
} = require('./orphaned-batch-recovery');
const {
  emitNoBatchDiagnosticOnce,
} = require('./worker-no-batch-diagnostics');

const enabled = String(process.env.DIRECT_DISPATCHER_WORKER_ENABLED || 'false').toLowerCase() === 'true';
const intervalMs = Number.parseInt(process.env.DIRECT_DISPATCHER_WORKER_INTERVAL_MS || '30000', 10);
const workerConcurrency = Math.max(
  Number.parseInt(process.env.DIRECT_DISPATCHER_WORKER_CONCURRENCY || '1', 10),
  1
);
const shutdownGraceMs = Math.max(
  Number.parseInt(process.env.DIRECT_DISPATCHER_SHUTDOWN_GRACE_MS || '15000', 10),
  1000
);

let activeWorkers = 0;
let shutdownRequested = false;
let shutdownSignal = null;
let shutdownTimer = null;
let initialTopUpTimer = null;
let intervalHandle = null;
let topUpInProgress = false;
const activeChildren = new Set();

function exitIfShutdownDrained() {
  if (!shutdownRequested || activeWorkers > 0) return;

  if (shutdownTimer) {
    clearTimeout(shutdownTimer);
    shutdownTimer = null;
  }

  logger.info('worker_loop.shutdown_complete', {
    signal: shutdownSignal,
    activeWorkers,
  });
  process.exit(0);
}

function requestShutdown(signal) {
  if (shutdownRequested) return;

  shutdownRequested = true;
  shutdownSignal = signal;

  if (initialTopUpTimer) clearTimeout(initialTopUpTimer);
  if (intervalHandle) clearInterval(intervalHandle);

  logger.warn('worker_loop.shutdown_requested', {
    signal,
    activeWorkers,
    workerConcurrency,
    shutdownGraceMs,
  });

  for (const child of activeChildren) {
    try {
      child.kill(signal);
    } catch (error) {
      logger.warn('worker_loop.child_signal_failed', {
        signal,
        pid: child.pid,
        error: {
          name: error.name,
          message: error.message,
        },
      });
    }
  }

  shutdownTimer = setTimeout(() => {
    logger.warn('worker_loop.shutdown_force_kill', {
      signal: shutdownSignal,
      activeWorkers,
    });

    for (const child of activeChildren) {
      try {
        child.kill('SIGKILL');
      } catch (error) {
        logger.warn('worker_loop.child_kill_failed', {
          pid: child.pid,
          error: {
            name: error.name,
            message: error.message,
          },
        });
      }
    }

    process.exit(0);
  }, shutdownGraceMs);

  exitIfShutdownDrained();
}

process.on('SIGTERM', () => requestShutdown('SIGTERM'));
process.on('SIGINT', () => requestShutdown('SIGINT'));

function forwardExecutorLine(stream, line, pid) {
  const trimmed = line.trim();
  if (!trimmed) return;

  try {
    const parsed = JSON.parse(trimmed);
    const { level, message, ts, ...rest } = parsed;
    const logLevel = typeof logger[level] === 'function' ? level : stream === 'stderr' ? 'warn' : 'info';

    if (message === 'relay_executor.no_batch') {
      void emitNoBatchDiagnosticOnce();
    }

    logger[logLevel](message || `worker_loop.executor_${stream}`, {
      ...rest,
      executor_ts: ts || null,
      executor_stream: stream,
      executor_pid: pid,
    });
    return;
  } catch (_) {
    // Fall back to plain-text forwarding when the child line is not JSON.
  }

  const fallbackLevel = stream === 'stderr' ? 'warn' : 'info';
  logger[fallbackLevel](`worker_loop.executor_${stream}`, {
    executor_stream: stream,
    executor_pid: pid,
    line: trimmed,
  });
}

function wireStreamForwarding(stream, streamName, pid, onChunk) {
  let buffer = '';

  stream.on('data', (chunk) => {
    const text = chunk.toString();
    onChunk(text);
    buffer += text;

    let newlineIndex = buffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      forwardExecutorLine(streamName, line, pid);
      newlineIndex = buffer.indexOf('\n');
    }
  });

  stream.on('end', () => {
    if (buffer.trim()) {
      forwardExecutorLine(streamName, buffer, pid);
    }
  });
}

function runExecutorOnce() {
  if (!enabled || shutdownRequested) return false;

  if (activeWorkers >= workerConcurrency) {
    logger.info('worker_loop.skip_at_capacity', {
      activeWorkers,
      workerConcurrency,
    });
    return false;
  }

  activeWorkers += 1;

  const child = spawn(
    process.execPath,
    ['-r', './src/relay-executor-live-instrumentation.js', 'src/relay-executor.js'],
    {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  activeChildren.add(child);

  let stdout = '';
  let stderr = '';

  wireStreamForwarding(child.stdout, 'stdout', child.pid, (text) => {
    stdout += text;
  });

  wireStreamForwarding(child.stderr, 'stderr', child.pid, (text) => {
    stderr += text;
  });

  child.on('error', (error) => {
    activeChildren.delete(child);
    activeWorkers = Math.max(activeWorkers - 1, 0);
    logger.error('worker_loop.spawn_failed', {
      error: {
        name: error.name,
        message: error.message,
        stack: error.stack,
      },
    });
    exitIfShutdownDrained();
  });

  child.on('close', (code, signal) => {
    activeChildren.delete(child);
    activeWorkers = Math.max(activeWorkers - 1, 0);

    const payload = {
      code,
      signal: signal || null,
      stdout: stdout.trim(),
      stderr: stderr.trim(),
      activeWorkers,
      workerConcurrency,
      executor_pid: child.pid,
    };

    if (code === 0) {
      logger.info('worker_loop.executor_completed', payload);
    } else {
      logger.error('worker_loop.executor_failed', payload);
    }

    exitIfShutdownDrained();
  });

  return true;
}

async function topUpWorkers() {
  if (!enabled || shutdownRequested || topUpInProgress) return;

  topUpInProgress = true;

  try {
    const recoveredBatches = await recoverOrphanedRunningBatchesOnce();

    if (recoveredBatches > 0) {
      logger.warn('worker_loop.orphaned_batches_recovered', {
        recovered_batches: recoveredBatches,
      });
    }

    while (activeWorkers < workerConcurrency) {
      const spawned = runExecutorOnce();
      if (!spawned) break;
    }
  } catch (error) {
    logger.error('worker_loop.orphaned_batch_recovery_failed', {
      error: {
        name: error.name,
        message: error.message,
        stack: error.stack,
      },
    });
  } finally {
    topUpInProgress = false;
  }
}

if (enabled) {
  logger.info('worker_loop.started', { intervalMs, workerConcurrency, shutdownGraceMs });

  initialTopUpTimer = setTimeout(() => {
    void topUpWorkers();
  }, 5000);
  intervalHandle = setInterval(() => {
    void topUpWorkers();
  }, intervalMs);
} else {
  logger.info('worker_loop.disabled');
}
