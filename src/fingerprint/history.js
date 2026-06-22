"use strict";

async function findRecentContentMatch(client, event, windowHours) {
  if (!event.tenant_id || !event.content_fingerprint) return null;

  const result = await client.query(
    `
    SELECT
      fingerprint_event_id,
      dispatch_campaign_id,
      source_system,
      send_type,
      domain_role,
      from_domain,
      content_fingerprint,
      policy_decision,
      decision_reason,
      created_at
    FROM control_plane.fingerprint_policy_events
    WHERE tenant_id = $1
      AND content_fingerprint = $2
      AND created_at >= now() - ($3::int * interval '1 hour')
      AND COALESCE(dispatch_campaign_id, -1) <> COALESCE($4::bigint, -1)
    ORDER BY created_at DESC
    LIMIT 1
    `,
    [
      event.tenant_id,
      event.content_fingerprint,
      windowHours,
      event.dispatch_campaign_id || null,
    ]
  );

  return result.rows[0] || null;
}

async function insertFingerprintEvent(client, event) {
  const result = await client.query(
    `
    INSERT INTO control_plane.fingerprint_policy_events (
      tenant_id, tenant_key, dispatch_campaign_id, sendy_campaign_id,
      content_snapshot_id, recipient_queue_id, source_system, source_object_id,
      send_type, domain_role, from_email, from_domain, recipient_email,
      recipient_domain, receiver_provider, canonical_recipient_group,
      subject_fingerprint, body_fingerprint, url_fingerprint,
      content_fingerprint, campaign_fingerprint, parent_fingerprint,
      policy_mode, policy_decision, decision_reason, related_event_id,
      payload_json, expires_at
    )
    VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8,
      $9, $10, $11, $12, $13, $14, $15, $16,
      $17, $18, $19, $20, $21, $22,
      $23, $24, $25, $26, $27::jsonb,
      now() + ($28::int * interval '1 hour')
    )
    RETURNING fingerprint_event_id
    `,
    [
      event.tenant_id || null,
      event.tenant_key || null,
      event.dispatch_campaign_id || null,
      event.sendy_campaign_id || null,
      event.content_snapshot_id || null,
      event.recipient_queue_id || null,
      event.source_system || null,
      event.source_object_id || null,
      event.send_type || null,
      event.domain_role || null,
      event.from_email || null,
      event.from_domain || null,
      event.recipient_email || null,
      event.recipient_domain || null,
      event.receiver_provider || null,
      event.canonical_recipient_group || null,
      event.subject_fingerprint || null,
      event.body_fingerprint || null,
      event.url_fingerprint || null,
      event.content_fingerprint || null,
      event.campaign_fingerprint || null,
      event.parent_fingerprint || null,
      event.policy_mode || "observe_only",
      event.policy_decision,
      event.decision_reason,
      event.related_event_id || null,
      JSON.stringify(event.payload_json || {}),
      event.window_hours || 24,
    ]
  );

  return result.rows[0]?.fingerprint_event_id || null;
}

module.exports = { findRecentContentMatch, insertFingerprintEvent };
