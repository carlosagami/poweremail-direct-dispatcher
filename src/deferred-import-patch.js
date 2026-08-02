"use strict";

const fs = require("fs");
const Module = require("module");
const path = require("path");

const originalExtension = Module._extensions[".js"];
const serverTarget = `${path.sep}src${path.sep}server.js`;
const relayTarget = `${path.sep}src${path.sep}relay-executor.js`;

function replaceOrThrow(source, searchValue, replaceValue, label, filename) {
  if (!source.includes(searchValue)) {
    throw new Error(`deferred-import patch missing ${label} in ${filename}`);
  }
  return source.replace(searchValue, replaceValue);
}

Module._extensions[".js"] = function patchedExtension(module, filename) {
  let content = fs.readFileSync(filename, "utf8");

  if (filename.endsWith(serverTarget)) {
    content = replaceOrThrow(
      content,
      'const { generateFingerprintVariant } = require("./fingerprint/variant-generator");',
      'const { generateFingerprintVariant } = require("./fingerprint/variant-generator");\nconst { buildDeferredImportSourceFilters } = require("./deferred-import-runtime");',
      "server runtime require",
      filename
    );

    content = replaceOrThrow(
      content,
      `      if (globalRecipients.length > 0) {
        const contentSnapshot = await createContentSnapshot(client, registry, effectiveCampaign, config);
        contentSnapshotId = contentSnapshot.contentSnapshotId;
        audienceSnapshotId = await createAudienceSnapshot(client, registry, effectiveCampaign, globalRecipients);
        recipientCount = await insertRecipients(client, registry, audienceSnapshotId, globalRecipients);
        batchCount = await createBatches(client, registry, audienceSnapshotId, batchSize);
        dispatchQueue = await ensureDispatchQueue(client, registry, config);
      }
`,
      `      if (globalRecipients.length > 0) {
        const contentSnapshot = await createContentSnapshot(client, registry, effectiveCampaign, config);
        contentSnapshotId = contentSnapshot.contentSnapshotId;
        audienceSnapshotId = await createAudienceSnapshot(
          client,
          registry,
          {
            ...effectiveCampaign,
            source_filters: buildDeferredImportSourceFilters(
              effectiveCampaign,
              globalRecipients,
              batchSize,
              {
                import_scope: "global",
                requested_tenant_key: requestedTenant.tenant_key,
              }
            ),
          },
          globalRecipients
        );
        recipientCount = globalRecipients.length;
        batchCount = 0;
        dispatchQueue = "deferred";
      }
`,
      "server global deferred import block",
      filename
    );

    content = replaceOrThrow(
      content,
      `        const parentAudienceSnapshotId = await createAudienceSnapshot(
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
`,
      `        const parentAudienceSnapshotId = await createAudienceSnapshot(
          client,
          parentRegistry,
          {
            ...parentCampaign,
            source_filters: buildDeferredImportSourceFilters(
              parentCampaign,
              parentGroup.recipients,
              batchSize,
              {
                import_scope: "parent_alias",
                parent_dispatch_campaign_id: Number(registry.dispatch_campaign_id),
                source_role: parentGroup.sourceRole,
              }
            ),
          },
          parentGroup.recipients
        );
        const parentRecipientCount = parentGroup.recipients.length;
        const parentBatchCount = 0;
        const parentDispatchQueue = "deferred";
`,
      "server parent deferred import block",
      filename
    );

    content = replaceOrThrow(
      content,
      `        const mirrorAudienceSnapshotId = await createAudienceSnapshot(
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
`,
      `        const mirrorAudienceSnapshotId = await createAudienceSnapshot(
          client,
          mirrorRegistry,
          {
            ...mirrorCampaign,
            source_filters: buildDeferredImportSourceFilters(
              mirrorCampaign,
              mirrorGroup.recipients,
              batchSize,
              {
                import_scope: "reserve_mirror",
                parent_dispatch_campaign_id: Number(registry.dispatch_campaign_id),
                reserve_domain: mirrorGroup.reserveDomain,
                source_role: mirrorGroup.sourceRole,
              }
            ),
          },
          mirrorGroup.recipients
        );
        const mirrorRecipientCount = mirrorGroup.recipients.length;
        const mirrorBatchCount = 0;
        const mirrorDispatchQueue = "deferred";
`,
      "server mirror deferred import block",
      filename
    );
  }

  if (filename.endsWith(relayTarget)) {
    content = replaceOrThrow(
      content,
      'const { personalizeText } = require("./personalize");',
      'const { personalizeText } = require("./personalize");\nconst { claimNextDeferredImportJob, processDeferredImportJob } = require("./deferred-import-runtime");',
      "relay runtime require",
      filename
    );

    content = replaceOrThrow(
      content,
      `    batch = hasExplicitCampaign
      ? await loadBatchByCampaign(cpDb, config.sendyCampaignId, config.tenantKey)
      : await claimNextQueuedBatch(cpDb, config.staleBatchTimeoutMs);
`,
      `    if (!hasExplicitCampaign) {
      const deferredImportJob = await claimNextDeferredImportJob(cpDb);
      if (deferredImportJob) {
        const importResult = await processDeferredImportJob(cpDb, config, deferredImportJob);
        logger.info("relay_executor.deferred_import_completed", importResult);
        return;
      }
    }

    batch = hasExplicitCampaign
      ? await loadBatchByCampaign(cpDb, config.sendyCampaignId, config.tenantKey)
      : await claimNextQueuedBatch(cpDb, config.staleBatchTimeoutMs);
`,
      "relay deferred import claim block",
      filename
    );
  }

  module._compile(content, filename);
};

module.exports = { originalExtension };
