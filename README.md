# PowerEmail Direct Dispatcher Pack

This pack is the next implementation step for the robust path:

- Sendy remains editorial UI only.
- `control_plane` becomes the source of truth for campaign state.
- The direct dispatcher owns intake, audience snapshot, batching and execution.
- Delivery goes to the tenant-aware relay instead of returning to Sendy for launch.

## What is included

- `docs/architecture.md`: target architecture and component responsibilities
- `docs/implementation-runbook.md`: rollout sequence and operator checklist
- `sql/001_direct_dispatch_schema.sql`: additive schema for direct broadcast dispatch
- `src/campaign-intake.js`: copies an approved Sendy campaign into `control_plane`
- `src/audience-resolver.js`: snapshots the audience outside Sendy and seeds recipient queue
- `src/batch-planner.js`: groups queued recipients into delivery batches
- `src/relay-executor.js`: executes batches in `dry-run` or `smtp-relay` mode

## Recommended order

1. Apply `sql/001_direct_dispatch_schema.sql`
2. Run `campaign-intake.js` for one pilot campaign
3. Run `audience-resolver.js`
4. Run `batch-planner.js`
5. Run `relay-executor.js` in `dry-run`
6. Validate outputs in `control_plane`
7. Switch executor to `smtp-relay` for a single pilot tenant

## Rate precedence

The dispatcher now supports an explicit operational override for pacing.

Relevant envs:

- `DIRECT_DISPATCHER_MAX_MSGS_PER_SECOND`: service-level default pacing
- `DIRECT_DISPATCHER_FORCE_MAX_MSGS_PER_SECOND`: emergency override that wins over campaign-level pacing

Effective precedence during execution:

1. `DIRECT_DISPATCHER_FORCE_MAX_MSGS_PER_SECOND`
2. `control_plane.campaign_dispatch_queue.requested_msgs_per_second`
3. `DIRECT_DISPATCHER_MAX_MSGS_PER_SECOND`

This is meant for live operational recovery when a campaign queue row is already persisted with an outdated pacing value.

## Live diagnostics

The dispatcher now emits executor logs in real time from the worker loop instead of waiting for process exit.

New observability behavior:

- `worker_loop` forwards child stdout and stderr lines as first-class logs
- `relay_executor.transport_config` remains the canonical source for effective pacing resolution and SMTP pool settings

This is meant to shorten live diagnosis when a batch looks stalled, under-paced, or falsely orphaned.

## Notes

- This pack intentionally targets `broadcast` first.
- `drip` should remain on the existing controller path until direct broadcast is stable.
- The scripts assume Sendy still stores the authoritative campaign/editorial data and audience membership in MySQL.
