'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');

const targetSuffix = `${path.sep}src${path.sep}server.js`;

function injectHelpers(source) {
  const marker = 'async function insertRecipients(client, registry, audienceSnapshotId, recipients) {';

  if (!source.includes(marker) || source.includes('function chunkRecipientArray(items, chunkSize) {')) {
    return source;
  }

  const helpers = `
function chunkRecipientArray(items, chunkSize) {
  const chunks = [];
  for (let index = 0; index < items.length; index += chunkSize) {
    chunks.push(items.slice(index, index + chunkSize));
  }
  return chunks;
}

function getImportChunkSize() {
  const configured = Number.parseInt(
    process.env.DIRECT_DISPATCHER_IMPORT_CHUNK_SIZE || '',
    10
  );

  if (!Number.isSafeInteger(configured) || configured <= 0) {
    return 500;
  }

  return configured;
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
      recipient.sendyListId ? Number.parseInt(String(recipient.sendyListId), 10) : null,
      recipient.email,
      recipient.subscriberName,
      JSON.stringify(recipient.customFields || {})
    );

    return \
      \`($\${offset + 1}, $\${offset + 2}, $\${offset + 3}, $\${offset + 4}, $\${offset + 5}, $\${offset + 6}, $\${offset + 7}, $\${offset + 8}, $\${offset + 9}::jsonb, 'queued')\`;
  });

  return {
    text: \
      \`
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
      VALUES \${placeholders.join(',\n             ')}
      ON CONFLICT (dispatch_campaign_id, email) DO NOTHING
      \`,
    values,
  };
}

`;

  return source.replace(marker, `${helpers}${marker}`);
}

function injectBulkInsertImplementation(source) {
  const original = `async function insertRecipients(client, registry, audienceSnapshotId, recipients) {
  await client.query(
    \
    \`
    DELETE FROM control_plane.campaign_recipient_queue
    WHERE dispatch_campaign_id = $1
    \`,
    [registry.dispatch_campaign_id]
  );

  const normalized = recipients.map(normalizeRecipient);

  for (const recipient of normalized) {
    await client.query(
      \
      \`
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
      \`,
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
}`;

  if (!source.includes(original) || source.includes('snapshot_import.chunk_completed')) {
    return source;
  }

  const replacement = `async function insertRecipients(client, registry, audienceSnapshotId, recipients) {
  await client.query(
    \
    \`
    DELETE FROM control_plane.campaign_recipient_queue
    WHERE dispatch_campaign_id = $1
    \`,
    [registry.dispatch_campaign_id]
  );

  const normalized = recipients.map(normalizeRecipient);
  const importChunkSize = getImportChunkSize();
  const chunks = chunkRecipientArray(normalized, importChunkSize);
  let importedCount = 0;

  logger.info("snapshot_import.started", {
    tenant_key: registry.tenant_key,
    sendy_campaign_id: registry.sendy_campaign_id,
    dispatch_campaign_id: registry.dispatch_campaign_id,
    audience_snapshot_id: audienceSnapshotId,
    received_recipients: normalized.length,
    chunk_size: importChunkSize,
    chunk_count: chunks.length,
  });

  for (const [index, recipientsChunk] of chunks.entries()) {
    const statement = buildRecipientInsertChunk(
      registry,
      audienceSnapshotId,
      recipientsChunk
    );
    const insertResult = await client.query(statement.text, statement.values);
    importedCount += Number(insertResult.rowCount || 0);

    logger.info("snapshot_import.chunk_completed", {
      tenant_key: registry.tenant_key,
      sendy_campaign_id: registry.sendy_campaign_id,
      dispatch_campaign_id: registry.dispatch_campaign_id,
      audience_snapshot_id: audienceSnapshotId,
      chunk_number: index + 1,
      chunk_size: recipientsChunk.length,
      chunk_imported: Number(insertResult.rowCount || 0),
      imported_recipients: importedCount,
      received_recipients: normalized.length,
      duplicate_recipients: Math.max(normalized.length - importedCount, 0),
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
  });

  return importedCount;
}`;

  return source.replace(original, replacement);
}

function transformServerSource(source) {
  let next = source;
  next = injectHelpers(next);
  next = injectBulkInsertImplementation(next);
  return next;
}

const originalJsLoader = Module._extensions['.js'];

Module._extensions['.js'] = function patchedJsLoader(module, filename) {
  if (!filename.endsWith(targetSuffix)) {
    return originalJsLoader(module, filename);
  }

  const raw = fs.readFileSync(filename, 'utf8');
  const transformed = transformServerSource(raw);
  return module._compile(transformed, filename);
};
