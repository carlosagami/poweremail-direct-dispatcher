# PowerEmail Test Mail Orchestrator MVP

This MVP generates legitimate brand-context test emails for each tenant and hands them to the existing Direct Dispatcher snapshot endpoint.

## Safety defaults

- Default mode is `plan`; it does not create snapshots or send.
- `handoff` mode requires `DIRECT_DISPATCHER_HANDOFF_TOKEN`.
- It reuses `/handoff/sendy-campaign-snapshot`, so parent aliases, reserve mirrors, batches, queueing and relay behavior stay in the existing dispatcher path.
- Mirror aliases must preserve the same local address and change only the reserve domain.

## Config

Brand config lives in:

```text
config/test-orchestrator.js
```

Operational Test lists:

```text
colonyspaces: 49
decosimil: 50
georgieboy: 51
lester: 52
shopology: 45
```

## Plan mode

```bash
npm run orchestrate:test
```

Optional single tenant:

```bash
TEST_ORCHESTRATOR_TENANT=colonyspaces npm run orchestrate:test
```

## Handoff mode

Use a low limit first:

```bash
TEST_ORCHESTRATOR_MODE=handoff \
TEST_ORCHESTRATOR_TENANT=colonyspaces \
TEST_ORCHESTRATOR_LIMIT=1 \
TEST_ORCHESTRATOR_FORCE_NOW=true \
TEST_ORCHESTRATOR_DISPATCHER_URL="$DIRECT_DISPATCHER_URL" \
npm run orchestrate:test
```

## Closure criteria

After a handoff, validate:

```text
poweremail-test-parent-alias grouped by primary/standby bucket
poweremail-test-reserve-mirror grouped by reserve_domain
dispatcher-reserve-sender-preserved in relay logs
From / Return-Path / DKIM / SPF / DMARC match expected domains
```
