"use strict";

const crypto = require("crypto");
const { validateFingerprintVariant } = require("./similarity-validator");

const COPY_INTENT_TYPES = [
  "casual_observation",
  "brief_human_note_no_cta",
  "neutral_context_note",
  "process_comment",
  "quiet_reflection",
  "operational_aside",
  "simple_acknowledgement",
  "informal_continuation",
  "one_line_thought",
  "low_energy_note",
  "direct_non_sales_comment",
  "context_clarification",
  "human_reaction",
  "no_question_message",
  "no_close_message",
  "minimal_close_message",
  "short_signature_message",
  "full_signature_message",
  "no_benefit_language_message",
  "no_sales_words_message",
];

const VARIATION_AXES = {
  opening: ["no_salutation", "direct_context", "fragment", "first_person_note", "neutral_statement"],
  length: ["very_short", "short", "medium", "long"],
  tone: ["casual_direct", "formal_sober", "quiet", "reflective", "operational", "plain"],
  cta: ["none", "soft"],
  structure: [
    "single_line",
    "one_paragraph",
    "two_short_paragraphs",
    "fragmented_note",
    "operational_note",
    "no_traditional_close",
  ],
  closing: ["none", "minimal", "natural_sentence", "short_signature", "full_signature"],
  brand_presence: ["absent", "indirect", "present"],
  product_presence: ["absent", "indirect", "present"],
  question_presence: ["none", "one_simple_question"],
  personalization_level: ["low", "medium", "high"],
  energy: ["low", "medium", "matter_of_fact"],
  rhythm: ["single_breath", "broken", "plain", "as_if_from_phone"],
  punctuation: ["plain", "minimal", "fragmented"],
  first_person: ["absent", "light", "present"],
  formality: ["informal", "neutral", "formal"],
};

function optionalString(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text.length ? text : null;
}

function boolValue(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").toLowerCase());
}

function hashInt(input) {
  const digest = crypto.createHash("sha256").update(String(input)).digest();
  return digest.readUInt32BE(0);
}

function pick(options, seed) {
  return options[hashInt(seed) % options.length];
}

