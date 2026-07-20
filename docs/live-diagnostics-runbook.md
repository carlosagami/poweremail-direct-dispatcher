# Dispatcher Live Diagnostics Runbook

This runbook is for live operational diagnosis of broadcast pacing in `poweremail-direct-dispatcher`.

It focuses on four recurring questions:

1. which pacing value is actually in effect
2. whether the worker is using newly changed variables yet
3. whether the running batch needs a reset to pick up new pacing
4. whether the real bottleneck is dispatcher pacing or downstream SMTP throughput

## Source of truth for effective pacing

At runtime, effective pacing is resolved in this order:

1. `DIRECT_DISPATCHER_FORCE_MAX_MSGS_PER_SECOND`
2. `control_plane.campaign_dispatch_queue.requested_msgs_per_second`
3. `DIRECT_DISPATCHER_MAX_MSGS_PER_SECOND`

Implication:

- changing only `DIRECT_DISPATCHER_MAX_MSGS_PER_SECOND` does not win if a queue row already has `requested_msgs_per_second`
- `DIRECT_DISPATCHER_FORCE_MAX_MSGS_PER_SECOND` is the emergency operational override when the queue row is already persisted with an outdated rate

## First validation

Always validate both layers before diagnosing throughput:

```sql
SELECT
  dispatch_campaign_id,
  queue_state,
  requested_msgs_per_second,
  started_at,
  finished_at,
  updated_at
FROM control_plane.campaign_dispatch_queue
WHERE dispatch_campaign_id = 3234;
```

```bash
railway variable list -s poweremail-direct-dispatcher -e production -k | rg 'DIRECT_DISPATCHER_(FORCE_MAX_MSGS_PER_SECOND|MAX_MSGS_PER_SECOND|SMTP_POOL_ENABLED|SMTP_MAX_CONNECTIONS|SMTP_MAX_MESSAGES|PROGRESS_EVERY_N_RECIPIENTS|BATCH_HEARTBEAT_MS|MAX_RECIPIENTS_PER_RUN)'
```

## Live log validation after PR 49

After the live-log improvement merged on July 20, 2026, Railway should show executor telemetry while the batch is still running.

Use:

```bash
railway logs -s poweremail-direct-dispatcher -e production | rg 'worker_loop.started|relay_executor.transport_config|relay_executor.batch_started|relay_executor.batch_progress|relay_executor.batch_completed|orphaned_batch_recovery'
```

What to look for:

- `relay_executor.transport_config`
- `max_msgs_per_second`
- `max_msgs_per_second_source`
- `campaign_requested_msgs_per_second`
- `configured_max_msgs_per_second`
- `forced_max_msgs_per_second`

Real success criterion:

- those lines must appear before `worker_loop.executor_completed`
- if they appear only after process exit, live diagnosis is still incomplete

## Important rule when changing pacing

Changing variables alone is not enough for the currently running batch.

A running batch has already started with a resolved pacing context. After changing any of these:

- `DIRECT_DISPATCHER_MAX_MSGS_PER_SECOND`
- `DIRECT_DISPATCHER_FORCE_MAX_MSGS_PER_SECOND`
- `requested_msgs_per_second` in `campaign_dispatch_queue`

reset the current running batch so the next run starts with the new pacing.

## Safe reset of the current running batch

```sql
BEGIN;

WITH running_batch AS (
  SELECT batch_key
  FROM control_plane.campaign_delivery_batches
  WHERE dispatch_campaign_id = 3234
    AND batch_state = 'running'
  ORDER BY delivery_batch_id DESC
  LIMIT 1
)
UPDATE control_plane.campaign_recipient_queue rq
   SET recipient_state = 'batched',
       updated_at = now()
  FROM running_batch rb
 WHERE rq.dispatch_campaign_id = 3234
   AND rq.batch_key = rb.batch_key
   AND rq.recipient_state = 'sending';

WITH running_batch AS (
  SELECT batch_key
  FROM control_plane.campaign_delivery_batches
  WHERE dispatch_campaign_id = 3234
    AND batch_state = 'running'
  ORDER BY delivery_batch_id DESC
  LIMIT 1
)
UPDATE control_plane.campaign_delivery_batches b
   SET batch_state = 'queued',
       started_at = NULL,
       updated_at = now()
  FROM running_batch rb
 WHERE b.dispatch_campaign_id = 3234
   AND b.batch_key = rb.batch_key
   AND b.batch_state = 'running';

COMMIT;
```

