const nodemailer = require("nodemailer");

const { loadConfig, loadServiceConfig } = require("./config");
const { createControlPlaneDb } = require("./db");
const logger = require("./logger");
const { chunkError } = require("./utils");
const { personalizeText } = require("./personalize");

const BATCH_EMPTY_ERROR_CODE = "BATCH_EMPTY";
const BATCH_EMPTY_ERROR_MESSAGE = "Batch has no batched recipients";
const NO_QUEUED_BATCH_ERROR_CODE = "NO_QUEUED_BATCH";
const SMTP_RELAY_STARTED_CODE = "SMTP_RELAY_STARTED";
const SMTP_RELAY_PROGRESS_CODE = "SMTP_RELAY_PROGRESS";
const SMTP_RELAY_PARTIAL_CODE = "SMTP_RELAY_PARTIAL";
const STALE_BATCH_REQUEUED_CODE = "STALE_BATCH_REQUEUED";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getSendDelayMs(config) {
  const rate = Number(config.maxMsgsPerSecond || 1);
  return Math.ceil(1000 / Math.max(rate, 0.1));
}

function isBatchEmptyError(err) {
  return err?.message === BATCH_EMPTY_ERROR_MESSAGE;
}

async function loadBatchByCampaign(cpDb, sendyCampaignId, tenantKey) {
  const { rows } = await cpDb.query(
    `
    SELECT
      q.dispatch_id,
      q.queue_state,
      q.requested_msgs_per_second,
      b.delivery_batch_id,
      b.dispatch_campaign_id,
      b.batch_key,
      b.batch_size,
      b.batch_state,
      c.tenant_id,
      c.content_snapshot_id,
      r.sendy_campaign_id,
      r.tenant_key
    FROM control_plane.campaign_delivery_batches b
    JOIN control_plane.sendy_campaign_registry r
      ON r.dispatch_campaign_id = b.dispatch_campaign_id
    JOIN control_plane.campaign_content_snapshots c
      ON c.content_snapshot_id = r.content_snapshot_id
    LEFT JOIN control_plane.campaign_dispatch_queue q
      ON q.dispatch_campaign_id = b.dispatch_campaign_id
    WHERE r.sendy_campaign_id = $1
      AND r.tenant_key = $2
      AND b.batch_state = 'queued'
    ORDER BY b.delivery_batch_id ASC
    LIMIT 1
    `,
    [sendyCampaignId, tenantKey]
  );
  return rows[0] || null;
}

async function reconcileDispatchWithoutQueuedBatch(client, queueRow) {
  const { rows } = await client.query(
    `
    SELECT
      count(*)::int AS total_batches,
      count(*) FILTER (WHERE batch_state = 'failed')::int AS failed_batches,
      count(*) FILTER (WHERE batch_state IN ('reserved', 'running'))::int AS active_batches,
      count(*) FILTER (WHERE batch_state = 'completed')::int AS completed_batches,
      (
        SELECT count(*)::int
        FROM control_plane.campaign_recipient_queue
        WHERE dispatch_campaign_id = $1
          AND recipient_state = 'batched'
      ) AS batched_recipients
    FROM control_plane.campaign_delivery_batches
    WHERE dispatch_campaign_id = $1
    `,
    [queueRow.dispatch_campaign_id]
  );

  const state = rows[0] || {
    total_batches: 0,
    failed_batches: 0,
    active_batches: 0,
    completed_batches: 0,
    batched_recipients: 0,
  };

  const totalBatches = Number(state.total_batches || 0);
  const failedBatches = Number(state.failed_batches || 0);
  const activeBatches = Number(state.active_batches || 0);
  const completedBatches = Number(state.completed_batches || 0);
  const batchedRecipients = Number(state.batched_recipients || 0);

  if (activeBatches > 0) {
    return {
      action: "defer",
      message: "Dispatch has active batches but none are currently queued",
      state: {
        total_batches: totalBatches,
        failed_batches: failedBatches,
        active_batches: activeBatches,
        completed_batches: completedBatches,
        batched_recipients: batchedRecipients,
      },
    };
  }

  if (totalBatches === 0 || failedBatches > 0 || batchedRecipients > 0) {
    const reason =
      totalBatches === 0
        ? "Dispatch queue row exists but campaign has no delivery batches"
        : failedBatches > 0
          ? "Dispatch queue row exists but campaign has failed batches and no queued batch"
          : "Dispatch queue row exists but campaign still has batched recipients and no queued batch";

    await client.query(
      `
      UPDATE control_plane.campaign_dispatch_queue
         SET queue_state = 'failed',
             finished_at = COALESCE(finished_at, now()),
             updated_at = now(),
             attempt_count = COALESCE(attempt_count, 0) + 1,
             last_error_code = $2,
             last_error_message = $3
       WHERE dispatch_id = $1
      `,
      [queueRow.dispatch_id, NO_QUEUED_BATCH_ERROR_CODE, reason]
    );

    await client.query(
      `
      UPDATE control_plane.sendy_campaign_registry
         SET direct_dispatch_state = 'failed',
             finished_at = COALESCE(finished_at, now()),
             updated_at = now()
       WHERE dispatch_campaign_id = $1
         AND direct_dispatch_state <> 'completed'
      `,
      [queueRow.dispatch_campaign_id]
    );

    return {
      action: "failed",
      message: reason,
      state: {
        total_batches: totalBatches,
        failed_batches: failedBatches,
        active_batches: activeBatches,
        completed_batches: completedBatches,
        batched_recipients: batchedRecipients,
      },
    };
  }

  await client.query(
    `
    UPDATE control_plane.campaign_dispatch_queue
       SET queue_state = 'completed',
           finished_at = COALESCE(finished_at, now()),
           updated_at = now()
     WHERE dispatch_id = $1
    `,
    [queueRow.dispatch_id]
  );

  await client.query(
    `
    UPDATE control_plane.sendy_campaign_registry
       SET direct_dispatch_state = 'completed',
           finished_at = COALESCE(finished_at, now()),
           updated_at = now()
     WHERE dispatch_campaign_id = $1
       AND direct_dispatch_state <> 'failed'
    `,
    [queueRow.dispatch_campaign_id]
  );

  return {
    action: "completed",
    message: "Dispatch has no queued batch because all batches are already complete",
    state: {
      total_batches: totalBatches,
      failed_batches: failedBatches,
      active_batches: activeBatches,
      completed_batches: completedBatches,
      batched_recipients: batchedRecipients,
    },
  };
}

