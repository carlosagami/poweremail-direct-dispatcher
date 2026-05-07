'use strict';

const http = require('http');
const { spawn } = require('child_process');
const { loadConfig } = require('./config');
const { createControlPlaneDb } = require('./db');
const logger = require('./logger');

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';

    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });

    req.on('end', () => {
      if (!body.trim()) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch (err) {
        reject(new Error('Invalid JSON body'));
      }
    });

    req.on('error', reject);
  });
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(statusCode, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
  });
  res.end(body);
}

function runNodeScript(script, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', reject);

    child.on('close', (code) => {
      if (code === 0) {
        resolve({ code, stdout, stderr });
        return;
      }

      const err = new Error(`${script} exited with code ${code}`);
      err.code = code;
      err.stdout = stdout;
      err.stderr = stderr;
      reject(err);
    });
  });
}

function normalizeInteger(value, fieldName) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${fieldName} must be a positive integer`);
  }
  return parsed;
}

function assertAuthorized(req) {
  const expected = process.env.DIRECT_DISPATCHER_HANDOFF_TOKEN;
  if (!expected) {
    throw new Error('DIRECT_DISPATCHER_HANDOFF_TOKEN is not configured');
  }

  const header = req.headers.authorization || '';
  const actual = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';

  if (!actual || actual !== expected) {
    const err = new Error('Unauthorized');
    err.statusCode = 401;
    throw err;
  }
}

async function loadCampaignBySendyId(cpDb, tenantKey, sendyCampaignId) {
  const { rows } = await cpDb.query(
    `
    SELECT
      dispatch_campaign_id,
      sendy_campaign_id,
      tenant_id,
      tenant_key,
      direct_dispatch_state
    FROM control_plane.sendy_campaign_registry
    WHERE tenant_key = $1
      AND sendy_campaign_id = $2
    ORDER BY dispatch_campaign_id DESC
    LIMIT 1
    `,
    [tenantKey, sendyCampaignId]
  );

  return rows[0] || null;
}

async function ensureDispatchQueue(cpDb, campaign, config) {
  const { rows } = await cpDb.query(
    `
    SELECT dispatch_id, queue_state
    FROM control_plane.campaign_dispatch_queue
    WHERE dispatch_campaign_id = $1
    ORDER BY dispatch_id DESC
    `,
    [campaign.dispatch_campaign_id]
  );

  if (rows.length > 1) {
    throw new Error(`Multiple dispatch queue rows found for dispatch_campaign_id=${campaign.dispatch_campaign_id}`);
  }

  if (rows.length === 0) {
    await cpDb.query(
      `
      INSERT INTO control_plane.campaign_dispatch_queue (
        dispatch_campaign_id,
        tenant_id,
        flow_type,
        queue_state,
        queue_priority,
        scheduled_for,
        not_before,
        attempt_count,
        requested_msgs_per_second
      )
      VALUES ($1, $2, 'broadcast', 'queued', 100, now(), now(), 0, $3)
      `,
      [
        campaign.dispatch_campaign_id,
        campaign.tenant_id,
        config.maxMsgsPerSecond,
      ]
    );

    return 'created';
  }

  await cpDb.query(
    `
    UPDATE control_plane.campaign_dispatch_queue
       SET queue_state = 'queued',
           not_before = now(),
           started_at = NULL,
           finished_at = NULL,
           last_heartbeat_at = NULL,
           locked_by = NULL,
           lock_expires_at = NULL,
           last_error_code = NULL,
           last_error_message = NULL,
           requested_msgs_per_second = $2,
           updated_at = now()
     WHERE dispatch_id = $1
    `,
    [rows[0].dispatch_id, config.maxMsgsPerSecond]
  );

  return 'updated';
}

async function handleHandoff(req, res) {
  assertAuthorized(req);

  const body = await readJson(req);
  const tenantKey = String(body.tenantKey || body.tenant_key || '').trim();
  const sendyCampaignId = normalizeInteger(body.sendyCampaignId || body.sendy_campaign_id, 'sendyCampaignId');

  if (!tenantKey) {
    throw new Error('tenantKey is required');
  }

  const env = {
    DIRECT_DISPATCHER_TENANT_KEY: tenantKey,
    DIRECT_DISPATCHER_SENDY_CAMPAIGN_ID: String(sendyCampaignId),
    DIRECT_DISPATCHER_EXECUTION_MODE: process.env.DIRECT_DISPATCHER_EXECUTION_MODE || 'dry-run',
  };

  logger.info('handoff.started', {
    tenant_key: tenantKey,
    sendy_campaign_id: sendyCampaignId,
  });

  const intake = await runNodeScript('src/campaign-intake.js', env);
  const resolve = await runNodeScript('src/audience-resolver.js', env);
  const plan = await runNodeScript('src/batch-planner.js', env);

  const config = {
    ...loadConfig(),
    tenantKey,
    sendyCampaignId,
  };

  const cpDb = createControlPlaneDb(config);
  let campaign;
  let dispatchQueue;

  try {
    campaign = await loadCampaignBySendyId(cpDb, tenantKey, sendyCampaignId);

    if (!campaign) {
      throw new Error('Campaign registry row not found after handoff pipeline');
    }

    if (campaign.direct_dispatch_state === 'completed') {
      throw new Error('Campaign is already completed');
    }

    dispatchQueue = await ensureDispatchQueue(cpDb, campaign, config);
  } finally {
    await cpDb.close();
  }

  logger.info('handoff.completed', {
    tenant_key: tenantKey,
    sendy_campaign_id: sendyCampaignId,
    dispatch_campaign_id: campaign.dispatch_campaign_id,
    dispatch_queue: dispatchQueue,
  });

  sendJson(res, 200, {
    ok: true,
    tenantKey,
    sendyCampaignId,
    dispatchCampaignId: Number(campaign.dispatch_campaign_id),
    dispatchQueue,
    steps: {
      intake: intake.code,
      resolve: resolve.code,
      plan: plan.code,
    },
  });
}

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'GET' && url.pathname === '/healthz') {
    sendJson(res, 200, { ok: true, service: 'poweremail-broadcast-dispatcher' });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/handoff/sendy-campaign') {
    await handleHandoff(req, res);
    return;
  }

  sendJson(res, 404, { ok: false, error: 'not_found' });
}

const server = http.createServer((req, res) => {
  route(req, res).catch((err) => {
    const statusCode = err.statusCode || 500;

    logger.error('server.request_failed', {
      error: {
        name: err.name,
        message: err.message,
        stack: err.stack,
      },
    });

    sendJson(res, statusCode, {
      ok: false,
      error: err.message,
    });
  });
});

const port = Number.parseInt(process.env.PORT || '3000', 10);

server.listen(port, '0.0.0.0', () => {
  logger.info('server.started', { port });
});
