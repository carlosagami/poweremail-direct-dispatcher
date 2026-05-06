#!/usr/bin/env node
'use strict';

const { loadConfig } = require('./config');
const { createControlPlaneDb } = require('./db');

function parseArgs(argv) {
  let dispatchCampaignId = null;
  let sendyCampaignId = null;
  let audit = false;
  let json = false;
  let prepareDryRun = false;
  let apply = false;
  let confirmPrepareDryRun = false;

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];

    if (token === '--audit') {
      audit = true;
      continue;
    }

    if (token === '--json') {
      json = true;
      continue;
    }

    if (token === '--prepare-dry-run') {
      prepareDryRun = true;
      continue;
    }

    if (token === '--apply') {
      apply = true;
      continue;
    }

    if (token === '--confirm-prepare-dry-run') {
      confirmPrepareDryRun = true;
      continue;
    }

    if (token === '--dispatch-campaign-id') {
      const value = argv[i + 1];
      if (!value) {
        throw new Error('Missing value for --dispatch-campaign-id');
      }

      dispatchCampaignId = Number(value);
      i += 1;
      continue;
    }

    if (token === '--sendy-campaign-id') {
      const value = argv[i + 1];
      if (!value) {
        throw new Error('Missing value for --sendy-campaign-id');
      }

      sendyCampaignId = Number(value);
      i += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${token}`);
  }

  if (!audit) {
    audit = true;
  }

  if (dispatchCampaignId != null && (!Number.isInteger(dispatchCampaignId) || dispatchCampaignId <= 0)) {
    throw new Error('--dispatch-campaign-id must be a positive integer');
  }

  if (sendyCampaignId != null && (!Number.isInteger(sendyCampaignId) || sendyCampaignId <= 0)) {
    throw new Error('--sendy-campaign-id must be a positive integer');
  }

  if (dispatchCampaignId == null && sendyCampaignId == null) {
    throw new Error('Either --dispatch-campaign-id or --sendy-campaign-id is required');
  }

  if (dispatchCampaignId != null && sendyCampaignId != null) {
    throw new Error('Use only one of --dispatch-campaign-id or --sendy-campaign-id');
  }

  return {
    dispatchCampaignId,
    sendyCampaignId,
    audit,
    json,
    prepareDryRun,
    apply,
    confirmPrepareDryRun,
  };
}

function rowsToMap(rows) {
  const map = {};

  for (const row of rows) {
    const key = row.key || '(null)';
    map[key] = Number(row.count);
  }

  return map;
}

function totalFromMap(map) {
  return Object.values(map).reduce((sum, value) => sum + Number(value || 0), 0);
}

function toNumberOrNull(value) {
  if (value == null) {
    return null;
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    return value;
  }

  return parsed;
}

function normalizeRegistry(row) {
  if (!row) {
    return null;
  }

  return {
    ...row,
    dispatch_campaign_id: toNumberOrNull(row.dispatch_campaign_id),
    tenant_id: toNumberOrNull(row.tenant_id),
    sendy_campaign_id: toNumberOrNull(row.sendy_campaign_id),
    content_snapshot_id: toNumberOrNull(row.content_snapshot_id),
    audience_snapshot_id: toNumberOrNull(row.audience_snapshot_id),
  };
}

function normalizeDispatchQueue(dispatchQueue) {
  if (!dispatchQueue.exists || !dispatchQueue.row) {
    return dispatchQueue;
  }

  return {
    exists: true,
    row: {
      ...dispatchQueue.row,
      dispatch_id: toNumberOrNull(dispatchQueue.row.dispatch_id),
      dispatch_campaign_id: toNumberOrNull(dispatchQueue.row.dispatch_campaign_id),
      tenant_id: toNumberOrNull(dispatchQueue.row.tenant_id),
    },
  };
}

async function fetchRegistry(db, dispatchCampaignId) {
  const result = await db.query(
    `
      SELECT
        dispatch_campaign_id,
        tenant_id,
        tenant_key,
        sendy_campaign_id,
        campaign_state,
        direct_dispatch_state,
        content_snapshot_id,
        audience_snapshot_id,
        created_at,
        updated_at
      FROM control_plane.sendy_campaign_registry
      WHERE dispatch_campaign_id = $1
      LIMIT 1
    `,
    [dispatchCampaignId]
  );

  return result.rows[0] || null;
}

async function fetchRegistryBySendyCampaignId(db, sendyCampaignId) {
  const result = await db.query(
    `
      SELECT
        dispatch_campaign_id,
        tenant_id,
        tenant_key,
        sendy_campaign_id,
        campaign_state,
        direct_dispatch_state,
        content_snapshot_id,
        audience_snapshot_id,
        created_at,
        updated_at
      FROM control_plane.sendy_campaign_registry
      WHERE sendy_campaign_id = $1
      ORDER BY dispatch_campaign_id DESC
      LIMIT 2
    `,
    [sendyCampaignId]
  );

  if (result.rows.length > 1) {
    throw new Error(`Multiple registry rows found for sendy_campaign_id=${sendyCampaignId}`);
  }

  return result.rows[0] || null;
}

async function fetchGroupedCounts(db, tableName, stateColumn, dispatchCampaignId) {
  const allowedTables = new Set([
    'campaign_recipient_queue',
    'campaign_delivery_batches',
  ]);

  const allowedColumns = new Set([
    'recipient_state',
    'batch_state',
  ]);

  if (!allowedTables.has(tableName)) {
    throw new Error(`Unsafe table name: ${tableName}`);
  }

  if (!allowedColumns.has(stateColumn)) {
    throw new Error(`Unsafe state column: ${stateColumn}`);
  }

  const result = await db.query(
    `
      SELECT
        ${stateColumn} AS key,
        count(*)::int AS count
      FROM control_plane.${tableName}
      WHERE dispatch_campaign_id = $1
      GROUP BY ${stateColumn}
      ORDER BY ${stateColumn}
    `,
    [dispatchCampaignId]
  );

  const byState = rowsToMap(result.rows);

  return {
    total: totalFromMap(byState),
    byState,
  };
}

async function fetchAttemptSummary(db, dispatchCampaignId) {
  const byResultCodeResult = await db.query(
    `
      SELECT
        result_code AS key,
        count(*)::int AS count
      FROM control_plane.campaign_delivery_attempts
      WHERE dispatch_campaign_id = $1
      GROUP BY result_code
      ORDER BY result_code
    `,
    [dispatchCampaignId]
  );

  const byExecutionModeResult = await db.query(
    `
      SELECT
        execution_mode AS key,
        count(*)::int AS count
      FROM control_plane.campaign_delivery_attempts
      WHERE dispatch_campaign_id = $1
      GROUP BY execution_mode
      ORDER BY execution_mode
    `,
    [dispatchCampaignId]
  );

  const byResultCode = rowsToMap(byResultCodeResult.rows);
  const byExecutionMode = rowsToMap(byExecutionModeResult.rows);

  return {
    total: totalFromMap(byResultCode),
    byResultCode,
    byExecutionMode,
  };
}

async function fetchDispatchQueue(db, dispatchCampaignId) {
  const result = await db.query(
    `
      SELECT
        dispatch_id,
        dispatch_campaign_id,
        tenant_id,
        flow_type,
        queue_state,
        queue_priority,
        scheduled_for,
        not_before,
        started_at,
        finished_at,
        attempt_count,
        last_error_code,
        last_error_message,
        requested_msgs_per_second,
        created_at,
        updated_at
      FROM control_plane.campaign_dispatch_queue
      WHERE dispatch_campaign_id = $1
      ORDER BY dispatch_id DESC
      LIMIT 1
    `,
    [dispatchCampaignId]
  );

  const row = result.rows[0] || null;

  return {
    exists: Boolean(row),
    row,
  };
}

function buildWarnings(context) {
  const warnings = [];

  if (context.config.executionMode !== 'dry-run') {
    warnings.push('Environment is not in dry-run mode.');
  }

  if (context.config.maxMsgsPerSecond > 1.25) {
    warnings.push('maxMsgsPerSecond is above the safe threshold of 1.25.');
  }

  if (context.config.maxRecipientsPerRun > 250) {
    warnings.push('maxRecipientsPerRun is above the recommended early-stage threshold of 250.');
  }

  if (!context.registry) {
    warnings.push('Campaign registry row was not found.');
    return warnings;
  }

  if (!context.registry.content_snapshot_id) {
    warnings.push('content_snapshot_id is missing.');
  }

  if (!context.registry.audience_snapshot_id) {
    warnings.push('audience_snapshot_id is missing.');
  }

  if (context.recipients.total === 0) {
    warnings.push('No recipients were found.');
  }

  if (context.batches.total === 0) {
    warnings.push('No batches were found.');
  }

  if ((context.recipients.byState.sent || 0) > 0) {
    warnings.push('Campaign already has sent recipients.');
  }

  if ((context.recipients.byState.sending || 0) > 0) {
    warnings.push('Campaign has recipients currently marked sending.');
  }

  if ((context.recipients.byState.failed || 0) > 0) {
    warnings.push('Campaign has failed recipients.');
  }

  if ((context.batches.byState.running || 0) > 0) {
    warnings.push('Campaign has running batches.');
  }

  if ((context.batches.byState.failed || 0) > 0) {
    warnings.push('Campaign has failed batches.');
  }

  if (context.registry.direct_dispatch_state === 'completed') {
    warnings.push('Campaign direct_dispatch_state is completed.');
  }

  if (context.dispatchQueue.exists && context.dispatchQueue.row.queue_state === 'completed') {
    warnings.push('Dispatch queue is already completed.');
  }

  warnings.push('Sendy may still show Draft; do not press Send in Sendy.');

  return warnings;
}

function buildVerdict(context) {
  if (!context.registry) {
    return 'BLOCKED_CAMPAIGN_NOT_FOUND';
  }

  if (context.config.executionMode !== 'dry-run') {
    return 'BLOCKED_ENV_NOT_DRY_RUN';
  }

  if (context.config.maxMsgsPerSecond > 1.25) {
    return 'BLOCKED_RATE_TOO_HIGH';
  }

  if (!context.registry.content_snapshot_id) {
    return 'BLOCKED_NO_CONTENT_SNAPSHOT';
  }

  if (!context.registry.audience_snapshot_id) {
    return 'BLOCKED_NO_AUDIENCE_SNAPSHOT';
  }

  if (context.recipients.total === 0) {
    return 'BLOCKED_NO_RECIPIENTS';
  }

  if (context.batches.total === 0) {
    return 'BLOCKED_NO_BATCHES';
  }

  if ((context.recipients.byState.sent || 0) > 0) {
    return 'BLOCKED_ALREADY_SENT';
  }

  if (context.registry.direct_dispatch_state === 'completed') {
    return 'BLOCKED_COMPLETED_CAMPAIGN';
  }

  if ((context.recipients.byState.sending || 0) > 0) {
    return 'AMBIGUOUS_STATE';
  }

  if ((context.batches.byState.running || 0) > 0) {
    return 'AMBIGUOUS_STATE';
  }

  return 'READY_FOR_DRY_RUN';
}

function buildRecommendation(verdict) {
  const messages = {
    BLOCKED_CAMPAIGN_NOT_FOUND: 'Check the dispatch campaign id in control_plane.',
    BLOCKED_ENV_NOT_DRY_RUN: 'Return .env to dry-run before continuing.',
    BLOCKED_RATE_TOO_HIGH: 'Lower maxMsgsPerSecond to 1.25 or less.',
    BLOCKED_NO_CONTENT_SNAPSHOT: 'Run intake again or inspect missing content snapshot.',
    BLOCKED_NO_AUDIENCE_SNAPSHOT: 'Run audience resolution again or inspect missing audience snapshot.',
    BLOCKED_NO_RECIPIENTS: 'Resolve audience before preparing dispatch.',
    BLOCKED_NO_BATCHES: 'Run batch-planner before preparing dispatch.',
    BLOCKED_ALREADY_SENT: 'This campaign already sent recipients. Use a new campaign for the next test.',
    BLOCKED_COMPLETED_CAMPAIGN: 'This campaign is already completed. Treat it as closed.',
    AMBIGUOUS_STATE: 'Inspect recipients, batches, and queue before preparing anything.',
    READY_FOR_DRY_RUN: 'Campaign looks eligible for dry-run preparation after operator review.',
  };

  return messages[verdict] || 'No recommendation available.';
}

function printCountSection(title, total, byState) {
  console.log(title);
  console.log(`  total: ${total}`);

  const keys = Object.keys(byState);
  if (keys.length === 0) {
    console.log('  (none)');
    return;
  }

  for (const key of keys) {
    console.log(`  ${key}: ${byState[key]}`);
  }
}

function buildPrepareDryRunPlan(context, verdict) {
  const sent = context.recipients.byState.sent || 0;
  const sending = context.recipients.byState.sending || 0;
  const dryRunSent = context.recipients.byState.dry_run_sent || 0;
  const completedBatches = context.batches.byState.completed || 0;
  const runningBatches = context.batches.byState.running || 0;

  const blockers = [];

  if (context.input.apply && !context.input.confirmPrepareDryRun) {
    blockers.push('apply requested without --confirm-prepare-dry-run');
  }

  if (verdict !== 'READY_FOR_DRY_RUN') {
    blockers.push(`audit verdict is ${verdict}`);
  }

  if (sent > 0) {
    blockers.push('campaign has sent recipients');
  }

  if (sending > 0) {
    blockers.push('campaign has recipients currently sending');
  }

  if (runningBatches > 0) {
    blockers.push('campaign has running batches');
  }

  if (context.registry && context.registry.direct_dispatch_state === 'completed') {
    blockers.push('campaign is completed');
  }

  if (context.dispatchQueue.exists && context.dispatchQueue.row.queue_state === 'completed') {
    blockers.push('dispatch queue is completed');
  }

  if (blockers.length > 0) {
    return {
      status: 'blocked',
      blockers,
      plannedChanges: [],
      note: 'No DB state will be modified.',
    };
  }

  const plannedChanges = [
    `recipients dry_run_sent -> batched: ${dryRunSent}`,
    `batches completed -> queued: ${completedBatches}`,
    'registry direct_dispatch_state -> batched',
    'dispatch queue queue_state -> queued',
  ];

  return {
    status: 'ready',
    blockers: [],
    plannedChanges,
    note: 'Plan mode only; no DB state will be modified.',
  };
}

function printPrepareDryRunPlan(plan) {
  console.log('');
  console.log('Prepare dry-run');
  console.log(`  status: ${plan.status}`);

  if (plan.blockers.length > 0) {
    console.log('  blockers:');
    for (const blocker of plan.blockers) {
      console.log(`    - ${blocker}`);
    }
  }

  if (plan.plannedChanges.length > 0) {
    console.log('  plannedChanges:');
    for (const change of plan.plannedChanges) {
      console.log(`    - ${change}`);
    }
  }

  console.log(`  note: ${plan.note}`);
}

function buildReport(context, warnings, verdict) {
  return {
    config: context.config,
    campaign: normalizeRegistry(context.registry),
    recipients: context.recipients,
    batches: context.batches,
    attempts: context.attempts,
    dispatchQueue: normalizeDispatchQueue(context.dispatchQueue),
    warnings,
    verdict,
    recommendation: buildRecommendation(verdict),
  };
}

function printReport(context, warnings, verdict) {
  console.log('PowerEmail Direct Dispatcher Audit');
  console.log('');

  console.log('Config');
  console.log(`  executionMode: ${context.config.executionMode}`);
  console.log(`  maxMsgsPerSecond: ${context.config.maxMsgsPerSecond}`);
  console.log(`  maxRecipientsPerRun: ${context.config.maxRecipientsPerRun}`);
  console.log('');

  console.log('Campaign');
  if (!context.registry) {
    console.log(`  dispatchCampaignId: ${context.input.dispatchCampaignId}`);
    console.log('  registry: not found');
  } else {
    console.log(`  dispatchCampaignId: ${context.registry.dispatch_campaign_id}`);
    console.log(`  sendyCampaignId: ${context.registry.sendy_campaign_id}`);
    console.log(`  tenantId: ${context.registry.tenant_id}`);
    console.log(`  tenantKey: ${context.registry.tenant_key}`);
    console.log(`  campaignState: ${context.registry.campaign_state}`);
    console.log(`  directDispatchState: ${context.registry.direct_dispatch_state}`);
  }
  console.log('');

  if (context.registry) {
    console.log('Snapshots');
    console.log(`  contentSnapshotId: ${context.registry.content_snapshot_id}`);
    console.log(`  audienceSnapshotId: ${context.registry.audience_snapshot_id}`);
    console.log('');
  }

  printCountSection('Recipients', context.recipients.total, context.recipients.byState);
  console.log('');

  printCountSection('Batches', context.batches.total, context.batches.byState);
  console.log('');

  printCountSection('Attempts by resultCode', context.attempts.total, context.attempts.byResultCode);
  console.log('');

  printCountSection('Attempts by executionMode', context.attempts.total, context.attempts.byExecutionMode);
  console.log('');

  console.log('Dispatch queue');
  console.log(`  exists: ${context.dispatchQueue.exists ? 'yes' : 'no'}`);
  if (context.dispatchQueue.exists) {
    console.log(`  queueState: ${context.dispatchQueue.row.queue_state}`);
    console.log(`  attemptCount: ${context.dispatchQueue.row.attempt_count}`);
    console.log(`  requestedMsgsPerSecond: ${context.dispatchQueue.row.requested_msgs_per_second}`);
    if (context.dispatchQueue.row.last_error_code) {
      console.log(`  lastErrorCode: ${context.dispatchQueue.row.last_error_code}`);
    }
    if (context.dispatchQueue.row.last_error_message) {
      console.log(`  lastErrorMessage: ${context.dispatchQueue.row.last_error_message}`);
    }
  }
  console.log('');

  console.log('Warnings');
  if (warnings.length === 0) {
    console.log('  (none)');
  } else {
    for (const warning of warnings) {
      console.log(`  - ${warning}`);
    }
  }
  console.log('');

  console.log('Verdict');
  console.log(`  ${verdict}`);
  console.log('');

  console.log('Recommendation');
  console.log(`  ${buildRecommendation(verdict)}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const db = createControlPlaneDb(config);

  try {
    const registry = args.dispatchCampaignId != null
      ? await fetchRegistry(db, args.dispatchCampaignId)
      : await fetchRegistryBySendyCampaignId(db, args.sendyCampaignId);

    const resolvedDispatchCampaignId = registry
      ? Number(registry.dispatch_campaign_id)
      : args.dispatchCampaignId;

    const recipients = await fetchGroupedCounts(
      db,
      'campaign_recipient_queue',
      'recipient_state',
      resolvedDispatchCampaignId
    );

    const batches = await fetchGroupedCounts(
      db,
      'campaign_delivery_batches',
      'batch_state',
      resolvedDispatchCampaignId
    );

    const attempts = await fetchAttemptSummary(db, resolvedDispatchCampaignId);
    const dispatchQueue = await fetchDispatchQueue(db, resolvedDispatchCampaignId);

    const context = {
      input: args,
      config: {
        executionMode: config.executionMode,
        maxMsgsPerSecond: Number(config.maxMsgsPerSecond),
        maxRecipientsPerRun: Number(config.maxRecipientsPerRun),
      },
      registry,
      recipients,
      batches,
      attempts,
      dispatchQueue,
    };

    const warnings = buildWarnings(context);
    const verdict = buildVerdict(context);

    if (args.json) {
      console.log(JSON.stringify(buildReport(context, warnings, verdict), null, 2));
    } else {
      printReport(context, warnings, verdict);

      if (args.prepareDryRun) {
        const prepareDryRunPlan = buildPrepareDryRunPlan(context, verdict);
        printPrepareDryRunPlan(prepareDryRunPlan);
      }
    }

    process.exitCode = verdict === 'READY_FOR_DRY_RUN' ? 0 : 1;
  } finally {
    if (db && typeof db.close === 'function') {
      await db.close();
    }
  }
}

main().catch((error) => {
  console.error(`[prepare-dispatch-run] ${error.message}`);
  process.exit(1);
});
