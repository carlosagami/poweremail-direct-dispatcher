'use strict';

const { loadServiceConfig } = require('./config');
const { createControlPlaneDb } = require('./db');
const logger = require('./logger');

const ORPHANED_BATCH_REQUEUED_CODE = 'ORPHANED_BATCH_REQUEUED';
const SMTP_RELAY_STARTED_CODE = 'SMTP_RELAY_STARTED';
const SMTP_RELAY_PROGRESS_CODE = 'SMTP_RELAY_PROGRESS';

function getOrphanedBatchTimeoutMs(config) {
  const configured = Number.parseInt(
    process.env.DIRECT_DISPATCHER_ORPHANED_BATCH_TIMEOUT_MS || '',
    10
  );

  if (Number.isFinite(configured) && configured > 0) {
    return Math.max(configured, 60 * 1000);
  }

  const staleTimeoutMs = Math.max(
    Number(config?.staleBatchTimeoutMs || 0),
    60 * 1000
  );

  return Math.max(Math.min(staleTimeoutMs, 2 * 60 * 1000), 60 * 1000);
}

async function recoverOrphanedRunningBatchesOnce() {
  const config = loadServiceConfig();
  const timeoutMs = getOrphanedBatchTimeoutMs(config);
  const cpDb = createControlPlaneDb(config);

  try {
    return await cpDb.tx(async (client) => {
      const { rows } = await client.query(
        `
        WITH orphaned_batches AS (
          SELECT
            b.delivery_batch_id,
            b.dispatch_campaign_id,
            b.batch_key,
            b.batch_size,
            r.sendy_campaign_id,
            r.tenant_key,
            count(q.recipient_queue_id) FILTER (WHERE q.recipient_state = 'sending')::int AS sending_recipients,
            count(q.recipient_queue_id) FILTER (WHERE q.recipient_state = 'batched')::int AS batched_recipients
          FROM control_plane.campaign_delivery_batches b
          JOIN control_plane.sendy_campaign_registry r
            ON r.dispatch_campaign_id = b.dispatch_campaign_id
          LEFT JOIN control_plane.campaign_recipient_queue q
            ON q.dispatch_campaign_id = b.dispatch_campaign_id
           AND q.batch_key = b.batch_key
          WHERE b.batch_state = 'running'
            AND b.updated_at < now() - ($1::bigint * interval '1 millisecond')
          GROUP BY
            b.delivery_batch_id,
            b.dispatch_campaign_id,
            b.batch_key,
            b.batch_size,
            r.sendy_campaign_id,
            r.tenant_key
          HAVING count(q.recipient_queue_id) FILTER (WHERE q.recipient_state = 'sending') = 0
             AND count(q.recipient_queue_id) FILTER (WHERE q.recipient_state = 'batched') > 0
          FOR UPDATE OF b SKIP LOCKED
        ),
        requeued_batches AS (
          UPDATE control_plane.campaign_delivery_batches b
             SET batch_state = 'queued',
                 started_at = NULL,
                 updated_at = now()
            FROM orphaned_batches ob
           WHERE b.delivery_batch_id = ob.delivery_batch_id
          RETURNING
            ob.delivery_batch_id,
            ob.dispatch_campaign_id,
            ob.batch_key,
            ob.batch_size,
            ob.sendy_campaign_id,
            ob.tenant_key,
            ob.sending_recipients,
            ob.batched_recipients
        )
        SELECT *
        FROM requeued_batches
        ORDER BY delivery_batch_id ASC
        `,
        [timeoutMs]
      );

      if (rows.length === 0) {
        return 0;
      }

      await client.query(
        `
        UPDATE control_plane.campaign_dispatch_queue
           SET queue_state = 'running',
               started_at = COALESCE(started_at, now()),
               updated_at = now()
         WHERE dispatch_campaign_id = ANY($1::bigint[])
           AND queue_state IN ('queued', 'reserved', 'launching', 'retry_wait', 'running')
        `,
        [rows.map((row) => row.dispatch_campaign_id)]
      );

      await client.query(
        `
        UPDATE control_plane.campaign_delivery_attempts
           SET result_status = 'warn',
               result_code = $2,
               result_message = $3,
               payload_json = COALESCE(payload_json, '{}'::jsonb) || jsonb_build_object(
                 'recovered_orphaned_batch', true,
                 'orphaned_timeout_ms', $1::bigint
               )
         WHERE delivery_batch_id = ANY($4::bigint[])
           AND result_status = 'warn'
           AND result_code IN ($5, $6)
        `,
        [
          timeoutMs,
          ORPHANED_BATCH_REQUEUED_CODE,
          'Batch automatically requeued after orphaned running batch timeout',
          rows.map((row) => row.delivery_batch_id),
          SMTP_RELAY_STARTED_CODE,
          SMTP_RELAY_PROGRESS_CODE,
        ]
      );

      for (const row of rows) {
        logger.warn('orphaned_batch_recovery.requeued', {
          sendy_campaign_id: row.sendy_campaign_id,
          tenant_key: row.tenant_key,
          dispatch_campaign_id: row.dispatch_campaign_id,
          batch_key: row.batch_key,
          delivery_batch_id: row.delivery_batch_id,
          batch_size: row.batch_size,
          batched_recipients: row.batched_recipients,
          sending_recipients: row.sending_recipients,
          orphaned_timeout_ms: timeoutMs,
        });
      }

      return rows.length;
    });
  } finally {
    await cpDb.close();
  }
}

module.exports = {
  recoverOrphanedRunningBatchesOnce,
  ORPHANED_BATCH_REQUEUED_CODE,
};
