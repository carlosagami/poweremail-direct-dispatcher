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
const WORKER_SHUTDOWN_CODE = "WORKER_SHUTDOWN";
const CONTROL_PLANE_PERSIST_RETRY_CODE = "CONTROL_PLANE_PERSIST_RETRY";
const SMTP_RELAY_RETRY_CODE = "SMTP_RELAY_RETRY";

let shutdownRequested = false;
let shutdownSignal = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requestShutdown(signal) {
  if (shutdownRequested) return;
  shutdownRequested = true;
  shutdownSignal = signal;
  logger.warn("relay_executor.shutdown_requested", { signal });
}

function isShutdownRequestedError(err) {
  return err?.code === WORKER_SHUTDOWN_CODE;
}

function throwIfShutdownRequested() {
  if (!shutdownRequested) return;
  const err = new Error(
    `Shutdown requested via ${shutdownSignal || "signal"}`
  );
  err.code = WORKER_SHUTDOWN_CODE;
  throw err;
}

process.on("SIGTERM", () => requestShutdown("SIGTERM"));
process.on("SIGINT", () => requestShutdown("SIGINT"));

function getSendDelayMs(config) {
  const rate = Number(config.maxMsgsPerSecond || 1);
  return Math.ceil(1000 / Math.max(rate, 0.1));
}

function getProgressEveryNRecipients(config) {
  return Math.max(Number(config.progressEveryNRecipients || 25), 1);
}

function getBatchHeartbeatMs(config) {
  return Math.max(Number(config.batchHeartbeatMs || 30000), 1000);
}

function isBatchEmptyError(err) {
  return err?.message === BATCH_EMPTY_ERROR_MESSAGE;
}

function isControlPlaneConnectionError(err) {
  const message = String(err?.message || "").toLowerCase();
  const stack = String(err?.stack || "").toLowerCase();
  const code = String(err?.code || "").toLowerCase();

  if (message.includes("connection terminated unexpectedly")) {
    return true;
  }

  if (message.includes("client has encountered a connection error")) {
    return true;
  }

  if (message.includes("server closed the connection unexpectedly")) {
    return true;
  }

  if (message.includes("terminating connection due to administrator command")) {
    return true;
  }

  if (stack.includes("/pg/") && message.includes("connection terminated")) {
    return true;
  }

  if (stack.includes("/pg/") && message.includes("connection refused")) {
    return true;
  }

  if (
    stack.includes("/pg/") &&
    ["econnreset", "econnrefused", "etimedout", "epipe", "57p01", "57p02", "57p03"].includes(code)
  ) {
    return true;
  }

  return false;
}

function isRetryableSmtpTransportError(err) {
  const message = String(err?.message || "").toLowerCase();
  const code = String(err?.code || "").toLowerCase();
  const command = String(err?.command || "").toLowerCase();

  if (["econnreset", "etimedout", "esocket", "econnection", "epipe"].includes(code)) {
    return true;
  }

  if (message.includes("socket hang up")) {
    return true;
  }

  if (message.includes("connection timeout")) {
    return true;
  }

  if (message.includes("connection closed unexpectedly")) {
    return true;
  }

  if (message.includes("greeting never received")) {
    return true;
  }

  if (message.includes("read econnreset")) {
    return true;
  }

  if (message.includes("write epipe")) {
    return true;
  }

  if (command === "conn" && message.includes("timeout")) {
    return true;
  }

  return false;
}

