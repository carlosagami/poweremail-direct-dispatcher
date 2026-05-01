BEGIN;

CREATE SCHEMA IF NOT EXISTS control_plane;

ALTER TABLE control_plane.sendy_campaign_registry
  ADD COLUMN IF NOT EXISTS direct_dispatch_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS content_snapshot_id bigint,
  ADD COLUMN IF NOT EXISTS audience_snapshot_id bigint,
  ADD COLUMN IF NOT EXISTS direct_dispatch_state text NOT NULL DEFAULT 'pending'
    CHECK (direct_dispatch_state IN ('pending', 'snapshotted', 'batched', 'running', 'completed', 'failed', 'cancelled'));

CREATE TABLE IF NOT EXISTS control_plane.campaign_content_snapshots (
  content_snapshot_id     bigserial PRIMARY KEY,
  dispatch_campaign_id    bigint NOT NULL
                         REFERENCES control_plane.sendy_campaign_registry(dispatch_campaign_id) ON DELETE CASCADE,
  tenant_id               bigint NOT NULL
                         REFERENCES control_plane.tenants(tenant_id) ON DELETE CASCADE,
  sendy_campaign_id       bigint NOT NULL,
  subject                 text,
  from_name               text,
  from_email              text,
  reply_to                text,
  plain_text              text,
  html_text               text,
  query_string            text,
  opens_tracking          boolean,
  links_tracking          boolean,
  web_version_lang        text,
  snapshot_state          text NOT NULL DEFAULT 'ready'
                         CHECK (snapshot_state IN ('ready', 'superseded')),
  source_json             jsonb NOT NULL,
  created_at              timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_campaign_content_snapshots_campaign
  ON control_plane.campaign_content_snapshots (dispatch_campaign_id, snapshot_state)
  WHERE snapshot_state = 'ready';

CREATE TABLE IF NOT EXISTS control_plane.campaign_audience_snapshots (
  audience_snapshot_id    bigserial PRIMARY KEY,
  dispatch_campaign_id    bigint NOT NULL
                         REFERENCES control_plane.sendy_campaign_registry(dispatch_campaign_id) ON DELETE CASCADE,
  tenant_id               bigint NOT NULL
                         REFERENCES control_plane.tenants(tenant_id) ON DELETE CASCADE,
  sendy_campaign_id       bigint NOT NULL,
  snapshot_state          text NOT NULL DEFAULT 'ready'
                         CHECK (snapshot_state IN ('ready', 'superseded', 'failed')),
  recipient_count         integer NOT NULL DEFAULT 0,
  source_filters_json     jsonb NOT NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_campaign_audience_snapshots_campaign
  ON control_plane.campaign_audience_snapshots (dispatch_campaign_id, snapshot_state)
  WHERE snapshot_state = 'ready';

CREATE TABLE IF NOT EXISTS control_plane.campaign_recipient_queue (
  recipient_queue_id      bigserial PRIMARY KEY,
  dispatch_campaign_id    bigint NOT NULL
                         REFERENCES control_plane.sendy_campaign_registry(dispatch_campaign_id) ON DELETE CASCADE,
  audience_snapshot_id    bigint NOT NULL
                         REFERENCES control_plane.campaign_audience_snapshots(audience_snapshot_id) ON DELETE CASCADE,
  tenant_id               bigint NOT NULL
                         REFERENCES control_plane.tenants(tenant_id) ON DELETE CASCADE,
  sendy_campaign_id       bigint NOT NULL,
  sendy_subscriber_id     bigint NOT NULL,
  sendy_list_id           bigint,
  email                   text NOT NULL,
  subscriber_name         text,
  custom_fields_json      jsonb,
  recipient_state         text NOT NULL DEFAULT 'queued'
                         CHECK (
                           recipient_state IN (
                             'queued',
                             'batched',
                             'sending',
                             'sent',
                             'dry_run_sent',
                             'failed',
                             'skipped'
                           )
                         ),
  batch_key               text,
  last_error_code         text,
  last_error_message      text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_campaign_recipient_queue_campaign_email
  ON control_plane.campaign_recipient_queue (dispatch_campaign_id, email);

CREATE INDEX IF NOT EXISTS idx_campaign_recipient_queue_pick
  ON control_plane.campaign_recipient_queue (dispatch_campaign_id, recipient_state, sendy_subscriber_id);

CREATE TABLE IF NOT EXISTS control_plane.campaign_delivery_batches (
  delivery_batch_id       bigserial PRIMARY KEY,
  dispatch_campaign_id    bigint NOT NULL
                         REFERENCES control_plane.sendy_campaign_registry(dispatch_campaign_id) ON DELETE CASCADE,
  audience_snapshot_id    bigint NOT NULL
                         REFERENCES control_plane.campaign_audience_snapshots(audience_snapshot_id) ON DELETE CASCADE,
  tenant_id               bigint NOT NULL
                         REFERENCES control_plane.tenants(tenant_id) ON DELETE CASCADE,
  batch_key               text NOT NULL,
  flow_type               text NOT NULL DEFAULT 'broadcast'
                         CHECK (flow_type IN ('broadcast')),
  batch_state             text NOT NULL DEFAULT 'queued'
                         CHECK (batch_state IN ('queued', 'reserved', 'running', 'completed', 'failed', 'cancelled')),
  batch_size              integer NOT NULL,
  reserved_by             text,
  started_at              timestamptz,
  finished_at             timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_campaign_delivery_batches_batch_key
  ON control_plane.campaign_delivery_batches (dispatch_campaign_id, batch_key);

CREATE INDEX IF NOT EXISTS idx_campaign_delivery_batches_pick
  ON control_plane.campaign_delivery_batches (dispatch_campaign_id, batch_state, created_at);

CREATE TABLE IF NOT EXISTS control_plane.campaign_delivery_attempts (
  delivery_attempt_id     bigserial PRIMARY KEY,
  delivery_batch_id       bigint NOT NULL
                         REFERENCES control_plane.campaign_delivery_batches(delivery_batch_id) ON DELETE CASCADE,
  dispatch_campaign_id    bigint NOT NULL
                         REFERENCES control_plane.sendy_campaign_registry(dispatch_campaign_id) ON DELETE CASCADE,
  tenant_id               bigint NOT NULL
                         REFERENCES control_plane.tenants(tenant_id) ON DELETE CASCADE,
  attempt_no              integer NOT NULL,
  executor_id             text,
  execution_mode          text NOT NULL,
  result_status           text NOT NULL CHECK (result_status IN ('ok', 'warn', 'error')),
  result_code             text,
  result_message          text,
  payload_json            jsonb,
  created_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_campaign_delivery_attempts_batch
  ON control_plane.campaign_delivery_attempts (delivery_batch_id, created_at DESC);

COMMIT;
