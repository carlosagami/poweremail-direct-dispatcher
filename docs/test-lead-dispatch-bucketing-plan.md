# Test lead dispatch bucketing improvement

## Problem

Campaign 491 confirmed a dispatcher-side fan-out regression:

- `poweremail-test-parent-alias`: 28 dispatches
- total recipients: 28
- average recipients per dispatch: 1.00
- original `sendy` dispatch was cancelled

This makes sends slow because each test lead pays the full cost of a dispatch registry row, content snapshot, audience snapshot, batch, queue row, worker claim, executor run, SMTP handoff, progress attempt and closeout.

The immediate cause is that `src/server.js` currently groups parent test lead dispatches by `pinned_from_email`. Recent mirror behavior also groups reserve mirrors by `mirror_from_email`, which can create the same fan-out pattern for reserve tests.

## Desired behavior

For a test campaign with primary and standby buckets:

```text
parent primary  -> 1 dispatch with N recipients
parent standby  -> 1 dispatch with N recipients
mirror reserve1 -> 1 dispatch with N recipients
mirror reserve2 -> 1 dispatch with N recipients
```

Expected campaign-level shape for the observed 28-recipient test:

```text
poweremail-test-parent-alias | 2 dispatches | 28 recipients | avg 14.00
```

The improvement must preserve the authorized per-recipient alias without creating one dispatch per alias.

## Design

### 1. Bucket parent groups by domain role/domain

Change `loadTestLeadParentGroups()` so the grouping key is the operational bucket, not the alias:

```js
const key = `${row.role}:${row.pinned_domain}`;
```

Each group should still keep all recipient-specific sender metadata.

### 2. Bucket reserve mirror groups by reserve domain

Change `loadTestLeadMirrorGroups()` so the grouping key is again:

```js
const key = row.reserve_domain;
```

Change `createMirrorRegistry()` source object id back to reserve-domain uniqueness:

```js
const sourceObjectId = `${originalRegistry.sendy_campaign_id}:mirror:${mirrorGroup.reserveDomain}`;
```

This re-aligns with the previous operational rule: one mirror campaign per reserve domain.

### 3. Preserve per-recipient sender identity in custom_fields_json

No schema migration is needed because `control_plane.campaign_recipient_queue.custom_fields_json` already exists as `jsonb`.

When building parent or mirror groups, attach dispatcher metadata to each recipient before insert:

```json
{
  "__poweremail_from_email": "eduardo2@espaciosparaconectar.com",
  "__poweremail_reply_to": "eduardo2@mail.espaciosparaconectar.com",
  "__poweremail_sender_bucket": "primary:espaciosparaconectar.com"
}
```

For reserve mirrors:

```json
{
  "__poweremail_from_email": "eduardo2@servireselcamino.com",
  "__poweremail_reply_to": "eduardo2@mail.servireselcamino.com",
  "__poweremail_sender_bucket": "reserve:servireselcamino.com"
}
```

### 4. Relay executor chooses sender per recipient

In `src/relay-executor.js`, parse `recipient.custom_fields_json` and prefer the per-recipient override when present:

```js
const senderOverride = getRecipientSenderOverride(recipient);
const from = formatFromHeader(content, config.relayFromEmail, senderOverride.fromEmail);
const replyTo = senderOverride.replyTo || content.reply_to || undefined;
```

The fallback path must remain unchanged for normal campaigns.

### 5. Log override usage

Add a compact log when an override is applied:

```text
relay_executor.recipient_sender_override_applied
```

Include dispatch campaign id, batch key, recipient queue id, recipient email and override domain. Do not log secrets.

## Files to change

- `src/server.js`
  - group parent aliases by role/domain
  - group reserve mirrors by reserve domain
  - attach per-recipient sender metadata before insert
  - return compact dispatch groups in handoff response

- `src/relay-executor.js`
  - parse recipient custom fields safely
  - use per-recipient From/Reply-To override when present
  - retain existing fallback behavior

## Validation

### Syntax

```bash
npm run check:execute
node --check src/server.js
```

### SQL shape after a new test campaign

```bash
psql "$PSQL_LEADS_URL" -c "
WITH parent AS (
  SELECT dispatch_campaign_id
  FROM control_plane.sendy_campaign_registry
  WHERE sendy_campaign_id = <SENDY_CAMPAIGN_ID>
  ORDER BY created_at DESC
  LIMIT 1
), related AS (
  SELECT r.*
  FROM control_plane.sendy_campaign_registry r
  WHERE r.dispatch_campaign_id IN (SELECT dispatch_campaign_id FROM parent)
     OR r.source_object_id LIKE '<SENDY_CAMPAIGN_ID>:%'
     OR r.sendy_snapshot_json->>'parent_dispatch_campaign_id' IN (
       SELECT dispatch_campaign_id::text FROM parent
     )
)
SELECT
  r.source_system,
  count(*) AS dispatches,
  sum(a.recipient_count) AS recipients,
  avg(a.recipient_count)::numeric(10,2) AS avg_recipients_per_dispatch
FROM related r
LEFT JOIN control_plane.campaign_audience_snapshots a
  ON a.dispatch_campaign_id = r.dispatch_campaign_id
 AND a.snapshot_state = 'ready'
GROUP BY r.source_system
ORDER BY r.source_system;
"
```

Expected:

```text
poweremail-test-parent-alias <= 2 dispatches
poweremail-test-reserve-mirror <= 2 dispatches
avg_recipients_per_dispatch > 1
```

### Functional close criteria

- no one-recipient dispatch explosion unless a bucket truly has one recipient
- worker completes fewer dispatches for the same test population
- delivered parent messages preserve expected primary/standby From
- delivered mirror messages preserve expected reserve From
- relay send-resolution shows correct SES identity, configuration set and MAIL FROM
- no self-send
- no cross-tenant alias use

## Rollback

Rollback should be one GitHub revert of the implementation PR. No schema rollback is required if metadata is stored in existing `custom_fields_json`.
