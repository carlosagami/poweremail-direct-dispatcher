const nodemailer = require("nodemailer");

const { loadConfig, loadServiceConfig } = require("./config");
const { createControlPlaneDb } = require("./db");
const logger = require("./logger");
const { chunkError } = require("./utils");
const { personalizeText } = require("./personalize");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getSendDelayMs(config) {
  const rate = Number(config.maxMsgsPerSecond || 1);
  return Math.ceil(1000 / Math.max(rate, 0.1));
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

async function claimNextQueuedBatch(cpDb) {
  return cpDb.tx(async (client) => {
    const queueResult = await client.query(
      `
      SELECT
        dispatch_id,
        dispatch_campaign_id,
        tenant_id,
        queue_state,
        requested_msgs_per_second
      FROM control_plane.campaign_dispatch_queue
      WHERE queue_state IN ('queued', 'reserved', 'launching', 'retry_wait', 'running')
      ORDER BY
        CASE queue_state
          WHEN 'running' THEN 0
          WHEN 'queued' THEN 1
          WHEN 'reserved' THEN 2
          WHEN 'launching' THEN 3
          WHEN 'retry_wait' THEN 4
          ELSE 9
        END,
        COALESCE(not_before, scheduled_for, created_at) ASC,
        queue_priority DESC,
        dispatch_id ASC
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
        $3::text AS queue_state,
        $4::numeric AS requested_msgs_per_second
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
        queueRow.queue_state,
        queueRow.requested_msgs_per_second,
      ]
    );

    const batch = batchResult.rows[0] || null;

    if (!batch) {
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

      return null;
    }

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

async function markAttempt(cpDb, batch, tenantId, executionMode, resultStatus, code, message, payload) {
  const { rows } = await cpDb.query(
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
  await cpDb.tx(async (client) => {
    await client.query(
      `
      UPDATE control_plane.campaign_delivery_batches
         SET batch_state = 'running',
             started_at = now(),
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
       WHERE dispatch_campaign_id = $1
         AND batch_key = $2
         AND recipient_state = 'batched'
      `,
      [batch.dispatch_campaign_id, batch.batch_key]
    );

    await finishBatchOrRequeue(client, batch);
  });

  await markAttempt(
    cpDb,
    batch,
    batch.tenant_id,
    "dry-run",
    "ok",
    "DRY_RUN_COMPLETED",
    `Dry-run completed for ${recipients.length} recipients`,
    { recipients: recipients.length }
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
  });

  await cpDb.query(
    `
    UPDATE control_plane.campaign_delivery_batches
       SET batch_state = 'running',
           started_at = now(),
           updated_at = now()
     WHERE delivery_batch_id = $1
    `,
    [batch.delivery_batch_id]
  );

  let sentCount = 0;
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

      await sleep(getSendDelayMs(config));
    }

    await finishBatchOrRequeue(cpDb, batch);

    await markAttempt(
      cpDb,
      batch,
      batch.tenant_id,
      "smtp-relay",
      "ok",
      "SMTP_RELAY_COMPLETED",
      `smtp-relay completed for ${sentCount} recipients`,
      { sent: sentCount }
    );
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

    await markAttempt(
      cpDb,
      batch,
      batch.tenant_id,
      "smtp-relay",
      "error",
      "SMTP_RELAY_ERROR",
      err.message,
      { sent_before_failure: sentCount }
    );
    throw err;
  }
}

async function main() {
  const hasExplicitCampaign =
    Boolean(process.env.DIRECT_DISPATCHER_TENANT_KEY) &&
    Boolean(process.env.DIRECT_DISPATCHER_SENDY_CAMPAIGN_ID);

  const config = hasExplicitCampaign ? loadConfig() : loadServiceConfig();
  const cpDb = createControlPlaneDb(config);

  try {
    const batch = hasExplicitCampaign
      ? await loadBatchByCampaign(cpDb, config.sendyCampaignId, config.tenantKey)
      : await claimNextQueuedBatch(cpDb);

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

    const content = await loadContent(cpDb, batch.content_snapshot_id);
    if (!content) {
      throw new Error("Content snapshot not found");
    }

    const recipients = await loadRecipients(
      cpDb,
      batch.dispatch_campaign_id,
      batch.batch_key,
      runConfig.maxRecipientsPerRun
    );
    if (recipients.length === 0) {
      throw new Error("Batch has no batched recipients");
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
    logger.error("relay_executor.failed", { error: chunkError(err) });
    process.exitCode = 1;
  } finally {
    await cpDb.close();
  }
}

main();
