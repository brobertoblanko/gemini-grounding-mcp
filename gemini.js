import { GoogleGenAI } from "@google/genai";
import { insertCitations } from "./citations.js";

/**
 * Wiederholungen bei voruebergehenden Fehlern. Ohne httpOptions.retryOptions
 * wiederholt das SDK NICHTS - dist/index.mjs beginnt apiCall() mit
 * "if (!retryOptions) { return fetch(url, requestInit); }", und einen Default
 * setzt es nirgends. Die Gemini-Doku behauptet pauschal, die offiziellen SDKs
 * haetten Retry ab Werk; belegt ist das nur fuers Python-SDK.
 *
 * ZWEI Codes fehlen ABSICHTLICH. Googles Default waere
 * [408, 429, 500, 502, 503, 504]; hier fehlen 429 und 504, jeder aus einem
 * eigenen Grund. Ohne diese Begruendung sieht die Liste wie unvollstaendig
 * abgeschrieben aus:
 *
 * 429: Die API liefert die Wartezeit selbst mit, als RetryInfo in
 * error.details ("retryDelay": "53s"). Das SDK wertet sie nicht aus - die
 * Zeichenkette "RetryInfo" kommt im gesamten Bundle nicht vor - und rechnet
 * stattdessen blind exponentiell. Bei den geforderten 53 Sekunden waeren alle
 * vier Versuche nach rund 15 Sekunden verbraucht, also lange bevor die Sperre
 * ueberhaupt ablaeuft. Fuer dasselbe Verhalten im Python-SDK laeuft
 * googleapis/python-genai#1875. Ein 429 kommt deshalb unveraendert und sofort
 * beim Client an, statt die Antwort um wirkungslose Wartezeit zu verlaengern.
 *
 * 504: Seit dieser Server eine eigene Frist mitschickt (siehe
 * SERVER_DEADLINE_SECONDS), ist ein 504 im Regelfall genau diese Frist und
 * nicht Googles ueberlastetes Gateway. Ihn zu wiederholen hiesse, dieselbe
 * Generierung noch dreimal bis zum Fristende laufen zu lassen - und dreimal zu
 * bezahlen, denn abgerechnet wird sie trotzdem. Die beiden Faelle sind hier
 * nicht zu trennen: Die Retry-Entscheidung faellt am Statuscode, lange bevor
 * irgendwer das DEADLINE_EXCEEDED im Body zu sehen bekaeme. Von den beiden
 * moeglichen Ursachen ist die teure die wahrscheinlichere, also gibt die Liste
 * den Code auf.
 *
 * Bei 500, 502, 503 und 408 gibt es keine Serverangabe, an der man sich
 * ausrichten koennte - dort ist blinder Backoff das einzig Moegliche und
 * deshalb richtig. 408 steht dabei der Vollstaendigkeit halber in der Liste:
 * Laeuft die Frist ab, antwortet Google mit 504, und laeuft die Anfrage ganz
 * ins Leere, bricht Node sie ohne jeden HTTP-Status ab (gemessen nach 306,8
 * Sekunden). Ein echter 408 kaeme nur von einer Zwischenstation.
 *
 * attempts zaehlt den Erstversuch mit. Vier Versuche bedeuten drei
 * Wiederholungen und mit den SDK-Defaults (initialDelay 1s, expBase 2, Jitter)
 * zwischen 7 und 14 Sekunden zusaetzlicher Wartezeit, bevor der Fehler kommt.
 *
 * Als exportierte Konstante, damit test/retry.test.js die Auslassungen pruefen
 * kann, ohne einen Client zu bauen oder SDK-Interna anzunehmen.
 */
export const RETRY_OPTIONS = {
  attempts: 4,
  httpStatusCodes: [408, 500, 502, 503],
};

