'use strict';

const { spawn } = require('child_process');
const logger = require('./logger');

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

  const child = spawn(process.execPath, ['src/relay-executor.js'], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  activeChildren.add(child);

  let stdout = '';
  let stderr = '';

  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
  });

  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
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

function topUpWorkers() {
  if (!enabled || shutdownRequested) return;

  while (activeWorkers < workerConcurrency) {
    const spawned = runExecutorOnce();
    if (!spawned) break;
  }
}

if (enabled) {
  logger.info('worker_loop.started', { intervalMs, workerConcurrency, shutdownGraceMs });

  initialTopUpTimer = setTimeout(topUpWorkers, 5000);
  intervalHandle = setInterval(topUpWorkers, intervalMs);
} else {
  logger.info('worker_loop.disabled');
}
