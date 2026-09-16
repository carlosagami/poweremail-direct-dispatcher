"use strict";

const fs = require("fs");
const Module = require("module");
const path = require("path");

const originalJsLoader = Module._extensions[".js"];
const orchestratorSuffix = `${path.sep}src${path.sep}test-mail-orchestrator.js`;
const serverSuffix = `${path.sep}src${path.sep}server.js`;

function replaceOrThrow(source, searchValue, replaceValue, label, filename) {
  if (!source.includes(searchValue)) {
    throw new Error(`shopology recipient coverage guard missing ${label} in ${filename}`);
  }
  return source.replace(searchValue, replaceValue);
}

function transformOrchestratorSource(source, filename) {
  let next = source;

  next = replaceOrThrow(
    next,
    `function recipientCohortConfig() {\n  const config = orchestratorConfig.recipientCohorts || {};`,
    `function recipientCohortConfig(brand = null) {\n  const baseConfig = orchestratorConfig.recipientCohorts || {};\n  const isShopology = brand?.tenantKey === "shopology";\n  const shopologyMin = Number.parseInt(\n    process.env.TEST_ORCHESTRATOR_SHOPOLOGY_RECIPIENTS_PER_SLOT_MIN || "8",\n    10\n  );\n  const shopologyMax = Number.parseInt(\n    process.env.TEST_ORCHESTRATOR_SHOPOLOGY_RECIPIENTS_PER_SLOT_MAX || "10",\n    10\n  );\n  const config = isShopology\n    ? {\n        ...baseConfig,\n        minRecipientsPerSlot: Number.isSafeInteger(shopologyMin) ? shopologyMin : 8,\n        maxRecipientsPerSlot: Number.isSafeInteger(shopologyMax) ? shopologyMax : 10,\n      }\n    : baseConfig;`,
    "recipient cohort config",
    filename
  );

  next = replaceOrThrow(
    next,
    `function selectRecipientsForSlot(recipients, brand, slot, dateText) {\n  const config = recipientCohortConfig();`,
    `function selectRecipientsForSlot(recipients, brand, slot, dateText) {\n  if (brand?.tenantKey === "shopology") {\n    return recipients;\n  }\n\n  const config = recipientCohortConfig(brand);`,
    "Shopology full seed pool selection",
    filename
  );

  return next;
}

