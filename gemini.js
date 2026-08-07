import { GoogleGenAI } from "@google/genai";
import { insertCitations } from "./citations.js";

/**
 * Wiederholungen bei voruebergehenden Fehlern. Ohne httpOptions.retryOptions
 * wiederholt das SDK NICHTS - dist/index.mjs beginnt apiCall() mit
 * "if (!retryOptions) { return fetch(url, requestInit); }", und einen Default
 * setzt es nirgends. Die Gemini-Doku behauptet pauschal, die offiziellen SDKs
 * haetten Retry ab Werk; belegt ist das nur fuers Python-SDK.
 *
 * 429 FEHLT ABSICHTLICH in der Liste - das ist der einzige nicht offensichtliche
 * Teil dieser Konfiguration. Googles Default waere
 * [408, 429, 500, 502, 503, 504], hier fehlt genau ein Eintrag, und das sieht
 * ohne diese Begruendung wie ein Tippfehler aus:
 *
 * Bei 429 liefert die API die Wartezeit selbst mit, als RetryInfo in
 * error.details ("retryDelay": "53s"). Das SDK wertet sie nicht aus - die
 * Zeichenkette "RetryInfo" kommt im gesamten Bundle nicht vor - und rechnet
 * stattdessen blind exponentiell. Bei den geforderten 53 Sekunden waeren alle
 * vier Versuche nach rund 15 Sekunden verbraucht, also lange bevor die Sperre
 * ueberhaupt ablaeuft. Fuer dasselbe Verhalten im Python-SDK laeuft
 * googleapis/python-genai#1875. Ein 429 kommt deshalb unveraendert und sofort
 * beim Client an, statt die Antwort um wirkungslose Wartezeit zu verlaengern.
 *
 * Bei 5xx und 408 gibt es keine Serverangabe, an der man sich ausrichten
 * koennte - dort ist blinder Backoff das einzig Moegliche und deshalb richtig.
 *
 * attempts zaehlt den Erstversuch mit. Vier Versuche bedeuten drei
 * Wiederholungen und mit den SDK-Defaults (initialDelay 1s, expBase 2, Jitter)
 * zwischen 7 und 14 Sekunden zusaetzlicher Wartezeit, bevor der Fehler kommt.
 *
 * Als exportierte Konstante, damit test/retry.test.js die Auslassung von 429
 * pruefen kann, ohne einen Client zu bauen oder SDK-Interna anzunehmen.
 */
export const RETRY_OPTIONS = {
  attempts: 4,
  httpStatusCodes: [408, 500, 502, 503, 504],
};

function getClient() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "GEMINI_API_KEY is not set. The API key must be provided via environment " +
        "variable (never hardcoded).",
    );
  }
  return new GoogleGenAI({ apiKey, httpOptions: { retryOptions: RETRY_OPTIONS } });
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
 * Quellen - gemessen 17 Treffer bei 14 eindeutigen URLs. Ohne diese Zuordnung
 * verwiesen die Marker im Text auf Nummern, die es in der Liste nicht gibt.
 *
 * INVARIANTE I1 (siehe CLAUDE.md und docs/specs.md, "Terms compliance"): JEDER
 * Chunk mit URI kommt in die Liste, auch wenn kein einziger Support auf ihn
 * zeigt. Dass hier weder gefiltert noch gekappt noch nach Domain dedupliziert
 * wird, ist keine Nachlaessigkeit, sondern Bedingung fuer die Nutzung von
 * Grounding with Google Search. Deduplizieren nach identischer URI ist erlaubt,
 * weil dabei kein Ziel verlorengeht - nach Domain nicht.
 */
