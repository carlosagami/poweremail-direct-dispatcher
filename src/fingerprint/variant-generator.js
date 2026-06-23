"use strict";

const { validateFingerprintVariant } = require("./similarity-validator");

function optionalString(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text.length ? text : null;
}

function boolValue(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").toLowerCase());
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
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

function variantSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: [
      "variant_subject",
      "variant_body",
      "variant_strategy",
      "cta_type",
      "changed_layers",
      "risk_notes",
      "safe_to_send",
    ],
    properties: {
      variant_subject: { type: "string" },
      variant_body: { type: "string" },
      variant_strategy: {
        type: "string",
        enum: ["new_angle", "softer_cta", "technical_probe", "reply_only"],
      },
      cta_type: {
        type: "string",
        enum: ["none_or_soft", "reply_only", "meeting_booking", "click_cta"],
      },
      changed_layers: {
        type: "array",
        items: {
          type: "string",
          enum: ["subject", "opening", "structure", "cta", "length", "tone"],
        },
      },
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
              "You create safe PowerEmail deliverability probe variants. Preserve the business intent, but change subject, opening, structure and CTA enough to avoid repeated content fingerprints. Do not add misleading claims, fake personal knowledge, or aggressive language. Return only the structured output.",
          },
          {
            role: "user",
            content: JSON.stringify({
              task: "Create a distinct variant for a reserve or standby deliverability probe.",
              original_subject: input.subject,
              original_body: input.body,
              tenant_key: input.tenantKey,
              from_email: input.fromEmail,
              domain_role: input.domainRole,
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
