import { GoogleGenAI } from "@google/genai";

function getClient() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "GEMINI_API_KEY is not set. The API key must be provided via environment " +
        "variable (never hardcoded).",
    );
  }
  return new GoogleGenAI({ apiKey });
}

/**
 * Baut die Quellenliste aus zwei getrennten Metadaten-Quellen der Gemini-API:
 * - groundingChunks: Treffer der Google-Suche
 * - urlContextMetadata: Seiten, die Gemini gezielt per URL Context gelesen hat
 * Beide Listen werden zusammengefuehrt und nach URL entduplifiziert.
 */
function buildSourceList(candidate) {
  const searchChunks = candidate?.groundingMetadata?.groundingChunks ?? [];
  const urlContextEntries = candidate?.urlContextMetadata?.urlMetadata ?? [];

  const seen = new Set();
  const sources = [];

  for (const chunk of searchChunks) {
    const uri = chunk.web?.uri;
    if (!uri || seen.has(uri)) continue;
    seen.add(uri);
    sources.push({ title: chunk.web?.title ?? uri, uri });
  }

  for (const entry of urlContextEntries) {
    const uri = entry.retrievedUrl;
    if (!uri || seen.has(uri)) continue;
    seen.add(uri);
    sources.push({ title: uri, uri });
  }

  return sources;
}

function formatSourcesBlock(sources) {
  if (sources.length === 0) return "";
  const list = sources
    .map((s, i) => `[${i + 1}] ${s.title} — ${s.uri}`)
    .join("\n");
  return `\n\nSources:\n${list}`;
}

/**
 * Baut den Antworttext aus den Parts der Antwort, statt `response.text` zu
 * nutzen. Der `.text`-Getter des SDK verwirft alles, was kein Textteil ist —
 * bei aktiviertem Code Execution also gerade den ausgefuehrten Code und dessen
 * Ergebnis — und schreibt dabei pro Aufruf eine Warnung nach stderr. Hier
 * kommen beide als Codebloecke mit in die Antwort, damit nachvollziehbar
 * bleibt, wie eine berechnete Zahl zustande gekommen ist.
 *
 * Code und Ergebnis kommen dabei ans ENDE, hinter den Antworttext. Die API
 * liefert die Parts in Ausfuehrungsreihenfolge, sodass die Antwort sonst mit
 * einem Codeblock beginnt und die eigentliche Auskunft erst darunter steht.
 * Der Rechenweg ist ein Beleg und gehoert damit dorthin, wo auch die
 * Quellenliste steht: hinter die Antwort, nicht davor.
 */
function buildText(candidate) {
  const textBlocks = [];
  const codeBlocks = [];

  for (const part of candidate?.content?.parts ?? []) {
    // Denk-Parts gehoeren nicht in die Ausgabe — ihr Umfang steht bereits als
    // Thinking-Tokens im Footer.
    if (part.thought) continue;

    if (part.text) {
      textBlocks.push(part.text);
    } else if (part.executableCode?.code) {
      // language ist das Language-Enum ("PYTHON"); LANGUAGE_UNSPECIFIED ergibt
      // keine sinnvolle Sprachangabe fuer den Codeblock.
      const language = (part.executableCode.language ?? "").toLowerCase();
      const fence = language.includes("unspecified") ? "" : language;
      // trimEnd, weil Code und Ausgabe mit einem Zeilenumbruch enden — sonst
      // steht eine Leerzeile vor dem schliessenden Codeblock.
      codeBlocks.push(`\`\`\`${fence}\n${part.executableCode.code.trimEnd()}\n\`\`\``);
    } else if (part.codeExecutionResult) {
      // outcome ist "OUTCOME_OK", "OUTCOME_FAILED", ... — das Praefix traegt
      // keine Information.
      const outcome =
        (part.codeExecutionResult.outcome ?? "").replace(/^OUTCOME_/, "") || "UNKNOWN";
      const output = (part.codeExecutionResult.output ?? "").trimEnd();
      codeBlocks.push(`Result (${outcome}):\n\`\`\`\n${output}\n\`\`\``);
    }
  }

  // Ueberschrift wie bei der Quellenliste, damit der nachgestellte Rechenweg
  // nicht als Fortsetzung des Antworttextes gelesen wird.
  if (codeBlocks.length > 0) codeBlocks.unshift("Code execution:");

  return [...textBlocks, ...codeBlocks].join("\n\n");
}

/**
 * Weist auf eine Antwort hin, die nicht regulaer zu Ende gelaufen ist. Ohne
 * diesen Hinweis saehe eine blockierte oder abgeschnittene Antwort wie ein
 * Erfolg aus: der Text fehlt oder bricht mitten im Satz ab, Quellenliste und
 * Footer stehen trotzdem unveraendert darunter.
 */
function formatNotice({ text, candidate, promptFeedback }) {
  const blockReason = promptFeedback?.blockReason;
  if (blockReason) {
    return `\n\n⚠️ Request blocked by the API — blockReason: ${blockReason}`;
  }

  const finishReason = candidate?.finishReason;
  if (text === "") {
    return `\n\n⚠️ The response contained no text — finishReason: ${finishReason ?? "unknown"}`;
  }
  // STOP ist der regulaere Abschluss. Alles andere — vor allem MAX_TOKENS —
  // bedeutet eine abgeschnittene Antwort, die sonst vollstaendig wirkt.
  if (finishReason && finishReason !== "STOP") {
    return `\n\n⚠️ The response is incomplete — finishReason: ${finishReason}`;
  }
  return "";
}

