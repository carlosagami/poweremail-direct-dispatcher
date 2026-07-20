# Relay Executor Latency And Heartbeat Plan

Date: July 20, 2026

## Objective

Instrument `relay-executor` so the next pacing bottleneck can be measured directly instead of inferred from coarse progress checkpoints.

This plan is the next code step after:

- PR 49: live streaming of child executor logs from `worker_loop`
- PR 50: operational runbook for rate precedence, reset behavior, and rolling throughput checks

## Problem confirmed in production

On July 20, 2026, production logs confirmed that:

- `max_msgs_per_second=3.5`
- `max_msgs_per_second_source=env_force`
- batches were starting correctly
- rolling throughput still stayed around 1,680 to 1,900 recipients per hour on larger batches

This means the next question is no longer whether the dispatcher picked up the rate.

The next question is where time is actually spent inside the loop.

## Current limitation

Today, `relay-executor` logs batch progress only at:

- first recipient
- every N recipients
- batch completion

That is enough to confirm liveness, but not enough to answer:

- how long each `sendMail` call takes
- how much time is spent sleeping for pacing
- whether SMTP pool settings are helping in practice
- whether downstream latency, not rate config, is the real bottleneck

## Proposed instrumentation

### 1. Per-send timing

For each recipient send attempt, measure at least:

- `send_duration_ms`
- `sleep_duration_ms`
- `loop_duration_ms`

Recommended log event:

- `relay_executor.recipient_timing`

Recommended fields:

- `dispatch_campaign_id`
- `batch_key`
- `delivery_batch_id`
- `delivery_attempt_id`
- `recipient_queue_id`
- `recipient_email`
- `send_duration_ms`
- `sleep_duration_ms`
- `loop_duration_ms`
- `sent_so_far`
- `planned`

Sampling guidance:

- do not emit for every recipient by default if volume is too high
- emit for first recipient
- emit every 25 recipients
- emit on completion
- optionally gate full per-recipient timing behind a dedicated env if needed later

### 2. Periodic batch heartbeat

Add a structured log during long-running SMTP batches.

Recommended log event:

- `relay_executor.batch_heartbeat`

Recommended cadence:

- every `batch_heartbeat_ms`

Recommended fields:

- `dispatch_campaign_id`
- `batch_key`
- `delivery_batch_id`
- `delivery_attempt_id`
- `elapsed_seconds`
- `sent`
- `remaining`
- `planned`
- `recipients_per_hour_overall`
- `last_send_duration_ms`
- `last_sleep_duration_ms`
- `max_msgs_per_second`
- `max_msgs_per_second_source`
- `campaign_requested_msgs_per_second`
- `configured_max_msgs_per_second`
- `forced_max_msgs_per_second`

### 3. Attempt payload enrichment

Extend `campaign_delivery_attempts.payload_json` progress updates so the latest timing context survives even if logs are missed.

Recommended fields to append in progress payloads:

- `elapsed_seconds`
- `recipients_per_hour_overall`
- `last_send_duration_ms`
- `last_sleep_duration_ms`
- `last_loop_duration_ms`

## Expected diagnostic outcomes

After this instrumentation, operators should be able to answer with evidence:

- whether the executor is spending most time in SMTP send latency or in intentional pacing sleep
- whether a raised rate still leaves throughput flat because downstream send latency dominates
- whether larger batch slowdowns correlate with provider behavior rather than dispatcher selection or stale recovery

## Recommended next implementation sequence

1. add timing measurement around `transporter.sendMail()`
2. add heartbeat emission during the running loop
3. enrich progress payloads with timing context
4. redeploy production
5. validate on one larger batch using rolling 60-second throughput plus timing logs

## Validation after implementation

Use this log filter:

```bash
railway logs -s poweremail-direct-dispatcher -e production | rg 'relay_executor.transport_config|relay_executor.batch_started|relay_executor.batch_progress|relay_executor.batch_heartbeat|relay_executor.recipient_timing|relay_executor.batch_completed'
```

Success criteria:

- `batch_heartbeat` appears during long-running batches
- timing logs show whether `send_duration_ms` or `sleep_duration_ms` dominates
- production tuning decisions can be made without inferring send latency from 25-recipient checkpoints alone

## After this step

If timing proves the loop is mostly blocked on downstream send latency, the next code change should evaluate controlled intra-batch concurrency rather than more rate guessing.