async function recoverStaleRunningBatches(cpDb, staleBatchTimeoutMs) {
  const timeoutMs = Math.max(Number(staleBatchTimeoutMs || 0), 60 * 1000);

  return cpDb.tx(async (client) => {
    const { rows } = await client.query(
      `
      WITH stale_batches AS (
        SELECT
          b.delivery_batch_id,
          b.dispatch_campaign_id,
          b.batch_key,
          b.batch_size,
          r.sendy_campaign_id,
          r.tenant_key
        FROM control_plane.campaign_delivery_batches b
        LEFT JOIN control_plane.sendy_campaign_registry r
          ON r.dispatch_campaign_id = b.dispatch_campaign_id
        WHERE b.batch_state = 'running'
          AND b.updated_at < now() - ($1::bigint * interval '1 millisecond')
        FOR UPDATE SKIP LOCKED
      ),
      requeued_batches AS (
        UPDATE control_plane.campaign_delivery_batches b
           SET batch_state = 'queued',
               started_at = NULL,
               updated_at = now()
          FROM stale_batches sb
         WHERE b.delivery_batch_id = sb.delivery_batch_id
        RETURNING
          sb.delivery_batch_id,
          sb.dispatch_campaign_id,
          sb.batch_key,
          sb.batch_size,
          sb.sendy_campaign_id,
          sb.tenant_key
      ),
      reset_recipients AS (
        UPDATE control_plane.campaign_recipient_queue r
           SET recipient_state = 'batched',
               updated_at = now()
          FROM requeued_batches rb
         WHERE r.dispatch_campaign_id = rb.dispatch_campaign_id
           AND r.batch_key = rb.batch_key
           AND r.recipient_state = 'sending'
        RETURNING r.recipient_queue_id, r.dispatch_campaign_id, r.batch_key
      )
      SELECT
        rb.delivery_batch_id,
        rb.dispatch_campaign_id,
        rb.batch_key,
        rb.batch_size,
        rb.sendy_campaign_id,
        rb.tenant_key,
        count(rr.recipient_queue_id)::int AS reset_sending_recipients
      FROM requeued_batches rb
      LEFT JOIN reset_recipients rr
        ON rr.dispatch_campaign_id = rb.dispatch_campaign_id
       AND rr.batch_key = rb.batch_key
      GROUP BY
        rb.delivery_batch_id,
        rb.dispatch_campaign_id,
        rb.batch_key,
        rb.batch_size,
        rb.sendy_campaign_id,
        rb.tenant_key
      ORDER BY rb.delivery_batch_id ASC
      `,
      [timeoutMs]
    );

    if (rows.length === 0) {
      return [];
    }

    await client.query(
      `
      UPDATE control_plane.campaign_delivery_attempts
         SET result_status = 'warn',
             result_code = $2,
             result_message = $3,
             payload_json = COALESCE(payload_json, '{}'::jsonb) || jsonb_build_object(
               'recovered_stale_batch', true,
               'stale_timeout_ms', $1::bigint
             )
       WHERE delivery_batch_id = ANY($4::bigint[])
         AND result_status = 'warn'
         AND result_code IN ($5, $6)
      `,
      [
        timeoutMs,
        STALE_BATCH_REQUEUED_CODE,
        'Batch automatically requeued after stale heartbeat timeout',
        rows.map((row) => row.delivery_batch_id),
        SMTP_RELAY_STARTED_CODE,
        SMTP_RELAY_PROGRESS_CODE,
      ]
    );

    for (const row of rows) {
      logger.warn("relay_executor.batch_requeued_stale", {
        sendy_campaign_id: row.sendy_campaign_id,
        tenant_key: row.tenant_key,
        dispatch_campaign_id: row.dispatch_campaign_id,
        batch_key: row.batch_key,
        delivery_batch_id: row.delivery_batch_id,
        batch_size: row.batch_size,
        reset_sending_recipients: row.reset_sending_recipients,
        stale_timeout_ms: timeoutMs,
      });
    }

    return rows;
  });
}

