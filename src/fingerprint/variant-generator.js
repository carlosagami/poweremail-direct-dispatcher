"use strict";

const crypto = require("crypto");
const { validateFingerprintVariant } = require("./similarity-validator");

const COPY_INTENT_TYPES = [
  "brief_human_note_no_cta",
  "single_line_specific_question",
  "soft_reflective_message",
  "contextual_follow_up_no_sale",
  "operational_or_logistical_comment",
  "process_observation",
  "courtesy_message",
  "micro_consultation",
  "longer_personal_explanation",
  "casual_direct_message",
  "formal_sober_message",
  "collaborative_message",
  "no_question_message",
  "one_question_message",
  "minimal_close_message",
  "no_traditional_close_message",
  "short_signature_message",
  "full_signature_message",
  "no_benefit_language_message",
  "no_sales_words_message",
];

const VARIATION_AXES = {
  opening: ["no_salutation", "first_person_note", "context_first", "direct_observation", "brief_courtesy"],
  length: ["very_short", "short", "medium", "long"],
  tone: ["casual_direct", "formal_sober", "collaborative", "soft_reflective", "operational", "courteous"],
  cta: ["none", "soft", "direct"],
  structure: [
    "single_line",
    "one_paragraph",
    "two_short_paragraphs",
    "operational_note",
    "personal_explanation",
    "no_traditional_close",
  ],
  closing: ["none", "minimal", "natural_sentence", "short_signature", "full_signature"],
  brand_presence: ["absent", "indirect", "present"],
  product_presence: ["absent", "indirect", "present"],
  question_presence: ["none", "one_simple_question", "contextual_question"],
  personalization_level: ["low", "medium", "high"],
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

  if (intentType.includes("no_cta") || intentType.includes("no_question") || intentType.includes("courtesy")) {
    matrix.cta = "none";
  }
  if (intentType.includes("one_question") || intentType.includes("question")) {
    matrix.question_presence = "one_simple_question";
  }
  if (intentType.includes("no_question")) {
    matrix.question_presence = "none";
  }
  if (intentType.includes("no_traditional_close")) {
    matrix.closing = "none";
    matrix.structure = "no_traditional_close";
  }
  if (intentType.includes("formal")) {
    matrix.tone = "formal_sober";
  }
  if (intentType.includes("casual")) {
    matrix.tone = "casual_direct";
  }
  if (intentType.includes("longer")) {
    matrix.length = "long";
    matrix.structure = "personal_explanation";
  }
  if (intentType.includes("single_line")) {
    matrix.length = "very_short";
    matrix.structure = "single_line";
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
          "new_angle",
          "softer_cta",
          "technical_probe",
          "reply_only",
          "human_note",
          "operational_note",
          "contextual_follow_up",
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
              "You create safe PowerEmail deliverability probe variants for Microsoft 365/Defender testing. These are non-commercial diagnostic, warmup, and initial-conversation emails. Preserve the broad business context, but produce genuinely different human-written copy with a distinct structure, rhythm, opening, length, tone, CTA level, closing, and intent. Do not spin synonyms. Do not add links, attachments, urgency, discounts, promotions, grand claims, fake personal knowledge, deceptive wording, pressure, newsletter language, or aggressive prospecting. Avoid repeated openings like 'Hola' and repeated closings like 'Quedo atento'. Return only the structured output.",
          },
          {
            role: "user",
            content: JSON.stringify({
              task: "Create one distinct variant for a reserve or standby deliverability probe.",
              original_subject: input.subject,
              original_body: input.body,
              tenant_key: input.tenantKey,
              from_email: input.fromEmail,
              domain_role: input.domainRole,
              required_copy_intent_type: input.variationContract.copy_intent_type,
              required_variation_matrix: input.variationContract.copy_variation_matrix,
              hard_constraints: [
                "No urgency language.",
                "No gratis/oferta/promocion/descuento/ultima oportunidad.",
                "No grand claims.",
                "No links unless the original explicitly had links; do not add new URLs.",
                "No attachments.",
                "No newsletter tone.",
                "No mass-campaign tone.",
                "No aggressive sales sequence tone.",
                "No more than one question.",
                "CTA must match the required cta axis.",
                "Body must match the required structure and length axis.",
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
    const variant = await callOpenAI(config, input, feedback);
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
