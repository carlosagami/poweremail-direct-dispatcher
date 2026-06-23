"use strict";

const { buildContentFingerprints } = require("./fingerprint");
const { normalizeBody, normalizeSubject } = require("./normalizer");

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
  const originalBody = normalizeBody(getBody(originalCampaign));
  const variantBody = normalizeBody(getBody(variantCampaign));
  const originalFingerprints = buildContentFingerprints(originalCampaign);
  const variantFingerprints = buildContentFingerprints(variantCampaign);
  const ngramOverlap = maxNgramOverlap(originalBody, variantBody);
  const first200Overlap = firstWindowOverlap(originalBody, variantBody, 200);
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

  const checks = {
    subjectChanged: Boolean(originalSubject && variantSubject && originalSubject !== variantSubject),
    bodyChanged: Boolean(originalBody && variantBody && originalBody !== variantBody),
    contentFingerprintChanged:
      originalFingerprints.content_fingerprint !== variantFingerprints.content_fingerprint,
    ngramOverlap,
    maxAllowedNgramOverlap,
    first200Overlap,
    maxAllowedFirstWindowOverlap,
    changedLayers,
    minChangedLayers,
  };

  const valid =
    checks.subjectChanged &&
    checks.bodyChanged &&
    checks.contentFingerprintChanged &&
    checks.ngramOverlap <= checks.maxAllowedNgramOverlap &&
    checks.first200Overlap <= checks.maxAllowedFirstWindowOverlap &&
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
