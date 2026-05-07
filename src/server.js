"use strict";

const http = require("http");
const { loadServiceConfig } = require("./config");
const { createControlPlaneDb } = require("./db");
const logger = require("./logger");

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 20 * 1024 * 1024) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });

    req.on("end", () => {
      if (!body.trim()) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(new Error("Invalid JSON body"));
      }
    });

    req.on("error", reject);
  });
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(statusCode, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body, "utf8"),
  });
  res.end(body);
}

function httpError(statusCode, message, details = {}) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.details = details;
  return error;
}

function assertAuthorized(req) {
  const expected = process.env.DIRECT_DISPATCHER_HANDOFF_TOKEN;
  if (!expected) {
    throw httpError(500, "DIRECT_DISPATCHER_HANDOFF_TOKEN is not configured");
  }

  const header = req.headers.authorization || "";
  const actual = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";

  if (!actual || actual !== expected) {
    throw httpError(401, "Unauthorized");
  }
}

function positiveInteger(value, fieldName) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw httpError(400, `${fieldName} must be a positive integer`);
  }
  return parsed;
}

function optionalString(value) {
  if (value === null || value === undefined) return null;
  const text = String(value);
  return text.length ? text : null;
}

function requiredString(value, fieldName) {
  const text = optionalString(value);
  if (!text) throw httpError(400, `${fieldName} is required`);
  return text;
}

function boolFromSendy(value) {
  if (value === true || value === false) return value;
  if (value === null || value === undefined || value === "") return null;
  const text = String(value).toLowerCase();
  if (["1", "true", "yes", "on"].includes(text)) return true;
  if (["0", "false", "no", "off"].includes(text)) return false;
  return null;
}

async function findTenant(client, tenantKey) {
  const result = await client.query(
    `
    SELECT tenant_id, tenant_key
    FROM control_plane.tenants
    WHERE tenant_key = $1
      AND status = 'active'
    LIMIT 1
    `,
    [tenantKey]
  );

  if (!result.rows[0]) {
    throw httpError(404, `Active tenant not found: ${tenantKey}`);
  }

  return result.rows[0];
}

async function loadRegistry(client, tenantKey, sendyCampaignId) {
  const result = await client.query(
    `
    SELECT
      dispatch_campaign_id,
      tenant_id,
      tenant_key,
      sendy_campaign_id,
      direct_dispatch_state,
      campaign_state
    FROM control_plane.sendy_campaign_registry
    WHERE tenant_key = $1
      AND sendy_campaign_id = $2
    ORDER BY dispatch_campaign_id DESC
    LIMIT 1
    `,
    [tenantKey, sendyCampaignId]
  );

  return result.rows[0] || null;
}