async function claimNextQueuedBatch(cpDb, staleBatchTimeoutMs) {
  await recoverStaleRunningBatches(cpDb, staleBatchTimeoutMs);

  return cpDb.tx(async (client) => {
    const queueResult = await client.query(
      `
      SELECT
        q.dispatch_id,
        q.dispatch_campaign_id,
        q.tenant_id,
        q.queue_state,
        q.requested_msgs_per_second
      FROM control_plane.campaign_dispatch_queue q
      WHERE q.queue_state IN ('queued', 'reserved', 'launching', 'retry_wait', 'running')
        AND NOT EXISTS (
          SELECT 1
          FROM control_plane.campaign_delivery_batches active_batches
          WHERE active_batches.dispatch_campaign_id = q.dispatch_campaign_id
            AND active_batches.batch_state IN ('reserved', 'running')
        )
      ORDER BY
        CASE q.queue_state
          WHEN 'running' THEN 0
          WHEN 'queued' THEN 1
          WHEN 'reserved' THEN 2
          WHEN 'launching' THEN 3
          WHEN 'retry_wait' THEN 4
          ELSE 9
        END,
        COALESCE(q.not_before, q.scheduled_for, q.created_at) ASC,
        q.queue_priority DESC,
        q.dispatch_id ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
      `
    );

    const queueRow = queueResult.rows[0];
    if (!queueRow) {
      return null;
    }

    const batchResult = await client.query(
      `
      SELECT
        b.delivery_batch_id,
        b.dispatch_campaign_id,
        b.batch_key,
        b.batch_size,
        b.batch_state,
        c.tenant_id,
        c.content_snapshot_id,
        r.sendy_campaign_id,
        r.tenant_key,
        $2::bigint AS dispatch_id,
        'running'::text AS queue_state,
        $3::numeric AS requested_msgs_per_second
      FROM control_plane.campaign_delivery_batches b
      JOIN control_plane.sendy_campaign_registry r
        ON r.dispatch_campaign_id = b.dispatch_campaign_id
      JOIN control_plane.campaign_content_snapshots c
        ON c.content_snapshot_id = r.content_snapshot_id
      WHERE b.dispatch_campaign_id = $1
        AND b.batch_state = 'queued'
      ORDER BY b.delivery_batch_id ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
      `,
      [
        queueRow.dispatch_campaign_id,
        queueRow.dispatch_id,
        queueRow.requested_msgs_per_second,
      ]
    );

    const batch = batchResult.rows[0] || null;

    if (!batch) {
      const reconciliation = await reconcileDispatchWithoutQueuedBatch(
        client,
        queueRow
      );

      logger.warn("relay_executor.queue_without_queued_batch", {
        dispatch_campaign_id: queueRow.dispatch_campaign_id,
        dispatch_id: queueRow.dispatch_id,
        queue_state: queueRow.queue_state,
        action: reconciliation.action,
        reason: reconciliation.message,
        ...reconciliation.state,
      });

      return null;
    }

    await client.query(
      `
      UPDATE control_plane.campaign_delivery_batches
         SET batch_state = 'running',
             started_at = COALESCE(started_at, now()),
             updated_at = now()
       WHERE delivery_batch_id = $1
      `,
      [batch.delivery_batch_id]
    );

    await client.query(
      `
      UPDATE control_plane.campaign_dispatch_queue
         SET queue_state = 'running',
             started_at = COALESCE(started_at, now()),
             updated_at = now()
       WHERE dispatch_id = $1
      `,
      [queueRow.dispatch_id]
    );

    return batch;
  });
}

