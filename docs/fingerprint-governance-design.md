# PowerEmail Fingerprint Governance Design

Date: 2026-06-22
Status: design proposal
Primary repository: `carlosagami/poweremail-direct-dispatcher`

## Executive Summary

PowerEmail should add a Fingerprint Governance layer in the Direct Dispatcher path to reduce artificial deliverability risk from repeated commercial fingerprints across related tenant domains.

The goal is not to prove that Microsoft is blocking because of duplicate content. The goal is to prevent a plausible and operationally expensive risk pattern:

- same or near-identical subject/body/CTA
- related sender domains for the same tenant
- same recipient domain or recipient cohort
- compact time windows
- parent/mirror or standby/reserve traffic that looks coordinated

The first implementation must be observe-only. It must not block or alter active customer sends until production evidence shows which policies are safe to enforce.

## Correct Architectural Placement

Real Sendy campaigns do not pass through the Test Mail Orchestrator. The orchestrator is only one producer of test traffic.

Canonical placement:

```text
Sendy / snapshot producer / Test Orchestrator
        |
        v
POST /handoff/sendy-campaign-snapshot
        |
        v
poweremail-direct-dispatcher
  - tenant resolution
  - content snapshot
  - audience snapshot
  - parent alias / reserve mirror expansion
  - fingerprint governance
        |
        v
control_plane
  - snapshots
  - recipient queue
  - batches
  - fingerprint events/history
        |
        v
relay-executor
  - final policy check
  - personalization
  - per-recipient sender override
        |
        v
smtp-relay-ses
  - tenant-aware identity and transport
  - SES identity / config set / MAIL FROM
  - provider-specific MIME
  - unsubscribe handling
```

The relay may emit evidence, but it must not own campaign-level content policy or variant generation.

## Non-Goals For This Project Stage

This design intentionally excludes:

- Microsoft calibration / EmailClusterId integration
- Deliverability Monitor changes
- automatic rewriting of real campaigns to real leads
- model calls inside `smtp-relay-ses`
- broad blocking of customer production campaigns
- DNS, SES identity, MAIL FROM, unsubscribe, or Submission Bot changes

## Current Repo Surfaces

Relevant current files:

```text
src/server.js
src/relay-executor.js
src/test-mail-orchestrator.js
src/campaign-intake.js
src/config.js
sql/001_direct_dispatch_schema.sql
docs/architecture.md
```

Current important behavior:

- `/handoff/sendy-campaign-snapshot` receives campaign and recipients.
- `server.js` resolves tenant by requested tenant key and can override by sender.
- `server.js` writes content snapshots, audience snapshots, recipient queue, batches and dispatch queue.
- `server.js` creates pinned parent alias and reserve mirror dispatches for test automation.
- Parent alias and reserve mirror dispatches currently inherit the original campaign content unless changed before snapshot creation.
- `relay-executor.js` loads a content snapshot and batched recipients, personalizes subject/text/html, applies per-recipient sender overrides, then submits to `smtp-relay-ses`.
- `test-mail-orchestrator.js` already generates automated test copy and posts into the same handoff endpoint.

## Proposed Components

### 1. FingerprintGuard module

New module family inside Direct Dispatcher:

```text
src/fingerprint/normalizer.js
src/fingerprint/fingerprint.js
src/fingerprint/policy.js
src/fingerprint/history.js
src/fingerprint/index.js
```

Responsibilities:

- normalize subject, plain text and HTML-derived text
- extract URL domains / link families when available
- compute deterministic fingerprints
- infer send type and domain role from registry, campaign source metadata and sender domain
- compare against recent history
- emit policy decision events
- return a decision for the current snapshot or recipient send

Initial decisions:

```text
allow_original
dry_run_warn
require_variant
block_duplicate
skip_policy_disabled
```

Initial reasons:

```text
primary_campaign_original
same_content_same_tenant_recent
same_content_same_recipient_domain_recent
exact_parent_mirror_clone
missing_required_metadata
policy_observe_only
policy_disabled
```

