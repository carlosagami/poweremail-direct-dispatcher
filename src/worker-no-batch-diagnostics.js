'use strict';

const { loadServiceConfig } = require('./config');
const { createControlPlaneDb } = require('./db');
const logger = require('./logger');
const { chunkError } = require('./utils');

const cooldownMs = Math.max(
  Number.parseInt(
    process.env.DIRECT_DISPATCHER_NO_BATCH_DIAGNOSTIC_COOLDOWN_MS || '60000',
    10
  ),
  5000
);

let lastStartedAt = 0;
let inFlight = false;

async function emitNoBatchDiagnosticOnce() {
  const now = Date.now();
  if (inFlight || now - lastStartedAt < cooldownMs) {
    return false;
  }

  inFlight = true;
  lastStartedAt = now;

  let cpDb = null;

  try {
    cpDb = createControlPlaneDb(loadServiceConfig());

    const [{ rows: batchSummaryRows }, { rows: activeBatchRows }, { rows: queueRows }] =
      await Promise.all([
        cpDb.query(
          `
          SELECT
            count(*) FILTER (WHERE batch_state = 'queued')::int AS queued_batches,
            count(*) FILTER (WHERE batch_state = 'running')::int AS running_batches,
            count(*) FILTER (WHERE batch_state = 'reserved')::int AS reserved_batches
          FROM control_plane.campaign_delivery_batches
          WHERE batch_state IN ('queued', 'running', 'reserved')
          `
        ),
        cpDb.query(
          `
          SELECT
            dispatch_campaign_id,
            batch_key,
            batch_state,
            batch_size,
            ROUND(EXTRACT(EPOCH FROM (now() - updated_at))::numeric, 1) AS idle_seconds,
            started_at,
            updated_at
          FROM control_plane.campaign_delivery_batches
          WHERE batch_state IN ('running', 'reserved')
          ORDER BY updated_at ASC
          LIMIT 5
          `
        ),
        cpDb.query(
          `
          SELECT
            dispatch_campaign_id,
            queue_state,
            requested_msgs_per_second,
            ROUND(EXTRACT(EPOCH FROM (now() - updated_at))::numeric, 1) AS idle_seconds,
            started_at,
            updated_at
          FROM control_plane.campaign_dispatch_queue
          WHERE queue_state IN ('queued', 'reserved', 'launching', 'retry_wait', 'running')
          ORDER BY updated_at ASC
          LIMIT 5
          `
        ),
      ]);

    const summary = batchSummaryRows[0] || {
      queued_batches: 0,
      running_batches: 0,
      reserved_batches: 0,
    };

    logger.warn('worker_loop.no_batch_diagnostic', {
      queued_batches: Number(summary.queued_batches || 0),
      running_batches: Number(summary.running_batches || 0),
      reserved_batches: Number(summary.reserved_batches || 0),
      oldest_active_batches: activeBatchRows,
      queue_snapshot: queueRows,
      diagnostic_cooldown_ms: cooldownMs,
    });

    return true;
  } catch (error) {
    logger.error('worker_loop.no_batch_diagnostic_failed', {
      diagnostic_cooldown_ms: cooldownMs,
      error: chunkError(error),
    });
    return false;
  } finally {
    inFlight = false;
    if (cpDb) {
      try {
        await cpDb.close();
      } catch (_) {
        // Best-effort close for diagnostics path.
      }
    }
  }
}

module.exports = { emitNoBatchDiagnosticOnce };