async function loadContent(cpDb, contentSnapshotId) {
  const { rows } = await cpDb.query(
    `SELECT * FROM control_plane.campaign_content_snapshots WHERE content_snapshot_id = $1`,
    [contentSnapshotId]
  );
  return rows[0] || null;
}

async function loadRecipients(cpDb, dispatchCampaignId, batchKey, limit) {
  const { rows } = await cpDb.query(
    `
    SELECT *
    FROM control_plane.campaign_recipient_queue
    WHERE dispatch_campaign_id = $1
      AND batch_key = $2
      AND recipient_state = 'batched'
    ORDER BY sendy_subscriber_id ASC
    LIMIT $3
    `,
    [dispatchCampaignId, batchKey, Math.max(Number(limit || 25), 1)]
  );
  return rows;
}

async function markAttempt(db, batch, tenantId, executionMode, resultStatus, code, message, payload) {
  const { rows } = await db.query(
    `
    INSERT INTO control_plane.campaign_delivery_attempts (
      delivery_batch_id,
      dispatch_campaign_id,
      tenant_id,
      attempt_no,
      executor_id,
      execution_mode,
      result_status,
      result_code,
      result_message,
      payload_json
    )
    VALUES (
      $1, $2, $3,
      COALESCE((
        SELECT max(attempt_no) + 1
        FROM control_plane.campaign_delivery_attempts
        WHERE delivery_batch_id = $1
      ), 1),
      'relay-executor-01',
      $4, $5, $6, $7, $8::jsonb
    )
    RETURNING delivery_attempt_id
    `,
    [
      batch.delivery_batch_id,
      batch.dispatch_campaign_id,
      tenantId,
      executionMode,
      resultStatus,
      code || null,
      message || null,
      JSON.stringify(payload || {}),
    ]
  );
  return rows[0].delivery_attempt_id;
}

async function updateAttempt(db, deliveryAttemptId, resultStatus, code, message, payload) {
  await db.query(
    `
    UPDATE control_plane.campaign_delivery_attempts
       SET result_status = $2,
           result_code = $3,
           result_message = $4,
           payload_json = $5::jsonb
     WHERE delivery_attempt_id = $1
    `,
    [
      deliveryAttemptId,
      resultStatus,
      code || null,
      message || null,
      JSON.stringify(payload || {}),
    ]
  );
}

async function touchBatchProgress(db, batch) {
  await db.query(
    `
    UPDATE control_plane.campaign_delivery_batches
       SET updated_at = now()
     WHERE delivery_batch_id = $1
    `,
    [batch.delivery_batch_id]
  );
}

async function recordSmtpRelayProgress(db, batch, deliveryAttemptId, sentCount, plannedCount) {
  await updateAttempt(
    db,
    deliveryAttemptId,
    "warn",
    SMTP_RELAY_PROGRESS_CODE,
    `smtp-relay sent ${sentCount} of ${plannedCount} recipients`,
    {
      planned: plannedCount,
      sent: sentCount,
      remaining: Math.max(plannedCount - sentCount, 0),
      batch_key: batch.batch_key,
      batch_size: batch.batch_size,
    }
  );
  await touchBatchProgress(db, batch);
}