export function buildSourceList(candidate) {
  const searchChunks = candidate?.groundingMetadata?.groundingChunks ?? [];
  const urlContextEntries = candidate?.urlContextMetadata?.urlMetadata ?? [];

  const numberByUri = new Map();
  const chunkNumbers = new Map();
  const sources = [];
  let skipped = 0;

  const addSource = (title, uri) => {
    if (!numberByUri.has(uri)) {
      sources.push({ title, uri });
      numberByUri.set(uri, sources.length);
    }
    return numberByUri.get(uri);
  };

  searchChunks.forEach((chunk, index) => {
    const uri = chunk.web?.uri;
    // Der einzige Pfad, auf dem hier ein Link verlorengehen kann. Bisher
    // liefert die API ausschliesslich web-Chunks, das ist gemessen; kaeme ein
    // zweiter Typ hinzu, verschwaenden dessen Links stillschweigend aus der
    // Liste und I1 waere gebrochen, ohne dass es jemand saehe. Mehr als das
    // Zaehlen ist ohne Kenntnis des unbekannten Typs nicht moeglich - der
    // Footer macht daraus wenigstens einen sichtbaren Verlust.
    if (!uri) {
      skipped++;
      return;
    }
    // chunk.web.title ?? uri ersetzt KEINEN vorhandenen Titel, sondern
    // beschriftet einen Eintrag, zu dem die API keinen mitgeliefert hat. Der
    // Titel ist laut Terms Bestandteil des Links (I2), ein vorhandener bleibt
    // deshalb unangetastet.
    chunkNumbers.set(index, addSource(chunk.web?.title ?? uri, uri));
  });

  // URL-Context-Quellen stehen hinter den Suchtreffern und beeinflussen die
  // Nummerierung der Marker deshalb nicht.
  //
  // Gemessen an einer Anfrage mit konkreter URL: Die gelesene Seite stand
  // zusaetzlich als groundingChunk in der Antwort - mit echtem Seitentitel,
  // direkter URL und eigenen Supports. Sie kam ueber die Deduplizierung hier
  // also gar nicht mehr an und bekam trotzdem Marker. Hier landet nur eine
  // Seite, die NICHT zugleich Chunk ist; die bleibt dann ohne Marker, weil es
  // zu ihr keine Supports gibt.
  for (const entry of urlContextEntries) {
    if (entry.retrievedUrl) addSource(entry.retrievedUrl, entry.retrievedUrl);
  }

  return { sources, chunkNumbers, skipped };
}

/**
 * INVARIANTE I2: `s.title` und `s.uri` gehen unveraendert hinaus. Die
 * Redirect-URLs sind lang und sehen nach einem Kuerzungskandidaten aus - sie
 * duerfen aber weder gekuerzt noch auf die Domain reduziert noch aufgeloest
 * werden (I3), und der Titel zaehlt ausdruecklich mit. Vier Zeilen, die harmlos
 * aussehen, und denen man den Titel als geschuetzten Bestandteil nicht ansieht:
 * siehe CLAUDE.md und docs/specs.md, "Terms compliance".
 */
export function formatSourcesBlock(sources) {
  if (sources.length === 0) return "";
  const list = sources
    .map((s, i) => `[${i + 1}] ${s.title} - ${s.uri}`)
    .join("\n");
  return `\n\nSources:\n${list}`;
}