/**
 * Die Frist, die Googles Gateway mitbekommt: Nach dieser Zeit soll es die
 * Generierung abbrechen, statt weiterzurechnen. Das SDK schickt sie als Header
 * X-Server-Timeout in ganzen Sekunden.
 *
 * Der Wert leitet sich aus dem kuerzesten Glied der Kette ab, und alle drei
 * Zahlen sind gemessen, nicht geschaetzt:
 * - Node bricht eine schweigende Verbindung nach 306,8 s ab (Undicis
 *   headersTimeout von 300 s plus Verbindungsaufbau)
 * - der MCP-Client von Claude Code wartet 1800 s, also sechsmal laenger
 * - Google selbst kennt ohne diesen Header ueberhaupt keine Frist
 *
 * Node kappt also zuerst. Alles, was Google jenseits dieser Grenze noch
 * generiert, kann niemand mehr entgegennehmen - bezahlt wird es trotzdem:
 * Input-Tokens voll, Output-Tokens bis zum tatsaechlichen Ende des Laufs.
 * Kostenlos sind nur Ablehnungen vor der Ausfuehrung (400, 401, 403, 429).
 * 290 Sekunden liegen knapp unter Nodes Grenze, damit Google aufhoert, bevor
 * die Leitung gekappt wird - und der Fehler als 504 mit Begruendung ankommt
 * statt als blosser Verbindungsabbruch.
 *
 * Bewusst NICHT ueber httpOptions.timeout gesetzt, obwohl das SDK denselben
 * Header daraus baut: Es erzeugte aus dem Wert zusaetzlich einen clientseitigen
 * AbortController, also eine zweite Uhr, die mit Googles Antwort um die Wette
 * liefe. Wer dieses Rennen gewinnt, ist Zufall, und gewinnt die eigene Uhr,
 * kommt "This operation was aborted" an statt der Begruendung.
 *
 * Die Standard-Header bleiben unangetastet: patchHttpOptions() mischt beide
 * Objekte per Object.assign, User-Agent und Content-Type gehen nicht verloren.
 */
export const SERVER_DEADLINE_SECONDS = 290;

/**
 * Fehler, bei denen NICHT auf das Backup-Modell ausgewichen wird. Alles andere
 * loest den Fallback aus, sofern ein Backup konfiguriert ist.
 *
 * Eine Negativliste, und das ist die eigentliche Entscheidung: Ein kuenftiger,
 * heute unbekannter Fehlercode bekommt damit automatisch den Fallback, statt
 * lautlos durch eine Positivliste zu fallen. Bewusst NICHT dieselbe Liste wie
 * RETRY_OPTIONS - die beiden beantworten verschiedene Fragen. Der Retry fragt
 * "hilft Warten?", der Fallback "kann ein anderes Modell der Unterschied sein?".
 * Bei 429 gehen die Antworten auseinander: Warten bringt nichts, weil das SDK
 * Googles retryDelay ignoriert, ausweichen dagegen sofort etwas, weil
 * Kontingente pro Modell zaehlen.
 *
 * Die drei Ausnahmen haben zwei verschiedene Gruende:
 *
 * 401 und 403 sind aussichtslos. Beide haengen am API-Schluessel, und der
 * zweite Aufruf nutzt denselben - das Modell kann die Ursache gar nicht sein.
 *
 * 504 ist zu teuer. Bei diesem Server ist das im Regelfall die eigene Frist
 * (siehe SERVER_DEADLINE_SECONDS), also eine vollstaendig gelaufene und
 * abgerechnete Generierung. Ein Fallback verdoppelt sie und legt bis zu 290
 * weitere Sekunden Wartezeit drauf.
 *
 * Ein Netzwerkfehler steht nicht in der Liste und braucht es nicht: Er traegt
 * gar keinen status und scheidet dadurch von selbst aus.
 */
export const NO_FALLBACK_STATUS = [401, 403, 504];

/**
 * Uebersetzt einen Fehler in eine Zeile, die auch dann noch etwas aussagt, wenn
 * er aus dem Netzwerk kommt statt aus der API.
 *
 * Ein ApiError traegt den Grund im Klartext (message ist der rohe JSON-Body der
 * Fehlerantwort) und braucht nichts weiter. Ein Netzwerkfehler dagegen heisst
 * bei Node IMMER "fetch failed" - abgelehnte Verbindung, unbekannter Host,
 * Zeitueberschreitung, alles dasselbe Wort. Was tatsaechlich geschah, steht
 * ausschliesslich in error.cause, und genau die verliert der Client, weil ein
 * MCP-Tool nur eine Zeile Text zurueckgeben kann.
 *
 * Der Code ist optional: Gemessen liefert "bad port" gar keinen, ECONNREFUSED
 * dagegen schon. Ohne diese Zeile steht bei einer abgebrochenen Verbindung nur
 * "fetch failed" beim aufrufenden Agenten, und der kann dem Nutzer nichts
 * erklaeren, was ueber "hat nicht geklappt" hinausgeht.
 */
