const { loadConfig } = require("./config");
const { createControlPlaneDb } = require("./db");
const logger = require("./logger");
const { chunkError, buildBatchKey } = require("./utils");

async function loadCampaign(cpDb, sendyCampaignId, tenantKey) {
  const { rows } = await cpDb.query(
    `
    SELECT dispatch_campaign_id, audience_snapshot_id, tenant_id
    FROM control_plane.sendy_campaign_registry
    WHERE sendy_campaign_id = $1
      AND tenant_key = $2
    ORDER BY dispatch_campaign_id DESC
    LIMIT 1
    `,
    [sendyCampaignId, tenantKey]
  );
  return rows[0] || null;
}

async function loadQueuedRecipients(cpDb, dispatchCampaignId) {
  const { rows } = await cpDb.query(
    `
    SELECT recipient_queue_id
    FROM control_plane.campaign_recipient_queue
    WHERE dispatch_campaign_id = $1
      AND recipient_state = 'queued'
    ORDER BY sendy_subscriber_id ASC
    `,
    [dispatchCampaignId]
  );
  return rows;
}

async function main() {
  const config = loadConfig();
  const cpDb = createControlPlaneDb(config);

  try {
    const campaign = await loadCampaign(
      cpDb,
      config.sendyCampaignId,
      config.tenantKey
    );
    if (!campaign) {
      throw new Error("Dispatch campaign not found");
    }

    const recipients = await loadQueuedRecipients(cpDb, campaign.dispatch_campaign_id);
    if (recipients.length === 0) {
      logger.warn("batch_planner.no_queued_recipients", {
        sendy_campaign_id: config.sendyCampaignId,
      });
      return;
    }

    let batchNo = 0;
    const batches = [];

    await cpDb.tx(async (client) => {
      await client.query(
        `
        DELETE FROM control_plane.campaign_delivery_batches
         WHERE dispatch_campaign_id = $1
           AND batch_state IN ('queued', 'reserved', 'failed')
        `,
        [campaign.dispatch_campaign_id]
      );

      for (let i = 0; i < recipients.length; i += config.batchSize) {
        batchNo += 1;
        const chunk = recipients.slice(i, i + config.batchSize);
        const batchKey = buildBatchKey(campaign.dispatch_campaign_id, batchNo);

        await client.query(
          `
          INSERT INTO control_plane.campaign_delivery_batches (
            dispatch_campaign_id,
            audience_snapshot_id,
            tenant_id,
            batch_key,
            batch_size,
            batch_state
          )
          VALUES ($1, $2, $3, $4, $5, 'queued')
          `,
          [
            campaign.dispatch_campaign_id,
            campaign.audience_snapshot_id,
            campaign.tenant_id,
            batchKey,
            chunk.length,
          ]
        );

        const ids = chunk.map((row) => row.recipient_queue_id);
        await client.query(
          `
          UPDATE control_plane.campaign_recipient_queue
             SET recipient_state = 'batched',
                 batch_key = $2,
                 updated_at = now()
           WHERE recipient_queue_id = ANY($1::bigint[])
          `,
          [ids, batchKey]
        );

        batches.push({ batchKey, size: chunk.length });
      }

      await client.query(
        `
        UPDATE control_plane.sendy_campaign_registry
           SET direct_dispatch_state = 'batched',
               updated_at = now()
         WHERE dispatch_campaign_id = $1
        `,
        [campaign.dispatch_campaign_id]
      );
    });

    logger.info("batch_planner.completed", {
      sendy_campaign_id: config.sendyCampaignId,
      dispatch_campaign_id: campaign.dispatch_campaign_id,
      batch_count: batches.length,
      batch_size: config.batchSize,
    });
  } catch (err) {
    logger.error("batch_planner.failed", { error: chunkError(err) });
    process.exitCode = 1;
  } finally {
    await cpDb.close();
  }
}

main();
