'use strict';

const { spawn } = require('child_process');
const logger = require('./logger');

const enabled = String(process.env.DIRECT_DISPATCHER_WORKER_ENABLED || 'false').toLowerCase() === 'true';
const intervalMs = Number.parseInt(process.env.DIRECT_DISPATCHER_WORKER_INTERVAL_MS || '30000', 10);

let running = false;

function runExecutorOnce() {
  if (!enabled) return;

  if (running) {
    logger.info('worker_loop.skip_already_running');
    return;
  }

  running = true;

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
    running = false;
    logger.error('worker_loop.spawn_failed', {
      error: {
        name: error.name,
        message: error.message,
        stack: error.stack,
      },
    });
  });

  child.on('close', (code) => {
    running = false;

    const payload = {
      code,
      stdout: stdout.trim(),
      stderr: stderr.trim(),
    };

    if (code === 0) {
      logger.info('worker_loop.executor_completed', payload);
    } else {
      logger.error('worker_loop.executor_failed', payload);
    }
  });
}

if (enabled) {
  logger.info('worker_loop.started', { intervalMs });

  setTimeout(runExecutorOnce, 5000);
  setInterval(runExecutorOnce, intervalMs);
} else {
  logger.info('worker_loop.disabled');
}
