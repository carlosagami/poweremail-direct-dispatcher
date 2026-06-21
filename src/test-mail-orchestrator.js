"use strict";

const crypto = require("crypto");
const { loadServiceConfig } = require("./config");
const { createControlPlaneDb } = require("./db");
const logger = require("./logger");
const { chunkError } = require("./utils");
const orchestratorConfig = require("../config/test-orchestrator");

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const OPENAI_CHAT_COMPLETIONS_URL = "https://api.openai.com/v1/chat/completions";
const COPY_MODES = new Set(["auto", "ai", "local"]);
const EMAIL_ADDRESS_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;

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

function boolEnv(name, fallback = false) {
  const value = process.env[name];
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function optionalPositiveIntEnv(name) {
  const value = process.env[name];
  if (value == null || value === "") return null;
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed < 0) {
    throw new Error(`Invalid ${name}=${value}; expected a positive integer or 0`);
  }
  return parsed;
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

function isSlotDue(slot, now = new Date(), lookbackMinutes = null) {
  const parts = localDateTimeParts(now);
  const nowMinutes = Number(parts.hour) * 60 + Number(parts.minute);
  const slotMinutes = slot.hour * 60 + slot.minute;

  if (slotMinutes > nowMinutes) return false;
  if (lookbackMinutes == null) return true;
  return nowMinutes - slotMinutes <= lookbackMinutes;
}

function isWeekendDateText(dateText) {
  const [year, month, day] = String(dateText).split("-").map((part) => Number.parseInt(part, 10));
  const dayOfWeek = new Date(Date.UTC(year, month - 1, day, 12)).getUTCDay();
  return dayOfWeek === 0 || dayOfWeek === 6;
}

function dayTypeForDate(dateText) {
  return isWeekendDateText(dateText) ? "weekend" : "weekday";
}

function sendVolumeForDate(dateText) {
  const dailySends = orchestratorConfig.dailySends || {};
  const selected = isWeekendDateText(dateText) ? dailySends.weekends : dailySends.weekdays;
  const fallback = {
    minPerBrand: dailySends.minPerBrand,
    maxPerBrand: dailySends.maxPerBrand,
  };
  const volume = selected || fallback;

  if (!Number.isInteger(volume.minPerBrand) || !Number.isInteger(volume.maxPerBrand)) {
    throw new Error(`Invalid dailySends config for ${dayTypeForDate(dateText)}`);
  }
  if (volume.minPerBrand < 1 || volume.maxPerBrand < volume.minPerBrand) {
    throw new Error(`Invalid dailySends range for ${dayTypeForDate(dateText)}`);
  }
  return volume;
}

function buildDailySlots(brand, dateText = localDateString()) {
  const seed = hashInt(`${dateText}:${brand.tenantKey}`);
  const random = mulberry32(seed);
  const volume = sendVolumeForDate(dateText);
  const countRange = volume.maxPerBrand - volume.minPerBrand + 1;
  const count = volume.minPerBrand + Math.floor(random() * countRange);

  const start = orchestratorConfig.sendWindow.startHour * 60;
  const end = orchestratorConfig.sendWindow.endHour * 60;
  const usable = end - start;
  const baseGap = usable / count;
  const slots = [];

  for (let i = 0; i < count; i += 1) {
    const jitter = Math.floor((random() - 0.5) * Math.min(baseGap * 0.7, 55));
    const minuteOfDay = Math.max(start, Math.min(end - 1, Math.floor(start + baseGap * i + baseGap / 2 + jitter)));
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

function buildHtmlFromPlainText(plainText) {
  const escapeHtml = (value) =>
    String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

  return String(plainText)
    .trim()
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, "<br>\n")}</p>`)
    .join("<br><br>\n");
}

function normalizeHtmlSpacing(htmlText, plainText) {
  const html = String(htmlText || "").trim();
  if (!html) return buildHtmlFromPlainText(plainText);
  if (/<p[\s>]/i.test(html)) {
    return html
      .replace(/<\/p>\s*<p/gi, "</p><br><br>\n<p")
      .replace(/<\/p>\s*$/i, "</p>");
  }
  return buildHtmlFromPlainText(plainText);
}

function buildLocalCopy(brand, slot) {
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

  return {
    subject,
    plainText: body,
    htmlText: buildHtmlFromPlainText(body),
    topic,
    source: "local",
  };
}

function normalizedCopyMode() {
  const mode = String(process.env.TEST_ORCHESTRATOR_COPY_MODE || "auto").trim().toLowerCase();
  if (!COPY_MODES.has(mode)) {
    throw new Error(`Invalid TEST_ORCHESTRATOR_COPY_MODE=${mode}; expected auto, ai, or local`);
  }
  return mode;
}

function shouldUseAiCopy(mode) {
  if (mode === "local") return false;
  if (mode === "ai") return true;
  return Boolean(process.env.OPENAI_API_KEY);
}

function openAiModel() {
  return process.env.TEST_ORCHESTRATOR_OPENAI_MODEL || process.env.OPENAI_MODEL || "gpt-4.1-mini";
}

function copyTemperature() {
  const value = process.env.TEST_ORCHESTRATOR_COPY_TEMPERATURE;
  if (!value) return 0.85;
  const parsed = Number.parseFloat(value);
  if (Number.isNaN(parsed) || parsed < 0 || parsed > 2) {
    throw new Error(`Invalid TEST_ORCHESTRATOR_COPY_TEMPERATURE=${value}`);
  }
  return parsed;
}

function copyPrompt(brand, slot, topic, dateText) {
  return [
    "Genera un correo outbound breve en espanol neutro/latam.",
    "Responde exclusivamente JSON valido con estas llaves: subject, plainText, htmlText.",
    "No uses markdown. No incluyas explicaciones.",
    "El correo debe sonar humano, especifico y contextual a la marca que envia.",
    "No debe sonar a brochure, pitch comercial ni plantilla generica.",
    "Usa una observacion concreta del contexto del negocio y luego una pregunta o siguiente paso suave.",
    "Evita estas frases y construcciones: 'queria contarte', 'contamos con', 'te ofrecemos', 'tenemos la solucion', 'te gustaria saber mas', 'agenda una llamada', 'descubre', 'potencia', 'ideal para'.",
    "No prometas descuentos, resultados garantizados, urgencias falsas ni claims medicos.",
    "No menciones que fue generado por IA.",
    "JAMAS incluyas una direccion de correo electronico en subject, plainText o htmlText.",
    "El subject debe tener maximo 75 caracteres y sonar natural, no promocional.",
    "El plainText debe tener 70 a 130 palabras, con saludo, contexto, pregunta o CTA suave, despedida y firma.",
    "El htmlText debe contener el mismo contenido que plainText en HTML simple.",
    "En htmlText separa cada parrafo con dos lineas <br><br> entre etiquetas </p> y <p>.",
    "Datos del envio:",
    JSON.stringify({
      tenantKey: brand.tenantKey,
      brandName: brand.brandName,
      senderPersona: brand.senderPersona,
      senderDisplayName: brand.senderDisplayName,
      businessDomain: brand.businessDomain,
      topic,
      date: dateText,
      slotId: slot.slotId,
      slotIndex: slot.slotIndex,
      scheduledLocal: slotToTodayDate(slot),
      availableTopics: brand.topics,
    }),
  ].join("\n");
}

function extractResponseText(body) {
  if (typeof body.output_text === "string") return body.output_text;
  if (Array.isArray(body.output)) {
    for (const item of body.output) {
      if (!Array.isArray(item.content)) continue;
      for (const content of item.content) {
        if (typeof content.text === "string") return content.text;
      }
    }
  }
  if (Array.isArray(body.choices) && body.choices[0]?.message?.content) {
    return body.choices[0].message.content;
  }
  return "";
}

async function callOpenAi(prompt) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("Missing OPENAI_API_KEY for AI copy generation");

  const model = openAiModel();
  const temperature = copyTemperature();
  const useResponsesApi = ["1", "true", "yes"].includes(
    String(process.env.TEST_ORCHESTRATOR_USE_RESPONSES_API || "").toLowerCase()
  );

  const payload = useResponsesApi
    ? {
        model,
        temperature,
        input: prompt,
      }
    : {
        model,
        temperature,
        messages: [
          {
            role: "user",
            content: prompt,
          },
        ],
        response_format: {
          type: "json_object",
        },
      };

  const response = await fetch(useResponsesApi ? OPENAI_RESPONSES_URL : OPENAI_CHAT_COMPLETIONS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
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
    throw new Error(`OpenAI copy generation failed status=${response.status} body=${message}`);
  }

  const generated = extractResponseText(body);
  if (!generated) throw new Error("OpenAI response did not include generated text");
  return JSON.parse(generated);
}

function containsEmailAddress(value) {
  return EMAIL_ADDRESS_PATTERN.test(String(value || ""));
}

function assertCopyHasNoEmailAddress(subject, plainText, htmlText) {
  if (
    containsEmailAddress(subject) ||
    containsEmailAddress(plainText) ||
    containsEmailAddress(htmlText)
  ) {
    throw new Error("Generated copy contains a visible email address");
  }
}

function normalizeAiCopy(candidate, fallback) {
  const subject = String(candidate.subject || "").trim();
  const plainText = String(candidate.plainText || candidate.plain_text || "").trim();
  const htmlText = normalizeHtmlSpacing(candidate.htmlText || candidate.html_text, plainText);

  if (!subject || !plainText || !htmlText) {
    throw new Error("AI copy is missing subject, plainText, or htmlText");
  }
  assertCopyHasNoEmailAddress(subject, plainText, htmlText);

  return {
    ...fallback,
    subject: subject.slice(0, 90),
    plainText,
    htmlText,
    source: "ai",
  };
}

async function buildCopy(brand, slot, dateText) {
  const fallback = buildLocalCopy(brand, slot);
  const mode = normalizedCopyMode();
  if (!shouldUseAiCopy(mode)) return fallback;

  try {
    const prompt = copyPrompt(brand, slot, fallback.topic, dateText);
    const generated = await callOpenAi(prompt);
    return normalizeAiCopy(generated, fallback);
  } catch (error) {
    if (mode === "ai") throw error;
    logger.warn("test_orchestrator.ai_copy_fallback", {
      tenantKey: brand.tenantKey,
      slotId: slot.slotId,
      error: chunkError(error),
    });
    return fallback;
  }
}

async function loadActiveRecipients(cpDb, tenantKey, listId) {
  const { rows } = await cpDb.query(
    `
    SELECT
      o.override_id AS "sendySubscriberId",
      $2::integer AS "sendyListId",
      o.email_norm AS email,
      NULL::text AS name,
      jsonb_build_object(
        'source', 'tenant_test_lead_alias_overrides',
        'sendy_test_list_id', $2::integer
      ) AS "customFields"
    FROM control_plane.tenants t
    JOIN control_plane.tenant_test_lead_alias_overrides o
      ON o.tenant_id = t.tenant_id
     AND o.enabled = true
    WHERE t.tenant_key = $1
      AND t.status = 'active'
    ORDER BY o.email_norm ASC
    `,
    [tenantKey, listId]
  );
  return rows;
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
  const idSalt = String(process.env.TEST_ORCHESTRATOR_ID_SALT || "").trim();
  const idSource = idSalt ? slot.slotId + ":" + idSalt : slot.slotId;
  return 800000000 + (hashInt(idSource) % 100000000);
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
        copy_source: copy.source,
        copy_topic: copy.topic,
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

function previewLimit(defaultLimit) {
  const value = process.env.TEST_ORCHESTRATOR_PREVIEW_LIMIT || process.env.TEST_ORCHESTRATOR_LIMIT;
  const parsed = Number.parseInt(value || String(defaultLimit || 1), 10);
  if (Number.isNaN(parsed) || parsed < 1) return 1;
  return parsed;
}

function buildCopyPreviews(planned, limit) {
  return planned.slice(0, limit).map((item) => ({
    tenantKey: item.brand.tenantKey,
    scheduledLocal: slotToTodayDate(item.slot),
    sendyCampaignId: item.payload.sendyCampaignId,
    subject: item.copy.subject,
    plainText: item.copy.plainText,
    htmlText: item.copy.htmlText,
    copySource: item.copy.source,
    copyTopic: item.copy.topic,
    fromEmail: item.sender.from_email,
    recipients: item.recipients,
    due: item.due,
  }));
}

async function main() {
  const mode = process.env.TEST_ORCHESTRATOR_MODE || "plan";
  const forceNow = boolEnv("TEST_ORCHESTRATOR_FORCE_NOW", false);
  const dueLookbackMinutes = optionalPositiveIntEnv("TEST_ORCHESTRATOR_DUE_LOOKBACK_MINUTES");
  const limit = Number.parseInt(process.env.TEST_ORCHESTRATOR_LIMIT || "1", 10);
  const now = new Date();
  const dateText = localDateString(now);
  const config = loadServiceConfig();
  const cpDb = createControlPlaneDb(config);

  try {
    const planned = [];

    for (const brand of selectedBrands()) {
      const recipients = await loadActiveRecipients(cpDb, brand.tenantKey, brand.sendyTestListId);
      const sender = await loadBaseSender(cpDb, brand.tenantKey);
      const slots = buildDailySlots(brand, dateText);

      for (const slot of slots) {
        const copy = await buildCopy(brand, slot, dateText);
        const payload = buildHandoffPayload(brand, slot, sender, copy, recipients);
        planned.push({
          brand,
          slot,
          sender,
          copy,
          payload,
          recipients: recipients.length,
          due: forceNow || isSlotDue(slot, now, dueLookbackMinutes),
        });
      }
    }

    logger.info("test_orchestrator.plan", {
      mode,
      copyMode: normalizedCopyMode(),
      forceNow,
      dueLookbackMinutes,
      date: dateText,
      dayType: dayTypeForDate(dateText),
      timezone: orchestratorConfig.timezone,
      sendWindow: orchestratorConfig.sendWindow,
      sendVolume: sendVolumeForDate(dateText),
      slots: planned.map((item) => ({
        tenantKey: item.brand.tenantKey,
        scheduledLocal: slotToTodayDate(item.slot),
        sendyCampaignId: item.payload.sendyCampaignId,
        subject: item.copy.subject,
        copySource: item.copy.source,
        copyTopic: item.copy.topic,
        fromEmail: item.sender.from_email,
        recipients: item.recipients,
        due: item.due,
      })),
    });

    if (mode === "plan" && boolEnv("TEST_ORCHESTRATOR_PREVIEW_COPY", false)) {
      logger.info("test_orchestrator.copy_preview", {
        mode,
        copyMode: normalizedCopyMode(),
        date: dateText,
        dayType: dayTypeForDate(dateText),
        previews: buildCopyPreviews(planned, previewLimit(limit)),
      });
    }

    if (mode !== "handoff") return;

    const due = planned.filter((item) => item.due).slice(0, Math.max(limit, 1));
    for (const item of due) {
      const result = await postHandoff(item.payload);
      logger.info("test_orchestrator.handoff_completed", {
        tenantKey: item.brand.tenantKey,
        sendyCampaignId: item.payload.sendyCampaignId,
        scheduledLocal: slotToTodayDate(item.slot),
        copySource: item.copy.source,
        copyTopic: item.copy.topic,
        result,
      });
    }
  } catch (error) {
    logger.error("test_orchestrator.failed", { error: chunkError(error) });
    process.exitCode = 1;
  } finally {
    await cpDb.close();
  }
}

main();
