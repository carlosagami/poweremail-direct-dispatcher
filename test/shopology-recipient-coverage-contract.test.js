"use strict";

// P0 regression contract. Tests run against synthetically generated recipients
// without importing the network/DB/SMTP entrypoints. No AUTH, DATA or SES.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  transformOrchestratorSource,
  transformServerSource,
} = require("../src/test-mail-shopology-recipient-coverage-guard");

function sourceFile(name) {
  return fs.readFileSync(path.join(__dirname, "..", "src", name), "utf8");
}

function isolatedFunction(source, functionName, nextFunction, dependencies) {
  const start = source.indexOf("function " + functionName + "(");
  assert.ok(start >= 0, "missing " + functionName);
  const stop = source.indexOf("\nfunction " + nextFunction + "(", start);
  assert.ok(stop > start, "missing boundary before " + nextFunction);
  // Only a deliberately extracted pure function is evaluated. This never
  // loads server.js or orchestrator.js and cannot create a network client.
  return new Function(
    ...Object.keys(dependencies),
    source.slice(start, stop) + "\nreturn " + functionName + ";"
  )(...Object.values(dependencies));
}

function hashInt(value) {
  let h = 0;
  for (const char of String(value)) h = (Math.imul(h, 31) + char.charCodeAt(0)) >>> 0;
  return h >>> 0;
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

const allRecipients = Array.from({ length: 29 }, (_, index) => ({
  email: "seed" + String(index + 1).padStart(2, "0") + "@synthetic.invalid",
}));
const slot = { slotIndex: 1, slotId: "2026-11-08:shopology:synthetic" };
const dateText = "2026-11-08";
const cohortDependencies = {
  recipientCohortConfig: () => ({ enabled: true, minRecipientsPerSlot: 1, maxRecipientsPerSlot: 2 }),
  hashInt,
};

test("Shopology runtime must load all seed candidates; unpatched 1-2 sampling reproduces failure", () => {
  const plain = sourceFile("test-mail-orchestrator.js");
  const transformed = transformOrchestratorSource(plain, "src/test-mail-orchestrator.js");
  const unpatchedSelector = isolatedFunction(plain, "selectRecipientsForSlot", "isWeekendDateText", cohortDependencies);
  const patchedSelector = isolatedFunction(transformed, "selectRecipientsForSlot", "isWeekendDateText", cohortDependencies);

  const oldCohort = unpatchedSelector(allRecipients, { tenantKey: "shopology" }, slot, dateText);
  assert.ok(oldCohort.length >= 1 && oldCohort.length <= 2, "fixture must reproduce old 1-2 limit");
  const currentCohort = patchedSelector(allRecipients, { tenantKey: "shopology" }, slot, dateText);
  assert.strictEqual(currentCohort, allRecipients, "Shopology must retain entire input pool before pinning");

  // Other tenants retain the deliberately small test cohort.
  const other = patchedSelector(allRecipients, { tenantKey: "lester" }, slot, dateText);
  assert.ok(other.length >= 1 && other.length <= 2, "other brands must not get a wider audience");
});

test("Server coverage guard requires primary AND standby, at least 3 distinct seeds each", () => {
  const transformed = transformServerSource(sourceFile("server.js"), "src/server.js");
  const select = isolatedFunction(
    transformed,
    "selectShopologyParentGroups",
    "assertShopologyDomainCoverage",
    {
      shopologyDomainSeedsPerRole: () => 3,
      campaignSourceJson: () => ({ slot_id: slot.slotId }),
      hashInt,
      normalizedRecipientEmail: (recipient) => String(recipient.email || "").toLowerCase(),
      httpError,
    }
  );

  const primary = { sourceRole: "primary", senderBucket: "primary:synthetic.invalid",
    recipients: allRecipients.slice(0, 5) };
  const standby = { sourceRole: "standby", senderBucket: "standby:synthetic.invalid",
    recipients: allRecipients.slice(5, 10) };
  const groups = select([primary, standby], {}, "synthetic-123");
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map((group) => group.recipients.length), [3, 3]);
  for (const group of groups) {
    assert.equal(new Set(group.recipients.map((r) => r.email)).size, 3, "must not repeat a seed");
  }

  assert.throws(
    () => select([standby], {}, "synthetic-123"),
    (err) => err.status === 409 && /missing primary seed group/.test(err.message),
    "missing primary role is a hard conflict, never a warning"
  );
  assert.throws(
    () => select([{ ...primary, recipients: primary.recipients.slice(0, 1) }, standby], {}, "synthetic-123"),
    (err) => err.status === 409 && /needs 3 seeds/.test(err.message),
    "one recipient cannot pass Shopology per-domain coverage"
  );
});

test("Reserve mirroring remains fail-closed per role and requires two distinct domains", () => {
  const transformed = transformServerSource(sourceFile("server.js"), "src/server.js");
  const assertCoverage = isolatedFunction(
    transformed,
    "assertShopologyDomainCoverage",
    "splitRecipientsForTestMirrors",
    { shopologyDomainSeedsPerRole: () => 3, httpError }
  );
  const parent = [
    { sourceRole: "primary", recipients: allRecipients.slice(0, 3) },
    { sourceRole: "standby", recipients: allRecipients.slice(3, 6) },
  ];
  const mirrors = [
    { sourceRole: "primary", reserveDomain: "reserve-primary.synthetic.invalid",
      recipients: allRecipients.slice(0, 3) },
    { sourceRole: "standby", reserveDomain: "reserve-standby.synthetic.invalid",
      recipients: allRecipients.slice(3, 6) },
  ];
  assert.doesNotThrow(() => assertCoverage(parent, mirrors));
  assert.throws(
    () => assertCoverage(parent, mirrors.slice(0, 1)),
    (err) => err.status === 409 && /incomplete for standby/.test(err.message)
  );
  assert.throws(
    () => assertCoverage(parent, [
      { ...mirrors[0], reserveDomain: "single.synthetic.invalid" },
      { ...mirrors[1], reserveDomain: "single.synthetic.invalid" },
    ]),
    (err) => err.status === 409 && /expected 2 reserve domains/.test(err.message)
  );
});