## Validate current running batch state

```sql
SELECT
  b.delivery_batch_id,
  b.batch_key,
  b.batch_state,
  b.started_at,
  b.updated_at,
  now() - b.updated_at AS idle_for,
  count(*) FILTER (WHERE rq.recipient_state = 'sent') AS sent,
  count(*) FILTER (WHERE rq.recipient_state = 'sending') AS sending,
  count(*) FILTER (WHERE rq.recipient_state = 'batched') AS batched
FROM control_plane.campaign_delivery_batches b
LEFT JOIN control_plane.campaign_recipient_queue rq
  ON rq.dispatch_campaign_id = b.dispatch_campaign_id
 AND rq.batch_key = b.batch_key
WHERE b.dispatch_campaign_id = 3234
  AND b.batch_state = 'running'
GROUP BY 1,2,3,4,5
ORDER BY b.delivery_batch_id DESC;
```

## Do not use average-since-start as the main speed metric

This query is useful for historical batch comparison:

- `sent / (now - started_at)`

But it decays over time and is misleading during slow starts, resets, retries, or partially completed batches.

For live operations, prefer the rolling 60-second window.

## Real throughput query for live diagnosis

```sql
WITH current_batch AS (
  SELECT batch_key
  FROM control_plane.campaign_delivery_batches
  WHERE dispatch_campaign_id = 3234
    AND batch_state = 'running'
  ORDER BY delivery_batch_id DESC
  LIMIT 1
),
recent AS (
  SELECT count(*) AS sent_last_60s
  FROM control_plane.campaign_recipient_queue rq
  JOIN current_batch cb ON cb.batch_key = rq.batch_key
  WHERE rq.dispatch_campaign_id = 3234
    AND rq.recipient_state = 'sent'
    AND rq.updated_at >= now() - interval '60 seconds'
)
SELECT
  sent_last_60s,
  sent_last_60s * 60 AS recipients_per_hour_last_60s
FROM recent;
```

Interpretation:

- this is the best live estimate of current effective throughput
- if this is low while `transport_config.max_msgs_per_second` is high, the next bottleneck is probably downstream SMTP or provider latency
- if this is low and `transport_config.max_msgs_per_second` is also low, the limiter is still dispatcher-side pacing

## Recommended live diagnosis sequence

1. confirm service restart with `worker_loop.started`
2. inspect env variables
3. inspect `campaign_dispatch_queue.requested_msgs_per_second`
4. reset the current running batch if pacing changed
5. confirm `relay_executor.transport_config` on the next batch start
6. measure rolling 60-second throughput
7. only then decide whether to tune dispatcher vars or inspect downstream SMTP relay behavior

## Recurrent failure modes

### Variable changed but throughput did not change

Most likely causes:

- running batch was not reset
- queue row still had old `requested_msgs_per_second`
- no `DIRECT_DISPATCHER_FORCE_MAX_MSGS_PER_SECOND` was set for emergency override

### Batch looks stalled but is not orphaned

Most likely causes:

- logs were previously buffered until executor exit
- average-since-start metric made throughput look worse than the current minute
- SMTP transport is progressing slowly but still healthy

### Batch gets requeued as stale

Check:

- whether `updated_at` was being refreshed
- whether `relay_executor.batch_progress` is visible live
- whether the worker actually restarted mid-batch
- whether downstream SMTP latency is so high that only heartbeats prove liveness

## Next structural improvement after this runbook

If live logs show the effective pacing clearly but throughput still remains far below target, the next improvement should move to downstream relay behavior rather than more dispatcher rate guessing.

That next layer usually means inspecting:

- SMTP connection reuse effectiveness
- provider-side latency per send
- relay-side bottlenecks outside `poweremail-direct-dispatcher`
