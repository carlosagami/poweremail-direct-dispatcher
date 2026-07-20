'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');

const targetSuffix = `${path.sep}src${path.sep}relay-executor.js`;

function injectHelpers(source) {
  const marker = 'async function executeSmtpRelay(cpDb, config, batch, recipients, content) {';

  if (!source.includes(marker) || source.includes('function getIntraBatchConcurrency(config) {')) {
    return source;
  }

  const helpers = `
function getIntraBatchConcurrency(config) {
  const configured = Number(
    config.intraBatchConcurrency ||
    process.env.DIRECT_DISPATCHER_INTRA_BATCH_CONCURRENCY ||
    2
  );

  if (!Number.isFinite(configured)) {
    return 1;
  }

  return Math.max(Math.floor(configured), 1);
}

function createGlobalRateLimiter(maxMsgsPerSecond) {
  const intervalMs = Math.ceil(
    1000 / Math.max(Number(maxMsgsPerSecond || 1), 0.1)
  );
  let nextAvailableAt = Date.now();
  let queue = Promise.resolve();

  return async function acquirePermit() {
    let release;
    const previous = queue;
    queue = new Promise((resolve) => {
      release = resolve;
    });

    await previous;

    const now = Date.now();
    const waitMs = Math.max(nextAvailableAt - now, 0);
    if (waitMs > 0) {
      await sleep(waitMs);
    }

    nextAvailableAt = Math.max(nextAvailableAt, Date.now()) + intervalMs;
    release();
    return waitMs;
  };
}

`;

  return source.replace(marker, `${helpers}${marker}`);
}

function injectConcurrentLoop(source) {
  const loopPattern =
    /throwIfShutdownRequested\(\);\n\n    for \(const recipient of recipients\) \{[\s\S]*?\n    const batchState = await finishBatchOrRequeue\(cpDb, batch\);/;

  if (!loopPattern.test(source) || source.includes('relay_executor.concurrency_config')) {
    return source;
  }

  const replacement = `throwIfShutdownRequested();

    const intraBatchConcurrency = Math.max(
      1,
      Math.min(getIntraBatchConcurrency(config), plannedCount)
    );
    const acquireRatePermit = createGlobalRateLimiter(config.maxMsgsPerSecond);
    let nextRecipientIndex = 0;
    let fatalError = null;

    logger.info("relay_executor.concurrency_config", {
      sendy_campaign_id: batch.sendy_campaign_id,
      tenant_key: batch.tenant_key,
      dispatch_campaign_id: batch.dispatch_campaign_id,
      batch_key: batch.batch_key,
      delivery_batch_id: batch.delivery_batch_id,
      delivery_attempt_id: deliveryAttemptId,
      intra_batch_concurrency: intraBatchConcurrency,
      max_msgs_per_second: Number(config.maxMsgsPerSecond),
      max_msgs_per_second_source: config.maxMsgsPerSecondSource || null,
    });

    async function processRecipientQueue(workerSlot) {
      while (nextRecipientIndex < recipients.length) {
        throwIfShutdownRequested();
        if (fatalError) throw fatalError;

        const recipient = recipients[nextRecipientIndex];
        nextRecipientIndex += 1;
        if (!recipient) {
          return;
        }

        await cpDb.query(
          \`\n          UPDATE control_plane.campaign_recipient_queue\n             SET recipient_state = 'sending',\n                 updated_at = now()\n           WHERE recipient_queue_id = $1\n          \`,
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

        const ratePermitWaitMs = await acquireRatePermit();

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
          \`\n          UPDATE control_plane.campaign_recipient_queue\n             SET recipient_state = 'sent',\n                 updated_at = now()\n           WHERE recipient_queue_id = $1\n          \`,
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

        logger.info("relay_executor.recipient_dispatch_slot", {
          sendy_campaign_id: batch.sendy_campaign_id,
          tenant_key: batch.tenant_key,
          dispatch_campaign_id: batch.dispatch_campaign_id,
          batch_key: batch.batch_key,
          delivery_batch_id: batch.delivery_batch_id,
          delivery_attempt_id: deliveryAttemptId,
          recipient_queue_id: recipient.recipient_queue_id,
          recipient_email: recipient.email,
          worker_slot: workerSlot,
          rate_permit_wait_ms: ratePermitWaitMs,
          sent: sentCount,
          planned: plannedCount,
        });

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
      }
    }

    await Promise.all(
      Array.from({ length: intraBatchConcurrency }, (_, index) =>
        (async () => {
          try {
            await processRecipientQueue(index + 1);
          } catch (error) {
            if (!fatalError) {
              fatalError = error;
            }
            throw error;
          }
        })()
      )
    );

    const batchState = await finishBatchOrRequeue(cpDb, batch);`;

  return source.replace(loopPattern, replacement);
}

function transformRelayExecutorSource(source) {
  let next = source;
  next = injectHelpers(next);
  next = injectConcurrentLoop(next);
  return next;
}

const originalJsLoader = Module._extensions['.js'];

Module._extensions['.js'] = function patchedJsLoader(module, filename) {
  if (!filename.endsWith(targetSuffix)) {
    return originalJsLoader(module, filename);
  }

  const raw = fs.readFileSync(filename, 'utf8');
  const transformed = transformRelayExecutorSource(raw);
  return module._compile(transformed, filename);
};
