'use strict';

const { spawn } = require('child_process');
const logger = require('./logger');

const enabled = String(process.env.DIRECT_DISPATCHER_WORKER_ENABLED || 'false').toLowerCase() === 'true';
const intervalMs = Number.parseInt(process.env.DIRECT_DISPATCHER_WORKER_INTERVAL_MS || '30000', 10);
const workerConcurrency = Math.max(
  Number.parseInt(process.env.DIRECT_DISPATCHER_WORKER_CONCURRENCY || '1', 10),
  1
);

let activeWorkers = 0;

function runExecutorOnce() {
  if (!enabled) return false;

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

  let stdout = '';
  let stderr = '';

  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
  });

  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  child.on('error', (error) => {
    activeWorkers = Math.max(activeWorkers - 1, 0);
    logger.error('worker_loop.spawn_failed', {
      error: {
        name: error.name,
        message: error.message,
        stack: error.stack,
      },
    });
  });

  child.on('close', (code) => {
    activeWorkers = Math.max(activeWorkers - 1, 0);

    const payload = {
      code,
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
  });

  return true;
}

function topUpWorkers() {
  if (!enabled) return;

  while (activeWorkers < workerConcurrency) {
    const spawned = runExecutorOnce();
    if (!spawned) break;
  }
}

if (enabled) {
  logger.info('worker_loop.started', { intervalMs, workerConcurrency });

  setTimeout(topUpWorkers, 5000);
  setInterval(topUpWorkers, intervalMs);
} else {
  logger.info('worker_loop.disabled');
}
