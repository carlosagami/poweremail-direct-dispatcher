"use strict";

const HANDOFF_PATH_PATTERN = /\/handoff\/sendy-campaign-snapshot$/;

const TENANT_CONTEXTS = {
  colonyspaces: {
    brandName: "Colony Spaces",
    sender: "Eduardo",
    subjects: ["Detalle del espacio", "Referencia de agenda", "Punto de ubicacion"],
    defaultDetail:
      "Cuando una junta sale del ruido diario, el espacio ayuda a que la conversacion no se sienta improvisada.",
    defaultNote:
      "Para equipos que se mueven entre oficina, casa y visitas, esa diferencia se nota mas de lo que parece.",
    notes: [
      {
        pattern: /sala|junta|cliente|planeacion/i,
        detail:
          "Una sala de junta funciona mejor cuando permite llegar, sentarse y empezar sin resolver detalles en el momento.",
        note:
          "Eso pesa especialmente cuando hay clientes o decisiones que necesitan una conversacion tranquila.",
      },
      {
        pattern: /oficina|flexible|equipo|rota|fija/i,
        detail:
          "Una oficina flexible tiene sentido cuando la agenda cambia y no todo el equipo necesita el mismo lugar todos los dias.",
        note:
          "La utilidad esta en tener un punto confiable sin cargar con una oficina fija todo el mes.",
      },
    ],
  },
  decosimil: {
    brandName: "Deco-Simil",
    sender: "Andres",
    subjects: ["Detalle de material", "Nota de mantenimiento", "Referencia de acabado"],
    defaultDetail:
      "En materiales decorativos, la prueba real suele aparecer despues del uso diario y la limpieza frecuente.",
    defaultNote:
      "La textura, el color y el acabado tienen que seguir viendose bien cuando el espacio ya esta en operacion.",
    notes: [
      {
        pattern: /limpieza|mantenimiento|resisten|resistencia|durabilidad/i,
        detail:
          "Si un material se limpia seguido, no basta con que se vea bien en la muestra; tambien importa que conserve textura y acabado.",
        note:
          "En areas de uso diario, esa resistencia termina pesando mas que un detalle puramente decorativo.",
      },
      {
        pattern: /tela|vinil|acabado|transito|area|uso diario/i,
        detail:
          "Para espacios con transito constante, conviene elegir telas o viniles que no se castiguen rapido con el roce.",
        note:
          "Ahi la decision no es solo estetica; tambien es practica para mantener el lugar presentable.",
      },
      {
        pattern: /color|paleta/i,
        detail:
          "Una paleta de color funciona mejor cuando acompana el espacio sin cansarlo despues de unas semanas.",
        note:
          "El material puede llamar la atencion sin volverse lo unico que se ve.",
      },
    ],
  },
  georgieboy: {
    brandName: "Georgie Boy",
    sender: "Georgina",
    subjects: ["Detalle de talla", "Nota de calzado", "Referencia escolar"],
    defaultDetail:
      "En calzado infantil, la talla correcta se nota cuando el zapato acompana el dia sin quedar flojo ni apretar.",
    defaultNote:
      "Para escuela, recreo y caminatas cortas, la comodidad termina siendo tan importante como el diseno.",
    notes: [
      {
        pattern: /talla|espacio|floja/i,
        detail:
          "La talla ideal deja un poco de espacio para moverse, pero no tanto como para que el pie baile dentro del zapato.",
        note:
          "Ese punto medio ayuda a que el nino camine con mas seguridad durante el dia.",
      },
      {
        pattern: /suela|recreo|aguanta|rapido/i,
        detail:
          "Una suela escolar necesita resistir recreos, escaleras y uso constante sin vencerse demasiado pronto.",
        note:
          "No se trata solo de que el zapato este nuevo, sino de que aguante la rutina.",
      },
    ],
  },
  lester: {
    brandName: "Lester",
    sender: "Alejandro",
    subjects: ["Detalle de descanso", "Nota de soporte", "Referencia de colchon"],
    defaultDetail:
      "En descanso, el colchon correcto suele notarse cuando el cuerpo deja de compensar durante la noche.",
    defaultNote:
      "La comodidad importa, pero el soporte constante es lo que ayuda a que el descanso no dependa de una sola postura.",
    notes: [
      {
        pattern: /firmeza|soporte|rigida|cuerpo/i,
        detail:
          "La firmeza ayuda cuando sostiene el cuerpo sin sentirse como una superficie dura.",
        note:
          "Ese equilibrio hace que el descanso se sienta estable, no forzado.",
      },
      {
        pattern: /frescura|calurosa|noches/i,
        detail:
          "En noches calurosas, la frescura del colchon puede cambiar mucho la sensacion de descanso.",
        note:
          "Dormir sin acumular calor ayuda a despertar con menos interrupciones.",
      },
      {
        pattern: /medida|moverse|estorbar/i,
        detail:
          "La medida del colchon importa cuando permite moverse sin invadir el espacio de la otra persona.",
        note:
          "A veces el descanso mejora simplemente porque hay mas margen para cambiar de posicion.",
      },
    ],
  },
  shopology: {
    brandName: "Shopology",
    sender: "Carlos",
    subjects: ["Nota de seguimiento", "Referencia comercial", "Punto de proceso"],
    defaultDetail:
      "Un seguimiento comercial funciona mejor cuando deja claro que paso, que falta y quien debe mover el siguiente punto.",
    defaultNote:
      "Sin esa claridad, la conversacion se enfria aunque haya habido interes real.",
    notes: [
      {
        pattern: /nota|seguimiento|contexto|conversacion/i,
        detail:
          "Despues de una conversacion comercial, una nota clara ayuda a no reconstruir todo desde memoria.",
        note:
          "Lo importante es separar lo confirmado, lo pendiente y lo que todavia esta abierto.",
      },
      {
        pattern: /respuesta|objecion|criterio|proceso|guion/i,
        detail:
          "Las respuestas comerciales suenan mejor cuando tienen criterio, no cuando parecen salidas de un guion rigido.",
        note:
          "Ordenar las objeciones ayuda a contestar con mas calma y menos improvisacion.",
      },
    ],
  },
};

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

