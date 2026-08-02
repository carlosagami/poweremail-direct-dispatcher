"use strict";

const logger = require("./logger");

function optionalString(value) {
  if (value === null || value === undefined) return null;
  const text = String(value);
  return text.length ? text : null;
}

function requiredString(value, fieldName) {
  const text = optionalString(value);
  if (!text) {
    throw new Error(`${fieldName} is required`);
  }
  return text;
}

function positiveInteger(value, fieldName) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${fieldName} must be a positive integer`);
  }
  return parsed;
}

function parseCampaignSourceFilters(campaign) {
  const sourceFilters = campaign?.source_filters || campaign?.sourceFilters || {};
  return sourceFilters && typeof sourceFilters === "object" && !Array.isArray(sourceFilters)
    ? { ...sourceFilters }
    : {};
}

function buildDeferredImportSourceFilters(campaign, recipients, batchSize, extra = {}) {
  return {
    ...parseCampaignSourceFilters(campaign),
    deferred_import: {
      state: "pending",
      batch_size: batchSize,
      received_recipients: recipients.length,
      created_at: new Date().toISOString(),
      ...extra,
      recipients,
    },
  };
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

function chunkRecipientArray(items, chunkSize) {
  const chunks = [];

  for (let index = 0; index < items.length; index += chunkSize) {
    chunks.push(items.slice(index, index + chunkSize));
  }

  return chunks;
}

function recipientImportChunkSize(config) {
  const configured = Number.parseInt(String(config?.importChunkSize || ""), 10);
  return Number.isSafeInteger(configured) && configured > 0 ? configured : 500;
}

function buildRecipientInsertChunk(registry, audienceSnapshotId, recipientsChunk) {
  const values = [];

  const placeholders = recipientsChunk.map((recipient, index) => {
    const offset = index * 9;

    values.push(
      registry.dispatch_campaign_id,
      audienceSnapshotId,
      registry.tenant_id,
      registry.sendy_campaign_id,
      recipient.sendySubscriberId,
      recipient.sendyListId
        ? Number.parseInt(String(recipient.sendyListId), 10)
        : null,
      recipient.email,
      recipient.subscriberName,
      JSON.stringify(recipient.customFields || {})
    );

    return `(
      $${offset + 1},
      $${offset + 2},
      $${offset + 3},
      $${offset + 4},
      $${offset + 5},
      $${offset + 6},
      $${offset + 7},
      $${offset + 8},
      $${offset + 9}::jsonb,
      'queued'
    )`;
  });

  return {
    text: `
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
      VALUES ${placeholders.join(",\n")}
      ON CONFLICT (dispatch_campaign_id, email) DO NOTHING
    `,
    values,
  };
}

async function insertRecipients(db, registry, audienceSnapshotId, recipients, config) {
  await db.query(
    `
    DELETE FROM control_plane.campaign_recipient_queue
    WHERE dispatch_campaign_id = $1
    `,
    [registry.dispatch_campaign_id]
  );

  const normalized = recipients.map(normalizeRecipient);
  const chunkSize = recipientImportChunkSize(config);
  const chunks = chunkRecipientArray(normalized, chunkSize);
  const startedAt = Date.now();

  let importedCount = 0;

  logger.info("snapshot_import.started", {
    tenant_key: registry.tenant_key,
    sendy_campaign_id: registry.sendy_campaign_id,
    dispatch_campaign_id: registry.dispatch_campaign_id,
    audience_snapshot_id: audienceSnapshotId,
    received_recipients: normalized.length,
    chunk_size: chunkSize,
    chunk_count: chunks.length,
    async_import: true,
  });

  for (const [index, recipientsChunk] of chunks.entries()) {
    const statement = buildRecipientInsertChunk(
      registry,
      audienceSnapshotId,
      recipientsChunk
    );

    const result = await db.query(statement.text, statement.values);
    const insertedInChunk = Number(result.rowCount || 0);

    importedCount += insertedInChunk;

    logger.info("snapshot_import.chunk_completed", {
      tenant_key: registry.tenant_key,
      sendy_campaign_id: registry.sendy_campaign_id,
      dispatch_campaign_id: registry.dispatch_campaign_id,
      audience_snapshot_id: audienceSnapshotId,
      chunk_number: index + 1,
      chunk_count: chunks.length,
      chunk_size: recipientsChunk.length,
      chunk_imported: insertedInChunk,
      imported_recipients: importedCount,
      received_recipients: normalized.length,
      duplicate_recipients: Math.max(normalized.length - importedCount, 0),
      elapsed_ms: Date.now() - startedAt,
      async_import: true,
    });
  }

  logger.info("snapshot_import.completed", {
    tenant_key: registry.tenant_key,
    sendy_campaign_id: registry.sendy_campaign_id,
    dispatch_campaign_id: registry.dispatch_campaign_id,
    audience_snapshot_id: audienceSnapshotId,
    received_recipients: normalized.length,
    imported_recipients: importedCount,
    duplicate_recipients: Math.max(normalized.length - importedCount, 0),
    chunk_size: chunkSize,
    chunk_count: chunks.length,
    elapsed_ms: Date.now() - startedAt,
    async_import: true,
  });

  return {
    receivedCount: normalized.length,
    importedCount,
    duplicateCount: Math.max(normalized.length - importedCount, 0),
    chunkSize,
    chunkCount: chunks.length,
  };
}

async function createBatches(db, registry, audienceSnapshotId, batchSize) {
  await db.query(
    `
    DELETE FROM control_plane.campaign_delivery_batches
    WHERE dispatch_campaign_id = $1
    `,
    [registry.dispatch_campaign_id]
  );

  const recipients = await db.query(
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

    await db.query(
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

    await db.query(
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

  await db.query(
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

async function ensureDispatchQueue(db, registry, config) {
  const existing = await db.query(
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
    await db.query(
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

  await db.query(
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

async function markDeferredImportState(db, audienceSnapshotId, state, details = {}, stripRecipients = false) {
  await db.query(
    `
    UPDATE control_plane.campaign_audience_snapshots
       SET source_filters_json = COALESCE(source_filters_json, '{}'::jsonb)
         || jsonb_build_object(
              'deferred_import',
              (
                CASE
                  WHEN $4::boolean THEN COALESCE(source_filters_json -> 'deferred_import', '{}'::jsonb) - 'recipients'
                  ELSE COALESCE(source_filters_json -> 'deferred_import', '{}'::jsonb)
                END
              ) || jsonb_build_object(
                'state', $2::text,
                'state_details', $3::jsonb
              )
            )
     WHERE audience_snapshot_id = $1
    `,
    [audienceSnapshotId, state, JSON.stringify(details || {}), stripRecipients]
  );
}

async function claimNextDeferredImportJob(cpDb) {
  return cpDb.tx(async (client) => {
    const { rows } = await client.query(
      `
      SELECT
        r.dispatch_campaign_id,
        r.tenant_id,
        r.tenant_key,
        r.sendy_campaign_id,
        a.audience_snapshot_id,
        a.source_filters_json
      FROM control_plane.sendy_campaign_registry r
      JOIN control_plane.campaign_audience_snapshots a
        ON a.dispatch_campaign_id = r.dispatch_campaign_id
      LEFT JOIN control_plane.campaign_dispatch_queue q
        ON q.dispatch_campaign_id = r.dispatch_campaign_id
      WHERE r.direct_dispatch_state IN ('snapshotted', 'importing')
        AND a.snapshot_state = 'ready'
        AND q.dispatch_id IS NULL
        AND jsonb_typeof(a.source_filters_json -> 'deferred_import' -> 'recipients') = 'array'
      ORDER BY r.updated_at ASC, r.dispatch_campaign_id ASC
      LIMIT 1
      FOR UPDATE OF r, a SKIP LOCKED
      `
    );

    const row = rows[0];
    if (!row) return null;

    await client.query(
      `
      UPDATE control_plane.sendy_campaign_registry
         SET direct_dispatch_state = 'importing',
             updated_at = now()
       WHERE dispatch_campaign_id = $1
      `,
      [row.dispatch_campaign_id]
    );

    const deferredImport = row.source_filters_json?.deferred_import || {};

    await markDeferredImportState(
      client,
      row.audience_snapshot_id,
      "running",
      {
        claimed_at: new Date().toISOString(),
        received_recipients: Number(deferredImport.received_recipients || 0),
      },
      false
    );

    return {
      dispatch_campaign_id: row.dispatch_campaign_id,
      tenant_id: row.tenant_id,
      tenant_key: row.tenant_key,
      sendy_campaign_id: row.sendy_campaign_id,
      audience_snapshot_id: row.audience_snapshot_id,
      deferred_import: deferredImport,
    };
  });
}

async function processDeferredImportJob(cpDb, config, job) {
  const recipients = Array.isArray(job.deferred_import?.recipients)
    ? job.deferred_import.recipients
    : [];
  const parsedBatchSize = Number.parseInt(String(job.deferred_import?.batch_size || ""), 10);
  const batchSize = Number.isSafeInteger(parsedBatchSize) && parsedBatchSize > 0
    ? parsedBatchSize
    : Math.max(Number(config.batchSize || 250), 1);

  const registry = {
    dispatch_campaign_id: job.dispatch_campaign_id,
    tenant_id: job.tenant_id,
    tenant_key: job.tenant_key,
    sendy_campaign_id: job.sendy_campaign_id,
  };

  if (recipients.length === 0) {
    await cpDb.query(
      `
      UPDATE control_plane.sendy_campaign_registry
         SET direct_dispatch_state = 'cancelled',
             updated_at = now()
       WHERE dispatch_campaign_id = $1
      `,
      [job.dispatch_campaign_id]
    );

    await markDeferredImportState(
      cpDb,
      job.audience_snapshot_id,
      "completed",
      {
        received_recipients: 0,
        imported_recipients: 0,
        duplicate_recipients: 0,
        batch_count: 0,
        dispatch_queue: "skipped",
      },
      true
    );

    return {
      dispatch_campaign_id: job.dispatch_campaign_id,
      tenant_key: job.tenant_key,
      sendy_campaign_id: job.sendy_campaign_id,
      audience_snapshot_id: job.audience_snapshot_id,
      received_recipients: 0,
      imported_recipients: 0,
      duplicate_recipients: 0,
      batch_count: 0,
      dispatch_queue: "skipped",
    };
  }

  try {
    const importSummary = await insertRecipients(
      cpDb,
      registry,
      job.audience_snapshot_id,
      recipients,
      config
    );
    const batchCount = await createBatches(
      cpDb,
      registry,
      job.audience_snapshot_id,
      batchSize
    );
    const dispatchQueue = await ensureDispatchQueue(cpDb, registry, config);

    await markDeferredImportState(
      cpDb,
      job.audience_snapshot_id,
      "completed",
      {
        received_recipients: importSummary.receivedCount,
        imported_recipients: importSummary.importedCount,
        duplicate_recipients: importSummary.duplicateCount,
        chunk_size: importSummary.chunkSize,
        chunk_count: importSummary.chunkCount,
        batch_count: batchCount,
        dispatch_queue: dispatchQueue,
        completed_at: new Date().toISOString(),
      },
      true
    );

    return {
      dispatch_campaign_id: job.dispatch_campaign_id,
      tenant_key: job.tenant_key,
      sendy_campaign_id: job.sendy_campaign_id,
      audience_snapshot_id: job.audience_snapshot_id,
      received_recipients: importSummary.receivedCount,
      imported_recipients: importSummary.importedCount,
      duplicate_recipients: importSummary.duplicateCount,
      batch_count: batchCount,
      dispatch_queue: dispatchQueue,
    };
  } catch (error) {
    await markDeferredImportState(
      cpDb,
      job.audience_snapshot_id,
      "failed",
      {
        failed_at: new Date().toISOString(),
        error_message: error.message,
      },
      false
    );
    throw error;
  }
}

module.exports = {
  buildDeferredImportSourceFilters,
  claimNextDeferredImportJob,
  processDeferredImportJob,
};
