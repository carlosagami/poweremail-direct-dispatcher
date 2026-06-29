"use strict";

const { buildContentFingerprints } = require("./fingerprint");
const {
  extractUrlDomains,
  normalizeBody,
  normalizeSubject,
} = require("./normalizer");

const EMAIL_ADDRESS_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const QUESTION_PATTERN = /[?¿]/g;
const URL_PATTERN = /\bhttps?:\/\/\S+/i;

const FORBIDDEN_TERMS = [
  "gratis",
  "oferta",
  "promocion",
  "promoción",
  "descuento",
  "ultima oportunidad",
  "última oportunidad",
  "urgente",
  "aprovecha ahora",
  "solo por hoy",
  "garantizado",
  "imperdible",
];

const REQUIRED_MATRIX_AXES = [
  "opening",
  "length",
  "tone",
  "cta",
  "structure",
  "closing",
  "brand_presence",
  "product_presence",
  "question_presence",
  "personalization_level",
];

function clampNumber(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function tokenize(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9áéíóúüñ]+/gi, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

function ngrams(tokens, size) {
  const result = new Set();
  if (tokens.length < size) return result;

  for (let index = 0; index <= tokens.length - size; index += 1) {
    result.add(tokens.slice(index, index + size).join(" "));
  }

  return result;
}

function overlapRatio(left, right) {
  if (left.size === 0 && right.size === 0) return 0;
  if (left.size === 0 || right.size === 0) return 0;

  let overlap = 0;
  for (const item of left) {
    if (right.has(item)) overlap += 1;
  }

  return overlap / Math.min(left.size, right.size);
}

function maxNgramOverlap(originalBody, variantBody) {
  const originalTokens = tokenize(originalBody);
  const variantTokens = tokenize(variantBody);
  let maxOverlap = 0;

  for (let size = 4; size <= 8; size += 1) {
    maxOverlap = Math.max(
      maxOverlap,
      overlapRatio(ngrams(originalTokens, size), ngrams(variantTokens, size))
    );
  }

  return maxOverlap;
}

function textPrefix(value, length) {
  return tokenize(String(value || "").slice(0, length)).join(" ");
}

function firstWindowOverlap(originalBody, variantBody, length) {
  const original = new Set(tokenize(textPrefix(originalBody, length)));
  const variant = new Set(tokenize(textPrefix(variantBody, length)));
  return overlapRatio(original, variant);
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

function sourceJson(campaign) {
  const raw = campaign.source_json || campaign.sourceJson || {};
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
}

function normalizeForTermChecks(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function includesForbiddenTerms(value) {
  const normalized = normalizeForTermChecks(value);
  return FORBIDDEN_TERMS.filter((term) => normalized.includes(normalizeForTermChecks(term)));
}

function countQuestions(value) {
  return (String(value || "").match(QUESTION_PATTERN) || []).length;
}

function paragraphCount(value) {
  return String(value || "")
    .trim()
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean).length;
}

function wordCount(value) {
  return tokenize(value).length;
}

function lengthBucket(count) {
  if (count <= 12) return "very_short";
  if (count <= 45) return "short";
  if (count <= 110) return "medium";
  return "long";
}

function hasTemplateOpening(value) {
  return /^\s*(hola|buenos dias|buenos días|buenas tardes|buen dia|buen día)\b/i.test(
    String(value || "")
  );
}

function hasTemplateClosing(value) {
  return /(quedo atento|quedo atenta|quedamos atentos|saludos cordiales|cordialmente)\.?\s*$/i.test(
    String(value || "").trim()
  );
}

function hasValidVariationMatrix(matrix) {
  return Boolean(
    matrix &&
      typeof matrix === "object" &&
      !Array.isArray(matrix) &&
      REQUIRED_MATRIX_AXES.every((axis) => typeof matrix[axis] === "string" && matrix[axis].length > 0)
  );
}

function hasNoNewUrls(originalBody, variantBody) {
  const originalDomains = new Set(extractUrlDomains(originalBody));
  const variantDomains = extractUrlDomains(variantBody);
  if (variantDomains.length === 0) return true;
  if (originalDomains.size === 0) return false;
  return variantDomains.every((domain) => originalDomains.has(domain));
}

function validateFingerprintVariant(originalCampaign, variantCampaign, config = {}) {
  const maxAllowedNgramOverlap = clampNumber(
    config.fingerprintVariantMaxNgramOverlap,
    0.35,
    0,
    1
  );
  const maxAllowedFirstWindowOverlap = clampNumber(
    config.fingerprintVariantMaxFirstWindowOverlap,
    0.55,
    0,
    1
  );
  const minChangedLayers = Math.max(
    1,
    Number.parseInt(String(config.fingerprintVariantMinChangedLayers || 3), 10) || 3
  );

  const originalSubject = normalizeSubject(getSubject(originalCampaign));
  const variantSubject = normalizeSubject(getSubject(variantCampaign));
  const originalBodyRaw = getBody(originalCampaign);
  const variantBodyRaw = getBody(variantCampaign);
  const originalBody = normalizeBody(originalBodyRaw);
  const variantBody = normalizeBody(variantBodyRaw);
  const originalFingerprints = buildContentFingerprints(originalCampaign);
  const variantFingerprints = buildContentFingerprints(variantCampaign);
  const ngramOverlap = maxNgramOverlap(originalBody, variantBody);
  const first200Overlap = firstWindowOverlap(originalBody, variantBody, 200);
  const originalWordCount = wordCount(originalBodyRaw);
  const variantWordCount = wordCount(variantBodyRaw);
  const originalParagraphCount = paragraphCount(originalBodyRaw);
  const variantParagraphCount = paragraphCount(variantBodyRaw);
  const variantSourceJson = sourceJson(variantCampaign);
  const variationMatrix = variantSourceJson.fingerprint_variant_matrix || null;
  const changedLayers = [];

  if (originalSubject && variantSubject && originalSubject !== variantSubject) {
    changedLayers.push("subject");
  }
  if (originalBody && variantBody && originalBody !== variantBody) {
    changedLayers.push("body");
  }
  if (
    originalFingerprints.content_fingerprint &&
    variantFingerprints.content_fingerprint &&
    originalFingerprints.content_fingerprint !== variantFingerprints.content_fingerprint
  ) {
    changedLayers.push("content_fingerprint");
  }
  if (ngramOverlap <= maxAllowedNgramOverlap) {
    changedLayers.push("structure");
  }
  if (first200Overlap <= maxAllowedFirstWindowOverlap) {
    changedLayers.push("opening");
  }
  if (lengthBucket(originalWordCount) !== lengthBucket(variantWordCount)) {
    changedLayers.push("length");
  }
  if (originalParagraphCount !== variantParagraphCount) {
    changedLayers.push("paragraph_count");
  }

  const combinedVariantText = `${getSubject(variantCampaign)}\n${variantBodyRaw}`;
  const forbiddenTerms = includesForbiddenTerms(combinedVariantText);
  const questionCount = countQuestions(variantBodyRaw);
  const hasEmailAddress = EMAIL_ADDRESS_PATTERN.test(combinedVariantText);
  const hasUrl = URL_PATTERN.test(combinedVariantText);

  const checks = {
    subjectChanged: Boolean(originalSubject && variantSubject && originalSubject !== variantSubject),
    bodyChanged: Boolean(originalBody && variantBody && originalBody !== variantBody),
    contentFingerprintChanged:
      originalFingerprints.content_fingerprint !== variantFingerprints.content_fingerprint,
    ngramOverlap,
    maxAllowedNgramOverlap,
    first200Overlap,
    maxAllowedFirstWindowOverlap,
    originalWordCount,
    variantWordCount,
    originalLengthBucket: lengthBucket(originalWordCount),
    variantLengthBucket: lengthBucket(variantWordCount),
    originalParagraphCount,
    variantParagraphCount,
    questionCount,
    maxAllowedQuestions: 1,
    hasEmailAddress,
    hasUrl,
    noNewUrls: hasNoNewUrls(originalBodyRaw, variantBodyRaw),
    forbiddenTerms,
    hasTemplateOpening: hasTemplateOpening(variantBodyRaw),
    hasTemplateClosing: hasTemplateClosing(variantBodyRaw),
    hasVariationMatrix: hasValidVariationMatrix(variationMatrix),
    automationRisk: variantSourceJson.fingerprint_variant_automation_risk || null,
    ctaLevel: variantSourceJson.fingerprint_variant_cta_level || null,
    ctaMatchesMatrix:
      hasValidVariationMatrix(variationMatrix) &&
      variantSourceJson.fingerprint_variant_cta_level === variationMatrix.cta,
    intentType: variantSourceJson.fingerprint_variant_intent_type || null,
    changedLayers,
    minChangedLayers,
  };

  const valid =
    checks.subjectChanged &&
    checks.bodyChanged &&
    checks.contentFingerprintChanged &&
    checks.ngramOverlap <= checks.maxAllowedNgramOverlap &&
    checks.first200Overlap <= checks.maxAllowedFirstWindowOverlap &&
    checks.questionCount <= checks.maxAllowedQuestions &&
    !checks.hasEmailAddress &&
    checks.noNewUrls &&
    checks.forbiddenTerms.length === 0 &&
    !checks.hasTemplateClosing &&
    checks.hasVariationMatrix &&
    checks.ctaMatchesMatrix &&
    checks.automationRisk !== "high" &&
    Boolean(checks.intentType) &&
    changedLayers.length >= minChangedLayers;

  return {
    valid,
    checks,
    originalContentFingerprint: originalFingerprints.content_fingerprint,
    variantContentFingerprint: variantFingerprints.content_fingerprint,
  };
}

module.exports = {
  validateFingerprintVariant,
};
