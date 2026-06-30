"use strict";

const OPENAI_URL_PATTERN = /^https:\/\/api\.openai\.com\/v1\/(responses|chat\/completions)$/;

const FORBIDDEN_COPY_PATTERNS = [
  /\bhola[,.\s]/i,
  /\bobserv[eé]/i,
  /\bvi que\b/i,
  /\bnot[eé] que\b/i,
  /\bhe estado revisando\b/i,
  /\bme llam[oó] la atenci[oó]n\b/i,
  /\bc[oó]mo manejan actualmente\b/i,
  /\bhan considerado\b/i,
  /\bte interesar[ií]a\b/i,
  /\bestar[ií]as abierto\b/i,
  /\bsi tiene sentido\b/i,
  /\bsi te parece [uú]til\b/i,
  /\bquedo atent[oa]\b/i,
  /\bespero tus comentarios\b/i,
  /\bsaludos cordiales\b/i,
  /\bagenda una llamada\b/i,
  /\bte ofrecemos\b/i,
  /\bcontamos con\b/i,
];

const FORBIDDEN_SUBJECT_PATTERNS = [
  /^\s*una consulta sobre\b/i,
  /^\s*un detalle sobre\b/i,
  /^\s*consultando sobre\b/i,
  /^\s*una pregunta sobre\b/i,
  /^\s*has considerado\b/i,
  /^\s*\?has considerado\b/i,
];

const CTA_PATTERNS = [
  /\bresponder\b/i,
  /\bconversar\b/i,
  /\breuni[oó]n\b/i,
  /\bllamada\b/i,
  /\bagendar\b/i,
  /\bplaticar\b/i,
  /\bsi quieres\b/i,
  /\bsi gustas\b/i,
];

function parseJsonLineAfter(prompt, marker) {
  const lines = String(prompt || "").split("\n");
  const index = lines.findIndex((line) => line.trim() === marker);
  if (index < 0 || !lines[index + 1]) return null;
  try {
    return JSON.parse(lines[index + 1]);
  } catch (_) {
    return null;
  }
}

function extractPrompt(requestBody) {
  if (!requestBody || typeof requestBody !== "object") return "";
  if (typeof requestBody.input === "string") return requestBody.input;
  if (Array.isArray(requestBody.messages)) {
    return requestBody.messages.map((message) => message && message.content).filter(Boolean).join("\n");
  }
  return "";
}