async function failBatchAndDispatch(cpDb, batch, executionMode, reason) {
  await cpDb.tx(async (client) => {
    await client.query(
      `
      UPDATE control_plane.campaign_delivery_batches
         SET batch_state = 'failed',
             finished_at = COALESCE(finished_at, now()),
             updated_at = now()
       WHERE delivery_batch_id = $1
         AND batch_state IN ('queued', 'running')
      `,
      [batch.delivery_batch_id]
    );

    await client.query(
      `
      UPDATE control_plane.campaign_dispatch_queue
         SET queue_state = 'failed',
             finished_at = COALESCE(finished_at, now()),
             updated_at = now(),
             attempt_count = COALESCE(attempt_count, 0) + 1,
             last_error_code = $2,
             last_error_message = $3
       WHERE dispatch_campaign_id = $1
         AND queue_state IN ('queued', 'reserved', 'launching', 'retry_wait', 'running')
      `,
      [
        batch.dispatch_campaign_id,
        BATCH_EMPTY_ERROR_CODE,
        BATCH_EMPTY_ERROR_MESSAGE,
      ]
    );

    await client.query(
      `
      UPDATE control_plane.sendy_campaign_registry
         SET direct_dispatch_state = 'failed',
             finished_at = COALESCE(finished_at, now()),
             updated_at = now()
       WHERE dispatch_campaign_id = $1
         AND direct_dispatch_state <> 'completed'
      `,
      [batch.dispatch_campaign_id]
    );

    await markAttempt(
      client,
      batch,
      batch.tenant_id,
      executionMode,
      "error",
      BATCH_EMPTY_ERROR_CODE,
      BATCH_EMPTY_ERROR_MESSAGE,
      {
        reason,
        batch_key: batch.batch_key,
        batch_state: batch.batch_state,
      }
    );
  });
}

async function markDispatchRunning(cpDb, batch) {
  await cpDb.query(
    `
    UPDATE control_plane.sendy_campaign_registry
       SET direct_dispatch_state = 'running',
           started_at = COALESCE(started_at, now()),
           updated_at = now()
     WHERE dispatch_campaign_id = $1
       AND direct_dispatch_state IN ('pending', 'snapshotted', 'batched')
    `,
    [batch.dispatch_campaign_id]
  );

  await cpDb.query(
    `
    UPDATE control_plane.campaign_dispatch_queue
       SET queue_state = 'running',
           started_at = COALESCE(started_at, now()),
           updated_at = now()
     WHERE dispatch_campaign_id = $1
       AND queue_state IN ('queued', 'reserved', 'launching', 'retry_wait')
    `,
    [batch.dispatch_campaign_id]
  );
}

async function finishBatchOrRequeue(db, batch) {
  const { rows } = await db.query(
    `
    SELECT count(*)::int AS remaining
    FROM control_plane.campaign_recipient_queue
    WHERE dispatch_campaign_id = $1
      AND batch_key = $2
      AND recipient_state = 'batched'
    `,
    [batch.dispatch_campaign_id, batch.batch_key]
  );

  const remaining = rows[0]?.remaining || 0;
  if (remaining > 0) {
    await db.query(
      `
      UPDATE control_plane.campaign_delivery_batches
         SET batch_state = 'queued',
             updated_at = now()
       WHERE delivery_batch_id = $1
      `,
      [batch.delivery_batch_id]
    );
    return "queued";
  }

  await db.query(
    `
    UPDATE control_plane.campaign_delivery_batches
       SET batch_state = 'completed',
           finished_at = COALESCE(finished_at, now()),
           updated_at = now()
     WHERE delivery_batch_id = $1
    `,
    [batch.delivery_batch_id]
  );
  return "completed";
}

async function closeDispatchIfDone(cpDb, batch) {
  const { rows } = await cpDb.query(
    `
    SELECT
      count(*) FILTER (WHERE batch_state IN ('queued', 'reserved', 'running'))::int AS open_batches,
      count(*) FILTER (WHERE batch_state = 'failed')::int AS failed_batches
    FROM control_plane.campaign_delivery_batches
    WHERE dispatch_campaign_id = $1
    `,
    [batch.dispatch_campaign_id]
  );

  const openBatches = rows[0]?.open_batches || 0;
  const failedBatches = rows[0]?.failed_batches || 0;

  if (openBatches > 0) return "running";

  if (failedBatches > 0) {
    await cpDb.query(
      `
      UPDATE control_plane.campaign_dispatch_queue
         SET queue_state = 'failed',
             finished_at = COALESCE(finished_at, now()),
             updated_at = now()
       WHERE dispatch_campaign_id = $1
      `,
      [batch.dispatch_campaign_id]
    );

    await cpDb.query(
      `
      UPDATE control_plane.sendy_campaign_registry
         SET direct_dispatch_state = 'failed',
             finished_at = COALESCE(finished_at, now()),
             updated_at = now()
       WHERE dispatch_campaign_id = $1
      `,
      [batch.dispatch_campaign_id]
    );
    return "failed";
  }

  await cpDb.query(
    `
    UPDATE control_plane.campaign_dispatch_queue
       SET queue_state = 'completed',
           finished_at = COALESCE(finished_at, now()),
           updated_at = now()
     WHERE dispatch_campaign_id = $1
    `,
    [batch.dispatch_campaign_id]
  );

  await cpDb.query(
    `
    UPDATE control_plane.sendy_campaign_registry
       SET direct_dispatch_state = 'completed',
           finished_at = COALESCE(finished_at, now()),
           updated_at = now()
     WHERE dispatch_campaign_id = $1
    `,
    [batch.dispatch_campaign_id]
  );

  return "completed";
}

