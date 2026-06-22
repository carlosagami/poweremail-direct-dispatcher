"use strict";

function optionalString(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text.length ? text : null;
}

function emailDomain(email) {
  const text = optionalString(email);
  if (!text || !text.includes("@")) return null;
  return text.split("@").pop().toLowerCase();
}

function campaignSourceJson(campaign) {
  const sourceJson = campaign.source_json || campaign.sourceJson || {};
  if (sourceJson && typeof sourceJson === "object" && !Array.isArray(sourceJson)) {
    return sourceJson;
  }

  try {
    const parsed = JSON.parse(String(sourceJson || "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
}

function inferSendType(sourceJson) {
  if (sourceJson.send_type) return String(sourceJson.send_type);
  if (sourceJson.test_reserve_mirror) return "reserve_mirror";
  if (sourceJson.test_parent_alias) return "test_parent_alias";
  if (sourceJson.source_system === "poweremail-test-automation") return "campaign_test_probe";
  return "real_campaign";
}

function inferDomainRole(sourceJson) {
  if (sourceJson.domain_role) return String(sourceJson.domain_role);
  if (sourceJson.test_reserve_mirror) return "reserve";
  if (sourceJson.test_parent_alias && sourceJson.source_role) return String(sourceJson.source_role);
  if (sourceJson.source_role) return String(sourceJson.source_role);
  return "unknown";
}

function buildSnapshotContext(registry, campaign, contentSnapshotId) {
  const sourceJson = campaignSourceJson(campaign);
  const fromEmail = optionalString(campaign.from_email || campaign.fromEmail || registry.from_email);

  return {
    tenant_id: registry.tenant_id || null,
    tenant_key: registry.tenant_key || null,
    dispatch_campaign_id: registry.dispatch_campaign_id || null,
    sendy_campaign_id: registry.sendy_campaign_id || campaign.id || null,
    content_snapshot_id: contentSnapshotId || null,
    source_system:
      optionalString(sourceJson.source_system) ||
      optionalString(registry.source_system) ||
      "sendy",
    source_object_id:
      optionalString(sourceJson.source_object_id) ||
      optionalString(registry.source_object_id) ||
      null,
    send_type: inferSendType(sourceJson),
    domain_role: inferDomainRole(sourceJson),
    from_email: fromEmail,
    from_domain: emailDomain(fromEmail),
    parent_fingerprint: null,
    source_json: sourceJson,
  };
}

function decideSnapshotPolicy(event, related, mode) {
  if (!event.content_fingerprint) {
    return {
      policyDecision: mode === "enforce" ? "block_duplicate" : "dry_run_warn",
      decisionReason: "missing_content_fingerprint",
    };
  }

  if (event.send_type === "reserve_mirror" && related) {
    return {
      policyDecision: mode === "enforce" ? "block_duplicate" : "dry_run_warn",
      decisionReason: "exact_parent_mirror_clone",
    };
  }

  if (related) {
    return {
      policyDecision: "dry_run_warn",
      decisionReason: "same_content_same_tenant_recent",
    };
  }

  return {
    policyDecision: "allow_original",
    decisionReason: "no_recent_content_match",
  };
}

module.exports = { buildSnapshotContext, decideSnapshotPolicy };
