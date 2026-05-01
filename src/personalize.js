function parseCustomFields(value) {
  if (!value) return {};
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch (_) {
    return {};
  }
}

function personalizeText(template, recipient) {
  if (!template) return "";
  const customFields = parseCustomFields(recipient.custom_fields_json);
  let output = String(template);

  output = output.replace(/\[Email\]/gi, recipient.email || "");
  output = output.replace(/\[Name(?:,fallback=([^\]]+))?\]/gi, (_, fallback) => {
    return recipient.subscriber_name || fallback || "";
  });

  for (const [key, value] of Object.entries(customFields)) {
    const pattern = new RegExp(`\\[${key}\\]`, "gi");
    output = output.replace(pattern, value == null ? "" : String(value));
  }

  return output;
}

module.exports = { personalizeText };
