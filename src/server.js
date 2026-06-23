"use strict";

const http = require("http");
const crypto = require("crypto");
const { loadServiceConfig } = require("./config");
const { createControlPlaneDb } = require("./db");
const logger = require("./logger");
const { recordSnapshotFingerprintEvent } = require("./fingerprint");
const { generateFingerprintVariant } = require("./fingerprint/variant-generator");

function csvSet(value) {
  return new Set(
    String(value || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
  );
}

function shouldEnforceFingerprintDecision(config, fingerprint) {
  if (!fingerprint || !fingerprint.enabled) return false;
  if (String(config.fingerprintGovernanceMode || "").toLowerCase() !== "enforce") return false;
  if (fingerprint.policyDecision !== "block_duplicate") return false;

  const enforceReasons = csvSet(config.fingerprintGovernanceEnforceReasons);
  if (enforceReasons.size === 0) return false;

  return enforceReasons.has(fingerprint.decisionReason);
}

async function cancelFingerprintBlockedRegistry(client, registry) {
  await client.query(
    `
    UPDATE control_plane.sendy_campaign_registry
       SET direct_dispatch_state = 'cancelled',
           updated_at = now()
     WHERE dispatch_campaign_id = $1
    `,
    [registry.dispatch_campaign_id]
  );
}

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

function parseRecipientCustomFields(recipient) {
  const raw = recipient.customFields || recipient.custom_fields_json || {};
  if (!raw) return {};
  if (typeof raw === "object" && !Array.isArray(raw)) return { ...raw };
  try {
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
}

function withPowerEmailSenderOverride(recipient, fromEmail, replyTo, senderBucket) {
  return {
    ...recipient,
    customFields: {
      ...parseRecipientCustomFields(recipient),
      __poweremail_from_email: fromEmail,
      __poweremail_reply_to: replyTo,
      __poweremail_sender_bucket: senderBucket,
    },
  };
}

function hashInt(input) {
  const digest = crypto.createHash("sha256").update(String(input)).digest();
  return digest.readUInt32BE(0);
}

function normalizedRecipientEmail(recipient) {
  return String(recipient.email || "").trim().toLowerCase();
}

function campaignSourceJson(campaign) {
  const sourceJson = campaign.source_json || campaign.sourceJson || {};
  return sourceJson && typeof sourceJson === "object" && !Array.isArray(sourceJson) ? sourceJson : {};
}

function isTestAutomationCampaign(campaign) {
  return campaignSourceJson(campaign).source_system === "poweremail-test-automation";
}

function splitRecipientsForTestMirrors(recipients, campaign, sendyCampaignId) {
  if (!isTestAutomationCampaign(campaign) || recipients.length < 2) {
    return {
      parentRecipients: recipients,
      mirrorRecipients: recipients,
      splitApplied: false,
    };
  }

  const sourceJson = campaignSourceJson(campaign);
  const splitKey = sourceJson.slot_id || sourceJson.scheduled_for_local || sendyCampaignId;

  const ordered = [...recipients].sort((a, b) => {
    const aEmail = normalizedRecipientEmail(a);
    const bEmail = normalizedRecipientEmail(b);
    const diff = hashInt(`${splitKey}:mirror-split:${aEmail}`) - hashInt(`${splitKey}:mirror-split:${bEmail}`);
    if (diff !== 0) return diff;
    return aEmail.localeCompare(bEmail);
  });

  const parentRecipients = [];
  const mirrorRecipients = [];

  for (const [index, recipient] of ordered.entries()) {
    if (index % 2 === 0) {
      parentRecipients.push(recipient);
    } else {
      mirrorRecipients.push(recipient);
    }
  }

  return {
    parentRecipients,
    mirrorRecipients,
    splitApplied: true,
  };
}

function addGroupRecipientEmails(target, groups) {
  for (const group of groups) {
    for (const recipient of group.recipients || []) {
      const email = normalizedRecipientEmail(recipient);
      if (email) target.add(email);
    }
  }
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

async function resolveTenantFromSender(client, fromEmail) {
  const normalizedFrom = optionalString(fromEmail);
  if (!normalizedFrom || !normalizedFrom.includes("@")) return null;

  const result = await client.query(
    `
    SELECT
      t.tenant_id,
      t.tenant_key,
      'alias'::text AS source
    FROM control_plane.tenant_aliases a
    JOIN control_plane.tenants t
      ON t.tenant_id = a.tenant_id
    WHERE lower(a.from_email) = lower($1)
      AND a.enabled = true
      AND t.status = 'active'
    LIMIT 1
    `,
    [normalizedFrom]
  );

  if (result.rows[0]) return result.rows[0];

  const domain = normalizedFrom.split("@").pop().toLowerCase();

  const domainResult = await client.query(
    `
    SELECT
      t.tenant_id,
      t.tenant_key,
      'domain'::text AS source
    FROM control_plane.tenant_domains d
    JOIN control_plane.tenants t
      ON t.tenant_id = d.tenant_id
    WHERE lower(d.domain) = lower($1)
      AND d.is_enabled = true
      AND t.status = 'active'
    LIMIT 1
    `,
    [domain]
  );

  return domainResult.rows[0] || null;
}

function fallbackDisplayNameFromEmail(fromEmail) {
  const normalizedFrom = optionalString(fromEmail);
  if (!normalizedFrom || !normalizedFrom.includes("@")) return null;

  return normalizedFrom
    .split("@")[0]
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

async function resolveSenderDisplayName(client, tenantId, fromEmail) {
  const normalizedFrom = optionalString(fromEmail);
  if (!normalizedFrom) return null;

  const senderResult = await client.query(
    `
    SELECT display_name
    FROM control_plane.tenant_senders
    WHERE tenant_id = $1
      AND lower(from_email) = lower($2)
      AND is_enabled = true
      AND display_name IS NOT NULL
      AND btrim(display_name) <> ''
    LIMIT 1
    `,
    [tenantId, normalizedFrom]
  );

  if (senderResult.rows[0]?.display_name) {
    return {
      displayName: senderResult.rows[0].display_name,
      source: "tenant_senders",
    };
  }

  const tenantResult = await client.query(
    `
    SELECT display_name
    FROM control_plane.tenants
    WHERE tenant_id = $1
      AND display_name IS NOT NULL
      AND btrim(display_name) <> ''
    LIMIT 1
    `,
    [tenantId]
  );

  if (tenantResult.rows[0]?.display_name) {
    return {
      displayName: tenantResult.rows[0].display_name,
      source: "tenants",
    };
  }

  const fallbackDisplayName = fallbackDisplayNameFromEmail(normalizedFrom);

  return fallbackDisplayName
    ? {
        displayName: fallbackDisplayName,
        source: "email_localpart",
      }
    : null;
}


async function loadTestLeadMirrorGroups(client, tenantId, recipients) {
  const emails = Array.from(
    new Set(
      recipients
        .map((recipient) => String(recipient.email || "").trim().toLowerCase())
        .filter(Boolean)
    )
  );

  if (emails.length === 0) return [];

  const result = await client.query(
    `
    WITH matched_overrides AS (
      SELECT
        o.email_norm,
        o.pinned_from_email,
        split_part(o.pinned_from_email, '@', 1) AS localpart,
        split_part(o.pinned_from_email, '@', 2) AS pinned_domain
      FROM control_plane.tenant_test_lead_alias_overrides o
      WHERE o.tenant_id = $1
        AND o.enabled = true
        AND o.email_norm = ANY($2::text[])
    ),
    pinned_domains AS (
      SELECT
        mo.*,
        td.role,
        row_number() OVER (
          PARTITION BY td.tenant_id, td.role
          ORDER BY td.tenant_domain_id
        ) AS role_rank
      FROM matched_overrides mo
      JOIN control_plane.tenant_domains td
        ON td.tenant_id = $1
       AND td.domain = mo.pinned_domain
       AND td.is_enabled = true
      WHERE td.role IN ('primary', 'standby')
    ),
    reserves AS (
      SELECT
        td.domain,
        row_number() OVER (
          PARTITION BY td.tenant_id
          ORDER BY td.tenant_domain_id
        ) AS reserve_rank
      FROM control_plane.tenant_domains td
      WHERE td.tenant_id = $1
        AND td.role = 'reserve'
        AND td.is_enabled = true
    ),
    mirrors AS (
      SELECT
        pd.email_norm,
        pd.pinned_from_email,
        pd.localpart,
        pd.pinned_domain,
        pd.role,
        CASE
          WHEN pd.role = 'primary' THEN 1
          WHEN pd.role = 'standby' THEN 2
          ELSE NULL
        END AS target_reserve_rank
      FROM pinned_domains pd
    )
    SELECT
      m.email_norm,
      m.pinned_from_email,
      m.role,
      r.domain AS reserve_domain,
      m.localpart || '@' || r.domain AS mirror_from_email,
      m.localpart || '@mail.' || r.domain AS mirror_reply_to
    FROM mirrors m
    JOIN reserves r
      ON r.reserve_rank = m.target_reserve_rank
    JOIN control_plane.tenant_aliases a
      ON a.tenant_id = $1
     AND a.from_email = m.localpart || '@' || r.domain
     AND a.enabled = true
    ORDER BY r.reserve_rank, m.email_norm
    `,
    [tenantId, emails]
  );

  const recipientsByEmail = new Map(
    recipients.map((recipient) => [
      String(recipient.email || "").trim().toLowerCase(),
      recipient,
    ])
  );

  const groups = new Map();

  for (const row of result.rows) {
    const recipient = recipientsByEmail.get(row.email_norm);
    if (!recipient) continue;

    const key = row.reserve_domain;
    if (!groups.has(key)) {
      groups.set(key, {
        fromEmail: row.mirror_from_email,
        replyTo: row.mirror_reply_to,
        reserveDomain: row.reserve_domain,
        sourceRole: row.role,
        senderBucket: `reserve:${row.reserve_domain}`,
        recipients: [],
      });
    }

    groups.get(key).recipients.push(
      withPowerEmailSenderOverride(
        recipient,
        row.mirror_from_email,
        row.mirror_reply_to,
        `reserve:${row.reserve_domain}`
      )
    );
  }

  return Array.from(groups.values());
}

function buildMirrorCampaign(campaign, mirrorGroup, parentDispatchCampaignId) {
  return {
    ...campaign,
    from_email: mirrorGroup.fromEmail,
    fromEmail: mirrorGroup.fromEmail,
    reply_to: mirrorGroup.replyTo,
    replyTo: mirrorGroup.replyTo,
    source_json: {
      ...(campaign.source_json || {}),
      test_reserve_mirror: true,
      parent_dispatch_campaign_id: parentDispatchCampaignId,
      reserve_domain: mirrorGroup.reserveDomain,
      source_role: mirrorGroup.sourceRole,
    },
  };
}

async function createMirrorRegistry(client, tenant, originalRegistry, mirrorGroup, index) {
  const sourceObjectId = `${originalRegistry.sendy_campaign_id}:mirror:${mirrorGroup.reserveDomain}`;

  const existing = await client.query(
    `
    SELECT dispatch_campaign_id, tenant_id, tenant_key, sendy_campaign_id, direct_dispatch_state
    FROM control_plane.sendy_campaign_registry
    WHERE tenant_key = $1
      AND source_system = 'poweremail-test-reserve-mirror'
      AND source_object_id = $2
    ORDER BY dispatch_campaign_id DESC
    LIMIT 1
    `,
    [tenant.tenant_key, sourceObjectId]
  );

  if (existing.rows[0]) {
    if (existing.rows[0].direct_dispatch_state === "completed") {
      throw httpError(409, `Mirror dispatch already completed for ${sourceObjectId}`);
    }

    await client.query(
      `
      UPDATE control_plane.sendy_campaign_registry
         SET from_email = $2,
             reply_to = $3,
             direct_dispatch_state = CASE
               WHEN direct_dispatch_state = 'completed' THEN direct_dispatch_state
               ELSE 'pending'
             END,
             sendy_snapshot_json = COALESCE(sendy_snapshot_json, '{}'::jsonb) || jsonb_build_object(
               'test_reserve_mirror', true,
               'parent_dispatch_campaign_id', $1::bigint,
               'reserve_domain', $4::text,
               'source_role', $5::text
             ),
             updated_at = now()
       WHERE dispatch_campaign_id = $6
      `,
      [
        originalRegistry.dispatch_campaign_id,
        mirrorGroup.fromEmail,
        mirrorGroup.replyTo,
        mirrorGroup.reserveDomain,
        mirrorGroup.sourceRole,
        existing.rows[0].dispatch_campaign_id,
      ]
    );

    return existing.rows[0];
  }

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
    SELECT
      tenant_id,
      tenant_key,
      flow_type,
      'poweremail-test-reserve-mirror',
      $2,
      (($1::bigint * -10) - $3::bigint),
      sendy_campaign_name || ' [reserve mirror ' || $3::text || ']',
      subject,
      $4,
      $5,
      campaign_state,
      now(),
      'poweremail-mirror-dispatch',
      sendy_snapshot_json || jsonb_build_object(
        'test_reserve_mirror', true,
        'parent_dispatch_campaign_id', dispatch_campaign_id,
        'reserve_domain', $6::text,
        'source_role', $7::text
      ),
      true,
      'pending'
    FROM control_plane.sendy_campaign_registry
    WHERE dispatch_campaign_id = $1
    RETURNING dispatch_campaign_id, tenant_id, tenant_key, sendy_campaign_id, direct_dispatch_state
    `,
    [
      originalRegistry.dispatch_campaign_id,
      sourceObjectId,
      index,
      mirrorGroup.fromEmail,
      mirrorGroup.replyTo,
      mirrorGroup.reserveDomain,
      mirrorGroup.sourceRole,
    ]
  );

  return insert.rows[0];
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

async function createContentSnapshot(client, registry, campaign, config) {
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

  let fingerprint = null;

  try {
    fingerprint = await recordSnapshotFingerprintEvent(
      client,
      config || {},
      registry,
      campaign,
      insert.rows[0].content_snapshot_id
    );

    if (fingerprint.enabled) {
      logger.info("snapshot_handoff.fingerprint_observed", {
        tenant_key: registry.tenant_key,
        sendy_campaign_id: registry.sendy_campaign_id,
        dispatch_campaign_id: registry.dispatch_campaign_id,
        ...fingerprint,
      });
    }
  } catch (error) {
    logger.warn("snapshot_handoff.fingerprint_observe_failed", {
      tenant_key: registry.tenant_key,
      sendy_campaign_id: registry.sendy_campaign_id,
      dispatch_campaign_id: registry.dispatch_campaign_id,
      error: { name: error.name, message: error.message },
    });
  }

  return {
    contentSnapshotId: insert.rows[0].content_snapshot_id,
    fingerprint,
  };
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


async function loadTestLeadParentGroups(client, tenantId, recipients) {
  const emails = Array.from(
    new Set(
      recipients
        .map((recipient) => String(recipient.email || "").trim().toLowerCase())
        .filter(Boolean)
    )
  );

  if (emails.length === 0) return [];

  const result = await client.query(
    `
    SELECT
      o.email_norm,
      o.pinned_from_email,
      split_part(o.pinned_from_email, '@', 1) AS localpart,
      split_part(o.pinned_from_email, '@', 2) AS pinned_domain,
      td.role
    FROM control_plane.tenant_test_lead_alias_overrides o
    JOIN control_plane.tenant_domains td
      ON td.tenant_id = o.tenant_id
     AND td.domain = split_part(o.pinned_from_email, '@', 2)
     AND td.is_enabled = true
    JOIN control_plane.tenant_aliases a
      ON a.tenant_id = o.tenant_id
     AND lower(a.from_email) = lower(o.pinned_from_email)
     AND a.enabled = true
    WHERE o.tenant_id = $1
      AND o.enabled = true
      AND o.email_norm = ANY($2::text[])
      AND td.role IN ('primary', 'standby')
    ORDER BY td.role, o.email_norm
    `,
    [tenantId, emails]
  );

  const recipientsByEmail = new Map(
    recipients.map((recipient) => [
      String(recipient.email || "").trim().toLowerCase(),
      recipient,
    ])
  );

  const groups = new Map();

  for (const row of result.rows) {
    const recipient = recipientsByEmail.get(row.email_norm);
    if (!recipient) continue;

    const key = `${row.role}:${row.pinned_domain}`;
    if (!key) continue;

    if (!groups.has(key)) {
      groups.set(key, {
        fromEmail: row.pinned_from_email,
        replyTo: `${row.localpart}@mail.${row.pinned_domain}`,
        sourceRole: row.role,
        senderBucket: key,
        recipients: [],
      });
    }

    groups.get(key).recipients.push(
      withPowerEmailSenderOverride(
        recipient,
        row.pinned_from_email,
        `${row.localpart}@mail.${row.pinned_domain}`,
        key
      )
    );
  }

  return Array.from(groups.values());
}

function buildPinnedParentCampaign(campaign, parentGroup, parentDispatchCampaignId) {
  return {
    ...campaign,
    from_email: parentGroup.fromEmail,
    fromEmail: parentGroup.fromEmail,
    reply_to: parentGroup.replyTo,
    replyTo: parentGroup.replyTo,
    source_json: {
      ...(campaign.source_json || {}),
      test_parent_alias: true,
      parent_dispatch_campaign_id: parentDispatchCampaignId,
      source_role: parentGroup.sourceRole,
    },
  };
}

async function createPinnedParentRegistry(client, tenant, originalRegistry, parentGroup, index) {
  const parentBucketKey = String(parentGroup.senderBucket || parentGroup.fromEmail || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._+-@]/g, "_");

  const sourceObjectId = `${originalRegistry.sendy_campaign_id}:parent:${parentBucketKey}`;

  const existing = await client.query(
    `
    SELECT dispatch_campaign_id, tenant_id, tenant_key, sendy_campaign_id, direct_dispatch_state
    FROM control_plane.sendy_campaign_registry
    WHERE tenant_key = $1
      AND source_system = 'poweremail-test-parent-alias'
      AND source_object_id = $2
    ORDER BY dispatch_campaign_id DESC
    LIMIT 1
    `,
    [tenant.tenant_key, sourceObjectId]
  );

  if (existing.rows[0]) {
    if (existing.rows[0].direct_dispatch_state === "completed") {
      throw httpError(409, `Pinned parent dispatch already completed for ${sourceObjectId}`);
    }

    await client.query(
      `
      UPDATE control_plane.sendy_campaign_registry
         SET from_email = $2,
             reply_to = $3,
             direct_dispatch_state = CASE
               WHEN direct_dispatch_state = 'completed' THEN direct_dispatch_state
               ELSE 'pending'
             END,
             sendy_snapshot_json = COALESCE(sendy_snapshot_json, '{}'::jsonb) || jsonb_build_object(
               'test_parent_alias', true,
               'parent_dispatch_campaign_id', $1::bigint,
               'source_role', $4::text
             ),
             updated_at = now()
       WHERE dispatch_campaign_id = $5
      `,
      [
        originalRegistry.dispatch_campaign_id,
        parentGroup.fromEmail,
        parentGroup.replyTo,
        parentGroup.sourceRole,
        existing.rows[0].dispatch_campaign_id,
      ]
    );

    return existing.rows[0];
  }

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
    SELECT
      tenant_id,
      tenant_key,
      flow_type,
      'poweremail-test-parent-alias',
      $2,
      (($1::bigint * -1000) - $3::bigint),
      sendy_campaign_name || ' [parent alias ' || $3::text || ']',
      subject,
      $4,
      $5,
      campaign_state,
      now(),
      'poweremail-parent-alias-dispatch',
      sendy_snapshot_json || jsonb_build_object(
        'test_parent_alias', true,
        'parent_dispatch_campaign_id', dispatch_campaign_id,
        'source_role', $6::text
      ),
      true,
      'pending'
    FROM control_plane.sendy_campaign_registry
    WHERE dispatch_campaign_id = $1
    RETURNING dispatch_campaign_id, tenant_id, tenant_key, sendy_campaign_id, direct_dispatch_state
    `,
    [
      originalRegistry.dispatch_campaign_id,
      sourceObjectId,
      index,
      parentGroup.fromEmail,
      parentGroup.replyTo,
      parentGroup.sourceRole,
    ]
  );

  return insert.rows[0];
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
  const campaignFromEmail = optionalString(campaign.from_email || campaign.fromEmail);

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
      const requestedTenant = await findTenant(client, tenantKey);
      const senderTenant = await resolveTenantFromSender(client, campaignFromEmail);
      const tenant = senderTenant || requestedTenant;

      if (senderTenant && senderTenant.tenant_key !== requestedTenant.tenant_key) {
        logger.warn("snapshot_handoff.tenant_overridden_by_sender", {
          requested_tenant_key: requestedTenant.tenant_key,
          resolved_tenant_key: senderTenant.tenant_key,
          source: senderTenant.source,
          from_email: campaignFromEmail,
          sendy_campaign_id: sendyCampaignId,
        });
      }

      const senderDisplayName = await resolveSenderDisplayName(
        client,
        tenant.tenant_id,
        campaignFromEmail
      );

      const effectiveCampaign = {
        ...campaign,
        from_name: senderDisplayName?.displayName || campaign.from_name || campaign.fromName || null,
        fromName: senderDisplayName?.displayName || campaign.fromName || campaign.from_name || null,
      };

      if (senderDisplayName?.displayName) {
        logger.info("snapshot_handoff.sender_display_name_applied", {
          tenant_key: tenant.tenant_key,
          from_email: campaignFromEmail,
          display_name: senderDisplayName.displayName,
          source: senderDisplayName.source,
          sendy_campaign_id: sendyCampaignId,
        });
      }

      const registry = await upsertRegistry(client, tenant, sendyCampaignId, effectiveCampaign);
      const recipientSplit = splitRecipientsForTestMirrors(recipients, effectiveCampaign, sendyCampaignId);
      const parentGroups = await loadTestLeadParentGroups(
        client,
        tenant.tenant_id,
        recipientSplit.parentRecipients
      );
      const mirrorGroups = recipientSplit.mirrorRecipients.length > 0
        ? await loadTestLeadMirrorGroups(client, tenant.tenant_id, recipientSplit.mirrorRecipients)
        : [];
      const pinnedRecipientEmails = new Set();

      addGroupRecipientEmails(pinnedRecipientEmails, parentGroups);
      addGroupRecipientEmails(pinnedRecipientEmails, mirrorGroups);

      const globalRecipients = recipients.filter((recipient) => {
        const email = normalizedRecipientEmail(recipient);
        return !pinnedRecipientEmails.has(email);
      });

      let contentSnapshotId = null;
      let audienceSnapshotId = null;
      let recipientCount = 0;
      let batchCount = 0;
      let dispatchQueue = "skipped";

      if (globalRecipients.length > 0) {
        const contentSnapshot = await createContentSnapshot(client, registry, effectiveCampaign, config);
        contentSnapshotId = contentSnapshot.contentSnapshotId;
        audienceSnapshotId = await createAudienceSnapshot(client, registry, effectiveCampaign, globalRecipients);
        recipientCount = await insertRecipients(client, registry, audienceSnapshotId, globalRecipients);
        batchCount = await createBatches(client, registry, audienceSnapshotId, batchSize);
        dispatchQueue = await ensureDispatchQueue(client, registry, config);
      }

      if (globalRecipients.length === 0) {
        await client.query(
          `
          UPDATE control_plane.sendy_campaign_registry
             SET direct_dispatch_state = 'cancelled',
                 updated_at = now()
           WHERE dispatch_campaign_id = $1
          `,
          [registry.dispatch_campaign_id]
        );
      }

      const parentAliasDispatches = [];

      for (const [index, parentGroup] of parentGroups.entries()) {
        const parentRegistry = await createPinnedParentRegistry(client, tenant, registry, parentGroup, index + 1);
        const parentCampaign = buildPinnedParentCampaign(effectiveCampaign, parentGroup, registry.dispatch_campaign_id);
        const parentContentSnapshot = await createContentSnapshot(client, parentRegistry, parentCampaign, config);
        const parentContentSnapshotId = parentContentSnapshot.contentSnapshotId;
        const parentAudienceSnapshotId = await createAudienceSnapshot(
          client,
          parentRegistry,
          parentCampaign,
          parentGroup.recipients
        );
        const parentRecipientCount = await insertRecipients(
          client,
          parentRegistry,
          parentAudienceSnapshotId,
          parentGroup.recipients
        );
        const parentBatchCount = await createBatches(client, parentRegistry, parentAudienceSnapshotId, batchSize);
        const parentDispatchQueue = await ensureDispatchQueue(client, parentRegistry, config);

        parentAliasDispatches.push({
          dispatchCampaignId: Number(parentRegistry.dispatch_campaign_id),
          fromEmail: parentGroup.fromEmail,
          replyTo: parentGroup.replyTo,
          sourceRole: parentGroup.sourceRole,
          recipientCount: parentRecipientCount,
          batchCount: parentBatchCount,
          contentSnapshotId: Number(parentContentSnapshotId),
          audienceSnapshotId: Number(parentAudienceSnapshotId),
          dispatchQueue: parentDispatchQueue,
        });
      }

      const mirrorDispatches = [];

      for (const [index, mirrorGroup] of mirrorGroups.entries()) {
        const mirrorRegistry = await createMirrorRegistry(client, tenant, registry, mirrorGroup, index + 1);
        let mirrorCampaign = buildMirrorCampaign(effectiveCampaign, mirrorGroup, registry.dispatch_campaign_id);
        let mirrorContentSnapshot = await createContentSnapshot(client, mirrorRegistry, mirrorCampaign, config);
        let mirrorContentSnapshotId = mirrorContentSnapshot.contentSnapshotId;

        if (shouldEnforceFingerprintDecision(config, mirrorContentSnapshot.fingerprint)) {
          let variantResult = null;

          try {
            variantResult = await generateFingerprintVariant(config, mirrorCampaign, {
              tenantKey: tenant.tenant_key,
              fromEmail: mirrorGroup.fromEmail,
              domainRole: "reserve",
              parentFingerprintEventId: mirrorContentSnapshot.fingerprint.fingerprintEventId,
            });
          } catch (error) {
            logger.warn("snapshot_handoff.fingerprint_variant_failed", {
              tenant_key: tenant.tenant_key,
              dispatch_campaign_id: mirrorRegistry.dispatch_campaign_id,
              reason: "variant_generation_error",
              error: { name: error.name, message: error.message },
            });
          }

          if (variantResult?.ok) {
            mirrorCampaign = variantResult.campaign;
            mirrorContentSnapshot = await createContentSnapshot(client, mirrorRegistry, mirrorCampaign, config);
            mirrorContentSnapshotId = mirrorContentSnapshot.contentSnapshotId;

            logger.info("snapshot_handoff.fingerprint_variant_applied", {
              tenant_key: tenant.tenant_key,
              dispatch_campaign_id: mirrorRegistry.dispatch_campaign_id,
              content_snapshot_id: mirrorContentSnapshotId,
              attempt: variantResult.attempt,
              variant_strategy: variantResult.variant?.variant_strategy || null,
              validation: variantResult.validation?.checks || null,
            });

            if (shouldEnforceFingerprintDecision(config, mirrorContentSnapshot.fingerprint)) {
              await cancelFingerprintBlockedRegistry(client, mirrorRegistry);

              mirrorDispatches.push({
                dispatchCampaignId: Number(mirrorRegistry.dispatch_campaign_id),
                fromEmail: mirrorGroup.fromEmail,
                replyTo: mirrorGroup.replyTo,
                reserveDomain: mirrorGroup.reserveDomain,
                sourceRole: mirrorGroup.sourceRole,
                recipientCount: 0,
                batchCount: 0,
                contentSnapshotId: Number(mirrorContentSnapshotId),
                audienceSnapshotId: null,
                dispatchQueue: "fingerprint_enforced",
                skipped: true,
                variantRejected: true,
                fingerprintDecision: mirrorContentSnapshot.fingerprint.policyDecision,
                fingerprintReason: mirrorContentSnapshot.fingerprint.decisionReason,
              });
              continue;
            }
          } else {
            await cancelFingerprintBlockedRegistry(client, mirrorRegistry);

            mirrorDispatches.push({
              dispatchCampaignId: Number(mirrorRegistry.dispatch_campaign_id),
              fromEmail: mirrorGroup.fromEmail,
              replyTo: mirrorGroup.replyTo,
              reserveDomain: mirrorGroup.reserveDomain,
              sourceRole: mirrorGroup.sourceRole,
              recipientCount: 0,
              batchCount: 0,
              contentSnapshotId: Number(mirrorContentSnapshotId),
              audienceSnapshotId: null,
              dispatchQueue: "fingerprint_enforced",
              skipped: true,
              variantReason: variantResult?.reason || "variant_unavailable",
              fingerprintDecision: mirrorContentSnapshot.fingerprint.policyDecision,
              fingerprintReason: mirrorContentSnapshot.fingerprint.decisionReason,
            });
            continue;
          }
        }

        const mirrorAudienceSnapshotId = await createAudienceSnapshot(
          client,
          mirrorRegistry,
          mirrorCampaign,
          mirrorGroup.recipients
        );
        const mirrorRecipientCount = await insertRecipients(
          client,
          mirrorRegistry,
          mirrorAudienceSnapshotId,
          mirrorGroup.recipients
        );
        const mirrorBatchCount = await createBatches(client, mirrorRegistry, mirrorAudienceSnapshotId, batchSize);
        const mirrorDispatchQueue = await ensureDispatchQueue(client, mirrorRegistry, config);

        mirrorDispatches.push({
          dispatchCampaignId: Number(mirrorRegistry.dispatch_campaign_id),
          fromEmail: mirrorGroup.fromEmail,
          replyTo: mirrorGroup.replyTo,
          reserveDomain: mirrorGroup.reserveDomain,
          sourceRole: mirrorGroup.sourceRole,
          recipientCount: mirrorRecipientCount,
          batchCount: mirrorBatchCount,
          contentSnapshotId: Number(mirrorContentSnapshotId),
          audienceSnapshotId: Number(mirrorAudienceSnapshotId),
          dispatchQueue: mirrorDispatchQueue,
        });
      }

      return {
        ok: true,
        tenantKey: tenant.tenant_key,
        requestedTenantKey: requestedTenant.tenant_key,
        sendyCampaignId,
        dispatchCampaignId: Number(registry.dispatch_campaign_id),
        contentSnapshotId: Number(contentSnapshotId),
        audienceSnapshotId: Number(audienceSnapshotId),
        recipientCount,
        batchCount,
        dispatchQueue,
        testMirrorRecipientSplit: recipientSplit.splitApplied
          ? {
              parentRecipients: recipientSplit.parentRecipients.length,
              mirrorRecipients: recipientSplit.mirrorRecipients.length,
            }
          : null,
        parentAliasDispatches,
        mirrorDispatches,
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
