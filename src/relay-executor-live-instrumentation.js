'use strict';

const nodemailer = require('nodemailer');
const logger = require('./logger');

const heartbeatMs = Math.max(
  Number.parseInt(process.env.DIRECT_DISPATCHER_BATCH_HEARTBEAT_MS || '30000', 10),
  1000
);
const progressEvery = Math.max(
  Number.parseInt(process.env.DIRECT_DISPATCHER_PROGRESS_EVERY_N_RECIPIENTS || '25', 10),
  1
);

const state = {
  sendyCampaignId: null,
  tenantKey: null,
  dispatchCampaignId: null,
  batchKey: null,
  deliveryBatchId: null,
  deliveryAttemptId: null,
  plannedRecipients: null,
  startedAtMs: null,
  lastPersistedSent: 0,
  successfulSendCalls: 0,
  lastSendDurationMs: null,
  heartbeatTimer: null,
  transportConfig: {},
};

function extractMessageContext(message) {
  const headers = message?.headers || {};
  return {
    dispatchCampaignId: headers['X-PowerEmail-Dispatch-Campaign-Id'] || headers['X-PowerEmail-Dispatch-Campaign'] || null,
    batchKey: headers['X-PowerEmail-Batch-Key'] || null,
    tenantKey: headers['X-PowerEmail-Tenant-Key'] || null,
    recipientEmail: message?.to || null,
  };
}

function getObservedSent() {
  return Math.max(state.lastPersistedSent, state.successfulSendCalls);
}

function calculateRecipientsPerHour(elapsedMs, sent) {
  if (!elapsedMs || elapsedMs <= 0 || !sent) return 0;
  return Number(((sent / elapsedMs) * 3600000).toFixed(2));
}

function emitBatchHeartbeat(reason) {
  if (!state.batchKey || !state.startedAtMs) return;

  const observedSent = getObservedSent();
  const elapsedMs = Date.now() - state.startedAtMs;

  logger.info('relay_executor.batch_heartbeat', {
    sendy_campaign_id: state.sendyCampaignId,
    tenant_key: state.tenantKey,
    dispatch_campaign_id: state.dispatchCampaignId,
    batch_key: state.batchKey,
    delivery_batch_id: state.deliveryBatchId,
    delivery_attempt_id: state.deliveryAttemptId,
    reason,
    sent: observedSent,
    planned: state.plannedRecipients,
    remaining:
      typeof state.plannedRecipients === 'number'
        ? Math.max(state.plannedRecipients - observedSent, 0)
        : null,
    elapsed_seconds: Number((elapsedMs / 1000).toFixed(1)),
    recipients_per_hour_overall: calculateRecipientsPerHour(elapsedMs, observedSent),
    last_send_duration_ms: state.lastSendDurationMs,
    smtp_pool_enabled: state.transportConfig.smtp_pool_enabled ?? null,
    smtp_max_connections: state.transportConfig.smtp_max_connections ?? null,
    smtp_max_messages: state.transportConfig.smtp_max_messages ?? null,
    progress_every_n_recipients:
      state.transportConfig.progress_every_n_recipients ?? progressEvery,
    batch_heartbeat_ms: state.transportConfig.batch_heartbeat_ms ?? heartbeatMs,
    max_msgs_per_second: state.transportConfig.max_msgs_per_second ?? null,
    max_msgs_per_second_source: state.transportConfig.max_msgs_per_second_source ?? null,
    campaign_requested_msgs_per_second:
      state.transportConfig.campaign_requested_msgs_per_second ?? null,
    configured_max_msgs_per_second:
      state.transportConfig.configured_max_msgs_per_second ?? null,
    forced_max_msgs_per_second:
      state.transportConfig.forced_max_msgs_per_second ?? null,
  });
}

function ensureHeartbeatTimer() {
  if (state.heartbeatTimer || !state.batchKey) return;

  state.heartbeatTimer = setInterval(() => {
    emitBatchHeartbeat('timer');
  }, heartbeatMs);

  if (typeof state.heartbeatTimer.unref === 'function') {
    state.heartbeatTimer.unref();
  }
}

function stopHeartbeatTimer(reason) {
  if (!state.heartbeatTimer) return;
  clearInterval(state.heartbeatTimer);
  state.heartbeatTimer = null;
  emitBatchHeartbeat(reason);
}

