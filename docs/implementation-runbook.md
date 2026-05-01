# Direct Dispatcher Implementation Runbook

## Phase 0

- Keep current traffic controller in place.
- Keep current Sendy hooks in `observe_only`.
- Do not use the bridge as the long-term path.

## Phase 1: Schema

Apply:

```bash
psql "$CONTROL_PLANE_DATABASE_URL" -f sql/001_direct_dispatch_schema.sql
```

## Phase 2: Campaign intake

Run for one approved campaign:

```bash
DIRECT_DISPATCHER_TENANT_KEY=shopology \
DIRECT_DISPATCHER_SENDY_CAMPAIGN_ID=332 \
npm run intake
```

Expected outcome:

- row in `control_plane.sendy_campaign_registry`
- row in `control_plane.campaign_content_snapshots`
- campaign state `approved`

## Phase 3: Audience snapshot

```bash
DIRECT_DISPATCHER_SENDY_CAMPAIGN_ID=332 npm run resolve
```

Expected outcome:

- row in `control_plane.campaign_audience_snapshots`
- recipients in `control_plane.campaign_recipient_queue`
- no duplicates for the same campaign + email

## Phase 4: Batch planning

```bash
DIRECT_DISPATCHER_SENDY_CAMPAIGN_ID=332 \
DIRECT_DISPATCHER_BATCH_SIZE=250 \
npm run plan-batches
```

Expected outcome:

- rows in `control_plane.campaign_delivery_batches`
- recipient rows move from `queued` to `batched`

## Phase 5: Executor dry-run

```bash
DIRECT_DISPATCHER_SENDY_CAMPAIGN_ID=332 \
DIRECT_DISPATCHER_EXECUTION_MODE=dry-run \
npm run execute
```

Expected outcome:

- rows in `control_plane.campaign_delivery_attempts`
- batch state changes to `completed`
- recipient rows move to `dry_run_sent`

## Phase 6: Executor live pilot

Only after dry-run is stable:

```bash
DIRECT_DISPATCHER_SENDY_CAMPAIGN_ID=332 \
DIRECT_DISPATCHER_EXECUTION_MODE=smtp-relay \
npm run execute
```

## Verification queries

### Registry

```sql
SELECT dispatch_campaign_id, tenant_key, sendy_campaign_id, campaign_state, updated_at
FROM control_plane.sendy_campaign_registry
ORDER BY dispatch_campaign_id DESC
LIMIT 20;
```

### Audience snapshot

```sql
SELECT audience_snapshot_id, dispatch_campaign_id, snapshot_state, recipient_count, created_at
FROM control_plane.campaign_audience_snapshots
ORDER BY audience_snapshot_id DESC
LIMIT 20;
```

### Batches

```sql
SELECT delivery_batch_id, dispatch_campaign_id, batch_state, batch_size, started_at, finished_at
FROM control_plane.campaign_delivery_batches
ORDER BY delivery_batch_id DESC
LIMIT 20;
```

### Attempts

```sql
SELECT delivery_attempt_id, delivery_batch_id, result_status, result_code, created_at
FROM control_plane.campaign_delivery_attempts
ORDER BY delivery_attempt_id DESC
LIMIT 50;
```

## Rollback

- Stop the executor.
- Leave Sendy native scheduling active only if direct broadcast has not cut over.
- Mark the campaign as `failed` or `cancelled` in `control_plane`.
- Keep audience snapshot and attempt records for postmortem.
