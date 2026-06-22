"use strict";

const crypto = require("crypto");
const {
  extractUrlDomains,
  normalizeBody,
  normalizeSubject,
} = require("./normalizer");

function sha256(value) {
  return crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

function fingerprintOrNull(value) {
  return value ? sha256(value) : null;
}

function buildContentFingerprints(content) {
  const subject = normalizeSubject(content.subject || content.title || "");
  const body = normalizeBody(
    content.plain_text || content.plainText || content.html_text || content.htmlText || ""
  );
  const urlDomains = extractUrlDomains(
    `${content.html_text || content.htmlText || ""}\n${content.plain_text || content.plainText || ""}`
  );
  const urlText = urlDomains.join(",");

  return {
    subject_fingerprint: fingerprintOrNull(subject),
    body_fingerprint: fingerprintOrNull(body),
    url_fingerprint: fingerprintOrNull(urlText),
    content_fingerprint: fingerprintOrNull([subject, body, urlText].join("\n---\n")),
    campaign_fingerprint: fingerprintOrNull([subject, body].join("\n---\n")),
    url_domains: urlDomains,
  };
}

module.exports = { buildContentFingerprints };