export function describeError(error) {
  const cause = error?.cause;
  if (!cause) return error?.message ?? String(error);
  const code = cause.code ? `${cause.code}: ` : "";
  return `${error.message} (${code}${cause.message ?? cause})`;
}

function getClient() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "GEMINI_API_KEY is not set. The API key must be provided via environment " +
        "variable (never hardcoded).",
    );
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      retryOptions: RETRY_OPTIONS,
      headers: { "X-Server-Timeout": String(SERVER_DEADLINE_SECONDS) },
    },
  });
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

/**
 * Die Zeile ueber einen geglueckten Fallback auf das Backup-Modell. Ohne
 * Fallback ein leerer String und damit keine Zeile - gleiche Regel wie bei den
 * Suchanfragen: Der Normalfall verlaengert den Footer nicht.
 *
 * 🔁 und nicht ⚠️: Ein geglueckter Fallback ist keine beeintraechtigte Antwort.
 * Das Warnzeichen bleibt den Faellen vorbehalten, in denen mit der Antwort
 * selbst etwas nicht stimmt (verworfene Marker, uebersprungene Quellen,
 * finishReason, blockReason).
 *
 * Drei Codes bekommen einen Zusatz, weil bei ihnen etwas ZU TUN ist; bei allen
 * uebrigen - 503, 500, 502, 408 und allem Kuenftigen - ist die Stoerung
 * voruebergehend und der blosse Code sagt genug. Der 400 ist dabei der einzige,
 * bei dem die Zeile echte Diagnose leistet: Dass das Backup dieselbe Anfrage
 * annimmt, beweist, dass nicht die Anfrage das Problem war, sondern das Modell.
 */
export function formatFallbackNote(fallback) {
  if (!fallback) return "";

  const { model, status, statusName } = fallback;
  const answered = "answered by backup";

  switch (status) {
    case 404:
      return `\n🔁 ${model} does not exist (404) - ${answered}. Update your default.`;
    case 429:
      return `\n🔁 ${model} hit its quota (429) - ${answered}.`;
    case 400:
      return (
        `\n🔁 ${model} rejected the request (400) - ${answered}. ` +
        "Check the thinking level of your default model."
      );
    default:
      return `\n🔁 ${model} failed (${statusName ? `${status} ${statusName}` : status}) - ${answered}.`;
  }
}

export function formatFooter({
  usageMetadata,
  model,
  thinkingLevel,
  sourceCount,
  dropped,
  skipped,
  searchQueries,
  fallback,
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
    formatSearchQueries(searchQueries) +
    formatFallbackNote(fallback)
  );
}

/**
 * Der Fehlerkoerper der API als Objekt: status ("UNAVAILABLE", "NOT_FOUND",
 * ...) und, falls vorhanden, der maschinenlesbare Grund aus error.details.
 *
 * Die message eines ApiError IST der JSON-Koerper der Fehlerantwort, auch bei
 * einer Antwort ohne JSON - das SDK baut dann selbst eine. Trotzdem in einem
 * try: Beides ist Beiwerk, und daran darf kein Aufruf scheitern, der sonst
 * durchgelaufen waere.
 */
function readErrorBody(error) {
  try {
    const body = JSON.parse(error.message)?.error;
    return {
      statusName: body?.status,
      reason: body?.details?.find((detail) => detail.reason)?.reason,
    };
  } catch {
    return {};
  }
}

/**
 * Warum bei EINGERICHTETEM Backup trotzdem nicht ausgewichen wird - oder
 * undefined, wenn der Fallback stattfindet.
 *
 * Jeder dieser Gruende geht als Text an den Nutzer, weil er sonst die
 * unbeantwortbare Frage "warum hat mein Backup nicht gegriffen?" zuruecklaesst.
 * Ein nicht eingerichtetes Backup kommt hier gar nicht an: Dann gibt es nichts
 * zu erklaeren.
 */