function extractGeneratedText(body) {
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

function parseGeneratedCopy(body) {
  const text = extractGeneratedText(body);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (_) {
    return null;
  }
}

function hasPattern(patterns, value) {
  return patterns.some((pattern) => pattern.test(String(value || "")));
}

function questionCount(value) {
  return (String(value || "").match(/[?¿]/g) || []).length;
}

function aiCopyLooksLikeOutreach(copy, style) {
  const subject = String(copy?.subject || "");
  const plainText = String(copy?.plainText || copy?.plain_text || "");
  const combined = `${subject}\n${plainText}`;
  const matrix = style?.matrix || {};

  if (hasPattern(FORBIDDEN_SUBJECT_PATTERNS, subject)) return true;
  if (hasPattern(FORBIDDEN_COPY_PATTERNS, combined)) return true;
  if (matrix.question === "none" && questionCount(combined) > 0) return true;
  if (matrix.cta === "none" && hasPattern(CTA_PATTERNS, combined)) return true;
  return false;
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;");
}

function buildHtmlFromPlainText(plainText) {
  return String(plainText || "")
    .trim()
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, "<br>\n")}</p>`)
    .join("<br><br>\n");
}

function safeCopyFromStyle(style, data) {
  const styleId = style?.id || "quiet_observation";
  const topic = data?.topic || "este punto";
  const sender = data?.senderPersona || data?.senderDisplayName || "";

  const copies = {
    one_line_note: {
      subject: "Nota breve",
      plainText: `${topic}: lo dejaria asi por ahora.`,
    },
    phone_fragment: {
      subject: "Lo dejo anotado",
      plainText: `Solo para dejar anotado lo de ${topic}.\n\nLo demas puede esperar.`,
    },
    operational_comment: {
      subject: "Comentario operativo",
      plainText: `Registro esto como punto operativo.\n\n${topic} queda mejor si se mantiene con un criterio unico y sin mezclar explicaciones.\n\nNada adicional por ahora.`,
    },
    quiet_observation: {
      subject: "Un comentario",
      plainText: `Hay algo de ${topic} que conviene mirar con calma.\n\nA veces el dato pequeno termina ordenando mejor el resto.`,
    },
    single_question: {
      subject: "Pregunta corta",
      plainText: `Sobre ${topic}, cual dato dejamos como referencia principal?`,
    },
    long_personal_note: {
      subject: "Contexto breve",
      plainText: `Me quede pensando en ${topic}.\n\nNo lo pondria como un tema grande ni como algo para resolver con mucha vuelta.\n\nA veces alcanza con dejar clara una referencia y evitar que cada quien lo interprete distinto.\n\n${sender || "Lo dejo aqui."}`,
    },
    formal_record: {
      subject: "Registro breve",
      plainText: `Dejo constancia breve sobre ${topic}.\n\nEl punto queda registrado como referencia interna.`,
    },
    acknowledgement: {
      subject: "Anotado",
      plainText: `Recibido lo de ${topic}.\n\nQueda ubicado.`,
    },
    internal_note: {
      subject: "Nota interna",
      plainText: `Apunte interno sobre ${topic}.\n\nNo lo veo como conversacion larga; solo como una referencia para no perder consistencia.`,
    },
    neutral_clarification: {
      subject: "Para dejarlo claro",
      plainText: `Para dejarlo claro: ${topic} no necesita una explicacion extensa en este momento.\n\nCon mantener el criterio principal alcanza.`,
    },
  };

  const selected = copies[styleId] || copies.quiet_observation;
  return {
    subject: selected.subject,
    plainText: selected.plainText,
    htmlText: buildHtmlFromPlainText(selected.plainText),
  };
}

function replaceGeneratedText(body, safeCopy) {
  const replacement = JSON.stringify(safeCopy);
  if (typeof body.output_text === "string") {
    body.output_text = replacement;
    return body;
  }
  if (Array.isArray(body.output)) {
    for (const item of body.output) {
      if (!Array.isArray(item.content)) continue;
      for (const content of item.content) {
        if (typeof content.text === "string") {
          content.text = replacement;
          return body;
        }
      }
    }
  }
  if (Array.isArray(body.choices) && body.choices[0]?.message) {
    body.choices[0].message.content = replacement;
  }
  return body;
}

function responseFromJson(body, response) {
  return new Response(JSON.stringify(body), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

if (!globalThis.__POWEREMAIL_TEST_COPY_AI_GUARD_INSTALLED__) {
  globalThis.__POWEREMAIL_TEST_COPY_AI_GUARD_INSTALLED__ = true;
  const originalFetch = globalThis.fetch;

  if (typeof originalFetch === "function") {
    globalThis.fetch = async function guardedFetch(input, init) {
      const url = typeof input === "string" ? input : input?.url;
      const disabled = ["1", "true", "yes", "on"].includes(
        String(process.env.TEST_ORCHESTRATOR_AI_COPY_GUARD_DISABLED || "").toLowerCase()
      );

      if (disabled || !OPENAI_URL_PATTERN.test(String(url || ""))) {
        return originalFetch(input, init);
      }

      let requestBody = null;
      try {
        requestBody = JSON.parse(String(init?.body || "{}"));
      } catch (_) {}

      const prompt = extractPrompt(requestBody);
      const style = parseJsonLineAfter(prompt, "Estilo base requerido:");
      const data = parseJsonLineAfter(prompt, "Datos del envio:");
      const response = await originalFetch(input, init);

      if (!response.ok) return response;

      const text = await response.text();
      let body;
      try {
        body = JSON.parse(text);
      } catch (_) {
        return new Response(text, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      }

      const copy = parseGeneratedCopy(body);
      if (!copy || !aiCopyLooksLikeOutreach(copy, style)) {
        return responseFromJson(body, response);
      }

      const safeCopy = safeCopyFromStyle(style, data);
      const guardedBody = replaceGeneratedText(body, safeCopy);
      console.warn(
        JSON.stringify({
          ts: new Date().toISOString(),
          level: "warn",
          message: "test_orchestrator.ai_copy_guard_replaced",
          baseCopyStyle: style?.id || null,
          subject: copy.subject || null,
          replacementSubject: safeCopy.subject,
        })
      );
      return responseFromJson(guardedBody, response);
    };
  }
}