function formatFooter({ usageMetadata, model, thinkingLevel, sourceCount }) {
  const inputTokens = usageMetadata?.promptTokenCount ?? 0;
  const outputTokens = usageMetadata?.candidatesTokenCount ?? 0;
  const thinkingTokens = usageMetadata?.thoughtsTokenCount ?? 0;
  return (
    `\n\n---\n🔢 ${inputTokens} input / ${outputTokens} output / ${thinkingTokens} thinking tokens ` +
    `| 🔍 ${sourceCount} sources | 🤖 ${model} (thinking: ${thinkingLevel})`
  );
}

/**
 * Fuehrt eine Gemini-Recherche mit allen drei Built-in-Tools durch
 * (Google Search, URL Context, Code Execution) und haengt Quellenliste
 * sowie Token-Footer an den Antworttext an.
 */
export async function runSearch({ query, model, thinkingLevel }) {
  const ai = getClient();

  const response = await ai.models.generateContent({
    model,
    contents: query,
    config: {
      tools: [{ googleSearch: {} }, { urlContext: {} }, { codeExecution: {} }],
      thinkingConfig: { thinkingLevel },
    },
  });

  const candidate = response.candidates?.[0];
  const sources = buildSourceList(candidate);

  const text = buildText(candidate);
  const notice = formatNotice({
    text,
    candidate,
    promptFeedback: response.promptFeedback,
  });
  const sourcesBlock = formatSourcesBlock(sources);
  const footer = formatFooter({
    usageMetadata: response.usageMetadata,
    model,
    thinkingLevel,
    sourceCount: sources.length,
  });

  // Der Footer bleibt in jedem Fall der letzte Bestandteil der Antwort.
  return text + notice + sourcesBlock + footer;
}

/** Kuerzt eine Tokenzahl lesbar ab: 1048576 -> 1M, 65536 -> 64k. */
function formatTokenLimit(limit) {
  if (typeof limit !== "number") return "?";
  if (limit >= 1024 * 1024) return `${Math.round(limit / (1024 * 1024))}M`;
  if (limit >= 1024) return `${Math.round(limit / 1024)}k`;
  return String(limit);
}

/**
 * Ob ein Modell mit DIESEM Server funktioniert. Zwei Bedingungen, beide aus
 * den Angaben der API selbst statt aus dem Modellnamen — ein Namensmuster
 * wuerde bei jeder neuen Modellfamilie brechen (Codenamen wie
 * "nano-banana-pro-preview" verraten nichts ueber die Faehigkeiten):
 * - generateContent: erzeugt ueberhaupt Text (schliesst Embeddings, Imagen,
 *   Veo und die Live-/Audio-Modelle aus)
 * - thinking: akzeptiert ein Thinking-Level. runSearch schickt immer eines
 *   mit, andernfalls antwortet die API mit
 *   400 "Thinking level is not supported for this model."
 */
function isUsableModel(model) {
  return (model.supportedActions ?? []).includes("generateContent") && model.thinking === true;
}

/** Warum ein Modell nicht in der Standardliste steht — nur fuer die --all-Ansicht. */
function modelStatus(model) {
  const actions = model.supportedActions ?? [];
  if (!actions.includes("generateContent")) return actions[0] ?? "no generateContent";
  return model.thinking === true ? "thinking" : "no thinking";
}

/**
 * Listet die fuer den aktuellen API-Key verfuegbaren Modelle mit Token-Limits.
 * Standardmaessig nur die, die mit diesem Server nutzbar sind; mit all=true
 * die vollstaendige Liste inkl. Statusspalte.
 *
 * Die Liste sagt nichts ueber die Verfuegbarkeit aus: abgekuendigte Modelle
 * erscheinen weiterhin, antworten aber mit 404. Ein Feld dafuer gibt es nicht.
 */
export async function listModels({ all = false } = {}) {
  const ai = getClient();
  const pager = await ai.models.list({ config: { pageSize: 50 } });

  const models = [];
  for await (const model of pager) models.push(model);
  if (models.length === 0) return "No models available for this API key.";

  const usable = models.filter(isUsableModel);

  // Sicherung gegen ein leeres Ergebnis, falls die API die ausgewerteten
  // Felder einmal nicht mehr liefert: dann lieber die volle Liste zeigen als
  // gar keine.
  const filterFailed = usable.length === 0;
  const showAll = all || filterFailed;
  const shown = [...(showAll ? models : usable)];

  const name = (model) => (model.name ?? "?").replace(/^models\//, "");
  shown.sort((a, b) => name(a).localeCompare(name(b)));
  const width = Math.max(...shown.map((model) => name(model).length));

  const lines = shown.map((model) => {
    const limits =
      `${formatTokenLimit(model.inputTokenLimit).padStart(4)} in / ` +
      `${formatTokenLimit(model.outputTokenLimit).padStart(4)} out`;
    const status = showAll ? `  ${modelStatus(model)}` : "";
    return `${name(model).padEnd(width)}  ${limits}${status}`;
  });

  let note;
  if (filterFailed) {
    note =
      `All ${models.length} models — the usability filter matched nothing, so ` +
      "nothing is hidden. Check whether the API still reports supportedActions and thinking.";
  } else if (all) {
    note =
      `All ${models.length} models. Only the ${usable.length} marked "thinking" work with ` +
      "this server, which always sends a thinking level. Being listed is no guarantee " +
      "a model still answers — retired ones stay in this list and return 404.";
  } else {
    note =
      `${usable.length} of ${models.length} models usable with this server (text generation ` +
      "plus thinking level support). Request all models to see the rest.";
  }

  return `${lines.join("\n")}\n\n${note}`;
}