### 2. Control plane schema

Additive SQL only.

Proposed first table:

```sql
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
```

Suggested indexes:

```sql
CREATE INDEX IF NOT EXISTS idx_fingerprint_events_tenant_created
  ON control_plane.fingerprint_policy_events (tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_fingerprint_events_content_recent
  ON control_plane.fingerprint_policy_events (tenant_id, content_fingerprint, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_fingerprint_events_recipient_domain_recent
  ON control_plane.fingerprint_policy_events (tenant_id, recipient_domain, content_fingerprint, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_fingerprint_events_campaign_recent
  ON control_plane.fingerprint_policy_events (tenant_id, campaign_fingerprint, created_at DESC);
```

A later phase may add a compact `fingerprint_send_history` table or materialized view if event volume becomes high.

### 3. Policy configuration

Start with environment flags to avoid blocking production unexpectedly:

```text
FINGERPRINT_GOVERNANCE_MODE=disabled|observe_only|enforce
FINGERPRINT_GOVERNANCE_ENFORCE_REASONS=exact_parent_mirror_clone
FINGERPRINT_GOVERNANCE_WINDOW_HOURS=24
FINGERPRINT_GOVERNANCE_REQUIRE_METADATA=false
```

Recommended initial production mode:

```text
FINGERPRINT_GOVERNANCE_MODE=observe_only
```

### 4. Integration in `server.js`

Add observe-only calls around snapshot creation:

- original campaign content snapshot
- pinned parent alias content snapshot
- reserve mirror content snapshot

The function should evaluate before or immediately after `createContentSnapshot()` so the event can store `content_snapshot_id` when available.

High-value first detection:

```text
original campaign content -> parent alias content -> reserve mirror content
```

Reserve mirror is the first likely enforcement target because it can copy the same content while changing sender domain.

### 5. Integration in `relay-executor.js`

Add final pre-send policy check before `transporter.sendMail()`.

This is important because `relay-executor.js` sees:

- personalized subject/text/html
- recipient email and recipient domain
- per-recipient sender override from `custom_fields_json`
- final from domain before SMTP relay

Initial behavior in observe mode:

- emit recipient-level fingerprint event for sampled or all sends, depending config
- do not block

Later enforce behavior:

- block only reasons explicitly listed in `FINGERPRINT_GOVERNANCE_ENFORCE_REASONS`
- mark recipient as `skipped` or dispatch as failed with a clear policy code, not a generic SMTP error

Suggested result code:

```text
FINGERPRINT_POLICY_BLOCKED
```

### 6. Interaction With Test Mail Orchestrator

The orchestrator remains a producer. It should not own the canonical policy.

Add richer `campaign.source_json` metadata:

```json
{
  "source_system": "poweremail-test-automation",
  "send_type": "campaign_test_probe",
  "slot_id": "2026-06-22:shopology:3",
  "scheduled_for_local": "2026-06-22T10:30:00",
  "recipient_cohort_id": "shopology:2026-06-22:slot-3",
  "copy_source": "ai",
  "copy_topic": "seguimiento comercial",
  "allow_content_mutation": true
}
```

Later, the orchestrator can generate variants for no-primary probes, but the dispatcher must validate and record the policy decision.

## Fingerprint Strategy

Initial deterministic fingerprints:

```text
subject_fingerprint
body_fingerprint
url_fingerprint
content_fingerprint
campaign_fingerprint
```

Normalization rules:

- lowercase
- trim and collapse whitespace
- strip HTML tags into text
- remove tracking-only fragments where safely detectable
- normalize common prefixes like `re:` and `fw:` from subject
- hash normalized values with SHA-256

Do not use semantic embeddings in the first production step. Deterministic fingerprints are easier to audit and safer for rollout.

## Initial Policy Matrix