function captureLogEvent(message, payload) {
  if (!payload || typeof payload !== 'object') return;

  if (message === 'relay_executor.transport_config') {
    state.transportConfig = {
      smtp_pool_enabled: payload.smtp_pool_enabled,
      smtp_max_connections: payload.smtp_max_connections,
      smtp_max_messages: payload.smtp_max_messages,
      progress_every_n_recipients: payload.progress_every_n_recipients,
      batch_heartbeat_ms: payload.batch_heartbeat_ms,
      max_msgs_per_second: payload.max_msgs_per_second,
      max_msgs_per_second_source: payload.max_msgs_per_second_source,
      campaign_requested_msgs_per_second:
        payload.campaign_requested_msgs_per_second,
      configured_max_msgs_per_second:
        payload.configured_max_msgs_per_second,
      forced_max_msgs_per_second: payload.forced_max_msgs_per_second,
    };
    return;
  }

  if (message === 'relay_executor.batch_started') {
    state.sendyCampaignId = payload.sendy_campaign_id || null;
    state.tenantKey = payload.tenant_key || null;
    state.dispatchCampaignId = payload.dispatch_campaign_id || null;
    state.batchKey = payload.batch_key || null;
    state.deliveryBatchId = payload.delivery_batch_id || null;
    state.deliveryAttemptId = payload.delivery_attempt_id || null;
    state.plannedRecipients = Number(payload.planned_recipients || 0) || null;
    state.startedAtMs = Date.now();
    state.lastPersistedSent = 0;
    state.successfulSendCalls = 0;
    state.lastSendDurationMs = null;
    ensureHeartbeatTimer();
    return;
  }

  if (message === 'relay_executor.batch_progress') {
    state.lastPersistedSent = Number(payload.sent || 0);
    return;
  }

  if (
    message === 'relay_executor.batch_completed' ||
    message === 'relay_executor.batch_failed' ||
    message === 'relay_executor.batch_interrupted'
  ) {
    if (typeof payload.sent === 'number') {
      state.lastPersistedSent = payload.sent;
    }
    stopHeartbeatTimer(message);
  }
}

function wrapLoggerMethod(level) {
  const original = logger[level];
  if (typeof original !== 'function') return;

  logger[level] = (message, payload) => {
    try {
      captureLogEvent(message, payload);
    } catch (_) {
      // Keep instrumentation best-effort and never block executor logs.
    }
    return original.call(logger, message, payload);
  };
}

wrapLoggerMethod('info');
wrapLoggerMethod('warn');
wrapLoggerMethod('error');

const originalCreateTransport = nodemailer.createTransport.bind(nodemailer);

nodemailer.createTransport = function patchedCreateTransport(...args) {
  const transport = originalCreateTransport(...args);

  if (!transport || typeof transport.sendMail !== 'function') {
    return transport;
  }

  const originalSendMail = transport.sendMail.bind(transport);

  transport.sendMail = async function patchedSendMail(message, ...rest) {
    const startedAt = Date.now();

    try {
      const result = await originalSendMail(message, ...rest);
      const durationMs = Date.now() - startedAt;
      const messageContext = extractMessageContext(message);

      state.successfulSendCalls += 1;
      state.lastSendDurationMs = durationMs;

      if (
        state.successfulSendCalls === 1 ||
        state.successfulSendCalls % progressEvery === 0 ||
        (state.plannedRecipients &&
          state.successfulSendCalls === state.plannedRecipients)
      ) {
        const elapsedMs = state.startedAtMs ? Date.now() - state.startedAtMs : 0;
        logger.info('relay_executor.recipient_timing', {
          sendy_campaign_id: state.sendyCampaignId,
          tenant_key: messageContext.tenantKey || state.tenantKey,
          dispatch_campaign_id:
            messageContext.dispatchCampaignId || state.dispatchCampaignId,
          batch_key: messageContext.batchKey || state.batchKey,
          delivery_batch_id: state.deliveryBatchId,
          delivery_attempt_id: state.deliveryAttemptId,
          recipient_email: messageContext.recipientEmail,
          sent_observed: getObservedSent(),
          planned: state.plannedRecipients,
          send_duration_ms: durationMs,
          elapsed_seconds: Number((elapsedMs / 1000).toFixed(1)),
          recipients_per_hour_overall: calculateRecipientsPerHour(
            elapsedMs,
            getObservedSent()
          ),
        });
      }

      return result;
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const messageContext = extractMessageContext(message);

      logger.warn('relay_executor.recipient_send_failed_timing', {
        sendy_campaign_id: state.sendyCampaignId,
        tenant_key: messageContext.tenantKey || state.tenantKey,
        dispatch_campaign_id:
          messageContext.dispatchCampaignId || state.dispatchCampaignId,
        batch_key: messageContext.batchKey || state.batchKey,
        delivery_batch_id: state.deliveryBatchId,
        delivery_attempt_id: state.deliveryAttemptId,
        recipient_email: messageContext.recipientEmail,
        send_duration_ms: durationMs,
        error_code: error?.code || null,
        error_message: error?.message || null,
      });

      throw error;
    }
  };

  return transport;
};