async function executeDryRun(cpDb, batch, recipients) {
  const recipientIds = recipients.map((recipient) => recipient.recipient_queue_id);

  if (recipientIds.length === 0) {
    throw new Error("Dry-run received no recipients to process");
  }

  let batchState = "unknown";
  let remaining = 0;

  await cpDb.tx(async (client) => {
    await client.query(
      `
      UPDATE control_plane.campaign_delivery_batches
         SET batch_state = 'running',
             started_at = COALESCE(started_at, now()),
             updated_at = now()
       WHERE delivery_batch_id = $1
      `,
      [batch.delivery_batch_id]
    );

    await client.query(
      `
      UPDATE control_plane.campaign_recipient_queue
         SET recipient_state = 'dry_run_sent',
             updated_at = now()
       WHERE recipient_queue_id = ANY($1::bigint[])
         AND dispatch_campaign_id = $2
         AND batch_key = $3
         AND recipient_state = 'batched'
      `,
      [recipientIds, batch.dispatch_campaign_id, batch.batch_key]
    );

    const remainingResult = await client.query(
      `
      SELECT count(*)::int AS remaining
      FROM control_plane.campaign_recipient_queue
      WHERE dispatch_campaign_id = $1
        AND batch_key = $2
        AND recipient_state = 'batched'
      `,
      [batch.dispatch_campaign_id, batch.batch_key]
    );

    remaining = remainingResult.rows[0]?.remaining || 0;
    batchState = await finishBatchOrRequeue(client, batch);
  });

  await markAttempt(
    cpDb,
    batch,
    batch.tenant_id,
    "dry-run",
    "ok",
    batchState === "completed" ? "DRY_RUN_COMPLETED" : "DRY_RUN_PARTIAL",
    batchState === "completed"
      ? `Dry-run completed for ${recipients.length} recipients`
      : `Dry-run processed ${recipients.length} recipients; ${remaining} remaining`,
    {
      processed: recipients.length,
      remaining,
      batch_state: batchState,
    }
  );
}