function buildVariationMatrix(input, attempt) {
  const seed = [
    input.tenantKey || "unknown",
    input.fromEmail || "unknown",
    input.domainRole || "unknown",
    input.subject || "",
    attempt,
  ].join(":");
  const intentType = COPY_INTENT_TYPES[hashInt(`${seed}:intent`) % COPY_INTENT_TYPES.length];
  const matrix = {};

  for (const [axis, options] of Object.entries(VARIATION_AXES)) {
    matrix[axis] = pick(options, `${seed}:${axis}`);
  }

  matrix.cta = "none";
  matrix.question_presence = "none";

  if (intentType === "context_clarification" || intentType === "human_reaction") {
    matrix.question_presence = "one_simple_question";
    matrix.cta = "soft";
  }
  if (intentType.includes("no_close") || intentType === "one_line_thought") {
    matrix.closing = "none";
    matrix.structure = intentType === "one_line_thought" ? "single_line" : "no_traditional_close";
  }
  if (intentType.includes("formal")) {
    matrix.tone = "formal_sober";
    matrix.formality = "formal";
  }
  if (intentType.includes("casual") || intentType.includes("informal")) {
    matrix.tone = "casual_direct";
    matrix.formality = "informal";
  }
  if (intentType.includes("longer")) {
    matrix.length = "long";
  }
  if (intentType.includes("one_line")) {
    matrix.length = "very_short";
    matrix.structure = "single_line";
    matrix.closing = "none";
  }
  if (intentType === "low_energy_note") {
    matrix.energy = "low";
    matrix.cta = "none";
  }

  return {
    copy_intent_type: intentType,
    copy_variation_matrix: matrix,
  };
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function bodyToHtml(value) {
  return String(value || "")
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, "<br>")}</p>`)
    .join("\n");
}

function getBody(campaign) {
  return String(
    campaign.plain_text ||
      campaign.plainText ||
      campaign.html_text ||
      campaign.htmlText ||
      ""
  );
}

function getSubject(campaign) {
  return String(campaign.subject || campaign.title || "");
}

function normalizeSubjectForComparison(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function variantSubjectUnchanged(originalSubject, variantSubject) {
  const original = normalizeSubjectForComparison(originalSubject);
  const variant = normalizeSubjectForComparison(variantSubject);
  return Boolean(original && variant && original === variant);
}

function fallbackVariantSubject(input, variant, attempt) {
  const options = [
    "Nota breve",
    "Un comentario",
    "Punto para revisar",
    "Referencia corta",
    "Lo dejo ubicado",
    "Detalle suelto",
    "Apunte rapido",
    "Contexto breve",
  ];
  const seed = [
    input.tenantKey || "unknown",
    input.fromEmail || "unknown",
    input.subject || "",
    variant.copy_intent_type || "",
    attempt,
  ].join(":");

  let subject = options[hashInt(seed) % options.length];
  if (variantSubjectUnchanged(input.subject, subject)) {
    subject = options[(hashInt(`${seed}:fallback`) + 1) % options.length];
  }
  return subject;
}

function ensureVariantSubjectChanged(input, variant, attempt) {
  if (!variantSubjectUnchanged(input.subject, variant.variant_subject)) {
    return variant;
  }

  const changedLayers = Array.isArray(variant.changed_layers)
    ? Array.from(new Set([...variant.changed_layers, "subject"]))
    : ["subject"];

  return {
    ...variant,
    variant_subject: fallbackVariantSubject(input, variant, attempt),
    changed_layers: changedLayers,
  };
}

function variantsEnabled(config) {
  return boolValue(config.fingerprintVariantsEnabled);
}

function variantsMode(config) {
  const mode = String(config.fingerprintVariantsMode || "observe_only").toLowerCase();
  return ["observe_only", "enforce"].includes(mode) ? mode : "observe_only";
}

function maxAttempts(config) {
  const parsed = Number.parseInt(String(config.fingerprintVariantMaxAttempts || 3), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, 5) : 3;
}

function timeoutMs(config) {
  const parsed = Number.parseInt(String(config.fingerprintVariantTimeoutMs || 20000), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 20000;
}

function buildVariantCampaign(campaign, variant, metadata) {
  const sourceJson = campaign.source_json || campaign.sourceJson || {};
  const variantBody = String(variant.variant_body || "").trim();
  const variantSubject = String(variant.variant_subject || "").trim();
  const variantHtml = bodyToHtml(variantBody);
  const variantMetadata = {
    fingerprint_variant: true,
    fingerprint_variant_strategy: variant.variant_strategy,
    fingerprint_variant_changed_layers: variant.changed_layers || [],
    fingerprint_variant_model: metadata.model,
    fingerprint_variant_attempt: metadata.attempt,
    fingerprint_variant_parent_event_id: metadata.parentFingerprintEventId || null,
    fingerprint_variant_intent_type: variant.copy_intent_type,
    fingerprint_variant_cta_level: variant.cta_level,
    fingerprint_variant_automation_risk: variant.automation_risk,
    fingerprint_variant_deliverability_notes: variant.deliverability_notes,
    fingerprint_variant_matrix: variant.copy_variation_matrix,
  };
  const variantSourceJson = {
    ...(sourceJson && typeof sourceJson === "object" && !Array.isArray(sourceJson) ? sourceJson : {}),
    ...variantMetadata,
  };

  return {
    ...campaign,
    ...variantMetadata,
    subject: variantSubject,
    title: variantSubject,
    plain_text: variantBody,
    plainText: variantBody,
    html_text: variantHtml,
    htmlText: variantHtml,
    source_json: variantSourceJson,
    sourceJson: variantSourceJson,
  };
}

function responseText(payload) {
  if (typeof payload.output_text === "string") return payload.output_text;

  const chunks = [];
  for (const item of payload.output || []) {
    for (const content of item.content || []) {
      if (typeof content.text === "string") chunks.push(content.text);
    }
  }

  return chunks.join("\n").trim();
}

function variationMatrixSchema() {
  const properties = {};
  const required = Object.keys(VARIATION_AXES);

  for (const [axis, options] of Object.entries(VARIATION_AXES)) {
    properties[axis] = { type: "string", enum: options };
  }

  return {
    type: "object",
    additionalProperties: false,
    required,
    properties,
  };
}

function variantSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: [
      "variant_subject",
      "variant_body",
      "variant_strategy",
      "copy_intent_type",
      "copy_variation_matrix",
      "cta_level",
      "changed_layers",
      "automation_risk",
      "deliverability_notes",
      "risk_notes",
      "safe_to_send",
    ],
    properties: {
      variant_subject: { type: "string" },
      variant_body: { type: "string" },
      variant_strategy: {
        type: "string",
        enum: [
          "human_note",
          "casual_observation",
          "neutral_note",
          "operational_note",
          "quiet_reflection",
          "contextual_follow_up",
          "reply_like",
        ],
      },
      copy_intent_type: {
        type: "string",
        enum: COPY_INTENT_TYPES,
      },
      copy_variation_matrix: variationMatrixSchema(),
      cta_level: {
        type: "string",
        enum: ["none", "soft", "direct"],
      },
      changed_layers: {
        type: "array",
        items: {
          type: "string",
          enum: [
            "subject",
            "opening",
            "structure",
            "cta",
            "length",
            "tone",
            "closing",
            "question_presence",
            "brand_presence",
            "product_presence",
            "energy",
            "rhythm",
            "punctuation",
            "first_person",
            "formality",
          ],
        },
      },
      automation_risk: {
        type: "string",
        enum: ["low", "medium", "high"],
      },
      deliverability_notes: { type: "string" },
      risk_notes: { type: "string" },
      safe_to_send: { type: "boolean" },
    },
  };
}

async function callOpenAI(config, input, feedback) {
  const apiKey = optionalString(config.openaiApiKey);
  const model = optionalString(config.fingerprintVariantModel);

  if (!apiKey) throw new Error("OPENAI_API_KEY is required for fingerprint variants");
  if (!model) throw new Error("FINGERPRINT_VARIANT_MODEL is required for fingerprint variants");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs(config));

  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        input: [
          {
            role: "system",
            content:
              "Create safe PowerEmail deliverability probe variants for Microsoft 365/Defender testing. The goal is NOT better SDR copy. The goal is ordinary human communication that is least identifiable as automated prospecting. Avoid the cold-outreach pattern: greeting, company observation, proof of research, exploratory question, invitation to talk, cordial close. Many messages should have no question, no CTA, no invitation, no sales intent, and no traditional close. Some may start without a greeting, be one sentence, feel like a quick note, a context remark, a casual observation, an internal-style note, a human reaction, or a continuation of a conversation. Never use urgency, discounts, promotions, grand claims, fake personal knowledge, pressure, newsletter language, or sales-development wording. Return only the structured output.",
          },
          {
            role: "user",
            content: JSON.stringify({
              task: "Create one non-SDR, human-normal variant for a reserve or standby deliverability probe.",
              original_subject: input.subject,
              original_body: input.body,
              tenant_key: input.tenantKey,
              from_email: input.fromEmail,
              domain_role: input.domainRole,
              required_copy_intent_type: input.variationContract.copy_intent_type,
              required_variation_matrix: input.variationContract.copy_variation_matrix,
              hard_constraints: [
                "Do not sound like a seller, SDR, cold outreach tool, prospecting sequence, or newsletter.",
                "The variant_subject must be different from the original_subject, while staying natural and non-promotional.",
                "Avoid: Hola, Observe, Vi que, Note que, He estado revisando, Me llamo la atencion.",
                "Avoid: Como manejan actualmente, Han considerado, Te interesaria, Estarias abierto a.",
                "Avoid: Si tiene sentido, Si te parece util, Quedo atento, Espero tus comentarios, Saludos cordiales.",
                "No urgency language.",
                "No gratis/oferta/promocion/descuento/ultima oportunidad.",
                "No grand claims.",
                "No links unless the original explicitly had links; do not add new URLs.",
                "No attachments.",
                "No more than one question; prefer no question unless the matrix requires one.",
                "No explicit invitation unless the matrix CTA is soft; never make a meeting/demo CTA.",
                "Before returning, ask: does this look like automated cold outreach? If yes, rewrite it.",
              ],
              previous_validation_feedback: feedback || null,
            }),
          },
        ],
        text: {
          format: {
            type: "json_schema",
            name: "poweremail_fingerprint_variant",
            strict: true,
            schema: variantSchema(),
          },
        },
      }),
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(
        `OpenAI variant request failed: ${response.status} ${JSON.stringify(payload).slice(0, 500)}`
      );
    }

    const text = responseText(payload);
    if (!text) throw new Error("OpenAI variant response did not include output text");
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

async function generateFingerprintVariant(config, campaign, context = {}) {
  if (!variantsEnabled(config)) {
    return { ok: false, skipped: true, reason: "variants_disabled" };
  }

  if (variantsMode(config) !== "enforce") {
    return { ok: false, skipped: true, reason: "variants_not_enforced" };
  }

  const input = {
    subject: getSubject(campaign),
    body: getBody(campaign),
    tenantKey: context.tenantKey || null,
    fromEmail: context.fromEmail || campaign.from_email || campaign.fromEmail || null,
    domainRole: context.domainRole || "reserve",
  };
  let feedback = null;

  for (let attempt = 1; attempt <= maxAttempts(config); attempt += 1) {
    input.variationContract = buildVariationMatrix(input, attempt);
    const generatedVariant = await callOpenAI(config, input, feedback);
    const variant = ensureVariantSubjectChanged(input, generatedVariant, attempt);
    if (!variant.safe_to_send) {
      feedback = { safe_to_send: false, risk_notes: variant.risk_notes || "" };
      continue;
    }

    const variantCampaign = buildVariantCampaign(campaign, variant, {
      model: config.fingerprintVariantModel,
      attempt,
      parentFingerprintEventId: context.parentFingerprintEventId || null,
    });
    const validation = validateFingerprintVariant(campaign, variantCampaign, config);

    if (validation.valid) {
      const validationMetadata = {
        fingerprint_variant_validation: validation.checks || null,
        fingerprint_variant_validated_at: new Date().toISOString(),
      };
      const sourceJson = {
        ...(variantCampaign.source_json || variantCampaign.sourceJson || {}),
        ...validationMetadata,
      };

      return {
        ok: true,
        campaign: {
          ...variantCampaign,
          ...validationMetadata,
          source_json: sourceJson,
          sourceJson,
        },
        variant,
        validation,
        attempt,
      };
    }

    feedback = validation.checks;
  }

  return {
    ok: false,
    skipped: false,
    reason: "variant_validation_failed",
    feedback,
  };
}

module.exports = {
  generateFingerprintVariant,
};