async function upsertRegistry(client, tenant, sendyCampaignId, campaign) {
  const existing = await loadRegistry(client, tenant.tenant_key, sendyCampaignId);

  if (existing && existing.direct_dispatch_state === "completed") {
    throw httpError(409, `Campaign ${sendyCampaignId} is already completed in direct dispatch`);
  }

  const name = optionalString(campaign.title || campaign.name);
  const subject = optionalString(campaign.subject || campaign.title);
  const fromEmail = optionalString(campaign.from_email || campaign.fromEmail);
  const replyTo = optionalString(campaign.reply_to || campaign.replyTo);
  const snapshotJson = JSON.stringify(campaign);

  if (!existing) {
    const insert = await client.query(
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
        campaign_state,
        approved_at,
        approved_by,
        sendy_snapshot_json,
        direct_dispatch_enabled,
        direct_dispatch_state
      )
      VALUES (
        $1, $2, 'broadcast', 'sendy', $3, $4, $5, $6, $7, $8,
        'approved', now(), 'sendy-click', $9::jsonb, true, 'pending'
      )
      RETURNING dispatch_campaign_id, tenant_id, tenant_key, sendy_campaign_id, direct_dispatch_state
      `,
      [
        tenant.tenant_id,
        tenant.tenant_key,
        String(sendyCampaignId),
        sendyCampaignId,
        name,
        subject,
        fromEmail,
        replyTo,
        snapshotJson,
      ]
    );

    return insert.rows[0];
  }

  const update = await client.query(
    `
    UPDATE control_plane.sendy_campaign_registry
       SET sendy_campaign_name = $3,
           subject = $4,
           from_email = $5,
           reply_to = $6,
           campaign_state = 'approved',
           approved_at = COALESCE(approved_at, now()),
           approved_by = COALESCE(approved_by, 'sendy-click'),
           sendy_snapshot_json = $7::jsonb,
           direct_dispatch_enabled = true,
           direct_dispatch_state = CASE
             WHEN direct_dispatch_state IN ('failed', 'cancelled') THEN direct_dispatch_state
             ELSE 'pending'
           END,
           updated_at = now()
     WHERE dispatch_campaign_id = $1
       AND tenant_key = $2
     RETURNING dispatch_campaign_id, tenant_id, tenant_key, sendy_campaign_id, direct_dispatch_state
    `,
    [
      existing.dispatch_campaign_id,
      tenant.tenant_key,
      name,
      subject,
      fromEmail,
      replyTo,
      snapshotJson,
    ]
  );

  return update.rows[0];
}

async function createContentSnapshot(client, registry, campaign) {
  await client.query(
    `
    UPDATE control_plane.campaign_content_snapshots
       SET snapshot_state = 'superseded',
           updated_at = now()
     WHERE dispatch_campaign_id = $1
       AND snapshot_state = 'ready'
    `,
    [registry.dispatch_campaign_id]
  );

  const insert = await client.query(
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
      snapshot_state,
      source_json
    )
    VALUES (
      $1, $2, $3, $4, $5, $6, $7,
      $8, $9, $10, $11, $12, $13,
      'ready', $14::jsonb
    )
    RETURNING content_snapshot_id
    `,
    [
      registry.dispatch_campaign_id,
      registry.tenant_id,
      registry.sendy_campaign_id,
      optionalString(campaign.subject || campaign.title),
      optionalString(campaign.from_name || campaign.fromName),
      optionalString(campaign.from_email || campaign.fromEmail),
      optionalString(campaign.reply_to || campaign.replyTo),
      optionalString(campaign.plain_text || campaign.plainText),
      optionalString(campaign.html_text || campaign.htmlText),
      optionalString(campaign.query_string || campaign.queryString),
      boolFromSendy(campaign.opens_tracking || campaign.opensTracking),
      boolFromSendy(campaign.links_tracking || campaign.linksTracking),
      optionalString(campaign.web_version_lang || campaign.webVersionLang),
      JSON.stringify(campaign),
    ]
  );

  await client.query(
    `
    UPDATE control_plane.sendy_campaign_registry
       SET content_snapshot_id = $2,
           direct_dispatch_state = 'snapshotted',
           updated_at = now()
     WHERE dispatch_campaign_id = $1
    `,
    [registry.dispatch_campaign_id, insert.rows[0].content_snapshot_id]
  );

  return insert.rows[0].content_snapshot_id;
}

async function createAudienceSnapshot(client, registry, campaign, recipients) {
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

  const sourceFilters = {
    lists: campaign.lists || null,
    to_send_lists: campaign.to_send_lists || campaign.toSendLists || null,
    lists_excl: campaign.lists_excl || campaign.listsExcl || null,
    segs: campaign.segs || null,
    segs_excl: campaign.segs_excl || campaign.segsExcl || null,
    source: "sendy-click-snapshot",
  };

  const insert = await client.query(
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
      registry.sendy_campaign_id,
      recipients.length,
      JSON.stringify(sourceFilters),
    ]
  );

  await client.query(
    `
    UPDATE control_plane.sendy_campaign_registry
       SET audience_snapshot_id = $2,
           direct_dispatch_state = 'snapshotted',
           updated_at = now()
     WHERE dispatch_campaign_id = $1
    `,
    [registry.dispatch_campaign_id, insert.rows[0].audience_snapshot_id]
  );

  return insert.rows[0].audience_snapshot_id;
}