async function executeSmtpRelay(cpDb, config, batch, recipients, content) {
  const transporter = nodemailer.createTransport({
    host: config.relaySmtpHost,
    port: config.relaySmtpPort,
    secure: config.relaySmtpSecure,
    auth:
      config.relaySmtpUser && config.relaySmtpPassword
        ? {
            user: config.relaySmtpUser,
            pass: config.relaySmtpPassword,
          }
        : undefined,
    requireTLS: false,
    ignoreTLS: true,
    tls: {
      rejectUnauthorized: false,
    },
  });

  await cpDb.query(
    `
    UPDATE control_plane.campaign_delivery_batches
       SET batch_state = 'running',
           started_at = COALESCE(started_at, now()),
           updated_at = now()
     WHERE delivery_batch_id = $1
    `,
    [batch.delivery_batch_id]
  );

  let sentCount = 0;
  const plannedCount = recipients.length;
  const deliveryAttemptId = await markAttempt(
    cpDb,
    batch,
    batch.tenant_id,
    "smtp-relay",
    "warn",
    SMTP_RELAY_STARTED_CODE,
    `smtp-relay started for up to ${plannedCount} recipients`,
    {
      planned: plannedCount,
      sent: 0,
      remaining: plannedCount,
      batch_key: batch.batch_key,
      batch_size: batch.batch_size,
    }
  );

  logger.info("relay_executor.batch_started", {
    sendy_campaign_id: batch.sendy_campaign_id,
    tenant_key: batch.tenant_key,
    dispatch_campaign_id: batch.dispatch_campaign_id,
    batch_key: batch.batch_key,
    delivery_batch_id: batch.delivery_batch_id,
    delivery_attempt_id: deliveryAttemptId,
    planned_recipients: plannedCount,
  });

  try {
    for (const recipient of recipients) {
      await cpDb.query(
        `
        UPDATE control_plane.campaign_recipient_queue
           SET recipient_state = 'sending',
               updated_at = now()
         WHERE recipient_queue_id = $1
        `,
        [recipient.recipient_queue_id]
      );

      const subject = personalizeText(content.subject || "", recipient);
      const text = personalizeText(content.plain_text || "", recipient);
      const html = personalizeText(content.html_text || "", recipient);

      await transporter.sendMail({
        from: content.from_email || config.relayFromEmail,
        to: recipient.email,
        replyTo: content.reply_to || undefined,
        subject,
        text,
        html,
        headers: {
          "X-PowerEmail-Dispatch-Campaign": String(batch.dispatch_campaign_id),
          "X-PowerEmail-Batch-Key": batch.batch_key,
        },
      });

      sentCount += 1;
      await cpDb.query(
        `
        UPDATE control_plane.campaign_recipient_queue
           SET recipient_state = 'sent',
               updated_at = now()
         WHERE recipient_queue_id = $1
        `,
        [recipient.recipient_queue_id]
      );

      await recordSmtpRelayProgress(
        cpDb,
        batch,
        deliveryAttemptId,
        sentCount,
        plannedCount
      );

      if (
        sentCount === 1 ||
        sentCount === plannedCount ||
        sentCount % 25 === 0
      ) {
        logger.info("relay_executor.batch_progress", {
          sendy_campaign_id: batch.sendy_campaign_id,
          tenant_key: batch.tenant_key,
          dispatch_campaign_id: batch.dispatch_campaign_id,
          batch_key: batch.batch_key,
          delivery_batch_id: batch.delivery_batch_id,
          delivery_attempt_id: deliveryAttemptId,
          sent: sentCount,
          planned: plannedCount,
        });
      }

      await sleep(getSendDelayMs(config));
    }

    const batchState = await finishBatchOrRequeue(cpDb, batch);
    const remaining = Math.max(plannedCount - sentCount, 0);

    await updateAttempt(
      cpDb,
      deliveryAttemptId,
      batchState === "completed" ? "ok" : "warn",
      batchState === "completed"
        ? "SMTP_RELAY_COMPLETED"
        : SMTP_RELAY_PARTIAL_CODE,
      batchState === "completed"
        ? `smtp-relay completed for ${sentCount} recipients`
        : `smtp-relay partially completed ${sentCount} recipients; ${remaining} remaining`,
      {
        planned: plannedCount,
        sent: sentCount,
        remaining,
        batch_state: batchState,
        batch_key: batch.batch_key,
        batch_size: batch.batch_size,
      }
    );

    logger.info("relay_executor.batch_completed", {
      sendy_campaign_id: batch.sendy_campaign_id,
      tenant_key: batch.tenant_key,
      dispatch_campaign_id: batch.dispatch_campaign_id,
      batch_key: batch.batch_key,
      delivery_batch_id: batch.delivery_batch_id,
      delivery_attempt_id: deliveryAttemptId,
      sent: sentCount,
      planned: plannedCount,
      batch_state: batchState,
    });
  } catch (err) {
    await cpDb.query(
      `
      UPDATE control_plane.campaign_delivery_batches
         SET batch_state = 'failed',
             finished_at = now(),
             updated_at = now()
       WHERE delivery_batch_id = $1
      `,
      [batch.delivery_batch_id]
    );

    await cpDb.query(
      `
      UPDATE control_plane.campaign_recipient_queue
         SET recipient_state = 'failed',
             last_error_code = 'SMTP_RELAY_ERROR',
             last_error_message = $3,
             updated_at = now()
       WHERE dispatch_campaign_id = $1
         AND batch_key = $2
         AND recipient_state IN ('batched', 'sending')
      `,
      [batch.dispatch_campaign_id, batch.batch_key, err.message]
    );

    await updateAttempt(
      cpDb,
      deliveryAttemptId,
      "error",
      "SMTP_RELAY_ERROR",
      err.message,
      {
        planned: plannedCount,
        sent_before_failure: sentCount,
        remaining: Math.max(plannedCount - sentCount, 0),
        batch_key: batch.batch_key,
        batch_size: batch.batch_size,
      }
    );

    logger.error("relay_executor.batch_failed", {
      sendy_campaign_id: batch.sendy_campaign_id,
      tenant_key: batch.tenant_key,
      dispatch_campaign_id: batch.dispatch_campaign_id,
      batch_key: batch.batch_key,
      delivery_batch_id: batch.delivery_batch_id,
      delivery_attempt_id: deliveryAttemptId,
      sent_before_failure: sentCount,
      error: chunkError(err),
    });
    throw err;
  }
}

