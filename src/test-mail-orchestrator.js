"use strict";

const crypto = require("crypto");
const { loadServiceConfig } = require("./config");
const { createControlPlaneDb } = require("./db");
const { createSendyDb } = require("./sendy-db");
const logger = require("./logger");
const { chunkError } = require("./utils");
const orchestratorConfig = require("../config/test-orchestrator");

function hashInt(input) {
  const digest = crypto.createHash("sha256").update(String(input)).digest();
  return digest.readUInt32BE(0);
}

function mulberry32(seed) {
  return function next() {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function localDateString(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: orchestratorConfig.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function localDateTimeParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: orchestratorConfig.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

function slotToTodayDate(slot) {
  const date = localDateString();
  return `${date}T${String(slot.hour).padStart(2, "0")}:${String(slot.minute).padStart(2, "0")}:00`;
}

function isSlotDue(slot, now = new Date()) {
  const parts = localDateTimeParts(now);
  const nowMinutes = Number(parts.hour) * 60 + Number(parts.minute);
  const slotMinutes = slot.hour * 60 + slot.minute;
  return slotMinutes <= nowMinutes;
}

function buildDailySlots(brand, dateText = localDateString()) {
  const seed = hashInt(`${dateText}:${brand.tenantKey}`);
  const random = mulberry32(seed);
  const countRange =
    orchestratorConfig.dailySends.maxPerBrand - orchestratorConfig.dailySends.minPerBrand + 1;
  const count = orchestratorConfig.dailySends.minPerBrand + Math.floor(random() * countRange);

  const start = orchestratorConfig.sendWindow.startHour * 60;
  const end = orchestratorConfig.sendWindow.endHour * 60;
  const usable = end - start;
  const baseGap = usable / count;
  const slots = [];

  for (let i = 0; i < count; i += 1) {
    const jitter = Math.floor((random() - 0.5) * Math.min(baseGap * 0.7, 55));
    const minuteOfDay = Math.max(
      start,
      Math.min(end - 1, Math.floor(start + baseGap * i + baseGap / 2 + jitter))
    );
    slots.push({
      slotIndex: i + 1,
      hour: Math.floor(minuteOfDay / 60),
      minute: minuteOfDay % 60,
      slotId: `${dateText}:${brand.tenantKey}:${i + 1}`,
    });
  }

  return slots.sort((a, b) => a.hour * 60 + a.minute - (b.hour * 60 + b.minute));
}

function topicForSlot(brand, slot) {
  const index = hashInt(`${slot.slotId}:topic`) % brand.topics.length;
  return brand.topics[index];
}

function buildCopy(brand, slot) {
  const topic = topicForSlot(brand, slot);
  const subjectMap = {
    colonyspaces: `Seguimiento sobre ${topic}`,
    decosimil: `Revision de ${topic}`,
    georgieboy: `Opciones de ${topic}`,
    lester: `Notas sobre ${topic}`,
    shopology: `Avance de ${topic}`,
  };

  const subject = subjectMap[brand.tenantKey] || `Seguimiento sobre ${topic}`;
  const body = [
    "Hola,",
    "",
    `Estuve pensando en ${topic} y creo que conviene revisarlo con un enfoque practico y aterrizado al dia a dia.`,
    "",
    `En ${brand.brandName} podemos preparar una recomendacion breve considerando ${brand.businessDomain}, sin hacerlo mas complejo de lo necesario.`,
    "",
    "Si me compartes un poco mas de contexto sobre lo que quieres priorizar, puedo dejarte una propuesta mas puntual para revisarla contigo.",
    "",
    brand.senderPersona === "Georgina" ? "Quedo atenta." : "Quedo atento.",
    "",
    "Saludos,",
    "",
    brand.senderPersona,
    "",
    brand.brandName,
  ].join("\n");

  return { subject, plainText: body, htmlText: body.replace(/\n/g, "<br>\n") };
}

async function loadActiveRecipients(sendyDb, listId) {
  return sendyDb.query(
    `
    SELECT
      id AS sendySubscriberId,
      list AS sendyListId,
      email,
      name,
      custom_fields AS customFields
    FROM subscribers
    WHERE list = ?
      AND unsubscribed = 0
      AND bounced = 0
      AND complaint = 0
      AND confirmed = 1
    ORDER BY id ASC
    `,
    [listId]
  );
}

async function loadBaseSender(cpDb, tenantKey) {
  const { rows } = await cpDb.query(
    `
    WITH tenant AS (
      SELECT tenant_id, tenant_key
      FROM control_plane.tenants
      WHERE tenant_key = $1
        AND status = 'active'
      LIMIT 1
    ),
    active_role AS (
      SELECT t.tenant_id, COALESCE(tr.active_domain_role, 'primary') AS role
      FROM tenant t
      LEFT JOIN control_plane.tenant_runtime tr
        ON tr.tenant_id = t.tenant_id
    )
    SELECT
      ta.from_email,
      split_part(lower(ta.from_email), '@', 1) || '@mail.' || split_part(lower(ta.from_email), '@', 2) AS reply_to
    FROM active_role ar
    JOIN control_plane.tenant_domains td
      ON td.tenant_id = ar.tenant_id
     AND td.role = ar.role
     AND td.is_enabled = true
    JOIN control_plane.tenant_aliases ta
      ON ta.tenant_id = ar.tenant_id
     AND ta.enabled = true
     AND split_part(lower(ta.from_email), '@', 2) = lower(td.domain)
    ORDER BY ta.tenant_alias_id
    LIMIT 1
    `,
    [tenantKey]
  );

  if (!rows[0]) throw new Error(`No enabled base sender found for tenant=${tenantKey}`);
  return rows[0];
}

function buildSyntheticCampaignId(slot) {
  return 800000000 + (hashInt(slot.slotId) % 100000000);
}

function buildHandoffPayload(brand, slot, sender, copy, recipients) {
  const sendyCampaignId = buildSyntheticCampaignId(slot);
  return {
    tenantKey: brand.tenantKey,
    sendyCampaignId,
    batchSize: orchestratorConfig.dispatch.batchSize,
    campaign: {
      id: sendyCampaignId,
      title: copy.subject,
      label: `PowerEmail test automation ${slot.slotId}`,
      subject: copy.subject,
      from_name: brand.senderDisplayName,
      fromName: brand.senderDisplayName,
      from_email: sender.from_email,
      fromEmail: sender.from_email,
      reply_to: sender.reply_to,
      replyTo: sender.reply_to,
      plain_text: copy.plainText,
      plainText: copy.plainText,
      html_text: copy.htmlText,
      htmlText: copy.htmlText,
      lists: String(brand.sendyTestListId),
      to_send_lists: String(brand.sendyTestListId),
      opens_tracking: false,
      links_tracking: false,
      source_json: {
        source_system: orchestratorConfig.dispatch.sourceSystem,
        slot_id: slot.slotId,
        scheduled_for_local: slotToTodayDate(slot),
        sendy_test_list_id: brand.sendyTestListId,
        mirrors_enabled: orchestratorConfig.dispatch.mirrorsEnabled,
      },
    },
    recipients,
  };
}

async function postHandoff(payload) {
  const baseUrl = process.env.TEST_ORCHESTRATOR_DISPATCHER_URL || process.env.DIRECT_DISPATCHER_URL;
  const token = process.env.DIRECT_DISPATCHER_HANDOFF_TOKEN;
  if (!baseUrl) throw new Error("Missing TEST_ORCHESTRATOR_DISPATCHER_URL or DIRECT_DISPATCHER_URL");
  if (!token) throw new Error("Missing DIRECT_DISPATCHER_HANDOFF_TOKEN");

  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/handoff/sendy-campaign-snapshot`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const text = await response.text();
  let body = text;
  try {
    body = JSON.parse(text);
  } catch (_) {}

  if (!response.ok) {
    const message = typeof body === "object" ? JSON.stringify(body) : String(body);
    throw new Error(`handoff failed status=${response.status} body=${message}`);
  }

  return body;
}

function selectedBrands() {
  const only = (process.env.TEST_ORCHESTRATOR_TENANT || "").trim();
  if (!only) return orchestratorConfig.brands;
  const wanted = new Set(only.split(",").map((item) => item.trim()).filter(Boolean));
  return orchestratorConfig.brands.filter((brand) => wanted.has(brand.tenantKey));
}

async function main() {
  const mode = process.env.TEST_ORCHESTRATOR_MODE || "plan";
  const forceNow = ["1", "true", "yes"].includes(String(process.env.TEST_ORCHESTRATOR_FORCE_NOW || "").toLowerCase());
  const limit = Number.parseInt(process.env.TEST_ORCHESTRATOR_LIMIT || "1", 10);
  const dateText = localDateString();
  const config = loadServiceConfig();
  const cpDb = createControlPlaneDb(config);
  const sendyDb = createSendyDb(config);

  try {
    const planned = [];

    for (const brand of selectedBrands()) {
      const recipients = await loadActiveRecipients(sendyDb, brand.sendyTestListId);
      const sender = await loadBaseSender(cpDb, brand.tenantKey);
      const slots = buildDailySlots(brand, dateText);

      for (const slot of slots) {
        const copy = buildCopy(brand, slot);
        const payload = buildHandoffPayload(brand, slot, sender, copy, recipients);
        planned.push({
          brand,
          slot,
          sender,
          copy,
          payload,
          recipients: recipients.length,
          due: forceNow || isSlotDue(slot),
        });
      }
    }

    logger.info("test_orchestrator.plan", {
      mode,
      date: dateText,
      timezone: orchestratorConfig.timezone,
      slots: planned.map((item) => ({
        tenantKey: item.brand.tenantKey,
        scheduledLocal: slotToTodayDate(item.slot),
        sendyCampaignId: item.payload.sendyCampaignId,
        subject: item.copy.subject,
        fromEmail: item.sender.from_email,
        recipients: item.recipients,
        due: item.due,
      })),
    });

    if (mode !== "handoff") return;

    const due = planned.filter((item) => item.due).slice(0, Math.max(limit, 1));
    for (const item of due) {
      const result = await postHandoff(item.payload);
      logger.info("test_orchestrator.handoff_completed", {
        tenantKey: item.brand.tenantKey,
        sendyCampaignId: item.payload.sendyCampaignId,
        scheduledLocal: slotToTodayDate(item.slot),
        result,
      });
    }
  } catch (error) {
    logger.error("test_orchestrator.failed", { error: chunkError(error) });
    process.exitCode = 1;
  } finally {
    await Promise.allSettled([cpDb.close(), sendyDb.close()]);
  }
}

main();