function normalizeRecipient(raw, index) {
  const email = requiredString(raw.email, `recipients[${index}].email`);

  return {
    sendySubscriberId: positiveInteger(
      raw.sendySubscriberId || raw.sendy_subscriber_id || raw.id || index + 1,
      `recipients[${index}].sendySubscriberId`
    ),
    sendyListId: raw.sendyListId || raw.sendy_list_id || raw.list || raw.list_id || null,
    email,
    subscriberName: optionalString(raw.subscriberName || raw.subscriber_name || raw.name),
    customFields: raw.customFields || raw.custom_fields_json || {},
  };
}

async function insertRecipients(client, registry, audienceSnapshotId, recipients) {
  await client.query(
    `
    DELETE FROM control_plane.campaign_recipient_queue
    WHERE dispatch_campaign_id = $1
    `,
    [registry.dispatch_campaign_id]
  );

  const normalized = recipients.map(normalizeRecipient);

  for (const recipient of normalized) {
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
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, 'queued')
      `,
      [
        registry.dispatch_campaign_id,
        audienceSnapshotId,
        registry.tenant_id,
        registry.sendy_campaign_id,
        recipient.sendySubscriberId,
        recipient.sendyListId ? Number.parseInt(String(recipient.sendyListId), 10) : null,
        recipient.email,
        recipient.subscriberName,
        JSON.stringify(recipient.customFields || {}),
      ]
    );
  }

  return normalized.length;
}

async function createBatches(client, registry, audienceSnapshotId, batchSize) {
  await client.query(
    `
    DELETE FROM control_plane.campaign_delivery_batches
    WHERE dispatch_campaign_id = $1
    `,
    [registry.dispatch_campaign_id]
  );

  const recipients = await client.query(
    `
    SELECT recipient_queue_id
    FROM control_plane.campaign_recipient_queue
    WHERE dispatch_campaign_id = $1
      AND audience_snapshot_id = $2
      AND recipient_state = 'queued'
    ORDER BY recipient_queue_id
    `,
    [registry.dispatch_campaign_id, audienceSnapshotId]
  );

  const ids = recipients.rows.map((row) => row.recipient_queue_id);
  let batchCount = 0;

  for (let start = 0; start < ids.length; start += batchSize) {
    const chunk = ids.slice(start, start + batchSize);
    batchCount += 1;

    const batchKey = `${registry.dispatch_campaign_id}:batch:${String(batchCount).padStart(6, "0")}`;

    await client.query(
      `
      INSERT INTO control_plane.campaign_delivery_batches (
        dispatch_campaign_id,
        audience_snapshot_id,
        tenant_id,
        batch_key,
        flow_type,
        batch_state,
        batch_size
      )
      VALUES ($1, $2, $3, $4, 'broadcast', 'queued', $5)
      `,
      [
        registry.dispatch_campaign_id,
        audienceSnapshotId,
        registry.tenant_id,
        batchKey,
        chunk.length,
      ]
    );

    await client.query(
      `
      UPDATE control_plane.campaign_recipient_queue
         SET recipient_state = 'batched',
             batch_key = $2,
             updated_at = now()
       WHERE recipient_queue_id = ANY($1::bigint[])
      `,
      [chunk, batchKey]
    );
  }

  await client.query(
    `
    UPDATE control_plane.sendy_campaign_registry
       SET direct_dispatch_state = 'batched',
           queued_at = now(),
           updated_at = now()
     WHERE dispatch_campaign_id = $1
    `,
    [registry.dispatch_campaign_id]
  );

  return batchCount;
}

async function ensureDispatchQueue(client, registry, config) {
  const existing = await client.query(
    `
    SELECT dispatch_id
    FROM control_plane.campaign_dispatch_queue
    WHERE dispatch_campaign_id = $1
    ORDER BY dispatch_id DESC
    LIMIT 1
    `,
    [registry.dispatch_campaign_id]
  );

  if (existing.rows[0]) {
    await client.query(
      `
      UPDATE control_plane.campaign_dispatch_queue
         SET queue_state = 'queued',
             scheduled_for = now(),
             not_before = now(),
             started_at = NULL,
             finished_at = NULL,
             last_heartbeat_at = NULL,
             locked_by = NULL,
             lock_expires_at = NULL,
             attempt_count = 0,
             last_error_code = NULL,
             last_error_message = NULL,
             requested_msgs_per_second = $2,
             updated_at = now()
       WHERE dispatch_id = $1
      `,
      [existing.rows[0].dispatch_id, config.maxMsgsPerSecond]
    );

    return "updated";
  }

  await client.query(
    `
    INSERT INTO control_plane.campaign_dispatch_queue (
      dispatch_campaign_id,
      tenant_id,
      flow_type,
      queue_state,
      queue_priority,
      scheduled_for,
      not_before,
      attempt_count,
      requested_msgs_per_second
    )
    VALUES ($1, $2, 'broadcast', 'queued', 100, now(), now(), 0, $3)
    `,
    [registry.dispatch_campaign_id, registry.tenant_id, config.maxMsgsPerSecond]
  );

  return "created";
}

async function handleSnapshotHandoff(req, res, config) {
  assertAuthorized(req);

  const body = await readJson(req);
  const tenantKey = requiredString(body.tenantKey || body.tenant_key, "tenantKey");
  const sendyCampaignId = positiveInteger(
    body.sendyCampaignId || body.sendy_campaign_id,
    "sendyCampaignId"
  );

  const campaign = body.campaign || {};
  const recipients = Array.isArray(body.recipients) ? body.recipients : [];

  if (recipients.length === 0) {
    throw httpError(400, "recipients array is required for snapshot handoff");
  }

  const batchSize = positiveInteger(body.batchSize || body.batch_size || config.batchSize || 250, "batchSize");

  logger.info("snapshot_handoff.started", {
    tenant_key: tenantKey,
    sendy_campaign_id: sendyCampaignId,
    recipients: recipients.length,
    batch_size: batchSize,
  });

  const db = createControlPlaneDb(config);
  let result;

  try {
    result = await db.tx(async (client) => {
      const tenant = await findTenant(client, tenantKey);
      const registry = await upsertRegistry(client, tenant, sendyCampaignId, campaign);
      const contentSnapshotId = await createContentSnapshot(client, registry, campaign);
      const audienceSnapshotId = await createAudienceSnapshot(client, registry, campaign, recipients);
      const recipientCount = await insertRecipients(client, registry, audienceSnapshotId, recipients);
      const batchCount = await createBatches(client, registry, audienceSnapshotId, batchSize);
      const dispatchQueue = await ensureDispatchQueue(client, registry, config);

      return {
        ok: true,
        tenantKey,
        sendyCampaignId,
        dispatchCampaignId: Number(registry.dispatch_campaign_id),
        contentSnapshotId: Number(contentSnapshotId),
        audienceSnapshotId: Number(audienceSnapshotId),
        recipientCount,
        batchCount,
        dispatchQueue,
        executionMode: config.executionMode,
      };
    });
  } finally {
    await db.close();
  }

  logger.info("snapshot_handoff.completed", result);
  sendJson(res, 200, result);
}

async function route(req, res, config) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (req.method === "GET" && url.pathname === "/healthz") {
    sendJson(res, 200, {
      ok: true,
      service: "poweremail-broadcast-dispatcher",
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/handoff/sendy-campaign-snapshot") {
    await handleSnapshotHandoff(req, res, config);
    return;
  }

  if (req.method === "POST" && url.pathname === "/handoff/sendy-campaign") {
    sendJson(res, 410, {
      ok: false,
      error: "Use /handoff/sendy-campaign-snapshot. Railway cannot read Sendy MySQL directly.",
    });
    return;
  }

  sendJson(res, 404, {
    ok: false,
    error: "not_found",
  });
}

function main() {
  const config = loadServiceConfig();
  const port = Number.parseInt(process.env.PORT || "3000", 10);

  const server = http.createServer((req, res) => {
    route(req, res, config).catch((error) => {
      logger.error("server.request_failed", {
        error: {
          name: error.name,
          message: error.message,
          stack: error.stack,
        },
        details: error.details || {},
      });

      sendJson(res, error.statusCode || 500, {
        ok: false,
        error: error.message || "Internal server error",
        details: error.details || {},
      });
    });
  });

  server.listen(port, "0.0.0.0", () => {
    logger.info("server.started", { port });
  });
}

main();
