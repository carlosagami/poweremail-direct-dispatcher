# Defender Controlled Sampling Runbook

Temporary operating mode for PowerEmail automated deliverability tests when Microsoft Defender starts correlating repeated test traffic as `Threats found` / `Advanced filter` while SPF, DKIM, DMARC and CompAuth pass.

## Scope

This runbook covers the Test Mail Orchestrator only.

It does not approve changes to:

- Submission Bot core logic
- Microsoft Graph permissions
- credentials
- historical logs or reports

## Current temporary limits

The temporary code defaults are:

- weekdays: 1-2 slots per brand
- weekends: 1 slot per brand
- recipient cohorts: 1-2 recipients per slot

With 5 configured brands, expected volume is:

- weekdays: 5-10 planned slots per day
- weekends: 5 planned slots per day
- weekdays recipient exposure: 5-20 recipient deliveries per day
- weekends recipient exposure: 5-10 recipient deliveries per day

## Pre-production dry-run

Run plan mode before approving production:

```bash
TEST_ORCHESTRATOR_MODE=plan \
TEST_ORCHESTRATOR_COPY_MODE=local \
TEST_ORCHESTRATOR_FORCE_NOW=false \
npm run orchestrate:test
```

Expected evidence:

- `mode=plan`
- no `handoff_completed`
- `sendVolume.weekdays.minPerBrand=1`
- `sendVolume.weekdays.maxPerBrand=2`
- or on weekend, `sendVolume.weekends.minPerBrand=1` and `maxPerBrand=1`
- `recipientCohorts.minRecipientsPerSlot=1`
- `recipientCohorts.maxRecipientsPerSlot=2`

## Production approval

Approve merge/deploy only after dry-run confirms the expected plan and no handoff occurred.

After deployment, do not use repeated `TEST_ORCHESTRATOR_FORCE_NOW=true` runs unless validating one specific code path. Prefer normal cron evidence.

## Submission sampling policy

Do not submit every Junk or Quarantine clone automatically during this experiment.

Use representative samples by fingerprint group:

- from domain
- sender email
- sender IP
- SES configuration set or account when available
- Feedback-ID
- MAIL FROM domain
- Return-Path domain
- subject family
- copy fingerprint
- URL domains
- link count
- recipient mailbox

Recommended cap:

- start with 1 submission per fingerprint group
- allow up to 3 only when there is meaningful variation
- wait for Microsoft result before submitting another message from the same group

## Required reporting dimensions

Evaluate the experiment over 48-72 hours using:

- Inbox vs Junk
- `Threats found` rate
- `Advanced filter` rate
- SCL, BCL, SFV and CAT
- sender IP
- from domain
- Feedback-ID or SES configuration set
- copy fingerprint
- URL domains and link count
- recipient mailbox

## Rollback

Revert the temporary config to the previous defaults:

```text
weekdays: 9-11 slots per brand
weekends: 3-6 slots per brand
recipient cohorts: 3-5 recipients per slot
```

Rollback is complete only after a plan-mode run shows the restored values. Do not use restored volume as proof that Microsoft placement improved.