/**
 * Baut den Antworttext aus den Parts der Antwort, statt `response.text` zu
 * nutzen. Der `.text`-Getter des SDK verwirft alles, was kein Textteil ist -
 * bei aktiviertem Code Execution also gerade den ausgefuehrten Code und dessen
 * Ergebnis - und schreibt dabei pro Aufruf eine Warnung nach stderr. Hier
 * kommen beide als Codebloecke mit in die Antwort, damit nachvollziehbar
 * bleibt, wie eine berechnete Zahl zustande gekommen ist.
 *
 * Code und Ergebnis kommen dabei ans ENDE, hinter den Antworttext. Die API
 * liefert die Parts in Ausfuehrungsreihenfolge, sodass die Antwort sonst mit
 * einem Codeblock beginnt und die eigentliche Auskunft erst darunter steht.
 * Der Rechenweg ist ein Beleg und gehoert damit dorthin, wo auch die
 * Quellenliste steht: hinter die Antwort, nicht davor.
 *
 * Hier werden ausserdem die Belegmarker gesetzt (siehe citations.js) -
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
  // dabei aber mit - partIndex zaehlt ueber ALLE Parts des Kandidaten.
  (candidate?.content?.parts ?? []).forEach((part, partIndex) => {
    // Denk-Parts gehoeren nicht in die Ausgabe - ihr Umfang steht bereits als
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
      // trimEnd, weil Code und Ausgabe mit einem Zeilenumbruch enden - sonst
      // steht eine Leerzeile vor dem schliessenden Codeblock.
      codeBlocks.push(`\`\`\`${fence}\n${part.executableCode.code.trimEnd()}\n\`\`\``);
    } else if (part.codeExecutionResult) {
      // outcome ist "OUTCOME_OK", "OUTCOME_FAILED", ... - das Praefix traegt
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
    return `\n\n⚠️ Request blocked by the API - blockReason: ${blockReason}`;
  }

  const finishReason = candidate?.finishReason;
  if (text === "") {
    return `\n\n⚠️ The response contained no text - finishReason: ${finishReason ?? "unknown"}`;
  }
  // STOP ist der regulaere Abschluss. Alles andere - vor allem MAX_TOKENS -
  // bedeutet eine abgeschnittene Antwort, die sonst vollstaendig wirkt.
  if (finishReason && finishReason !== "STOP") {
    return `\n\n⚠️ The response is incomplete - finishReason: ${finishReason}`;
  }
  return "";
}

// Zeichenbudget fuer die Zeile mit den abgesetzten Suchanfragen. Gemessen:
// ueblich 2 bis 6 Anfragen mit zusammen 73 bis 270 Zeichen, die einzelne
// Anfrage 29 bis 84 Zeichen - bei einer bewusst ueberbreiten Anfrage aber 11
// Anfragen mit ueber 500 Zeichen. Eine Obergrenze nennt die API nicht, deshalb
// die Kappung: 300 laesst den Normalfall unangetastet durch und faengt den
// Ausreisser ab, der den Footer sonst ueber mehrere Zeilen zieht.
const SEARCH_QUERY_BUDGET = 300;

/**
 * Baut die Footer-Zeile mit den Suchanfragen, die Gemini tatsaechlich an die
 * Google-Suche geschickt hat (groundingMetadata.webSearchQueries).
 *
 * Sie steht im Footer, weil sie eine Luecke sichtbar macht, die weder
 * Quellenliste noch Belegmarker zeigen: OB die Suche die Frage ueberhaupt
 * abgedeckt hat. Gemessen an einer Anfrage nach sechs Web-Frameworks suchte
 * Gemini sechsmal nur nach "<Framework> current version" - Bundle-Groesse und
 * Rendering-Strategie, ebenfalls gefragt, kamen unrecherchiert aus dem
 * Modellwissen. Der Antwort sah man das nicht an.
 *
 * Eigene Zeile statt Anhang an die Kennzahlen: zusammen waeren es im
 * gemessenen Extremfall 385 Zeichen, die im Terminal auf vier Zeilen
 * umbrechen - ausgerechnet bei den langen Antworten, wo der Footer die
 * Orientierung geben soll.
 *
 * Leeres Array ergibt einen leeren String und damit keine Zeile. Gleiche
 * Regel wie beim Hinweis auf verworfene Marker: Der Normalfall soll den Footer
 * nicht verlaengern.
 */
export function formatSearchQueries(queries = []) {
  if (queries.length === 0) return "";

  // Die Anfrage, die das Budget reisst, wird noch VOLLSTAENDIG geschrieben -
  // eine mitten im Wort abgeschnittene Suchanfrage ist wertlos. Der Ueberhang
  // ist dabei durch die Laenge einer einzelnen Anfrage begrenzt.
  const shown = [];
  let length = 0;
  for (const query of queries) {
    shown.push(query);
    // Das Trennzeichen zaehlt ab dem zweiten Eintrag mit, damit das Budget die
    // tatsaechliche Zeilenlaenge meint und nicht die Summe der Anfragen.
    length += query.length + (shown.length > 1 ? 3 : 0);
    if (length >= SEARCH_QUERY_BUDGET) break;
  }

  const rest = queries.length - shown.length;
  // " · " statt ", ": Die Suchanfragen enthalten selbst Anfuehrungszeichen und
  // Ziffernfolgen, zwischen denen ein Komma als Trenner untergeht.
  return `\n🔎 Searched: ${shown.join(" · ")}${rest > 0 ? ` (+${rest} more)` : ""}`;
}

