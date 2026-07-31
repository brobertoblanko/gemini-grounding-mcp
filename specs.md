# specs.md — Architektur & Funktionsweise

Details zu Aufbau, genutzten Gemini-API-Tools, Antwortformat und technischen
Referenzen des Gemini-Grounding-MCP-Servers. Verhaltensregeln für Claude Code
in diesem Projekt stehen in [CLAUDE.md](./CLAUDE.md), Installation und
Registrierung in [README.md](./README.md).

## Warum ein eigener MCP statt eines fertigen npm-Pakets

Fertige Community-MCP-Pakete (z. B. via `npx paket@latest`) laden bei jedem Start
automatisch die neueste Version aus der npm-Registry nach. Das bedeutet:

- Der ausgeführte Code kann sich jederzeit ohne mein Wissen ändern
- Es gibt keine Transparenz darüber, was der fremde Code tatsächlich tut
- Kein Google- oder Anthropic-Backing, nur Community-Pflege unbekannter Qualität

**Entscheidung:** Stattdessen wird ein eigener, extrem kleiner Wrapper geschrieben,
der ausschließlich zwei offizielle, seriöse SDKs nutzt:

- `@google/genai` — Googles offizielles Gemini-SDK
- `@modelcontextprotocol/sdk` — das offizielle MCP-SDK (Anthropic)

Dadurch bleibt der komplette Code lokal, nachvollziehbar und ändert sich nur,
wenn ich selbst etwas anpasse — kein automatischer Versionswechsel im Hintergrund.

## Technische Basis

- Node.js (20+, von `@google/genai` gefordert), ES Modules
  (`"type": "module"` in package.json)
- Kommunikation über stdio (Standard-MCP-Transport)
- API-Key wird ausschließlich über die Umgebungsvariable `GEMINI_API_KEY`
  übergeben, niemals im Code hinterlegt

## Implementierung

Umgesetzt in flachen Modulen ohne `src/`-Layout und ohne Build-Step
(für die Projektgröße bringt `src/` in Node ohne Build-Step keinen Vorteil):

- `index.js` — Server-Bootstrap, registriert die drei Tools über
  `server.registerTool(...)`, baut den stdio-Transport auf.
- `gemini.js` — kapselt den `GoogleGenAI`-Aufruf inkl. der drei kombinierten
  Built-in-Tools, baut Quellenliste und Footer aus der API-Antwort.
- `config.js` — liest/schreibt die dauerhafte Modellwahl in einer
  scriptrelativen `config.json` (nicht `./config.json`, da das
  Arbeitsverzeichnis eines per stdio gestarteten MCP-Servers nicht garantiert
  der Projektordner ist).
- `cli.js` — zweites Frontend auf denselben Kern: dieselben Exporte aus
  `gemini.js` und `config.js`, die auch `index.js` nutzt, über die
  Kommandozeile erreichbar. Ohne zusätzliche Abhängigkeit (ein `switch` über
  `process.argv` genügt), ohne zweiten Ort für den API-Key. Zwei bewusste
  Unterschiede zum MCP-Server: Laufzeitfehler werden mit vollem Stacktrace
  ausgegeben statt wie in `index.js` auf eine Zeile für den Client verdichtet,
  und die Ausgabe geht auf stdout — beim stdio-Transport wäre das unmöglich,
  weil dort JSON-RPC darüber läuft. Aufruf und Unterbefehle: siehe README.

  Der Fehler wird dabei trotzdem per `try`/`catch` abgefangen, obwohl die
  Ausgabe dieselbe bleibt: Beendet Node den Prozess wegen einer unbehandelten
  Rejection hart, während noch eine Netzwerkverbindung offen ist, bricht libuv
  unter Windows mit `Assertion failed ... src\win\async.c` ab, und der Prozess
  endet mit `0xC0000409` statt mit Code 1. Deshalb `console.error(error)` —
  identisch zu Nodes eigener Ausgabe — gefolgt von `process.exitCode = 1`
  statt `process.exit()`, damit Node regulär herunterfährt.

  Das gilt **ausnahmslos**: `cli.js` enthält kein `process.exit()`. Ein
  Bedienfehler wirft stattdessen einen `UsageError`, den derselbe `catch`-Block
  abfängt und mit nur seiner Meldung ausgibt — für einen Tippfehler auf der
  Kommandozeile ist ein Stacktrace sinnlos. Zweiter Grund gegen `process.exit()`:
  stdout und stderr sind unter Windows auf einem TTY asynchron, ein sofortiges
  Beenden kann eine längere Ausgabe wie die Hilfe abschneiden. Weil `fail()`
  wirft statt zu beenden, liegen Argumentauswertung und `switch` gemeinsam in
  einer `main()`-Funktion innerhalb des `try`.

  Argumente werden dabei strikt geprüft, weil jede Nachsicht hier still
  danebengeht: Eine Suchanfrage muss **genau ein** Argument sein — Optionen
  werden per `indexOf` aus der Argumentliste geschnitten, sodass ein
  `--thinking high` mitten in einer unquotiert getippten Frage sonst
  unbemerkt Wörter aus der Anfrage entfernt hätte. Ein leeres Argument
  (etwa aus einer nicht gesetzten Shell-Variablen) ist ebenfalls ein Fehler,
  statt Tokens für eine leere Anfrage auszugeben. Was nach der Auswertung noch
  mit `--` beginnt, ist eine unbekannte Option und bricht ab — `models --al`
  hätte sonst kommentarlos die gefilterte Liste gezeigt, die man für die
  vollständige hält. Überzählige Argumente lehnt jeder Unterbefehl ab.