function transformServerSource(source, filename) {
  let next = source;

  const helperAnchor = `function isTestAutomationCampaign(campaign) {\n  return campaignSourceJson(campaign).source_system === "poweremail-test-automation";\n}\n`;

  const helpers = `${helperAnchor}\nfunction shopologyDomainSeedsPerRole() {\n  const parsed = Number.parseInt(\n    process.env.TEST_ORCHESTRATOR_SHOPOLOGY_SEEDS_PER_DOMAIN || "3",\n    10\n  );\n  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 3;\n}\n\nfunction isShopologyDomainCoverageCampaign(tenantKey, campaign) {\n  return tenantKey === "shopology" && isTestAutomationCampaign(campaign);\n}\n\nfunction selectShopologyParentGroups(groups, campaign, sendyCampaignId) {\n  const minimum = shopologyDomainSeedsPerRole();\n  const sourceJson = campaignSourceJson(campaign);\n  const splitKey = sourceJson.slot_id || sourceJson.scheduled_for_local || sendyCampaignId;\n  const requiredRoles = new Set(["primary", "standby"]);\n  const selectedGroups = [];\n\n  for (const role of requiredRoles) {\n    const roleGroups = groups.filter((group) => group.sourceRole === role);\n    if (roleGroups.length === 0) {\n      throw httpError(409, \\`Shopology test coverage missing \\${role} seed group\\`);\n    }\n  }\n\n  for (const group of groups) {\n    if (!requiredRoles.has(group.sourceRole)) continue;\n    const recipients = [...(group.recipients || [])];\n    if (recipients.length < minimum) {\n      throw httpError(409, \\`Shopology test coverage needs \\${minimum} seeds for \\${group.senderBucket}; found \\${recipients.length}\\`);\n    }\n\n    const ordered = recipients.sort((a, b) => {\n      const aEmail = normalizedRecipientEmail(a);\n      const bEmail = normalizedRecipientEmail(b);\n      const diff = hashInt(\\`\\${splitKey}:domain-seed:\\${group.senderBucket}:\\${aEmail}\\`) -\n        hashInt(\\`\\${splitKey}:domain-seed:\\${group.senderBucket}:\\${bEmail}\\`);\n      if (diff !== 0) return diff;\n      return aEmail.localeCompare(bEmail);\n    });\n\n    const start = hashInt(\\`\\${splitKey}:domain-seed-start:\\${group.senderBucket}\\`) % ordered.length;\n    const selected = [];\n    for (let index = 0; index < minimum; index += 1) {\n      selected.push(ordered[(start + index) % ordered.length]);\n    }\n\n    selectedGroups.push({ ...group, recipients: selected });\n  }\n\n  return selectedGroups;\n}\n\nfunction assertShopologyDomainCoverage(parentGroups, mirrorGroups) {\n  const minimum = shopologyDomainSeedsPerRole();\n  const roles = ["primary", "standby"];\n\n  for (const role of roles) {\n    const parentCount = parentGroups\n      .filter((group) => group.sourceRole === role)\n      .reduce((sum, group) => sum + (group.recipients || []).length, 0);\n    const mirrorRoleGroups = mirrorGroups.filter((group) => group.sourceRole === role);\n    const mirrorCount = mirrorRoleGroups\n      .reduce((sum, group) => sum + (group.recipients || []).length, 0);\n\n    if (parentCount < minimum || mirrorCount < minimum || mirrorRoleGroups.length === 0) {\n      throw httpError(409, \\`Shopology test coverage incomplete for \\${role}: parent=\\${parentCount}, reserve=\\${mirrorCount}, minimum=\\${minimum}\\`);\n    }\n  }\n\n  const reserveDomains = new Set(mirrorGroups.map((group) => group.reserveDomain).filter(Boolean));\n  if (reserveDomains.size < 2) {\n    throw httpError(409, \\`Shopology test coverage expected 2 reserve domains; found \\${reserveDomains.size}\\`);\n  }\n}\n`;

  next = replaceOrThrow(
    next,
    helperAnchor,
    helpers,
    "Shopology domain coverage helpers",
    filename
  );

  next = replaceOrThrow(
    next,
    `      const registry = await upsertRegistry(client, tenant, sendyCampaignId, effectiveCampaign);\n      const recipientSplit = splitRecipientsForTestMirrors(recipients, effectiveCampaign, sendyCampaignId);\n      const parentGroups = await loadTestLeadParentGroups(\n        client,\n        tenant.tenant_id,\n        recipientSplit.parentRecipients\n      );\n      const mirrorGroups = recipientSplit.mirrorRecipients.length > 0\n        ? await loadTestLeadMirrorGroups(client, tenant.tenant_id, recipientSplit.mirrorRecipients)\n        : [];\n      const pinnedRecipientEmails = new Set();`,
    `      const registry = await upsertRegistry(client, tenant, sendyCampaignId, effectiveCampaign);\n      const shopologyDomainCoverage = isShopologyDomainCoverageCampaign(tenant.tenant_key, effectiveCampaign);\n      const recipientSplit = shopologyDomainCoverage\n        ? { parentRecipients: recipients, mirrorRecipients: [], splitApplied: false }\n        : splitRecipientsForTestMirrors(recipients, effectiveCampaign, sendyCampaignId);\n      let parentGroups = await loadTestLeadParentGroups(\n        client,\n        tenant.tenant_id,\n        recipientSplit.parentRecipients\n      );\n\n      if (shopologyDomainCoverage) {\n        parentGroups = selectShopologyParentGroups(parentGroups, effectiveCampaign, sendyCampaignId);\n      }\n\n      const mirrorRecipients = shopologyDomainCoverage\n        ? parentGroups.flatMap((group) => group.recipients || [])\n        : recipientSplit.mirrorRecipients;\n      const mirrorGroups = mirrorRecipients.length > 0\n        ? await loadTestLeadMirrorGroups(client, tenant.tenant_id, mirrorRecipients)\n        : [];\n\n      if (shopologyDomainCoverage) {\n        assertShopologyDomainCoverage(parentGroups, mirrorGroups);\n      }\n\n      const pinnedRecipientEmails = new Set();`,
    "Shopology domain-aware parent/mirror selection",
    filename
  );

  next = replaceOrThrow(
    next,
    `      const globalRecipients = recipients.filter((recipient) => {\n        const email = normalizedRecipientEmail(recipient);\n        return !pinnedRecipientEmails.has(email);\n      });`,
    `      const globalRecipients = shopologyDomainCoverage\n        ? []\n        : recipients.filter((recipient) => {\n            const email = normalizedRecipientEmail(recipient);\n            return !pinnedRecipientEmails.has(email);\n          });`,
    "Shopology unselected seed suppression",
    filename
  );

  return next;
}

Module._extensions[".js"] = function shopologyRecipientCoverageLoader(module, filename) {
  if (filename.endsWith(orchestratorSuffix)) {
    const raw = fs.readFileSync(filename, "utf8");
    return module._compile(transformOrchestratorSource(raw, filename), filename);
  }

  if (filename.endsWith(serverSuffix)) {
    const raw = fs.readFileSync(filename, "utf8");
    return module._compile(transformServerSource(raw, filename), filename);
  }

  return originalJsLoader(module, filename);
};

module.exports = {
  transformOrchestratorSource,
  transformServerSource,
};
