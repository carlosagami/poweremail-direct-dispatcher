const { loadConfig } = require("./config");
const { createControlPlaneDb } = require("./db");
const { createSendyDb } = require("./sendy-db");
const logger = require("./logger");
const { chunkError, parseCsvIds } = require("./utils");

function csvPlaceholders(values) {
  return values.map(() => "?").join(",");
}

async function loadRegistry(cpDb, sendyCampaignId, tenantKey) {
  const { rows } = await cpDb.query(
    `
    SELECT dispatch_campaign_id, tenant_id, sendy_snapshot_json
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

async function resolveRecipients(sendyDb, snapshot) {
  const campaign = snapshot.sendy_snapshot_json;

  // Sendy clears campaigns.lists after launch/preparation and keeps the
  // materialized target lists in campaigns.to_send_lists.
  // For direct-dispatch snapshots, prefer lists when present, otherwise
  // fall back to to_send_lists.
  const sourceLists = campaign.lists || campaign.to_send_lists;

  const lists = parseCsvIds(sourceLists);
  const listsExcl = parseCsvIds(campaign.lists_excl);
  const segs = parseCsvIds(campaign.segs);
  const segsExcl = parseCsvIds(campaign.segs_excl);

  if (lists.length === 0 && segs.length === 0) {
    throw new Error(
      "Campaign has no lists, to_send_lists, or segments to resolve"
    );
  }

  const where = [
    "s.unsubscribed = 0",
    "s.bounced = 0",
    "s.complaint = 0",
    "s.confirmed = 1",
  ];
  const params = [];

  if (lists.length > 0) {
    where.push(`s.list IN (${csvPlaceholders(lists)})`);
    params.push(...lists);
  }

  if (segs.length > 0) {
    where.push(
      `EXISTS (
         SELECT 1
         FROM subscribers_seg ss1
         WHERE ss1.subscriber_id = s.id
           AND ss1.seg_id IN (${csvPlaceholders(segs)})
       )`
    );
    params.push(...segs);
  }

  if (listsExcl.length > 0) {
    where.push(`s.email NOT IN (
      SELECT sx.email
      FROM subscribers sx
      WHERE sx.list IN (${csvPlaceholders(listsExcl)})
    )`);
    params.push(...listsExcl);
  }

  if (segsExcl.length > 0) {
    where.push(`s.email NOT IN (
      SELECT sx.email
      FROM subscribers sx
      JOIN subscribers_seg ssx ON ssx.subscriber_id = sx.id
      WHERE ssx.seg_id IN (${csvPlaceholders(segsExcl)})
    )`);
    params.push(...segsExcl);
  }

  const sql = `
    SELECT
      s.id AS sendy_subscriber_id,
      s.list AS sendy_list_id,
      s.email,
      s.name,
      s.custom_fields
    FROM subscribers s
    WHERE ${where.join("\n      AND ")}
    ORDER BY s.id ASC
  `;

  return sendyDb.query(sql, params);
}

async function main() {
  const config = loadConfig();
  const cpDb = createControlPlaneDb(config);
  const sendyDb = createSendyDb(config);

  try {
    const registry = await loadRegistry(
      cpDb,
      config.sendyCampaignId,
      config.tenantKey
    );
    if (!registry) {
      throw new Error(
        `Registry row missing for sendy_campaign_id=${config.sendyCampaignId} tenant=${config.tenantKey}`
      );
    }

    const recipients = await resolveRecipients(sendyDb, registry);

    const result = await cpDb.tx(async (client) => {
      await client.query(
        `
        UPDATE control_plane.campaign_audience_snapshots
           SET snapshot_state = 'superseded',
               updated_at = now()
         WHERE dispatch_campaign_id = $1
           AND snapshot_state = 'ready'
        `,
        [registry.dispatch_campaign_id]
      );

      const snapshotResult = await client.query(
        `
        INSERT INTO control_plane.campaign_audience_snapshots (
          dispatch_campaign_id,
          tenant_id,
          sendy_campaign_id,
          snapshot_state,
          recipient_count,
          source_filters_json
        )
        VALUES ($1, $2, $3, 'ready', $4, $5::jsonb)
        RETURNING audience_snapshot_id
        `,
        [
          registry.dispatch_campaign_id,
          registry.tenant_id,
          config.sendyCampaignId,
          recipients.length,
          JSON.stringify(registry.sendy_snapshot_json),
        ]
      );

      const audienceSnapshotId = snapshotResult.rows[0].audience_snapshot_id;

      await client.query(
        `
        DELETE FROM control_plane.campaign_recipient_queue
         WHERE dispatch_campaign_id = $1
        `,
        [registry.dispatch_campaign_id]
      );

      for (const recipient of recipients) {
        await client.query(
          `
          INSERT INTO control_plane.campaign_recipient_queue (
            dispatch_campaign_id,
            audience_snapshot_id,
            tenant_id,
            sendy_campaign_id,
            sendy_subscriber_id,
            sendy_list_id,
            email,
            subscriber_name,
            custom_fields_json,
            recipient_state
          )
          VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, 'queued'
          )
          `,
          [
            registry.dispatch_campaign_id,
            audienceSnapshotId,
            registry.tenant_id,
            config.sendyCampaignId,
            recipient.sendy_subscriber_id,
            recipient.sendy_list_id || null,
            recipient.email,
            recipient.name || null,
            recipient.custom_fields
              ? JSON.stringify(recipient.custom_fields)
              : JSON.stringify({}),
          ]
        );
      }

      await client.query(
        `
        UPDATE control_plane.sendy_campaign_registry
           SET audience_snapshot_id = $2,
               direct_dispatch_state = 'snapshotted',
               updated_at = now()
         WHERE dispatch_campaign_id = $1
        `,
        [registry.dispatch_campaign_id, audienceSnapshotId]
      );

      return { audienceSnapshotId };
    });

    logger.info("audience_resolver.completed", {
      tenant_key: config.tenantKey,
      sendy_campaign_id: config.sendyCampaignId,
      dispatch_campaign_id: registry.dispatch_campaign_id,
      audience_snapshot_id: result.audienceSnapshotId,
      recipients: recipients.length,
    });
  } catch (err) {
    logger.error("audience_resolver.failed", { error: chunkError(err) });
    process.exitCode = 1;
  } finally {
    await Promise.allSettled([cpDb.close(), sendyDb.close()]);
  }
}

main();