function fallbackRefusal({ error, model, backupModel, reason }) {
  if (backupModel === model) {
    return "backup not tried: it is the same model as the default";
  }
  // Gemessen: Ein unbrauchbarer Schluessel kommt NICHT als 401 oder 403,
  // sondern als 400 INVALID_ARGUMENT mit "API key not valid" - der Statuscode
  // allein reicht hier also nicht. Ein 400 loest sonst durchaus einen Fallback
  // aus, weil dahinter ein Modell stehen kann, das das Thinking-Level nicht
  // kennt. Der Schluessel dagegen gilt fuer beide Modelle: aussichtslos.
  if (reason === "API_KEY_INVALID") {
    return "backup not tried: the API key is not valid, and the backup would use the same one";
  }
  const status = error?.status;
  if (typeof status !== "number") {
    // Kein HTTP-Status heisst: Die Anfrage hat die API nie erreicht oder die
    // Verbindung brach ab. Beim zweiten Modell liefe sie ueber dieselbe
    // Leitung zu demselben Host.
    return "backup not tried: the request never reached the API";
  }
  if (NO_FALLBACK_STATUS.includes(status)) {
    return status === 504
      ? "backup not tried: the generation ran to the deadline and is billed - a retry would double it"
      : `backup not tried: ${status} applies to the API key, not to the model`;
  }
  return undefined;
}

/**
 * Ein Fehler, der zusaetzlich sagt, warum kein Backup versucht wurde. Als
 * schlichter Error ohne cause, damit describeError() ihn unveraendert
 * durchreicht - die Ursache eines Netzwerkfehlers steckt bereits im Text.
 */
function withRefusal(error, refusal) {
  return new Error(`${describeError(error)} (${refusal})`);
}

/** Ein Aufruf an die API. Alles, was pro Versuch gleich bleibt, steht hier. */
function generate(ai, { query, model, thinkingLevel }) {
  return ai.models.generateContent({
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
}

/**
 * Fuehrt eine Gemini-Recherche mit allen drei Built-in-Tools durch
 * (Google Search, URL Context, Code Execution), setzt die Belegmarker in den
 * Antworttext und haengt Quellenliste sowie Token-Footer an.
 *
 * Scheitert das Modell und ist ein Backup uebergeben, laeuft dieselbe Anfrage
 * ein zweites Mal - mit demselben Retry, weil der am Client haengt und nicht am
 * Aufruf. Ob ein Backup uebergeben WIRD, entscheidet resolveCallConfig() in
 * config.js: Ein namentlich genanntes Modell bekommt keines.
 *
 * Die gesamte Auswertung danach laeuft auf der Antwort, die gewonnen hat, und
 * weiss vom Fallback nichts - bis auf den Footer, der ihn nennen muss.
 */
export async function runSearch({
  query,
  model,
  thinkingLevel,
  backupModel,
  backupThinkingLevel,
}) {
  const ai = getClient();

  let response;
  // Bleibt undefined, wenn der Erstversuch durchlaeuft, und laesst dann die
  // Footer-Zeile ganz entfallen.
  let fallback;

  try {
    response = await generate(ai, { query, model, thinkingLevel });
  } catch (error) {
    // Ohne eingerichtetes Backup aendert sich nichts: Der Fehler geht
    // unveraendert hinaus, wie vor diesem Feature.
    if (!backupModel) throw error;

    const { statusName, reason } = readErrorBody(error);
    const refusal = fallbackRefusal({ error, model, backupModel, reason });
    if (refusal) throw withRefusal(error, refusal);

    fallback = { model, status: error.status, statusName };
    model = backupModel;
    // Ohne eigenes Level erbt das Backup das fuer DIESEN Aufruf tatsaechlich
    // genutzte, nicht den gespeicherten Standard: Wer thinkingLevel "high"
    // uebergeben hat, will es auch beim Ausweichmodell.
    thinkingLevel = backupThinkingLevel ?? thinkingLevel;

    try {
      response = await generate(ai, { query, model, thinkingLevel });
    } catch (backupError) {
      // Beide Fehler mit ihrem Modell davor. Stuende hier nur der zweite,
      // suchte man am falschen Modell; describeError() auf beiden, damit die
      // cause eines Netzwerkfehlers nicht verlorengeht.
      throw new Error(
        `${fallback.model}: ${describeError(error)} | ` +
          `backup ${backupModel}: ${describeError(backupError)}`,
      );
    }
  }

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
    // model und thinkingLevel oben zeigen nach einem Fallback bereits das
    // Backup - der Footer nennt damit von selbst, was tatsaechlich geantwortet
    // hat. Diese Zeile sagt zusaetzlich, warum.
    fallback,
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
