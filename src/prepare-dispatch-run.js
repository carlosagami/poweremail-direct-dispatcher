#!/usr/bin/env node
'use strict';

const { loadConfig } = require('./config');
const { createControlPlaneDb } = require('./db');

function parseArgs(argv) {
  let dispatchCampaignId = null;
  let audit = false;

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];

    if (token === '--audit') {
      audit = true;
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

    throw new Error(`Unknown argument: ${token}`);
  }

  if (!audit) {
    audit = true;
  }

  if (!Number.isInteger(dispatchCampaignId) || dispatchCampaignId <= 0) {
    throw new Error('--dispatch-campaign-id must be a positive integer');
  }

  return {
    dispatchCampaignId,
    audit,
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
    const registry = await fetchRegistry(db, args.dispatchCampaignId);

    const recipients = await fetchGroupedCounts(
      db,
      'campaign_recipient_queue',
      'recipient_state',
      args.dispatchCampaignId
    );

    const batches = await fetchGroupedCounts(
      db,
      'campaign_delivery_batches',
      'batch_state',
      args.dispatchCampaignId
    );

    const attempts = await fetchAttemptSummary(db, args.dispatchCampaignId);
    const dispatchQueue = await fetchDispatchQueue(db, args.dispatchCampaignId);

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

    printReport(context, warnings, verdict);

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