export function formatFooter({
  usageMetadata,
  model,
  thinkingLevel,
  sourceCount,
  dropped,
  skipped,
  searchQueries,
}) {
  const inputTokens = usageMetadata?.promptTokenCount ?? 0;
  const outputTokens = usageMetadata?.candidatesTokenCount ?? 0;
  const thinkingTokens = usageMetadata?.thoughtsTokenCount ?? 0;

  // Verworfene Marker gehoeren in den Footer, weil sie die Aussagekraft der
  // Antwort veraendern: Fehlt ein Marker, kann die Stelle ungegroundet sein -
  // oder die Pruefung hat ihn verworfen. Nur sichtbar, wenn es welche gab,
  // damit der Normalfall den Footer nicht verlaengert.
  const droppedNote = dropped > 0 ? ` | ⚠️ ${dropped} markers dropped` : "";

  // Uebersprungene Chunks nach derselben Regel: nur sichtbar, wenn es welche
  // gab. Anders als verworfene Marker betrifft das nicht die Aussagekraft der
  // Antwort, sondern die Vollstaendigkeit der Quellenliste - ein Verlust, der
  // ohne diese Zeile niemandem auffiele (I1, siehe buildSourceList).
  const skippedNote =
    skipped > 0 ? ` | ⚠️ ${skipped} sources omitted (unknown chunk type)` : "";

  return (
    `\n\n---\n🔢 ${inputTokens} input / ${outputTokens} output / ${thinkingTokens} thinking tokens ` +
    `| 🔍 ${sourceCount} sources | 🤖 ${model} (thinking: ${thinkingLevel})${droppedNote}${skippedNote}` +
    formatSearchQueries(searchQueries)
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
      // Das aktuelle Datum, sonst nichts. Ohne es legt das Modell "die neueste
      // Version" an seinem eigenen Trainingsstand aus statt an heute - gemessen
      // suchte es in vier von sechs Faellen nach "2025 2026", weil es das Jahr
      // nur ungefaehr kennt. Bei einem Server, dessen Zweck das Umgehen von
      // Trainingswissen ist, ist das die falsche Unschaerfe.
      //
      // Bewusst KEINE inhaltlichen Vorgaben wie "bevorzuge offizielle
      // Dokumentation": Die faerben jede Antwort ein und verengen Recherchen zu
      // Betriebssystem-Eigenheiten oder aktuellen Ereignissen. Ein Datum ist
      // ein Fakt, eine Quellenpraeferenz eine Meinung.
      //
      // toLocaleDateString("en-CA") ergibt YYYY-MM-DD in LOKALER Zeit.
      // toISOString() waere UTC und meldete in Mitteleuropa zwischen 00:00 und
      // 02:00 Uhr den Vortag - ausgerechnet in der Funktion, die das richtige
      // Datum sicherstellen soll.
      systemInstruction: `Today's date is ${new Date().toLocaleDateString("en-CA")}.`,
      tools: [{ googleSearch: {} }, { urlContext: {} }, { codeExecution: {} }],
      thinkingConfig: { thinkingLevel },
    },
  });

  const candidate = response.candidates?.[0];
  const { sources, chunkNumbers, skipped } = buildSourceList(candidate);

  // Das ?? [] ist die Absicherung gegen eine Antwort ohne groundingMetadata -
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
    skipped,
    // Gleiche Absicherung wie bei den Supports: Ohne Suchtreffer fehlt das
    // Feld, dann entfaellt die Zeile.
    searchQueries: candidate?.groundingMetadata?.webSearchQueries ?? [],
  });

  // Der Footer bleibt in jedem Fall der letzte Bestandteil der Antwort.
  //
  // Die Reihenfolge Text - Hinweis - Quellen - Footer hat einen zweiten Grund:
  // Zwischen der Antwort und den zugehoerigen Links steht damit nichts, was
  // der Server hinzugefuegt haette. Die Terms untersagen es, fremde Inhalte
  // zwischen die Grounded Results zu mischen; hier ist nichts dazwischen.
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
 * den Angaben der API selbst statt aus dem Modellnamen - ein Namensmuster
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

/** Warum ein Modell nicht in der Standardliste steht - nur fuer die --all-Ansicht. */
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
      `All ${models.length} models - the usability filter matched nothing, so ` +
      "nothing is hidden. Check whether the API still reports supportedActions and thinking.";
  } else if (all) {
    note =
      `All ${models.length} models. Only the ${usable.length} marked "thinking" work with ` +
      "this server, which always sends a thinking level. Being listed is no guarantee " +
      "a model still answers - retired ones stay in this list and return 404.";
  } else {
    note =
      `${usable.length} of ${models.length} models usable with this server (text generation ` +
      "plus thinking level support). Request all models to see the rest.";
  }

  return `${lines.join("\n")}\n\n${note}`;
}