## Verifizierte API-Fakten (Stand 07/2026)

Diese Werte wurden vor der Umsetzung gegen die aktuelle Gemini-API- und
`@google/genai`-SDK-Dokumentation geprüft, damit die Codebasis nicht auf
veralteten Trainingsdaten aufbaut. Maßgeblich sind immer die offiziellen
Quellen: [Gemini API Docs](https://ai.google.dev/gemini-api/docs),
[js-genai SDK](https://googleapis.github.io/js-genai/) und das
[MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk).

- `gemini-flash-latest` ist ein von Google gepflegter Alias und zeigt aktuell
  auf `gemini-3.5-flash`. Der Alias wird bei jedem neuen Flash-Release
  automatisch umgehängt.
- `thinkingLevel`-Enum: `minimal` | `low` | `medium` | `high`. Bei Flash-Modellen
  ist `medium` der API-Default — `high` muss also explizit gesetzt werden.
- Grounding-Metadaten liegen unter `response.candidates?.[0]?.groundingMetadata`
  (Array-Index `[0]` nicht vergessen). Jede Quelle in `groundingChunks[i].web`
  hat `uri`, `title` und `domain` (`domain` ist laut SDK-Typdoku nicht von der
  Gemini Developer API unterstützt und praktisch immer `undefined`).
- Per URL Context gelesene Seiten liefern ihre Quelle zusätzlich unter
  `candidates[0].urlContextMetadata.urlMetadata[].retrievedUrl`.
- Token-Zahlen liegen unter `response.usageMetadata`: `promptTokenCount`,
  `candidatesTokenCount`, `totalTokenCount`, sowie `thoughtsTokenCount` für
  die reinen Thinking-Tokens.
- Verbindungsaufbau im MCP-SDK erfolgt über
  `await server.connect(transport)` (nicht umgekehrt).
- `server.registerTool(name, { title?, description?, inputSchema }, handler)`
  ist die aktuell empfohlene API; `inputSchema` akzeptiert sowohl ein rohes
  Shape-Objekt (`{ query: z.string() }`) als auch ein volles `z.object({...})`.

## Bereits getestete Gemini-API-Befehle (Referenz)

Diese Aufrufe wurden vorab erfolgreich getestet und bilden die Grundlage
für die Logik im MCP-Server.

### Direkter REST-Aufruf (PowerShell / curl)

```powershell
curl "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent" `
  -H "Content-Type: application/json" `
  -H "X-goog-api-key: $env:GEMINI_API_KEY" `
  -X POST `
  -d '{
    "contents": [{"parts": [{"text": "Testanfrage"}]}],
    "tools": [{"googleSearch": {}}],
    "generationConfig": {
      "thinkingConfig": {"thinkingLevel": "high"}
    }
  }'
```

## Genutzte Gemini-API-Tools

Dieser MCP-Server nutzt ausschließlich drei der sechs offiziellen, von Google
gemanagten Built-in-Tools der Gemini API. Alle drei sind beim aktuellen
Standardmodell (`gemini-flash-latest`) verfügbar und werden **gemeinsam in
einem einzigen MCP-Tool `gemini-search`** aktiviert — es gibt bewusst nur
diesen einen Einstiegspunkt, Gemini entscheidet innerhalb des Aufrufs selbst,
welche der drei Fähigkeiten (Suchen → Lesen → Auswerten) es für die jeweilige
Anfrage tatsächlich braucht ([Doku: Tools](https://ai.google.dev/gemini-api/docs/tools)).

Bewusst NICHT genutzt werden: Google Maps (nicht relevant für Web-Research),
File Search (nur für eigene hochgeladene Dokumente), Computer Use (experimentell,
Browser-Steuerung, kein Research-Anwendungsfall) und Function Calling
(eigene Custom-Funktionen, hier nicht benötigt).

### 1. Google Search (Grounding)

Verbindet das Modell in Echtzeit mit aktuellen Webinhalten. Gemini entscheidet
selbst, wann eine Suche nötig ist, formuliert die Suchanfrage(n) eigenständig
und liefert eine Antwort mit Quellenangaben (Zitationen) zurück
([Doku: Grounding with Google Search](https://ai.google.dev/gemini-api/docs/google-search)).

```javascript
tools: [{ googleSearch: {} }];
```

**Zweck im Projekt:** Erste, breite Recherche zu einem Thema — der Standardfall
innerhalb des Tools `gemini-search`.

### 2. URL Context

Ermöglicht Gemini, gezielt den Inhalt einer oder mehrerer konkreter URLs zu lesen
und auszuwerten — inklusive PDFs, Bildern und HTML, bis zu 34 MB pro Anfrage
([Doku: URL Context](https://ai.google.dev/gemini-api/docs/url-context)).
Läuft komplett innerhalb des API-Aufrufs, ohne dass Claude selbst die Seite laden muss.

```javascript
tools: [{ urlContext: {} }];
```

**Zweck im Projekt:** Vertiefende Analyse einer Quelle, die zuvor per Google Search
gefunden wurde (z. B. wenn Claude wissen will, was genau auf einer bestimmten
Ergebnis-Seite steht) — innerhalb desselben Tools `gemini-search`, Gemini
ruft dieses Built-in bei Bedarf automatisch mit auf.

### 3. Code Execution

Lässt Gemini eigenständig Python-Code schreiben und in einer isolierten Sandbox
ausführen, um z. B. Berechnungen, Datenauswertungen oder einfache Statistiken
aus zuvor gefundenen/gelesenen Daten zu erstellen
([Doku: Code Execution](https://ai.google.dev/gemini-api/docs/code-execution)). Die Sandbox hat
keinen eigenen Internetzugang — sie arbeitet nur mit Daten, die bereits im
Kontext vorliegen (z. B. aus Google Search oder URL Context).

```javascript
tools: [{ codeExecution: {} }];
```

**Zweck im Projekt:** Optionale dritte Fähigkeit innerhalb von `gemini-search`
für Fälle, in denen gefundene/gelesene Daten noch rechnerisch ausgewertet
werden sollen (z. B. Durchschnittswerte, Vergleiche, einfache Diagrammdaten).

### Kombinierte Nutzung

Alle drei Tools können und sollen in einem einzigen Aufruf gleichzeitig aktiviert werden,
sodass Gemini selbst entscheidet, welche Schritte (Suchen → Lesen → Auswerten)
für die jeweilige Anfrage nötig sind
([Doku: Tools](https://ai.google.dev/gemini-api/docs/tools)):

```javascript
config: {
  tools: [
    { googleSearch: {} },
    { urlContext: {} },
    { codeExecution: {} }
  ],
  thinkingConfig: { thinkingLevel: 'high' },
}
```

### Referenzbeispiel über das offizielle Node-SDK

Vereinfachtes Beispiel des Musters, das `gemini.js` tatsächlich implementiert:

```javascript
import { GoogleGenAI } from "@google/genai";

const genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const response = await genAI.models.generateContent({
  model: "gemini-flash-latest",
  contents: "Testanfrage",
  config: {
    tools: [{ googleSearch: {} }, { urlContext: {} }, { codeExecution: {} }],
    thinkingConfig: { thinkingLevel: "high" },
  },
});

console.log(response.text);
```

Wichtige Parameter-Hinweise aus der Dokumentation:

- `thinkingLevel` ersetzt das ältere `thinkingBudget` (Integer) — bei
  `gemini-3.5-flash` gilt der Enum-Wert (`minimal`, `low`, `medium`, `high`)
- Ohne explizite Angabe ist Thinking bei diesem Modell standardmäßig auf
  `medium` gesetzt. Dieser Server sendet trotzdem immer ein Level mit, damit
  der Footer den tatsächlich genutzten Wert ausweisen kann — ohne
  `config.json` ebenfalls `medium`
- Der API-Key kann per Header (`X-goog-api-key`) oder als Query-Parameter
  (`?key=...`) übergeben werden; Header-Variante wird bevorzugt

## Antwort: Quellenliste und Token-Footer

Jede Antwort des MCP-Servers enthält neben dem eigentlichen Antworttext zwei
zusätzliche, direkt aus der Gemini-API-Antwort ausgelesene Teile (nicht selbst
berechnet oder geschätzt):

1. Eine **Quellenliste** (Titel + URL) am Ende des Textes — Claude soll die
   Quellen sehen und weiterverwerten können (z. B. gezielt eine URL vertiefen
   oder die Aussage einer Quelle zuordnen), nicht nur eine reine Zahl. Sie
   führt Google-Search-Treffer und per URL Context gelesene Seiten
   zusammen und dedupliziert nach URL.
2. Einen **Footer** mit Input-/Output-/Thinking-Tokens, Quellenanzahl sowie
   dem verwendeten Modell und Thinking-Level, zur Transparenz über den
   tatsächlichen Ressourcenverbrauch und die genutzte Modell-/Thinking-Wahl
   des Tool-Calls — der User soll nie raten müssen, was verwendet wurde.

### Antworttext: eigener Aufbau statt `response.text`

`gemini.js` setzt den Antworttext selbst aus `candidates[0].content.parts`
zusammen (`buildText`), statt den `.text`-Getter des SDK zu nutzen. Der Getter
verkettet ausschließlich Textteile, verwirft alles andere und schreibt dabei
pro Aufruf eine Warnung nach stderr. Bei aktiviertem Code Execution fällt damit
genau der Teil weg, der zeigt, wie ein Rechenergebnis zustande kam — die
Antwort behauptet ein Ergebnis, ohne den Weg dorthin zu belegen. `buildText`
übernimmt deshalb zusätzlich `executableCode` und `codeExecutionResult` als
Codeblöcke. Teile mit `thought: true` bleiben außen vor; ihr Umfang steht
bereits als Thinking-Tokens im Footer.

Die Reihenfolge wird dabei bewusst umgestellt: Die API liefert die Parts in
Ausführungsreihenfolge, sodass Code und Ergebnis **vor** dem erklärenden Text
stehen — die Antwort begänne also mit einem Codeblock, die eigentliche Auskunft
käme darunter. `buildText` sammelt Text- und Codeblöcke getrennt und hängt die
Codeblöcke unter der Überschrift `Code execution:` hinten an. Der Rechenweg ist
ein Beleg und steht damit dort, wo auch die Quellenliste steht: hinter der
Antwort, nicht davor.

Bewusst **nicht** begrenzt wird die Länge von `codeExecutionResult.output`:
Auch eine lange Ausgabe ist Teil des Rechenwegs, und ein Umfang, der im
Research-Kontext stören würde, ist die seltene Ausnahme.

### Hinweis bei nicht regulär beendeter Antwort

Fehlt der Text ganz oder bricht er ab, sähe die Antwort mit Quellenliste und
Footer trotzdem wie ein Erfolg aus. `formatNotice` fügt deshalb zwischen Text
und Quellenliste eine Zeile mit ⚠️ ein, wenn einer dieser Fälle vorliegt:

| Bedingung | Hinweis |
|---|---|
| `response.promptFeedback.blockReason` gesetzt | Anfrage von der API blockiert |
| Text leer | Antwort ohne Text, mit `candidates[0].finishReason` |
| `finishReason` gesetzt und ≠ `STOP` | unvollständige Antwort, vor allem `MAX_TOKENS` |

`STOP` ist der reguläre Abschluss; die übrigen Werte des `FinishReason`-Enums
(`MAX_TOKENS`, `SAFETY`, `RECITATION`, `BLOCKLIST`, …) bedeuten einen Abbruch.
Der Footer bleibt in jedem Fall der letzte Bestandteil der Antwort.

### Woher die Werte kommen

Jede `generateContent`-Antwort liefert automatisch ein `usageMetadata`-Objekt
mit der Token-Aufschlüsselung
([Doku: Token counting](https://ai.google.dev/gemini-api/docs/tokens)) sowie —
bei aktiviertem Google Search Tool — ein `groundingMetadata`-Objekt mit den
gefundenen Quellen
([Doku: Grounding with Google Search](https://ai.google.dev/gemini-api/docs/google-search)).
Bei aktiviertem URL-Context-Tool liegen die gelesenen Seiten zusätzlich unter
`urlContextMetadata`. **Wichtig:** Beide Metadaten-Objekte hängen am ersten
Kandidaten (`candidates[0]`), nicht direkt an `candidates`.

```javascript
const response = await genAI.models.generateContent({...})

const inputTokens = response.usageMetadata.promptTokenCount
const outputTokens = response.usageMetadata.candidatesTokenCount
const thinkingTokens = response.usageMetadata.thoughtsTokenCount

const candidate = response.candidates?.[0]
const searchChunks = candidate?.groundingMetadata?.groundingChunks ?? []
const urlContextEntries = candidate?.urlContextMetadata?.urlMetadata ?? []
```

### Felder im Detail

| Feld               | Pfad in der Antwort                                            | Bedeutung                                                     |
| ------------------ | -------------------------------------------------------------- | ------------------------------------------------------------- |
| Input-Tokens       | `usageMetadata.promptTokenCount`                               | Tokens der gesendeten Anfrage                                 |
| Output-Tokens      | `usageMetadata.candidatesTokenCount`                           | Tokens der generierten Antwort                                |
| Thinking-Tokens    | `usageMetadata.thoughtsTokenCount`                             | Reine Denk-Tokens (Reasoning), separat ausgewiesen            |
| Such-Quellen       | `candidates[0].groundingMetadata.groundingChunks`              | Array der bei der Google-Suche gefundenen Webquellen          |
| Such-Quell-URL     | `groundingChunks[i].web.uri`                                   | URL der einzelnen Suchquelle                                  |
| Such-Quell-Titel   | `groundingChunks[i].web.title`                                 | Titel der einzelnen Suchquelle                                |
| URL-Context-Quelle | `candidates[0].urlContextMetadata.urlMetadata[i].retrievedUrl` | URL einer von Gemini gezielt gelesenen Seite (kein Grounding) |

Beide Quell-Arrays sind nur vorhanden, wenn das jeweilige Tool tatsächlich
verwendet wurde — sonst leer oder nicht vorhanden, daher immer mit `?? []`
absichern.

### Quellenliste erzeugen

Such-Treffer und URL-Context-Seiten werden zu einer Liste zusammengeführt und
nach URL entduplifiziert (Such-Treffer haben Vorrang, da sie einen echten
Seitentitel mitbringen — URL-Context-Einträge liefern nur die URL selbst):

```javascript
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

const sourceList = sources
  .map((s, i) => `[${i + 1}] ${s.title} — ${s.uri}`)
  .join("\n");
```

### Footer-Format im Tool-Ergebnis

```javascript
const footer =
  `\n\n---\n🔢 ${inputTokens} Input / ${outputTokens} Output / ${thinkingTokens} Thinking Tokens ` +
  `| 🔍 ${sources.length} Quellen | 🤖 ${model} (thinking: ${thinkingLevel})`;

const sourcesBlock = sourceList ? `\n\nQuellen:\n${sourceList}` : "";

return {
  content: [{ type: "text", text: text + notice + sourcesBlock + footer }],
};
```

`text` stammt dabei aus `buildText(candidate)`, `notice` aus `formatNotice(...)` —
siehe die beiden Abschnitte oben.

Beispielausgabe am Ende jeder Antwort:

```text
Quellen:
[1] Gemini API Docs — https://ai.google.dev/gemini-api/docs/models
[2] Google Gen AI SDK — https://googleapis.github.io/js-genai/

---
🔢 245 Input / 89 Output / 40 Thinking Tokens | 🔍 2 Quellen | 🤖 gemini-flash-latest (thinking: high)
```

Tatsächlich implementiert in `gemini.js` (`buildText`, `formatNotice`,
`buildSourceList`, `formatSourcesBlock`, `formatFooter`).

## Konfigurierbare Modell- und Thinking-Level-Wahl

Der MCP-Server bietet zwei zusätzliche Tools, mit denen sich Standardmodell und
Standard-Thinking-Level dauerhaft festlegen lassen, ohne den Code selbst
bearbeiten zu müssen.

### gemini-list-models

Ruft über den offiziellen `models.list`-Endpunkt die für den aktuellen
API-Key verfügbaren Modelle ab, inklusive Token-Limits
([API-Referenz: Models](https://ai.google.dev/api/models)). Der Pager des SDK
holt weitere Seiten selbstständig nach; `pageSize` bestimmt nur die Größe der
einzelnen Anfrage, nicht die Gesamtzahl.

**Standardmäßig gefiltert.** Der Key gibt erheblich mehr Modelle frei, als
hier funktionieren — beim Stand dieser Messung 58 insgesamt, davon 32
nutzbar. Gefiltert wird über zwei Angaben, die jedes Modell selbst
mitliefert:

| Feld | Bedingung | Andernfalls |
|---|---|---|
| `supportedActions` | enthält `generateContent` | Modell erzeugt keinen Text — Embeddings, Imagen, Veo, Live/Audio |
| `thinking` | `true` | `400 Thinking level is not supported for this model.`, da `runSearch` immer ein `thinkingConfig` sendet |

Beide Felder sind im `Model`-Interface des SDK dokumentiert. Bewusst **nicht**
über Namensmuster gefiltert: Google vergibt Codenamen, die nichts über die
Fähigkeiten aussagen (`nano-banana-pro-preview` ist ein Bildmodell), sodass
jede Musterliste bei der nächsten Modellfamilie veraltet.

Grenzen, die der Filter nicht auflöst:

- Er trennt technische Lauffähigkeit, nicht Eignung. Bild-, Sprach- und
  Robotikmodelle erfüllen die Bedingungen teilweise ebenfalls.
- **Gelistet heißt nicht verfügbar.** Abgekündigte Modelle bleiben in der
  Antwort und liefern bei Nutzung `404 ... is no longer available` — nachweisbar
  an der 2.0-Generation. Ein Feld, das den Zustand vorab anzeigt, existiert
  nicht.

Deshalb ist `all` kein reiner Komfortschalter: Da die Liste ohnehin keine
Garantie gibt, darf die gefilterte Sicht nie die einzige sein. `all: true`
zeigt die vollständige Liste mit einer Statusspalte. Ergibt der Filter kein
einziges Modell — etwa weil die API die ausgewerteten Felder nicht mehr
liefert — fällt `listModels` selbsttätig auf die vollständige Liste zurück und
weist im Hinweistext darauf hin, statt eine leere Ausgabe zu erzeugen.

### gemini-set-model

Speichert Modell-ID und/oder Thinking-Level dauerhaft in einer lokalen
`config.json` im Projektordner. Beide Werte lassen sich unabhängig
voneinander setzen — ein Merge sorgt dafür, dass das Setzen des einen Werts
den bereits gespeicherten anderen Wert nicht überschreibt. Diese Wahl bleibt
über Server-Neustarts hinweg bestehen, bis sie erneut geändert wird.

```javascript
server.registerTool(
  "gemini-set-model",
  {
    inputSchema: {
      model: z
        .string()
        .optional()
        .describe(
          "Modell-ID, z. B. gemini-flash-latest oder ein fest gepinntes Modell wie gemini-3.5-flash",
        ),
      thinkingLevel: z
        .enum(["minimal", "low", "medium", "high"])
        .optional()
        .describe("Denktiefe des Modells"),
    },
  },
  async ({ model, thinkingLevel }) => {
    // mindestens ein Parameter ist Pflicht, sonst Fehler
    setSavedConfig({ model, thinkingLevel }); // Merge statt Ueberschreiben, siehe config.js
    return {
      content: [
        {
          type: "text",
          text: `Gespeichert — Modell: ${model}, Thinking-Level: ${thinkingLevel}`,
        },
      ],
    };
  },
);
```

### Auflösung der Standardwerte pro Aufruf

Das Tool `gemini-search` nutzt die gespeicherten Werte als Standard, sofern
beim jeweiligen Aufruf nichts explizit angegeben wird. Die Auflösung passiert
bewusst **im Handler zur Aufrufzeit** (`model ?? getSavedModel()`), nicht als
Zod-`.default()` im `inputSchema`: ein Schema-Default würde einmal beim
Registrieren des Tools ausgewertet und eingefroren, sodass `gemini-set-model`
erst nach einem Serverneustart wirken würde. `model` und `thinkingLevel` sind
im Schema deshalb `optional()`.

```javascript
function getSavedModel() {
  return readConfig().model ?? FALLBACK_MODEL; // "gemini-flash-latest" ohne config.json
}

function getSavedThinkingLevel() {
  return readConfig().thinkingLevel ?? FALLBACK_THINKING_LEVEL; // "medium" ohne config.json
}
```

Tatsächlich implementiert (inkl. `setSavedConfig`) in `config.js` — siehe „Implementierung" oben.
