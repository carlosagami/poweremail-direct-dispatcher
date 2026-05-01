const { loadConfig } = require("./config");
const { createControlPlaneDb } = require("./db");
const { createSendyDb } = require("./sendy-db");
const logger = require("./logger");
const { chunkError } = require("./utils");

async function loadTenantId(cpDb, tenantKey) {
  const { rows } = await cpDb.query(
    `SELECT tenant_id FROM control_plane.tenants WHERE tenant_key = $1`,
    [tenantKey]
  );
  if (!rows[0]) {
    throw new Error(`Tenant not found for tenant_key=${tenantKey}`);
  }
  return rows[0].tenant_id;
}

async function loadSendyCampaign(sendyDb, sendyCampaignId) {
  const rows = await sendyDb.query(
    `
    SELECT
      id,
      app,
      userID,
      title,
      label,
      from_name,
      from_email,
      reply_to,
      plain_text,
      html_text,
      query_string,
      opens_tracking,
      links_tracking,
      web_version_lang,
      lists,
      lists_excl,
      segs,
      segs_excl,
      send_date,
      timezone
    FROM campaigns
    WHERE id = ?
    `,
    [sendyCampaignId]
  );
  return rows[0] || null;
}

async function main() {
  const config = loadConfig();
  const cpDb = createControlPlaneDb(config);
  const sendyDb = createSendyDb(config);

  try {
    const tenantId = await loadTenantId(cpDb, config.tenantKey);
    const campaign = await loadSendyCampaign(sendyDb, config.sendyCampaignId);
    if (!campaign) {
      throw new Error(
        `Sendy campaign not found id=${config.sendyCampaignId}`
      );
    }

    const registry = await cpDb.tx(async (client) => {
      const regResult = await client.query(
        `
        INSERT INTO control_plane.sendy_campaign_registry (
          tenant_id,
          tenant_key,
          flow_type,
          source_system,
          source_object_id,
          sendy_campaign_id,
          sendy_campaign_name,
          subject,
          from_email,
          reply_to,
          expected_domain,
          campaign_state,
          requested_schedule_at,
          approved_at,
          approved_by,
          direct_dispatch_enabled,
          direct_dispatch_state,
          sendy_snapshot_json,
          created_at,
          updated_at
        )
        VALUES (
          $1, $2, 'broadcast', 'sendy', $3, $4, $5, $6, $7, $8, $9,
          'approved', now(), now(), 'direct-intake', true, 'pending', $10::jsonb, now(), now()
        )
        ON CONFLICT (sendy_campaign_id)
        DO UPDATE
          SET tenant_id = EXCLUDED.tenant_id,
              tenant_key = EXCLUDED.tenant_key,
              flow_type = EXCLUDED.flow_type,
              source_system = EXCLUDED.source_system,
              source_object_id = EXCLUDED.source_object_id,
              sendy_campaign_name = EXCLUDED.sendy_campaign_name,
              subject = EXCLUDED.subject,
              from_email = EXCLUDED.from_email,
              reply_to = EXCLUDED.reply_to,
              expected_domain = EXCLUDED.expected_domain,
              campaign_state = EXCLUDED.campaign_state,
              requested_schedule_at = EXCLUDED.requested_schedule_at,
              approved_at = EXCLUDED.approved_at,
              approved_by = EXCLUDED.approved_by,
              direct_dispatch_enabled = EXCLUDED.direct_dispatch_enabled,
              direct_dispatch_state = EXCLUDED.direct_dispatch_state,
              sendy_snapshot_json = EXCLUDED.sendy_snapshot_json,
              updated_at = now()
        RETURNING dispatch_campaign_id
        `,
        [
          tenantId,
          config.tenantKey,
          `campaign:${campaign.id}`,
          campaign.id,
          campaign.label || campaign.title || `Campaign ${campaign.id}`,
          campaign.title || "",
          campaign.from_email || "",
          campaign.reply_to || "",
          campaign.from_email ? campaign.from_email.split("@")[1] : null,
          JSON.stringify(campaign),
        ]
      );

      const dispatchCampaignId = regResult.rows[0].dispatch_campaign_id;

      const snapshotResult = await client.query(
        `
        INSERT INTO control_plane.campaign_content_snapshots (
          dispatch_campaign_id,
          tenant_id,
          sendy_campaign_id,
          subject,
          from_name,
          from_email,
          reply_to,
          plain_text,
          html_text,
          query_string,
          opens_tracking,
          links_tracking,
          web_version_lang,
          source_json
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb
        )
        RETURNING content_snapshot_id
        `,
        [
          dispatchCampaignId,
          tenantId,
          campaign.id,
          campaign.title || "",
          campaign.from_name || "",
          campaign.from_email || "",
          campaign.reply_to || "",
          campaign.plain_text || "",
          campaign.html_text || "",
          campaign.query_string || "",
          Boolean(campaign.opens_tracking),
          Boolean(campaign.links_tracking),
          campaign.web_version_lang || "",
          JSON.stringify(campaign),
        ]
      );

      await client.query(
        `
        UPDATE control_plane.sendy_campaign_registry
           SET content_snapshot_id = $2,
               updated_at = now()
         WHERE dispatch_campaign_id = $1
        `,
        [dispatchCampaignId, snapshotResult.rows[0].content_snapshot_id]
      );

      return {
        dispatchCampaignId,
        contentSnapshotId: snapshotResult.rows[0].content_snapshot_id,
      };
    });

    logger.info("campaign_intake.completed", {
      tenant_key: config.tenantKey,
      sendy_campaign_id: config.sendyCampaignId,
      dispatch_campaign_id: registry.dispatchCampaignId,
      content_snapshot_id: registry.contentSnapshotId,
    });
  } catch (err) {
    logger.error("campaign_intake.failed", { error: chunkError(err) });
    process.exitCode = 1;
  } finally {
    await Promise.allSettled([cpDb.close(), sendyDb.close()]);
  }
}

main();
