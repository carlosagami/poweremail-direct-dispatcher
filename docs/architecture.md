# Direct Dispatcher Architecture

## Goal

Remove Sendy from the scheduling path for `broadcast` campaigns while keeping Sendy as editorial UI.

## Final flow

1. A campaign is created and approved in Sendy.
2. Intake copies campaign metadata and content snapshot into `control_plane`.
3. Audience resolver calculates the exact audience outside Sendy and freezes it in a snapshot.
4. Batch planner creates delivery batches sized for the pilot tenant policy.
5. Executor sends those batches to the tenant-aware relay.
6. Relay remains responsible for sender identity, domain, config set and SES routing.
7. Delivery attempts, batch status and campaign status are tracked in `control_plane`.

## What Sendy still does

- editorial UI
- campaign editing
- list and segment management
- audience source data

## What Sendy stops doing for direct broadcast

- campaign scheduling
- dispatch ordering
- launch simultaneity decisions
- owning the active delivery loop

## Components

### Campaign Intake

Reads a single approved Sendy campaign and writes:

- `control_plane.sendy_campaign_registry`
- `control_plane.campaign_content_snapshots`

### Audience Resolver

Reads the Sendy campaign filters and writes:

- `control_plane.campaign_audience_snapshots`
- `control_plane.campaign_recipient_queue`

### Batch Planner

Groups queued recipients into:

- `control_plane.campaign_delivery_batches`

### Relay Executor

Consumes one batch at a time and writes:

- `control_plane.campaign_delivery_attempts`
- recipient-level state back to `campaign_recipient_queue`

## Why this is more robust

- tenant concurrency is no longer hidden inside Sendy's scheduler
- audience is frozen before send, reducing drift during execution
- launch and delivery state become queryable in `control_plane`
- the relay remains the identity-aware sending boundary

## Pilot boundaries

- `broadcast` only
- one tenant first: `shopology`
- `dry-run` first for executor
- then one real relay-backed pilot

## No-Go conditions

- tenant mismatch between campaign and resolved audience
- sender identity mismatch with tenant runtime or active send profile
- inability to snapshot audience without duplicates
- relay unable to preserve tenant identity guarantees
