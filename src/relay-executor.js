const nodemailer = require("nodemailer");

const { loadConfig } = require("./config");
const { createControlPlaneDb } = require("./db");
const logger = require("./logger");
const { chunkError } = require("./utils");
const { personalizeText } = require("./personalize");

async function loadBatch(cpDb, sendyCampaignId, tenantKey) {
  const { rows } = await cpDb.query(
    `
    SELECT
      b.delivery_batch_id,
      b.dispatch_campaign_id,
      b.batch_key,
      b.batch_size,
      b.batch_state,
      c.tenant_id,
      c.content_snapshot_id
    FROM control_plane.campaign_delivery_batches b
    JOIN control_plane.sendy_campaign_registry r
      ON r.dispatch_campaign_id = b.dispatch_campaign_id
    JOIN control_plane.campaign_content_snapshots c
      ON c.content_snapshot_id = r.content_snapshot_id
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

async function loadContent(cpDb, contentSnapshotId) {
  const { rows } = await cpDb.query(
    `SELECT * FROM control_plane.campaign_content_snapshots WHERE content_snapshot_id = $1`,
    [contentSnapshotId]
  );
  return rows[0] || null;
}

async function loadRecipients(cpDb, dispatchCampaignId, batchKey) {
  const { rows } = await cpDb.query(
    `
    SELECT *
    FROM control_plane.campaign_recipient_queue
    WHERE dispatch_campaign_id = $1
      AND batch_key = $2
      AND recipient_state = 'batched'
    ORDER BY sendy_subscriber_id ASC
    `,
    [dispatchCampaignId, batchKey]
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

    await client.query(
      `
      UPDATE control_plane.campaign_delivery_batches
         SET batch_state = 'completed',
             finished_at = now(),
             updated_at = now()
       WHERE delivery_batch_id = $1
      `,
      [batch.delivery_batch_id]
    );
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
    }

    await cpDb.query(
      `
      UPDATE control_plane.campaign_delivery_batches
         SET batch_state = 'completed',
             finished_at = now(),
             updated_at = now()
       WHERE delivery_batch_id = $1
      `,
      [batch.delivery_batch_id]
    );

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
  const config = loadConfig();
  const cpDb = createControlPlaneDb(config);

  try {
    const batch = await loadBatch(cpDb, config.sendyCampaignId, config.tenantKey);
    if (!batch) {
      logger.warn("relay_executor.no_batch", {
        sendy_campaign_id: config.sendyCampaignId,
        tenant_key: config.tenantKey,
      });
      return;
    }

    const content = await loadContent(cpDb, batch.content_snapshot_id);
    if (!content) {
      throw new Error("Content snapshot not found");
    }

    const recipients = await loadRecipients(
      cpDb,
      batch.dispatch_campaign_id,
      batch.batch_key
    );
    if (recipients.length === 0) {
      throw new Error("Batch has no batched recipients");
    }

    if (config.executionMode === "dry-run") {
      await executeDryRun(cpDb, batch, recipients);
      logger.info("relay_executor.completed", {
        execution_mode: "dry-run",
        sendy_campaign_id: config.sendyCampaignId,
        batch_key: batch.batch_key,
        recipients: recipients.length,
      });
      return;
    }

    if (config.executionMode === "smtp-relay") {
      await executeSmtpRelay(cpDb, config, batch, recipients, content);
      logger.info("relay_executor.completed", {
        execution_mode: "smtp-relay",
        sendy_campaign_id: config.sendyCampaignId,
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