| Scenario | Observe result | First enforce result |
|---|---|---|
| Real campaign from primary | `allow_original` | `allow_original` |
| Test parent alias clone | `dry_run_warn` if same fingerprint repeats | later decision |
| Reserve mirror exact clone | `dry_run_warn exact_parent_mirror_clone` | `block_duplicate` |
| Same content to same recipient_domain from another domain | `dry_run_warn` | later decision |
| Missing metadata in observe mode | `dry_run_warn missing_required_metadata` | later decision |
| Missing metadata in strict enforce mode | `block_duplicate` or `policy_missing_metadata` | future |

## Rollout Plan

### Phase 0 - Design and review

This document.

Exit criteria:

- architecture placement agreed
- data model agreed
- no-go and rollback criteria agreed
- first PR scope limited to dry-run

### Phase 1 - Dry-run fingerprints

Scope:

- add SQL table and indexes
- add fingerprint module
- add observe-only integration in `server.js`
- optionally add observe-only recipient-level events in `relay-executor.js`
- add logs and minimal tests

No behavior change:

- no blocks
- no variants
- no relay changes

Exit criteria:

- production can run with `FINGERPRINT_GOVERNANCE_MODE=observe_only`
- events are created for handoffs
- exact parent/mirror clone risks are visible
- no customer sends are blocked or altered

### Phase 2 - Narrow enforcement

Scope:

- enforce only `exact_parent_mirror_clone`
- start with Test Orchestrator traffic only
- leave real campaigns in observe mode

Exit criteria:

- mirror clone blocks are clear and auditable
- parent sends continue normally
- dispatch queue states remain understandable
- rollback is one env var back to `observe_only`

### Phase 3 - Full governance metadata

Scope:

- improve `send_type`, `domain_role`, `recipient_cohort_id`, `parent_fingerprint`
- improve recipient-domain comparisons
- optionally add `receiver_provider` if available cheaply

Exit criteria:

- policy reports distinguish real campaigns, test probes, parent aliases and reserve mirrors
- no-primary risk is visible before variant generation

### Phase 4 - Variant support for probes only

Scope:

- variants for no-primary probes only
- no automatic mutation of real campaign sends to real leads
- add local similarity validator
- retry generation only before queueing, not inside the relay

Exit criteria:

- standby/reserve probes can send approved variants
- exact clone risk is reduced without losing inbox probe value
- every transformed send has `variant_id`, `parent_fingerprint` and `decision_reason`

## Safety Rules

- Default to `disabled` or `observe_only`.
- Never block real campaigns in the first production rollout.
- Never call a model from `smtp-relay-ses`.
- Never mutate content after it reaches the relay.
- Never treat a deploy as closure; require observable events and queue health.
- Keep rollback to one environment variable whenever possible.

## No-Go Conditions

Do not enable enforcement if any of these are true:

- fingerprint events are missing for normal handoffs
- tenant resolution is ambiguous
- parent/mirror relationship cannot be identified
- event volume or latency affects handoff stability
- blocked sends would surface as generic SMTP failures
- rollback path is not tested

## First Implementation PR Scope

The next PR after this design should be limited to dry-run:

```text
sql/002_fingerprint_governance.sql
src/fingerprint/normalizer.js
src/fingerprint/fingerprint.js
src/fingerprint/policy.js
src/fingerprint/history.js
src/fingerprint/index.js
src/server.js integration
src/config.js flags
minimal tests or node --check validation
```

Recommended first PR title:

```text
Add observe-only fingerprint governance
```

Recommended first production mode:

```text
FINGERPRINT_GOVERNANCE_MODE=observe_only
```

## Review Questions

Before coding the dry-run PR, confirm:

1. Is `/handoff/sendy-campaign-snapshot` the only live path for real campaign launches?
2. Should initial event volume record one event per content snapshot, one per recipient, or content snapshots plus sampled recipient-level events?
3. Should first enforcement block mirror dispatch creation or allow creation but skip execution?
4. Should blocked recipients use `recipient_state='skipped'` or should the whole dispatch fail?
5. Do we want `receiver_provider` in phase 1, or defer it until after deterministic recipient-domain reporting?
