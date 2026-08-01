import { GoogleGenAI } from "@google/genai";
import { insertCitations } from "./citations.js";

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
 *
 * Liefert zusaetzlich chunkNumbers: die Zuordnung vom Index in
 * groundingChunks auf die Nummer in der AUSGEGEBENEN Liste. Beide Zaehlungen
 * laufen auseinander, weil groundingChunks Suchtreffer abbildet und nicht
 * Quellen — gemessen 17 Treffer bei 14 eindeutigen URLs. Ohne diese Zuordnung
 * verwiesen die Marker im Text auf Nummern, die es in der Liste nicht gibt.
 */
function buildSourceList(candidate) {
  const searchChunks = candidate?.groundingMetadata?.groundingChunks ?? [];
  const urlContextEntries = candidate?.urlContextMetadata?.urlMetadata ?? [];

  const numberByUri = new Map();
  const chunkNumbers = new Map();
  const sources = [];

  const addSource = (title, uri) => {
    if (!numberByUri.has(uri)) {
      sources.push({ title, uri });
      numberByUri.set(uri, sources.length);
    }
    return numberByUri.get(uri);
  };

  searchChunks.forEach((chunk, index) => {
    const uri = chunk.web?.uri;
    if (!uri) return;
    chunkNumbers.set(index, addSource(chunk.web?.title ?? uri, uri));
  });

  // URL-Context-Quellen stehen hinter den Suchtreffern und beeinflussen die
  // Nummerierung der Marker deshalb nicht.
  //
  // Gemessen an einer Anfrage mit konkreter URL: Die gelesene Seite stand
  // zusaetzlich als groundingChunk in der Antwort — mit echtem Seitentitel,
  // direkter URL und eigenen Supports. Sie kam ueber die Deduplizierung hier
  // also gar nicht mehr an und bekam trotzdem Marker. Hier landet nur eine
  // Seite, die NICHT zugleich Chunk ist; die bleibt dann ohne Marker, weil es
  // zu ihr keine Supports gibt.
  for (const entry of urlContextEntries) {
    if (entry.retrievedUrl) addSource(entry.retrievedUrl, entry.retrievedUrl);
  }

  return { sources, chunkNumbers };
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
 *
 * Hier werden ausserdem die Belegmarker gesetzt (siehe citations.js) —
 * bewusst an dieser Stelle, weil die Parts nur hier noch einzeln vorliegen:
 * Die Offsets der API zaehlen ab dem Anfang JEDES Parts, nach dem
 * join("\n\n") waeren sie ab dem zweiten Part um zwei Bytes verschoben.
 */
function buildText(candidate, { supports, chunkNumbers }) {
  const textBlocks = [];
  const codeBlocks = [];
  let dropped = 0;

  // forEach statt for...of: Der Schleifenindex IST der partIndex, auf den sich
  // segment.partIndex bezieht. Denk-Parts werden zwar uebersprungen, zaehlen
  // dabei aber mit — partIndex zaehlt ueber ALLE Parts des Kandidaten.
  (candidate?.content?.parts ?? []).forEach((part, partIndex) => {
    // Denk-Parts gehoeren nicht in die Ausgabe — ihr Umfang steht bereits als
    // Thinking-Tokens im Footer.
    if (part.thought) return;

    if (part.text) {
      // partIndex fehlt im JSON, wenn er 0 ist (Protobuf-Default), daher ?? 0.
      const result = insertCitations({
        text: part.text,
        supports: supports.filter((s) => (s.segment?.partIndex ?? 0) === partIndex),
        chunkNumbers,
      });
      textBlocks.push(result.text);
      dropped += result.dropped;
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
  });

  // Ueberschrift wie bei der Quellenliste, damit der nachgestellte Rechenweg
  // nicht als Fortsetzung des Antworttextes gelesen wird.
  if (codeBlocks.length > 0) codeBlocks.unshift("Code execution:");

  return { text: [...textBlocks, ...codeBlocks].join("\n\n"), dropped };
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

function formatFooter({ usageMetadata, model, thinkingLevel, sourceCount, dropped }) {
  const inputTokens = usageMetadata?.promptTokenCount ?? 0;
  const outputTokens = usageMetadata?.candidatesTokenCount ?? 0;
  const thinkingTokens = usageMetadata?.thoughtsTokenCount ?? 0;

  // Verworfene Marker gehoeren in den Footer, weil sie die Aussagekraft der
  // Antwort veraendern: Fehlt ein Marker, kann die Stelle ungegroundet sein —
  // oder die Pruefung hat ihn verworfen. Nur sichtbar, wenn es welche gab,
  // damit der Normalfall den Footer nicht verlaengert.
  const droppedNote = dropped > 0 ? ` | ⚠️ ${dropped} markers dropped` : "";

  return (
    `\n\n---\n🔢 ${inputTokens} input / ${outputTokens} output / ${thinkingTokens} thinking tokens ` +
    `| 🔍 ${sourceCount} sources | 🤖 ${model} (thinking: ${thinkingLevel})${droppedNote}`
  );
}

/**
 * Fuehrt eine Gemini-Recherche mit allen drei Built-in-Tools durch
 * (Google Search, URL Context, Code Execution), setzt die Belegmarker in den
 * Antworttext und haengt Quellenliste sowie Token-Footer an.
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
  const { sources, chunkNumbers } = buildSourceList(candidate);

  // Das ?? [] ist die Absicherung gegen eine Antwort ohne groundingMetadata —
  // dann laeuft alles unveraendert durch, nur ohne Marker.
  const { text, dropped } = buildText(candidate, {
    supports: candidate?.groundingMetadata?.groundingSupports ?? [],
    chunkNumbers,
  });

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
    dropped,
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