function pickContext(tenantKey, topic) {
  const context = TENANT_CONTEXTS[tenantKey] || {
    brandName: tenantKey || "PowerEmail",
    sender: "",
    subjects: ["Nota breve", "Referencia corta", "Punto simple"],
    defaultDetail: `Este punto sobre ${topic || "el tema"} queda mejor cuando se aterriza a una situacion concreta.`,
    defaultNote: "La referencia debe sonar humana, sobria y facil de entender.",
    notes: [],
  };
  const selected = context.notes.find((note) => note.pattern.test(String(topic || "")));
  return {
    context,
    detail: selected?.detail || context.defaultDetail,
    note: selected?.note || context.defaultNote,
  };
}

function stableIndex(value, count) {
  let hash = 0;
  for (const char of String(value || "")) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return count > 0 ? hash % count : 0;
}

function contextualCopy(payload) {
  const campaign = payload?.campaign || {};
  const sourceJson = campaign.source_json || {};
  const tenantKey = payload?.tenantKey || sourceJson.tenant_key || "";
  const topic = sourceJson.copy_topic || "este punto";
  const style = sourceJson.base_copy_style || "quiet_observation";
  const slotId = sourceJson.slot_id || campaign.id || topic;
  const { context, detail, note } = pickContext(tenantKey, topic);
  const subject = context.subjects[stableIndex(`${slotId}:${style}`, context.subjects.length)] || "Nota breve";
  const senderLine = context.sender || campaign.from_name || campaign.fromName || "";

  const bodies = {
    one_line_note: [detail],
    phone_fragment: [detail, note],
    operational_comment: ["Lo dejaria registrado asi.", detail, note],
    quiet_observation: [detail, note],
    single_question: [`Sobre ${topic}, el punto clave es si aplica al uso diario o solo a un caso puntual?`],
    long_personal_note: [`Me quede pensando en ${topic}.`, detail, note, senderLine || "Lo dejo aqui."],
    formal_record: [`Dejo constancia breve para ${context.brandName}.`, detail],
    acknowledgement: [detail, "Queda ubicado."],
    internal_note: [`Apunte interno sobre ${topic}.`, detail, note],
    neutral_clarification: [`Para dejarlo claro: ${topic} necesita una referencia concreta.`, detail],
  };
  const plainText = (bodies[style] || bodies.quiet_observation).join("\n\n");
  return {
    subject,
    plainText,
    htmlText: buildHtmlFromPlainText(plainText),
  };
}

function shouldRewrite(payload, url) {
  if (!HANDOFF_PATH_PATTERN.test(String(url || ""))) return false;
  const sourceJson = payload?.campaign?.source_json || {};
  if (sourceJson.source_system !== "poweremail-test-automation") return false;
  return sourceJson.copy_source === "local";
}

function rewritePayload(payload) {
  const copy = contextualCopy(payload);
  payload.campaign.subject = copy.subject;
  payload.campaign.title = copy.subject;
  payload.campaign.plain_text = copy.plainText;
  payload.campaign.plainText = copy.plainText;
  payload.campaign.html_text = copy.htmlText;
  payload.campaign.htmlText = copy.htmlText;
  payload.campaign.source_json.local_quality_guard = "contextual_v1";
  return { payload, copy };
}

if (!globalThis.__POWEREMAIL_TEST_LOCAL_COPY_QUALITY_GUARD_INSTALLED__) {
  globalThis.__POWEREMAIL_TEST_LOCAL_COPY_QUALITY_GUARD_INSTALLED__ = true;
  const originalFetch = globalThis.fetch;

  if (typeof originalFetch === "function") {
    globalThis.fetch = async function localCopyQualityGuardFetch(input, init = {}) {
      const url = typeof input === "string" ? input : input?.url;
      const disabled = ["1", "true", "yes", "on"].includes(
        String(process.env.TEST_ORCHESTRATOR_LOCAL_COPY_QUALITY_GUARD_DISABLED || "").toLowerCase()
      );

      if (disabled || !init?.body) {
        return originalFetch(input, init);
      }

      let payload = null;
      try {
        payload = JSON.parse(String(init.body));
      } catch (_) {}

      if (!payload || !shouldRewrite(payload, url)) {
        return originalFetch(input, init);
      }

      const rewritten = rewritePayload(payload);
      console.warn(
        JSON.stringify({
          ts: new Date().toISOString(),
          level: "warn",
          message: "test_orchestrator.local_copy_quality_guard_replaced",
          tenantKey: rewritten.payload.tenantKey || null,
          copyTopic: rewritten.payload.campaign?.source_json?.copy_topic || null,
          baseCopyStyle: rewritten.payload.campaign?.source_json?.base_copy_style || null,
          replacementSubject: rewritten.copy.subject,
        })
      );

      return originalFetch(input, {
        ...init,
        body: JSON.stringify(rewritten.payload),
      });
    };
  }
}
