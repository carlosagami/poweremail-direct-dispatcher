BEGIN;

CREATE SCHEMA IF NOT EXISTS control_plane;

CREATE TABLE IF NOT EXISTS control_plane.fingerprint_policy_events (
  fingerprint_event_id bigserial PRIMARY KEY,
  tenant_id bigint REFERENCES control_plane.tenants(tenant_id) ON DELETE SET NULL,
  tenant_key text,
  dispatch_campaign_id bigint,
  sendy_campaign_id bigint,
  content_snapshot_id bigint,
  recipient_queue_id bigint,
  source_system text,
  source_object_id text,
  send_type text,
  domain_role text,
  from_email text,
  from_domain text,
  recipient_email text,
  recipient_domain text,
  receiver_provider text,
  canonical_recipient_group text,
  subject_fingerprint text,
  body_fingerprint text,
  url_fingerprint text,
  content_fingerprint text,
  campaign_fingerprint text,
  parent_fingerprint text,
  policy_mode text NOT NULL DEFAULT 'observe_only',
  policy_decision text NOT NULL,
  decision_reason text NOT NULL,
  related_event_id bigint,
  payload_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fingerprint_events_tenant_created
  ON control_plane.fingerprint_policy_events (tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_fingerprint_events_content_recent
  ON control_plane.fingerprint_policy_events (tenant_id, content_fingerprint, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_fingerprint_events_recipient_domain_recent
  ON control_plane.fingerprint_policy_events (tenant_id, recipient_domain, content_fingerprint, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_fingerprint_events_campaign_recent
  ON control_plane.fingerprint_policy_events (tenant_id, campaign_fingerprint, created_at DESC);

COMMIT;