function escapeDisplayName(displayName) {
  return String(displayName || "").replace(/"/g, '\\"').trim();
}

function formatFromHeader(content, fallbackFromEmail, overrideFromEmail = null) {
  const fromEmail = String(
    overrideFromEmail || content.from_email || fallbackFromEmail || ""
  ).trim();
  const fromName = escapeDisplayName(content.from_name);

  if (fromName && fromEmail) {
    return `"${fromName}" <${fromEmail}>`;
  }

  return fromEmail;
}

function parseRecipientCustomFields(value) {
  if (!value) return {};
  if (typeof value === "object" && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch (_) {
    return {};
  }
}

function emailDomain(email) {
  const text = String(email || "").trim().toLowerCase();
  return text.includes("@") ? text.split("@").pop() : null;
}

function getRecipientSenderOverride(recipient) {
  const fields = parseRecipientCustomFields(recipient.custom_fields_json);
  const fromEmail = String(fields.__poweremail_from_email || "").trim();
  const replyTo = String(fields.__poweremail_reply_to || "").trim();
  const senderBucket = String(fields.__poweremail_sender_bucket || "").trim();

  return fromEmail
    ? {
        fromEmail,
        replyTo: replyTo || null,
        senderBucket: senderBucket || null,
      }
    : null;
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
    message:
      "Dispatch has no queued batch because all batches are already complete",
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
          b.batch_size
        FROM control_plane.campaign_delivery_batches b
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
          sb.batch_size
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
        r.sendy_campaign_id,
        r.tenant_key,
        count(rr.recipient_queue_id)::int AS reset_sending_recipients
      FROM requeued_batches rb
      LEFT JOIN control_plane.sendy_campaign_registry r
        ON r.dispatch_campaign_id = rb.dispatch_campaign_id
      LEFT JOIN reset_recipients rr
        ON rr.dispatch_campaign_id = rb.dispatch_campaign_id
       AND rr.batch_key = rb.batch_key
      GROUP BY
        rb.delivery_batch_id,
        rb.dispatch_campaign_id,
        rb.batch_key,
        rb.batch_size,
        r.sendy_campaign_id,
        r.tenant_key
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

async function markAttempt(
  db,
  batch,
  tenantId,
  executionMode,
  resultStatus,
  code,
  message,
  payload
) {
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

async function updateAttempt(
  db,
  deliveryAttemptId,
  resultStatus,
  code,
  message,
  payload
) {
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

async function recordSmtpRelayProgress(
  db,
  batch,
  deliveryAttemptId,
  sentCount,
  plannedCount
) {
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
}

async function requeueBatchForShutdown(db, batch) {
  await db.query(
    `
    UPDATE control_plane.campaign_delivery_batches
       SET batch_state = 'queued',
           started_at = NULL,
           updated_at = now()
     WHERE delivery_batch_id = $1
    `,
    [batch.delivery_batch_id]
  );

  await db.query(
    `
    UPDATE control_plane.campaign_recipient_queue
       SET recipient_state = 'batched',
           updated_at = now()
     WHERE dispatch_campaign_id = $1
       AND batch_key = $2
       AND recipient_state = 'sending'
    `,
    [batch.dispatch_campaign_id, batch.batch_key]
  );
}

async function recoverBatchAfterControlPlaneError(db, batch) {
  return db.tx(async (client) => {
    const { rows } = await client.query(
      `
      SELECT
        count(*) FILTER (WHERE recipient_state = 'batched')::int AS batched_recipients,
        count(*) FILTER (WHERE recipient_state = 'sending')::int AS sending_recipients
      FROM control_plane.campaign_recipient_queue
      WHERE dispatch_campaign_id = $1
        AND batch_key = $2
      `,
      [batch.dispatch_campaign_id, batch.batch_key]
    );

    const batchedRecipients = Number(rows[0]?.batched_recipients || 0);
    const sendingRecipients = Number(rows[0]?.sending_recipients || 0);

    if (sendingRecipients > 0) {
      await client.query(
        `
        UPDATE control_plane.campaign_recipient_queue
           SET recipient_state = 'batched',
               updated_at = now()
         WHERE dispatch_campaign_id = $1
           AND batch_key = $2
           AND recipient_state = 'sending'
        `,
        [batch.dispatch_campaign_id, batch.batch_key]
      );
    }

    const pendingRecipients = batchedRecipients + sendingRecipients;

    if (pendingRecipients > 0) {
      await client.query(
        `
        UPDATE control_plane.campaign_delivery_batches
           SET batch_state = 'queued',
               started_at = NULL,
               updated_at = now()
         WHERE delivery_batch_id = $1
        `,
        [batch.delivery_batch_id]
      );

      return {
        batchState: "queued",
        pendingRecipients,
        resetSendingRecipients: sendingRecipients,
      };
    }

    await client.query(
      `
      UPDATE control_plane.campaign_delivery_batches
         SET batch_state = 'completed',
             finished_at = COALESCE(finished_at, now()),
             updated_at = now()
       WHERE delivery_batch_id = $1
      `,
      [batch.delivery_batch_id]
    );

    return {
      batchState: "completed",
      pendingRecipients: 0,
      resetSendingRecipients: sendingRecipients,
    };
  });
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
  const progressEvery = getProgressEveryNRecipients(config);
  const heartbeatMs = getBatchHeartbeatMs(config);
  const smtpPoolEnabled = Boolean(config.smtpPoolEnabled);
  const smtpMaxConnections = Math.max(Number(config.smtpMaxConnections || 1), 1);
  const smtpMaxMessages = Math.max(Number(config.smtpMaxMessages || 500), 1);
  const transporter = nodemailer.createTransport({
    host: config.relaySmtpHost,
    port: config.relaySmtpPort,
    secure: config.relaySmtpSecure,
    pool: smtpPoolEnabled,
    maxConnections: smtpMaxConnections,
    maxMessages: smtpMaxMessages,
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
  let lastHeartbeatAt = Date.now();
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
      smtp_pool_enabled: smtpPoolEnabled,
      smtp_max_connections: smtpMaxConnections,
      smtp_max_messages: smtpMaxMessages,
      progress_every_n_recipients: progressEvery,
      batch_heartbeat_ms: heartbeatMs,
    }
  );

  async function maybeHeartbeatBatch(force = false) {
    const now = Date.now();
    if (!force && now - lastHeartbeatAt < heartbeatMs) {
      return false;
    }
    await touchBatchProgress(cpDb, batch);
    lastHeartbeatAt = now;
    return true;
  }

  logger.info("relay_executor.transport_config", {
    sendy_campaign_id: batch.sendy_campaign_id,
    tenant_key: batch.tenant_key,
    dispatch_campaign_id: batch.dispatch_campaign_id,
    batch_key: batch.batch_key,
    delivery_batch_id: batch.delivery_batch_id,
    smtp_pool_enabled: smtpPoolEnabled,
    smtp_max_connections: smtpMaxConnections,
    smtp_max_messages: smtpMaxMessages,
    progress_every_n_recipients: progressEvery,
    batch_heartbeat_ms: heartbeatMs,
    max_msgs_per_second: Number(config.maxMsgsPerSecond),
  });

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
    throwIfShutdownRequested();

    for (const recipient of recipients) {
      throwIfShutdownRequested();

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
      const senderOverride = getRecipientSenderOverride(recipient);

      if (senderOverride) {
        logger.info("relay_executor.recipient_sender_override_applied", {
          sendy_campaign_id: batch.sendy_campaign_id,
          tenant_key: batch.tenant_key,
          dispatch_campaign_id: batch.dispatch_campaign_id,
          batch_key: batch.batch_key,
          recipient_queue_id: recipient.recipient_queue_id,
          recipient_email: recipient.email,
          from_domain: emailDomain(senderOverride.fromEmail),
          reply_to_domain: emailDomain(senderOverride.replyTo),
          sender_bucket: senderOverride.senderBucket,
        });
      }

      await transporter.sendMail({
        from: formatFromHeader(
          content,
          config.relayFromEmail,
          senderOverride?.fromEmail || null
        ),
        to: recipient.email,
        replyTo: senderOverride?.replyTo || content.reply_to || undefined,
        subject,
        text,
        html,
        headers: {
          "X-PowerEmail-Tenant-Key": String(batch.tenant_key || ""),
          "X-PowerEmail-Dispatch-Campaign-Id": String(batch.dispatch_campaign_id),
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

      const shouldPersistProgress =
        sentCount === 1 ||
        sentCount === plannedCount ||
        sentCount % progressEvery === 0;

      if (shouldPersistProgress) {
        await recordSmtpRelayProgress(
          cpDb,
          batch,
          deliveryAttemptId,
          sentCount,
          plannedCount
        );
        lastHeartbeatAt = Date.now();
      } else {
        await maybeHeartbeatBatch();
      }

      if (
        sentCount === 1 ||
        sentCount === plannedCount ||
        sentCount % progressEvery === 0
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
        smtp_pool_enabled: smtpPoolEnabled,
        smtp_max_connections: smtpMaxConnections,
        progress_every_n_recipients: progressEvery,
        batch_heartbeat_ms: heartbeatMs,
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
    if (isShutdownRequestedError(err)) {
      await requeueBatchForShutdown(cpDb, batch);
      await updateAttempt(
        cpDb,
        deliveryAttemptId,
        "warn",
        WORKER_SHUTDOWN_CODE,
        `smtp-relay interrupted by ${shutdownSignal || "signal"} after sending ${sentCount} recipients`,
        {
          planned: plannedCount,
          sent: sentCount,
          remaining: Math.max(plannedCount - sentCount, 0),
          batch_state: "queued",
          interrupted: true,
          signal: shutdownSignal,
          batch_key: batch.batch_key,
          batch_size: batch.batch_size,
          smtp_pool_enabled: smtpPoolEnabled,
          smtp_max_connections: smtpMaxConnections,
          progress_every_n_recipients: progressEvery,
          batch_heartbeat_ms: heartbeatMs,
        }
      );

      logger.warn("relay_executor.batch_interrupted", {
        sendy_campaign_id: batch.sendy_campaign_id,
        tenant_key: batch.tenant_key,
        dispatch_campaign_id: batch.dispatch_campaign_id,
        batch_key: batch.batch_key,
        delivery_batch_id: batch.delivery_batch_id,
        delivery_attempt_id: deliveryAttemptId,
        sent_before_shutdown: sentCount,
        planned: plannedCount,
        signal: shutdownSignal,
      });
      return;
    }

    if (isControlPlaneConnectionError(err)) {
      let recovery = null;

      try {
        recovery = await recoverBatchAfterControlPlaneError(cpDb, batch);
      } catch (recoveryErr) {
        logger.error("relay_executor.batch_control_plane_recovery_failed", {
          sendy_campaign_id: batch.sendy_campaign_id,
          tenant_key: batch.tenant_key,
          dispatch_campaign_id: batch.dispatch_campaign_id,
          batch_key: batch.batch_key,
          delivery_batch_id: batch.delivery_batch_id,
          delivery_attempt_id: deliveryAttemptId,
          sent_before_error: sentCount,
          recovery_error: chunkError(recoveryErr),
          original_error: chunkError(err),
        });
        throw err;
      }

      try {
        await updateAttempt(
          cpDb,
          deliveryAttemptId,
          "warn",
          CONTROL_PLANE_PERSIST_RETRY_CODE,
          `control-plane persistence interrupted after sending ${sentCount} recipients`,
          {
            planned: plannedCount,
            sent_before_retry: sentCount,
            remaining: recovery.pendingRecipients,
            batch_state: recovery.batchState,
            batch_key: batch.batch_key,
            batch_size: batch.batch_size,
            reset_sending_recipients: recovery.resetSendingRecipients,
            control_plane_error: err.message,
            control_plane_error_code: err.code || null,
            smtp_pool_enabled: smtpPoolEnabled,
            smtp_max_connections: smtpMaxConnections,
            progress_every_n_recipients: progressEvery,
            batch_heartbeat_ms: heartbeatMs,
          }
        );
      } catch (attemptErr) {
        logger.error("relay_executor.batch_control_plane_attempt_update_failed", {
          sendy_campaign_id: batch.sendy_campaign_id,
          tenant_key: batch.tenant_key,
          dispatch_campaign_id: batch.dispatch_campaign_id,
          batch_key: batch.batch_key,
          delivery_batch_id: batch.delivery_batch_id,
          delivery_attempt_id: deliveryAttemptId,
          attempt_error: chunkError(attemptErr),
          original_error: chunkError(err),
        });
      }

      logger.warn("relay_executor.batch_recovered_control_plane_error", {
        sendy_campaign_id: batch.sendy_campaign_id,
        tenant_key: batch.tenant_key,
        dispatch_campaign_id: batch.dispatch_campaign_id,
        batch_key: batch.batch_key,
        delivery_batch_id: batch.delivery_batch_id,
        delivery_attempt_id: deliveryAttemptId,
        sent_before_error: sentCount,
        batch_state: recovery.batchState,
        pending_recipients: recovery.pendingRecipients,
        reset_sending_recipients: recovery.resetSendingRecipients,
        error: chunkError(err),
      });
      return;
    }

    if (isRetryableSmtpTransportError(err)) {
      let recovery = null;

      try {
        recovery = await recoverBatchAfterControlPlaneError(cpDb, batch);
      } catch (recoveryErr) {
        logger.error("relay_executor.batch_smtp_retry_recovery_failed", {
          sendy_campaign_id: batch.sendy_campaign_id,
          tenant_key: batch.tenant_key,
          dispatch_campaign_id: batch.dispatch_campaign_id,
          batch_key: batch.batch_key,
          delivery_batch_id: batch.delivery_batch_id,
          delivery_attempt_id: deliveryAttemptId,
          sent_before_error: sentCount,
          recovery_error: chunkError(recoveryErr),
          original_error: chunkError(err),
        });
        throw err;
      }

      try {
        await updateAttempt(
          cpDb,
          deliveryAttemptId,
          "warn",
          SMTP_RELAY_RETRY_CODE,
          `smtp transport interrupted after sending ${sentCount} recipients`,
          {
            planned: plannedCount,
            sent_before_retry: sentCount,
            remaining: recovery.pendingRecipients,
            batch_state: recovery.batchState,
            batch_key: batch.batch_key,
            batch_size: batch.batch_size,
            reset_sending_recipients: recovery.resetSendingRecipients,
            smtp_error: err.message,
            smtp_error_code: err.code || null,
            smtp_error_command: err.command || null,
            smtp_response_code: err.responseCode || null,
            smtp_pool_enabled: smtpPoolEnabled,
            smtp_max_connections: smtpMaxConnections,
            progress_every_n_recipients: progressEvery,
            batch_heartbeat_ms: heartbeatMs,
          }
        );
      } catch (attemptErr) {
        logger.error("relay_executor.batch_smtp_retry_attempt_update_failed", {
          sendy_campaign_id: batch.sendy_campaign_id,
          tenant_key: batch.tenant_key,
          dispatch_campaign_id: batch.dispatch_campaign_id,
          batch_key: batch.batch_key,
          delivery_batch_id: batch.delivery_batch_id,
          delivery_attempt_id: deliveryAttemptId,
          attempt_error: chunkError(attemptErr),
          original_error: chunkError(err),
        });
      }

      logger.warn("relay_executor.batch_recovered_smtp_transport_error", {
        sendy_campaign_id: batch.sendy_campaign_id,
        tenant_key: batch.tenant_key,
        dispatch_campaign_id: batch.dispatch_campaign_id,
        batch_key: batch.batch_key,
        delivery_batch_id: batch.delivery_batch_id,
        delivery_attempt_id: deliveryAttemptId,
        sent_before_error: sentCount,
        batch_state: recovery.batchState,
        pending_recipients: recovery.pendingRecipients,
        reset_sending_recipients: recovery.resetSendingRecipients,
        error: chunkError(err),
      });
      return;
    }

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
        smtp_pool_enabled: smtpPoolEnabled,
        smtp_max_connections: smtpMaxConnections,
        progress_every_n_recipients: progressEvery,
        batch_heartbeat_ms: heartbeatMs,
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
  } finally {
    if (typeof transporter.close === "function") {
      transporter.close();
    }
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
