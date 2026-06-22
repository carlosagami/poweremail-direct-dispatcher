"use strict";

function collapseWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function stripHtml(value) {
  return String(value || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ");
}

function decodeBasicEntities(value) {
  return String(value || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'");
}

function normalizeSubject(value) {
  return collapseWhitespace(
    decodeBasicEntities(value)
      .toLowerCase()
      .replace(/^\s*(re|fw|fwd)\s*:\s*/i, "")
  );
}

function normalizeBody(value) {
  return collapseWhitespace(
    decodeBasicEntities(stripHtml(value))
      .toLowerCase()
      .replace(/\bhttps?:\/\/\S+/g, " ")
  );
}

function extractUrlDomains(value) {
  const text = String(value || "");
  const domains = new Set();
  const regex = /\bhttps?:\/\/[^\s"'<>]+/gi;
  let match;

  while ((match = regex.exec(text))) {
    try {
      const url = new URL(match[0]);
      const hostname = url.hostname.toLowerCase().replace(/^www\./, "");
      if (hostname) domains.add(hostname);
    } catch (_) {}
  }

  return Array.from(domains).sort();
}

module.exports = {
  extractUrlDomains,
  normalizeBody,
  normalizeSubject,
};