async function main() {
  const hasExplicitCampaign =
    Boolean(process.env.DIRECT_DISPATCHER_TENANT_KEY) &&
    Boolean(process.env.DIRECT_DISPATCHER_SENDY_CAMPAIGN_ID);

  let config = hasExplicitCampaign ? loadConfig() : loadServiceConfig();
  const cpDb = createControlPlaneDb(config);
  let batch = null;

  try {
    batch = hasExplicitCampaign
      ? await loadBatchByCampaign(cpDb, config.sendyCampaignId, config.tenantKey)
      : await claimNextQueuedBatch(cpDb, config.staleBatchTimeoutMs);

    if (!batch) {
      logger.warn("relay_executor.no_batch", {
        mode: hasExplicitCampaign ? "targeted" : "queue",
        sendy_campaign_id: hasExplicitCampaign ? config.sendyCampaignId : null,
        tenant_key: hasExplicitCampaign ? config.tenantKey : null,
      });
      return;
    }

    const runConfig = {
      ...config,
      maxMsgsPerSecond:
        Number(batch.requested_msgs_per_second) > 0
          ? Number(batch.requested_msgs_per_second)
          : Number(config.maxMsgsPerSecond),
    };
    config = runConfig;

    const recipients = await loadRecipients(
      cpDb,
      batch.dispatch_campaign_id,
      batch.batch_key,
      runConfig.maxRecipientsPerRun
    );
    if (recipients.length === 0) {
      await failBatchAndDispatch(
        cpDb,
        batch,
        runConfig.executionMode,
        "no_batched_recipients_preflight"
      );

      logger.warn("relay_executor.batch_empty_failed", {
        execution_mode: runConfig.executionMode,
        sendy_campaign_id: batch.sendy_campaign_id,
        tenant_key: batch.tenant_key,
        dispatch_campaign_id: batch.dispatch_campaign_id,
        batch_key: batch.batch_key,
        delivery_batch_id: batch.delivery_batch_id,
        reason: "no_batched_recipients_preflight",
      });
      return;
    }

    const content = await loadContent(cpDb, batch.content_snapshot_id);
    if (!content) {
      throw new Error("Content snapshot not found");
    }

    await markDispatchRunning(cpDb, batch);

    if (config.executionMode === "dry-run") {
      await executeDryRun(cpDb, batch, recipients);
      await closeDispatchIfDone(cpDb, batch);
      logger.info("relay_executor.completed", {
        execution_mode: "dry-run",
        sendy_campaign_id: batch.sendy_campaign_id,
        tenant_key: batch.tenant_key,
        dispatch_campaign_id: batch.dispatch_campaign_id,
        batch_key: batch.batch_key,
        recipients: recipients.length,
      });
      return;
    }

    if (config.executionMode === "smtp-relay") {
      await executeSmtpRelay(cpDb, runConfig, batch, recipients, content);
      await closeDispatchIfDone(cpDb, batch);
      logger.info("relay_executor.completed", {
        execution_mode: "smtp-relay",
        sendy_campaign_id: batch.sendy_campaign_id,
        tenant_key: batch.tenant_key,
        dispatch_campaign_id: batch.dispatch_campaign_id,
        batch_key: batch.batch_key,
        recipients: recipients.length,
      });
      return;
    }

    throw new Error(
      `Unsupported DIRECT_DISPATCHER_EXECUTION_MODE=${config.executionMode}`
    );
  } catch (err) {
    if (batch && isBatchEmptyError(err)) {
      try {
        await failBatchAndDispatch(
          cpDb,
          batch,
          config.executionMode,
          "no_batched_recipients_runtime"
        );

        logger.warn("relay_executor.batch_empty_failed", {
          execution_mode: config.executionMode,
          sendy_campaign_id: batch.sendy_campaign_id,
          tenant_key: batch.tenant_key,
          dispatch_campaign_id: batch.dispatch_campaign_id,
          batch_key: batch.batch_key,
          delivery_batch_id: batch.delivery_batch_id,
          reason: "no_batched_recipients_runtime",
        });
        return;
      } catch (reconcileErr) {
        logger.error("relay_executor.batch_empty_reconcile_failed", {
          dispatch_campaign_id: batch.dispatch_campaign_id,
          batch_key: batch.batch_key,
          error: chunkError(reconcileErr),
          original_error: chunkError(err),
        });
        process.exitCode = 1;
        return;
      }
    }

    logger.error("relay_executor.failed", { error: chunkError(err) });
    process.exitCode = 1;
  } finally {
    await cpDb.close();
  }
}

main();
