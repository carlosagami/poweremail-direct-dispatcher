"use strict";

const fs = require("fs");
const Module = require("module");
const path = require("path");

const originalJsLoader = Module._extensions[".js"];
const targetSuffix = `${path.sep}src${path.sep}test-mail-orchestrator.js`;

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
    `function selectRecipientsForSlot(recipients, brand, slot, dateText) {\n  const config = recipientCohortConfig(brand);`,
    "brand-aware recipient selection",
    filename
  );

  return next;
}

Module._extensions[".js"] = function shopologyRecipientCoverageLoader(module, filename) {
  if (!filename.endsWith(targetSuffix)) {
    return originalJsLoader(module, filename);
  }

  const raw = fs.readFileSync(filename, "utf8");
  const transformed = transformOrchestratorSource(raw, filename);
  return module._compile(transformed, filename);
};

module.exports = { transformOrchestratorSource };
