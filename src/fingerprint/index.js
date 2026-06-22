"use strict";

const { buildContentFingerprints } = require("./fingerprint");
const { findRecentContentMatch, insertFingerprintEvent } = require("./history");
const { buildSnapshotContext, decideSnapshotPolicy } = require("./policy");

function normalizedMode(config) {
  const mode = String(config.fingerprintGovernanceMode || "disabled").toLowerCase();
  if (["disabled", "observe_only", "enforce"].includes(mode)) return mode;
  return "disabled";
}

async function recordSnapshotFingerprintEvent(client, config, registry, campaign, contentSnapshotId) {
  const mode = normalizedMode(config);
  if (mode === "disabled") {
    return {
      enabled: false,
      policyMode: mode,
      fingerprintEventId: null,
    };
  }

  const windowHours = Number(config.fingerprintGovernanceWindowHours || 24);
  const fingerprints = buildContentFingerprints(campaign);
  const context = buildSnapshotContext(registry, campaign, contentSnapshotId);
  const baseEvent = {
    ...context,
    ...fingerprints,
    policy_mode: mode,
    window_hours: windowHours,
  };

  const related = await findRecentContentMatch(client, baseEvent, windowHours);
  const decision = decideSnapshotPolicy(baseEvent, related, mode);
  const fingerprintEventId = await insertFingerprintEvent(client, {
    ...baseEvent,
    policy_decision: decision.policyDecision,
    decision_reason: decision.decisionReason,
    related_event_id: related?.fingerprint_event_id || null,
    payload_json: {
      related,
      url_domains: fingerprints.url_domains,
      source_json: context.source_json,
    },
  });

  return {
    enabled: true,
    policyMode: mode,
    fingerprintEventId,
    policyDecision: decision.policyDecision,
    decisionReason: decision.decisionReason,
    relatedEventId: related?.fingerprint_event_id || null,
    contentFingerprint: fingerprints.content_fingerprint,
  };
}

module.exports = { recordSnapshotFingerprintEvent };
