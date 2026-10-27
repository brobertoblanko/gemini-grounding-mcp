# specs.md - Architektur & Funktionsweise

*Read this page in [English](./specs.md).*

Details zu Aufbau, genutzten Gemini-API-Tools, Antwortformat und technischen
Referenzen des Gemini-Grounding-MCP-Servers. Verhaltensregeln für Claude Code
in diesem Projekt stehen in [CLAUDE.md](../CLAUDE.md), Installation und
Registrierung in [README.md](../README.md).

## Warum ein eigener MCP statt eines fertigen npm-Pakets

Fertige Community-MCP-Pakete (z. B. via `npx paket@latest`) laden bei jedem Start
automatisch die neueste Version aus der npm-Registry nach. Das bedeutet:

- Der ausgeführte Code kann sich jederzeit ohne mein Wissen ändern
- Es gibt keine Transparenz darüber, was der fremde Code tatsächlich tut
- Kein Google- oder Anthropic-Backing, nur Community-Pflege unbekannter Qualität

**Entscheidung:** Stattdessen wird ein eigener, extrem kleiner Wrapper geschrieben,
der ausschließlich zwei offizielle, seriöse SDKs nutzt:

- `@google/genai` - Googles offizielles Gemini-SDK
- `@modelcontextprotocol/server` - das offizielle MCP-SDK (Anthropic), Server-Paket seiner 2.x-Linie

Dadurch bleibt der komplette Code lokal, nachvollziehbar und ändert sich nur,
wenn ich selbst etwas anpasse - kein automatischer Versionswechsel im Hintergrund.

### Und trotzdem selbst auf npm

Seit Version 1.1.0 wird dieses Projekt als `@brobertoblanko/gemini-grounding-mcp`
auf npm veröffentlicht, und die README empfiehlt zur Registrierung `npx -y`.
Das ist genau der Mechanismus, gegen den der Abschnitt oben argumentiert - die
Einwände verschwinden nicht dadurch, dass es der eigene Code ist.

Bewusst in Kauf genommen, aus einem Grund: Ohne npm braucht jeder Interessent
einen Klon und einen absoluten Pfad in der Client-Konfiguration; das schließt
praktisch alle aus, die den Server nur ausprobieren wollen. Wer die Einwände
teilt, hat weiterhin beide Wege - der Klon-Weg bleibt vollständig unterstützt
und in der README beschrieben, und `npx @brobertoblanko/gemini-grounding-mcp@1.1.0`
mit fester Version nimmt dem `-y` die Beweglichkeit. Was hier ausgeliefert wird,
ist außerdem einsehbar: derselbe Code wie im Repository, ohne Build-Step,
gepackt über eine feste `files`-Liste.

## Technische Basis

- Node.js (22+, älteste Fassung mit Sicherheitsunterstützung), ES Modules
  (`"type": "module"` in package.json)
- Kommunikation über stdio (Standard-MCP-Transport)
- API-Key wird ausschließlich über die Umgebungsvariable `GEMINI_API_KEY`
  übergeben, niemals im Code hinterlegt

## Implementierung

Umgesetzt in flachen Modulen ohne `src/`-Layout und ohne Build-Step
(für die Projektgröße bringt `src/` in Node ohne Build-Step keinen Vorteil):

- `index.js` - Server-Bootstrap, registriert die drei Tools über
  `server.registerTool(...)` in `createServer()` und übergibt diese Factory
  an `serveStdio` (siehe „Beide Protokollrevisionen bedienen").
- `gemini.js` - kapselt den `GoogleGenAI`-Aufruf inkl. der drei kombinierten
  Built-in-Tools, baut Quellenliste und Footer aus der API-Antwort.
- `models.js` - alles zur Modellliste des Keys: die Filter hinter
  `gemini-list-models`, der Hinweis nach einem gespeicherten Modell und der
  Drift-Check.
- `citations.js` - setzt die Belegmarker in den Antworttext. Eigene Datei, weil
  dieser Code als einziger im Projekt **ohne Netzwerk und ohne API-Key
  vollständig prüfbar** ist: Rein gehen Text und Metadaten, heraus kommt Text -
  kein `getClient()`, keine Konfiguration, kein Zufall. Getestet gegen eine
  gespeicherte echte Antwort in `test/citations.test.js` (`npm test`, über
  Nodes eingebauten Test-Runner, ohne zusätzliche Abhängigkeit).
- `config.js` - liest/schreibt die dauerhafte Modellwahl und Frist in einer `config.json`
  am plattformüblichen Ort für Nutzer-State (siehe „Speicherort der
  Konfiguration" unten). Hier liegt auch `resolveCallConfig`, die einzige
  Antwort darauf, womit ein einzelner Aufruf tatsächlich läuft, und ebenso
  `formatSavedValues` und `formatConfigState`, die einzige Antwort darauf, was
  ein Speichern geändert hat und was danach gilt - alle drei gemeinsam genutzt
  von `index.js` und `cli.js`.
- `cli.js` - zweites Frontend auf denselben Kern: dieselben Exporte aus
  `gemini.js` und `config.js`, die auch `index.js` nutzt, über die
  Kommandozeile erreichbar. Ohne zusätzliche Abhängigkeit (ein `switch` über
  `process.argv` genügt), ohne zweiten Ort für den API-Key. Zwei bewusste
  Unterschiede zum MCP-Server: Ein Laufzeitfehler wird für einen Menschen
  ausgegeben - ein `ApiError` als `<Code> <Status> - <Googles Text>` über
  `formatRuntimeError()` in `gemini.js`, der volle Stacktrace nur mit
  `--debug` -, wo `index.js` dem Client über `describeError()` Googles rohen
  Body übergibt, und die Ausgabe geht auf stdout - beim stdio-Transport wäre das
  unmöglich, weil dort JSON-RPC darüber läuft. Der Stack bleibt hinter
  `--debug`, weil er aus SDK-Interna besteht und absolute lokale Pfade in
  jeden Bug-Report trägt, in den er kopiert wird. Aufruf und Unterbefehle:
  siehe README.

  Der Fehler müsste auch bei Nodes eigener Ausgabe per `try`/`catch` abgefangen
  werden: Beendet Node den Prozess wegen einer unbehandelten
  Rejection hart, während noch eine Netzwerkverbindung offen ist, bricht libuv
  unter Windows mit `Assertion failed ... src\win\async.c` ab, und der Prozess
  endet mit `0xC0000409` statt mit Code 1. Deshalb die Ausgabe über
  `console.error` - mit `--debug` `console.error(error)`, identisch zu Nodes
  eigener Ausgabe - gefolgt von `process.exitCode = 1` statt `process.exit()`,
  damit Node regulär herunterfährt.

  Das gilt **ausnahmslos**: `cli.js` enthält kein `process.exit()`. Ein
  Bedienfehler wirft stattdessen einen `UsageError`, den derselbe `catch`-Block
  abfängt und mit nur seiner Meldung ausgibt, wie jeden anderen Fehler hinter
  `Error:` - für einen Tippfehler auf der Kommandozeile ist ein Stacktrace
  sinnlos. Ein Fehler in der Syntax des Aufrufs trägt eine zweite Zeile mit der
  Verwendung des Befehls oder einem Verweis auf `help`; ein Fehler in den
  Werten sagt selbst, was zu tun ist. Zweiter Grund gegen `process.exit()`:
  stdout und stderr sind unter Windows auf einem TTY asynchron, ein sofortiges
  Beenden kann eine längere Ausgabe wie die Hilfe abschneiden. Weil `fail()`
  wirft statt zu beenden, liegen Argumentauswertung und `switch` gemeinsam in
  einer `main()`-Funktion innerhalb des `try`.

  Argumente werden dabei strikt geprüft, weil jede Nachsicht hier still
  danebengeht: Eine Suchanfrage muss **genau ein** Argument sein - Optionen
  werden per `indexOf` aus der Argumentliste geschnitten, sodass ein
  `--thinking high` mitten in einer unquotiert getippten Frage sonst
  unbemerkt Wörter aus der Anfrage entfernt hätte. Ein leeres Argument
  (etwa aus einer nicht gesetzten Shell-Variablen) ist ebenfalls ein Fehler,
  statt Tokens für eine leere Anfrage auszugeben. Was nach der Auswertung noch
  mit `--` beginnt, ist eine unbekannte Option und bricht ab - `models --al`
  hätte sonst kommentarlos die gefilterte Liste gezeigt, die man für die
  vollständige hält. `--help` und `--version` sind die einzigen Ausnahmen, weil
  beide weiter unten als Unterbefehle behandelt werden; ein `case` für eines
  von beiden im `switch` würde sonst nie erreicht. Überzählige Argumente lehnt
  jeder Unterbefehl ab.

  Eine **bekannte** Option am falschen Ort wird genauso abgelehnt. Optionen
  werden aus der Argumentliste geschnitten, bevor der Unterbefehl feststeht,
  sodass ohne Prüfung kein Zweig sie noch bemerkte: `config --thinking low`
  nahm die Option bislang entgegen und tat nichts damit. Jeder Zweig nennt
  deshalb die Optionen, die bei ihm eine Bedeutung haben (`allowFlags`, eine
  Positivliste, damit eine künftige Option nicht versehentlich überall erlaubt
  ist), und bei `models` läuft diese Prüfung vor dem API-Aufruf, sodass ein
  Tippfehler keine Anfrage kostet.

  Die beiden `set-*`-Befehle persistieren die jeweils **andere** Option:
  `set-model <id> --thinking <level>` speichert beides in einem Aufruf,
  `set-thinking <level> --model <id>` spiegelbildlich. Wer speichern lässt,
  will nicht, dass die Hälfte der Angabe verfällt. Die eigene Option des
  Befehls bleibt ein Fehler - `set-model x --model y` nennt zwei Modelle, und
  welches gemeint ist, weiß nur der Aufrufer. Die Bestätigungszeile nennt jeden
  geschriebenen Wert, damit ein gespeicherter Wert nie von einem verworfenen zu
  unterscheiden ist, und darunter folgt der gespeicherte Zustand (siehe
  „Was nach dem Speichern gemeldet wird" unten).

  Das Backup ist das eine, was diese Merge-Regel bricht, und zwar absichtlich:
  Es wird **als Einheit** geschrieben, sodass ein Backup-Modell ohne Level ein
  zuvor gespeichertes entfernt, statt es stehen zu lassen. Das Level gehört zu
  diesem einen Modell - über einen Wechsel des Backups hinweg gälte es
  stillschweigend für ein Modell, für das es nie gewählt wurde. Das Modell
  wegzulassen und nur ein Level zu übergeben ist der Weg, das Level des bereits
  gespeicherten Backups zu ändern.

  Die Regel steht in `setSavedConfig` und nicht in `cli.js`, aus demselben
  Grund wie `resolveCallConfig`: Der MCP-Handler schreibt dieselbe Datei, und
  ein Modell, das dort ein neues Backup setzt, hat keinen Anlass, ausdrücklich
  `null` mitzuschicken. Zwei Schnittstellen mit gegenläufiger Semantik auf
  einer Datei kann später niemand mehr erklären.

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
  ist `medium` der API-Default - `high` muss also explizit gesetzt werden.
- Grounding-Metadaten liegen unter `response.candidates?.[0]?.groundingMetadata`
  (Array-Index `[0]` nicht vergessen). Jede Quelle in `groundingChunks[i].web`
  hat `uri`, `title` und `domain` (`domain` ist laut SDK-Typdoku nicht von der
  Gemini Developer API unterstützt und praktisch immer `undefined`).
- Per URL Context gelesene Seiten liefern ihre Quelle zusätzlich unter
  `candidates[0].urlContextMetadata.urlMetadata[].retrievedUrl`.
- Token-Zahlen liegen unter `response.usageMetadata`: `promptTokenCount`,
  `candidatesTokenCount`, `totalTokenCount`, sowie `thoughtsTokenCount` für
  die reinen Thinking-Tokens.
- MCP-SDK 2.x (Stand 10/2026, Version 2.4.0): `McpServer` kommt aus
  `@modelcontextprotocol/server`, `serveStdio` und `StdioServerTransport` aus
  dem Subpath `@modelcontextprotocol/server/stdio`. `@modelcontextprotocol/node`
  ist HTTP-Middleware und für stdio nicht nötig.
- `server.registerTool(name, { title?, description?, inputSchema?, annotations?, _meta? }, handler)`;
  `inputSchema` ist ein Standard Schema wie `z.object({...})`. Ein rohes Shape
  (`{ query: z.string() }`) wird nur noch über einen veralteten Overload angenommen.

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
einem einzigen MCP-Tool `gemini-search`** aktiviert - es gibt bewusst nur
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

**Zweck im Projekt:** Erste, breite Recherche zu einem Thema - der Standardfall
innerhalb des Tools `gemini-search`.

### 2. URL Context

Ermöglicht Gemini, gezielt den Inhalt einer oder mehrerer konkreter URLs zu lesen
und auszuwerten - inklusive PDFs, Bildern und HTML, bis zu 34 MB pro Anfrage
([Doku: URL Context](https://ai.google.dev/gemini-api/docs/url-context)).
Läuft komplett innerhalb des API-Aufrufs, ohne dass Claude selbst die Seite laden muss.

```javascript
tools: [{ urlContext: {} }];
```

**Zweck im Projekt:** Vertiefende Analyse einer Quelle, die zuvor per Google Search
gefunden wurde (z. B. wenn Claude wissen will, was genau auf einer bestimmten
Ergebnis-Seite steht) - innerhalb desselben Tools `gemini-search`, Gemini
ruft dieses Built-in bei Bedarf automatisch mit auf.

### 3. Code Execution

Lässt Gemini eigenständig Python-Code schreiben und in einer isolierten Sandbox
ausführen, um z. B. Berechnungen, Datenauswertungen oder einfache Statistiken
aus zuvor gefundenen/gelesenen Daten zu erstellen
([Doku: Code Execution](https://ai.google.dev/gemini-api/docs/code-execution)). Die Sandbox hat
keinen eigenen Internetzugang - sie arbeitet nur mit Daten, die bereits im
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
    systemInstruction: `Today's date is ${new Date().toLocaleDateString("en-CA")}.`,
    tools: [{ googleSearch: {} }, { urlContext: {} }, { codeExecution: {} }],
    thinkingConfig: { thinkingLevel: "high" },
    store: false,
  },
});

console.log(response.text);
```

Wichtige Parameter-Hinweise aus der Dokumentation:

- `thinkingLevel` ersetzt das ältere `thinkingBudget` (Integer) - bei
  `gemini-3.5-flash` gilt der Enum-Wert (`minimal`, `low`, `medium`, `high`)
- Ohne explizite Angabe ist Thinking bei diesem Modell standardmäßig auf
  `medium` gesetzt. Dieser Server sendet trotzdem immer ein Level mit, damit
  der Footer den tatsächlich genutzten Wert ausweisen kann - ohne
  `config.json` ebenfalls `medium`
- Der API-Key kann per Header (`X-goog-api-key`) oder als Query-Parameter
  (`?key=...`) übergeben werden; Header-Variante wird bevorzugt

### Das aktuelle Datum als einzige System-Instruction

Das Modell hat selbst einen Trainings-Cutoff und legt "die neueste Version" an diesem aus, nicht an heute.
Vor dieser Instruction gemessen, suchte es in vier von sechs Aufrufen nach `2025 2026` - es kennt das Jahr nur ungefähr.
Bei einem Server, dessen ganzer Zweck das Umgehen von Trainingswissen ist, ist das die falsche Unschärfe.

```javascript
systemInstruction: `Today's date is ${new Date().toLocaleDateString("en-CA")}.`,
```

Drei Entscheidungen hinter dieser einen Zeile:

- **`systemInstruction` statt Präfix in `contents`.** Die Frage des Nutzers bleibt unangetastet; das Datum ist Kontext, nicht Teil der Anfrage.
- **Nur das Datum, sonst nichts.** Inhaltliche Vorgaben - "bevorzuge offizielle Dokumentation, GitHub, Stack Overflow", wie vergleichbare Server sie mitschicken - färben jede Antwort ein und verengen Recherchen zu Betriebssystem-Eigenheiten oder aktuellen Ereignissen. Ein Datum ist ein Fakt, eine Quellenpräferenz eine Meinung.
- **`toLocaleDateString("en-CA")` statt `toISOString()`.** Beide ergeben `YYYY-MM-DD`, aber `toISOString()` ist UTC und meldete in Mitteleuropa zwischen 00:00 und 02:00 Uhr den Vortag - ausgerechnet in der Funktion, die das richtige Datum sicherstellen soll.

Nach der Änderung verifiziert: Die Anfrage `Welche Node.js-Version ist aktuell LTS?` erzeugte die Suchanfrage `nodejs current lts version 2026` statt des vorherigen `2025 2026`, und direkt gefragt nennt das Modell das korrekte Datum.
Die Wirkung ist real, aber nicht absolut - bei breiten Fragen hedgt das Modell in einzelnen Suchanfragen weiterhin mit zwei Jahreszahlen.

### Logging bei Google: store

```javascript
store: false,
```

Seit dem 26.10.2026 speichert die Generate Content API Anfragen und Antworten bei **neu angelegten** Projekten standardmäßig; bei älteren nur, wenn das Logging in AI Studio eingeschaltet wurde ([Logs and datasets](https://ai.google.dev/gemini-api/docs/logs-datasets), Stand 26.10.2026).
Logs gibt es nur bei Projekten im Paid Tier, aufbewahrt werden sie standardmäßig 55 Tage.
Das Feld `store` auf Anfrage-Ebene hat Vorrang vor der Projekteinstellung, `false` hält also jede Anfrage aus diesen Logs heraus, egal wie und wann das Projekt eingerichtet wurde.
Das zählt hier, weil Rechercheanfragen regelmäßig Kontext aus der Arbeit tragen, in der sie gestellt wurden.

`store` ist nicht Invariante I4: I4 betrifft die Festplatte dieses Servers, `store` die Logs bei Google.
Die 30-tägige Speicherung für Grounding laut den Terms bleibt davon unberührt.

`scripts/probe-models.js` sendet das Feld ebenfalls, damit die Probe nicht weniger fragt als der Server.

## Antwort: Quellenliste und Token-Footer

Jede Antwort des MCP-Servers enthält neben dem eigentlichen Antworttext vier
zusätzliche, direkt aus der Gemini-API-Antwort ausgelesene Teile (nicht selbst
berechnet oder geschätzt):

1. Eine **Quellenliste** (Titel + URL) am Ende des Textes - Claude soll die
   Quellen sehen und weiterverwerten können (z. B. gezielt eine URL vertiefen
   oder die Aussage einer Quelle zuordnen), nicht nur eine reine Zahl. Sie
   führt Google-Search-Treffer und per URL Context gelesene Seiten
   zusammen und dedupliziert nach URL.
2. **Belegmarker** (`[1]`, `[1][3]`) im Fließtext an den Stellen, für die die
   API eine Quelle ausweist - damit sichtbar wird, welche Aussagen belegt sind
   und welche das Modell aus eigenem Wissen ergänzt hat.
3. Einen **Footer** mit Input-/Output-/Thinking-Tokens, Quellenanzahl sowie
   dem verwendeten Modell und Thinking-Level, zur Transparenz über den
   tatsächlichen Ressourcenverbrauch und die genutzte Modell-/Thinking-Wahl
   des Tool-Calls - der User soll nie raten müssen, was verwendet wurde.
4. Die **tatsächlich abgesetzten Suchanfragen** in einer zweiten Footer-Zeile,
   weil sie beantworten, was die anderen drei nicht können: ob die Suche die
   Frage überhaupt abgedeckt hat.

### Antworttext: eigener Aufbau statt `response.text`

`gemini.js` setzt den Antworttext selbst aus `candidates[0].content.parts`
zusammen (`buildText`), statt den `.text`-Getter des SDK zu nutzen. Der Getter
verkettet ausschließlich Textteile, verwirft alles andere und schreibt dabei
pro Aufruf eine Warnung nach stderr. Bei aktiviertem Code Execution fällt damit
genau der Teil weg, der zeigt, wie ein Rechenergebnis zustande kam - die
Antwort behauptet ein Ergebnis, ohne den Weg dorthin zu belegen. `buildText`
übernimmt deshalb zusätzlich `executableCode` und `codeExecutionResult` als
Codeblöcke. Teile mit `thought: true` bleiben außen vor; ihr Umfang steht
bereits als Thinking-Tokens im Footer.

Die Reihenfolge wird dabei bewusst umgestellt: Die API liefert die Parts in
Ausführungsreihenfolge, sodass Code und Ergebnis **vor** dem erklärenden Text
stehen - die Antwort begänne also mit einem Codeblock, die eigentliche Auskunft
käme darunter. `buildText` sammelt Text- und Codeblöcke getrennt und hängt die
Codeblöcke unter der Überschrift `Code execution:` hinten an. Der Rechenweg ist
ein Beleg und steht damit dort, wo auch die Quellenliste steht: hinter der
Antwort, nicht davor.

Bewusst **nicht** begrenzt wird die Länge von `codeExecutionResult.output`:
Auch eine lange Ausgabe ist Teil des Rechenwegs, und ein Umfang, der im
Research-Kontext stören würde, ist die seltene Ausnahme.

### Belegmarker im Fließtext

Zusätzlich zur Quellenliste am Ende stehen Marker direkt im Antworttext, an
den Stellen, für die die API über `groundingMetadata.groundingSupports` eine
Quelle ausweist:

```text
In Python 3.13 wurde `date_parser` entfernt[1]. Der Typcode 'w' ist neu[1][3].
Das Standardverhalten des C-Parsers ist unverändert.
```

Format: `[1]` direkt am Ende der belegten Textstelle, mehrere Quellen als
`[1][3]` (entspricht Googles Referenzimplementierung in der Gemini CLI). Die
Nummern sind dieselben wie in der Quellenliste.

**Der Zweck ist nicht in erster Linie, *welche* Quelle einen Satz stützt,
sondern *ob* er überhaupt belegt ist.** Gemessen an einer echten Antwort waren
27 % des Textes durch keinen einzigen Support gedeckt - Aussagen aus dem
Modellgedächtnis, optisch nicht von den recherchierten zu unterscheiden. Der
Leser dieses Servers schreibt gegen solche Sätze anschließend Code.

#### Semantik - wichtig

| Aussage | Gilt |
| --- | --- |
| Marker vorhanden ⇒ Stelle ist belegt | zuverlässig |
| Marker fehlt ⇒ Stelle ist unbelegt | **nur ein Indiz, kein Beweis** |

Ein Marker kann aus vier Gründen fehlen, von denen nur der erste die gemeinte
Bedeutung hat:

1. Die Stelle ist tatsächlich ungegroundet.
2. Die Verifikation gegen `segment.text` schlug fehl (siehe unten).
3. Die Position lag in einem Markdown-Codeabschnitt.
4. Die Quelle stammt **ausschließlich** aus `urlContextMetadata` - zu solchen
   Einträgen liefert die API keine `groundingSupports`, sie können also keinen
   Marker tragen.

Die Fälle 2 und 3 sind zählbar und stehen als `⚠️ n markers dropped` im Footer,
sobald sie über null liegen. Fall 4 ist an der Quellenliste erkennbar.

Zu Fall 4 eine Messung, die gegen die naheliegende Erwartung ausfiel: Bei einer
Anfrage mit konkreter URL hat URL Context nachweislich gefeuert
(`urlRetrievalStatus: URL_RETRIEVAL_STATUS_SUCCESS`) - die gelesene Seite stand
aber **zusätzlich als `groundingChunk`** in der Antwort, mit direkter URL statt
vertexaisearch-Weiterleitung und drei eigenen `groundingSupports`. Sie war damit vollständig durch Marker abgedeckt und kam
über die Deduplizierung nach URL gar nicht mehr im URL-Context-Zweig an.

Fall 4 greift also nur, wenn eine per URL Context gelesene Seite **nicht**
zugleich unter den `groundingChunks` auftaucht. Ob und wann das vorkommt, ist
offen - beobachtet wurde bisher nur der günstige Fall. „Kein Marker ⇒ unbelegt"
bleibt deshalb ein Indiz, ist aber weniger stumpf als beim Aufstellen dieser
Regel angenommen.

#### Umsetzung (`citations.js`)

- **Byte-Offsets, nicht Zeichenpositionen.** `startIndex`/`endIndex` sind laut
  SDK-Typdefinition „measured in bytes". An einer deutschen Testantwort stimmte
  keine einzige von 28 Positionen zeichenbasiert, alle 28 bytebasiert; Text und
  Bytes liefen am Ende um 44 Stellen auseinander. Eingefügt wird deshalb über
  `Buffer`. Google selbst hatte diesen Fehler in der Gemini CLI
  ([PR #5956](https://github.com/google-gemini/gemini-cli/pull/5956),
  aufgefallen an japanischem Text).
- **Pro Part, vor dem Zusammenfügen.** Die Offsets zählen ab dem Anfang jedes
  einzelnen Parts (`Segment.partIndex`, „Offset from the start of the Part"),
  nicht ab dem Anfang des zusammengesetzten Textes. `buildText` setzt die Marker
  deshalb innerhalb der Schleife über die Parts - vor dem `join("\n\n")` und vor
  den Code-Execution-Blöcken, die vom Server erzeugt werden und in der Zählung
  der API gar nicht existieren.
- **Verifikation gegen `segment.text`.** Die API liefert den erwarteten
  Ausschnitt mit. Passt er nicht zur berechneten Position, wird der Marker
  verworfen statt geraten. Folge: **Ein Marker kann nie an der falschen Stelle
  landen - er kann nur fehlen.** Das ist zugleich das Sicherheitsnetz gegen eine
  stille Änderung der Offset-Semantik durch Google.
- **Keine Marker in Codeabschnitten.** Ein Marker mitten in einem Codebeispiel
  macht aus `copy.replace(obj, x=1)` ein `copy.replace(obj[3], x=1)` -
  syntaktisch gültig, inhaltlich falsch, und unauffällig. Umzäunte Blöcke und
  Inline-Code werden in einem Durchlauf als Intervalle bestimmt (die Zäune
  stehen in der Alternation vorn und schlucken damit alles, was in ihnen steht);
  fällt die Zielposition hinein, wird der Marker verworfen. Ein Zaun, der nie
  geschlossen wird, reicht bis zum Ende des Textes, wie in CommonMark - eine
  durch `MAX_TOKENS` abgeschnittene Antwort endet oft mitten in einem Block.
  Nicht erkannt werden eingerückte Codeblöcke (vier Leerzeichen) -
  die einzige bekannte Lücke.
- **Nummern über `chunkNumbers`, nie über `index + 1`.** Siehe „Quellenliste
  erzeugen" unten.

Protobuf lässt Defaultwerte weg: `startIndex` und `partIndex` fehlen im JSON,
wenn sie 0 sind - beide brauchen `?? 0`. `confidenceScores` und `renderedParts`
wurden als Qualitätsfilter geprüft und verworfen: bei Gemini 3.x in der Praxis
leer (0 von 28 befüllt).

Bewusst nicht zusammengefasst werden redundante Marker an **verschiedenen**
Positionen. Verschachtelte Supports (gemessen: vier Supports mit gleichem
Startpunkt, verschiedenen Endpunkten und derselben Quelle) erzeugen mehrere
identische Marker in einem Absatz. Sie zusammenzufassen verwürfe Auflösung, und
für einen maschinellen Leser ist Rauschen billiger als eine fehlende Markierung.

Zusammengefasst wird, was an **derselben** Position steht. Dedupliziert wird
deshalb pro Byte-Offset und nicht pro Support: Zwei Supports, die auf demselben
Byte enden, haben keine Auflösung zu verlieren, und getrennt gehalten schrieben
sie dieselbe Nummer zweimal (`[1][1]`).

### Hinweis bei nicht regulär beendeter Antwort

Fehlt der Text ganz oder bricht er ab, sähe die Antwort mit Quellenliste und
Footer trotzdem wie ein Erfolg aus. `formatNotice` fügt deshalb zwischen Text
und Quellenliste eine Zeile mit ⚠️ ein, wenn einer dieser Fälle vorliegt:

| Bedingung | Hinweis |
| --- | --- |
| `response.promptFeedback.blockReason` gesetzt | Anfrage von der API blockiert |
| Text leer | Antwort ohne Text, mit `candidates[0].finishReason` |
| `finishReason` gesetzt und ≠ `STOP` | unvollständige Antwort, vor allem `MAX_TOKENS` |

`STOP` ist der reguläre Abschluss; die übrigen Werte des `FinishReason`-Enums
(`MAX_TOKENS`, `SAFETY`, `RECITATION`, `BLOCKLIST`, …) bedeuten einen Abbruch.
Der Footer bleibt in jedem Fall der letzte Bestandteil der Antwort.

### Woher die Werte kommen

Jede `generateContent`-Antwort liefert automatisch ein `usageMetadata`-Objekt
mit der Token-Aufschlüsselung
([Doku: Token counting](https://ai.google.dev/gemini-api/docs/tokens)) sowie -
bei aktiviertem Google Search Tool - ein `groundingMetadata`-Objekt mit den
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
| Suchanfragen       | `candidates[0].groundingMetadata.webSearchQueries`             | Array der tatsächlich an Google gesendeten Suchanfragen       |
| Such-Quellen       | `candidates[0].groundingMetadata.groundingChunks`              | Array der bei der Google-Suche gefundenen Webquellen          |
| Such-Quell-URL     | `groundingChunks[i].web.uri`                                   | URL der einzelnen Suchquelle                                  |
| Such-Quell-Titel   | `groundingChunks[i].web.title`                                 | Titel der einzelnen Suchquelle                                |
| Belegzuordnung     | `candidates[0].groundingMetadata.groundingSupports`            | Textstelle → Quelle, Grundlage der Belegmarker                |
| Belegte Textstelle | `groundingSupports[i].segment`                                 | `startIndex`/`endIndex` (in **Bytes**), `text`, `partIndex`   |
| Belegte Quellen    | `groundingSupports[i].groundingChunkIndices`                   | Indizes in `groundingChunks` - **nicht** in der Quellenliste  |
| URL-Context-Quelle | `candidates[0].urlContextMetadata.urlMetadata[i].retrievedUrl` | URL einer von Gemini gezielt gelesenen Seite (kein Grounding) |

Beide Quell-Arrays sind nur vorhanden, wenn das jeweilige Tool tatsächlich
verwendet wurde - sonst leer oder nicht vorhanden, daher immer mit `?? []`
absichern.

### Quellenliste erzeugen

Such-Treffer und URL-Context-Seiten werden zu einer Liste zusammengeführt und
nach URL entduplifiziert.
Such-Treffer haben Vorrang, weil nur sie `groundingSupports` mitbringen und
damit Belegmarker tragen können; ein später eintreffender URL-Context-Eintrag
nähme ihnen das.
Was sie **nicht** mitbringen, ist ein sprechender Titel: Gemessen steht in
`groundingChunks[i].web.title` der blanke Domainname (`npmjs.com`, `github.com`,
`dev.to`, `snyk.io`), der nicht mehr aussagt als die `retrievedUrl` eines
URL-Context-Eintrags.

`buildSourceList` liefert dabei **zwei** Dinge: die Liste selbst und die
Zuordnung `chunkNumbers` vom Index in `groundingChunks` auf die Nummer in der
ausgegebenen Liste. Beide Zählungen laufen auseinander, weil `groundingChunks`
Suchtreffer abbildet und nicht Quellen - gemessen 17 Treffer bei 14 eindeutigen
URLs, in einem früheren Lauf sogar 14 bei 4. Die Belegmarker dürfen deshalb
**niemals** über `index + 1` nummeriert werden; sie liefen sonst über das Ende
der Quellenliste hinaus oder verwiesen auf die falsche Quelle.

```javascript
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
  // Der einzige Pfad, auf dem ein Link verlorengehen kann - daher der Zaehler.
  if (!uri) {
    skipped++;
    return;
  }
  chunkNumbers.set(index, addSource(chunk.web?.title ?? uri, uri));
});

// URL-Context-Quellen stehen hinter den Suchtreffern und erzeugen keine
// Marker - sie beeinflussen die Nummerierung damit nicht.
for (const entry of urlContextEntries) {
  if (entry.retrievedUrl) addSource(entry.retrievedUrl, entry.retrievedUrl);
}

const sourceList = sources
  .map((s, i) => `[${i + 1}] ${s.title} - ${s.uri}`)
  .join("\n");
```

Chunks ohne `uri` schaffen es weder in die Liste noch in `chunkNumbers` und
erzeugen folglich keinen Marker.
Gezählt werden sie aber und stehen, sobald der Zähler über null liegt, als
`⚠️ n sources omitted (unknown chunk type)` im Footer.
Bisher liefert die API ausschließlich `web`-Chunks; käme ein zweiter Typ hinzu,
verschwänden dessen Links stillschweigend aus der Liste - der einzige Pfad in
diesem Code, auf dem eine Quelle verlorengehen kann (siehe
„Terms-Konformität" unten).
Mehr als Zählen ist ohne Kenntnis des unbekannten Typs nicht möglich, aber es
macht aus einem stillen Verlust einen sichtbaren.

### Footer-Format im Tool-Ergebnis

```javascript
// Verworfene Belegmarker nur, wenn es welche gab - der Normalfall soll den
// Footer nicht verlaengern. Gleiche Regel fuer uebersprungene Chunks.
const droppedNote = dropped > 0 ? ` | ⚠️ ${dropped} markers dropped` : "";
const skippedNote =
  skipped > 0 ? ` | ⚠️ ${skipped} sources omitted (unknown chunk type)` : "";

// Das Modell, das geantwortet hat, wo es nicht das angefragte ist.
const served = modelVersion && modelVersion !== model ? ` → ${modelVersion}` : "";

const footer =
  `\n\n---\n🔢 ${inputTokens} input / ${outputTokens} output / ${thinkingTokens} thinking tokens ` +
  `| 🔍 ${sources.length} sources | 🤖 ${model}${served} (thinking: ${thinkingLevel})` +
  `${droppedNote}${skippedNote}` +
  formatSearchQueries(searchQueries) +
  formatContinuationNote(usageMetadata) +
  formatFallbackNote(fallback);

const sourcesBlock = sourceList ? `\n\nSources:\n${sourceList}` : "";

return {
  content: [{ type: "text", text: text + notice + sourcesBlock + footer }],
};
```

`text` und `dropped` stammen dabei aus `buildText(candidate, { supports,
chunkNumbers })`, `notice` aus `formatNotice(...)` - siehe die Abschnitte oben.

Beispielausgabe am Ende jeder Antwort:

```text
Sources:
[1] Gemini API Docs - https://ai.google.dev/gemini-api/docs/models
[2] Google Gen AI SDK - https://googleapis.github.io/js-genai/

---
🔢 245 input / 89 output / 40 thinking tokens | 🔍 2 sources | 🤖 gemini-flash-latest → gemini-3.8-flash (thinking: high)
🔎 Searched: gemini api models list · google genai sdk models.list pagination
```

Das Feld `🤖` nennt das angefragte Modell und nach einem Pfeil dasjenige, das tatsächlich geantwortet hat, entnommen aus `response.modelVersion`.
Die beiden unterscheiden sich in zwei Fällen, gemessen am 26.10.2026: Ein Alias löst sich in ein konkretes Modell auf (`gemini-flash-latest` antwortet als `gemini-3.8-flash`, `gemini-pro-latest` als `gemini-3.1-pro-preview`), und eine abgekündigte ID wird ohne Fehler auf ihren Nachfolger umgeleitet (`gemini-3.7-flash` antwortet als `gemini-3.8-flash`).
Ohne den Pfeil nennte der Footer ein Modell, das nie gelaufen ist, und die Regel, dass das tatsächlich genutzte Modell immer sichtbar ist, gälte nur für konkrete, aktuelle IDs.
Verglichen wird auf exakte Zeichengleichheit; stimmen beide Namen überein oder fehlt `modelVersion` in der Antwort, sieht das Feld aus wie bisher.
Nach einem Fallback enthält `model` bereits das Backup, der Pfeil vergleicht also mit dem Modell, das tatsächlich gefragt wurde.

Die Zahl der verworfenen Marker gehört in den Footer, weil sie die
Aussagekraft der Antwort verändert: Fehlt ein Marker, kann die Stelle
ungegroundet sein - oder die Prüfung hat ihn verworfen. Das entspricht dem
Zweck des Footers, den tatsächlichen Zustand jedes einzelnen Aufrufs sichtbar
zu machen.

`formatFallbackNote` folgt demselben Muster wie `formatSearchQueries`: Ohne Fallback liefert es einen leeren String, und damit entfällt die Zeile ganz.
Es nutzt 🔁 und nicht ⚠️, weil ein geglückter Fallback keine beeinträchtigte Antwort ist - das Warnzeichen bleibt den Fällen vorbehalten, in denen mit der Antwort selbst etwas nicht stimmt.
Einzelheiten unten in „Das optionale Backup-Modell".
`formatContinuationNote` folgt demselben Muster für eine Antwort, die mehr als eine Anfrage gebraucht hat - siehe „Automatische Fortsetzung" unten.

### Die Zeile mit den Suchanfragen

`webSearchQueries` enthält die Anfragen, die Gemini tatsächlich an Google geschickt hat - nicht die Frage, die der Nutzer gestellt hat.
Beide gehen auseinander, und genau darin liegt der Nutzen.

Auf die Bitte, sechs Web-Frameworks nach Version **und** Bundle-Größe zu vergleichen, suchte das Modell sechsmal nach `<Framework> current version 2025 2026 npm` und einmal nach Bundle-Größen; Rendering-Strategie und Lernkurve, ebenfalls Teil der Frage, wurden nie gesucht und kamen aus dem Modellwissen.
Weder Quellenliste noch Belegmarker zeigen das: Marker weisen aus, ob ein *Satz* gestützt ist, nicht ob die *Suche* die Frage abgedeckt hat.
Damit ist diese Zeile die einzige Stelle, an der eine unterrecherchierte Antwort als solche erkennbar wird.

Format und Kappung:

- **Eigene Zeile** unterhalb der Kennzahlen, nicht an sie angehängt. Zusammen wären es im gemessenen Fall 385 Zeichen, die im Terminal auf vier Zeilen umbrechen - ausgerechnet bei den langen Antworten, in denen der Footer die Orientierung geben soll.
- **`·` als Trennzeichen**, nicht `,`. Die Suchanfragen enthalten selbst Anführungszeichen und Ziffernfolgen, zwischen denen ein Komma untergeht.
- **Kappung bei 300 Zeichen**, der Rest als `(+n more)`. Gemessen: üblich 2 bis 6 Anfragen mit zusammen 73 bis 270 Zeichen, die einzelne Anfrage 29 bis 84 Zeichen - bei einer bewusst überbreiten Frage aber 11 Anfragen mit über 500 Zeichen. Eine Obergrenze nennt die API nicht, daher die Kappung.
- **Die Anfrage, die das Budget reißt, wird noch vollständig ausgeschrieben** statt mitten im Wort abgeschnitten: Eine halbe Suchanfrage trägt keine Information, und der Überhang ist durch die Länge einer einzelnen Anfrage begrenzt.
- **Ein leeres Array erzeugt gar keine Zeile**, nach derselben Regel wie der Hinweis auf verworfene Marker: Der Normalfall soll den Footer nicht verlängern. Dass nicht gesucht wurde, ist über `🔍 0 sources` bereits sichtbar.
- **Identische Anfragen erscheinen einmal.** Nach einer Fortsetzung hängt das SDK die Anfragelisten aller Etappen aneinander, und eine Etappe kann eine Suche der vorigen wiederholen. Anders als für die Quellenliste gilt für diese Zeile keine Invariante - sie meldet, wonach gesucht wurde, und eine Wiederholung fügt dem nichts hinzu.

Tatsächlich implementiert in `gemini.js` (`buildText`, `formatNotice`,
`buildSourceList`, `formatSourcesBlock`, `formatFooter`, `formatSearchQueries`)
und `citations.js` (`insertCitations`).
`buildSourceList`, `formatSourcesBlock`, `formatFooter` und
`formatSearchQueries` sind exportiert und wie `insertCitations` ohne API-Key
prüfbar (`test/sources.test.js`, `test/search-queries.test.js`).
`gemini.js` und `models.js` lassen sich ohne `GEMINI_API_KEY` importieren,
weil `getClient()` erst in `runSearch` und `fetchModels` aufgerufen wird, nicht
beim Laden des Moduls.

### Automatische Fortsetzung

Seit `@google/genai` 2.26/2.29 schickt `generateContent()` eine Anfrage, deren Antwort mit `finishReason: "CONTINUATION"` endet, mit dem `continuationToken` der Antwort erneut und verschmilzt die Antworten (`generateContentWithContinuation`).
Das ist standardmäßig an; `automaticContinuation: false` schaltete es ab.
Der Server lässt es an: Eine abgeschnittene Antwort ist schlimmer als eine lange.

Was das Verschmelzen tut, gelesen im SDK-Quelltext (`mergeContinuationResponses`):

- die Parts werden aneinandergehängt, und `segment.partIndex` und `groundingChunkIndices` späterer Etappen werden verschoben, sodass `buildText` die Marker wie bisher pro Part setzt
- `groundingChunks` werden aneinandergehängt; `buildSourceList` dedupliziert identische URIs, was I1 erlaubt
- `usageMetadata` wird summiert, der Prompt eingeschlossen, weil jede Etappe ihn erneut sendet und abrechnet; `initialPromptTokenCount` behält den Wert der ersten Etappe
- `webSearchQueries` werden aneinandergehängt, `formatSearchQueries` schreibt identische Anfragen deshalb einmal
- `finishReason` ist der der letzten Etappe
- eine Obergrenze für die Zahl der Etappen gibt es nicht, und Fristen, Retries und Abrechnung gelten pro Anfrage (SDK-Doku zu `automaticContinuation`)

Die Token-Zeile zeigt die Summen, denn die werden abgerechnet.
Eine Zeile darunter sagt, warum die Input-Zahl ein Vielfaches dessen sein kann, was die Frage für sich gekostet hat:

```text
↪ Continued in further requests - input tokens summed over all of them (first request: 2405)
```

Das SDK zählt die Etappen nicht, `promptTokenCount > initialPromptTokenCount` ist die einzige Spur, die eine Fortsetzung hinterlässt (`formatContinuationNote`).
Es ist ein `↪` und kein `⚠️`: Die Antwort ist vollständig, sie hat nur mehr gekostet.

Die lokale Notbremse gilt für alle Etappen zusammen (siehe „Die Frist, die dieser Server mitschickt").
Eine späte Etappe kann deshalb abgeschnitten werden, während Google noch rechnet und abrechnet.

Nicht gemessen: ob das Gemini API für die Anfragen dieses Servers überhaupt `CONTINUATION` liefert - keine echte Antwort hat das bisher getan, und gezielt auslösen lässt es sich nicht.
`test/continuation.test.js` deckt den Pfad mit zwei nachgebauten Etappen durch das echte SDK ab.

## Terms-Konformität

Die Quellenliste ist keine Eigenschaft, an der sich schrauben ließe, sondern die
Bedingung, unter der dieser Server Grounding with Google Search überhaupt nutzen
darf.
Die [Gemini API Additional Terms of Service](https://ai.google.dev/gemini-api/terms#grounding-with-google-search)
schützen nicht die API, sondern die Verlage, deren Inhalte in den Antworten
zusammengefasst werden.
Der Link zur Quelle ist das Einzige, was zu ihnen zurückfließt, und Googles
Redirect ist das, was diesen Rückfluss nachweisbar macht.

Daraus folgen vier Invarianten.
Sie sind heute erfüllt und ab hier verbindlich: **Wer eine Änderung erwägt, die
eine von ihnen berührt, setzt sie nicht um, sondern fragt zuerst nach** - auch
dann, wenn die Änderung als Aufräumen, Kürzen oder Optimieren daherkommt.

| # | Invariante | Warum |
| --- | --- | --- |
| I1 | Kein Link wird je weggelassen | Jeder `groundingChunk` mit URI erscheint in der Liste, auch ohne Marker darauf. Keine Obergrenze, keine Auswahl, keine Deduplizierung nach Domain |
| I2 | Kein Link wird verändert, URI **und** Titel | Redirect-URLs gehen byteidentisch hinaus; der Titel zählt als Bestandteil des Links |
| I3 | Kein Redirect wird aufgelöst | Einziger ausgehender Verkehr ist der SDK-Aufruf an die Gemini-API |
| I4 | Nichts wird zwischengespeichert | Grounded Results berühren nie die Festplatte; `config.json` enthält Modellnamen, Thinking-Level und Frist, sonst nichts |

Deduplizieren nach identischer URI verstößt gegen keine davon, weil dabei kein
Ziel verlorengeht.
Deduplizieren nach Domain verstieße gegen I1.

### Was die Terms tatsächlich sagen

Dass der Titel zum Link gehört, steht ausdrücklich dort und ist der Teil, den
man am leichtesten übersieht:

> "Links" are any other means to fetch web pages (including hyperlinks and URLs), which may be contained in a Grounded Result or Search Suggestion.
> Links also include titles or labels provided with those means to fetch web pages.

Der entscheidende Satz für einen Server wie diesen ist der „for clarity"-Satz in
den Use Restrictions, nicht die Aufzählung davor:

> For clarity, Grounded Results, Search Suggestions, and Links are intended to be used in combination to respond to a given end user prompt and it is a violation of these terms to use Grounding with Google Search to extract or collect one or more of these components for another purpose (for example, using programmatic or automated means to collect Links, using Links to build an index, or **using Links to identify destination pages for crawling or scraping**).

Zweierlei folgt daraus.
Erstens nennt er I3 beim Namen, was die Herleitung erspart.
Zweitens beantwortet er aus dem Wortlaut statt durch Auslegung, ob ein Server
die Ergebnisse überhaupt verarbeiten darf: Untersagt ist das Herauslösen
einzelner Bestandteile **für einen anderen Zweck**.
Ohne diesen Satz liest sich die Aufzählung davor („cache, frame, syndicate,
resell, analyze, train on, or otherwise learn from") so, als sei auch die
bestimmungsgemäße Nutzung verboten.

Eine Klausel wird regelmäßig als Verbot zitiert und ist keines: „you do not
allow Grounded Results to be accessed or collected by automated or programmatic
means" steht **innerhalb einer Ausnahme**, nämlich der, die dem Endnutzer das
Kopieren erlaubt.
Die eigenständigen Verbote sind die oben zitierte „for clarity"-Restriktion und
das Verbot, die Ergebnisse zu verändern oder fremde Inhalte dazwischenzumischen.

### Warum die Quellenliste nicht gekappt wird

Die Quellenliste kostet mehr Tokens als der Antworttext.
Das ist bekannt, gemessen und akzeptiert - es ist der Preis des Tauschs, auf dem
Grounding beruht, und **kein Optimierungsauftrag**
([Issue #6](https://github.com/brobertoblanko/gemini-grounding-mcp/issues/6)).

Gemessen an einer Antwort mit 22 Quellen fallen die naheliegenden Einsparungen
klein oder ganz aus:

| Idee | Wirkung | Urteil |
| --- | --- | --- |
| Liste kappen | - | verstößt gegen I1 |
| Nur zitierte Quellen listen | keine - 22 von 22 waren durch mindestens einen Support belegt | bringt nichts |
| Nach Domain deduplizieren | etwa 1.000 Token | verstößt gegen I1 |
| Redirects zu kurzen URLs auflösen | - | verstößt gegen I3, den Fall nennen die Terms ausdrücklich |
| Liste in eine MCP-Resource verschieben | trennt Marker von Zielen, Client-Support unsicher | löst das eigentliche Problem nicht: Eine Liste aus fünfzehnmal demselben Domainnamen wird durch Verschieben nicht brauchbarer |

### Wo der Server Inhalt hinzufügt oder umstellt

Die Terms untersagen es, fremde Inhalte („any other content") zwischen die
Grounded Results zu mischen.
Der Server tut zweierlei, das daran rührt, und beides wiegt unterschiedlich
schwer:

- **Belegmarker** (`citations.js`) werden in den Antworttext eingefügt. Googles
  eigene Referenzimplementierung in der Gemini CLI setzt dieselben Marker, also
  kann die Klausel nicht sie meinen, sondern fremde Inhalte wie Werbung. Die
  Marker verweisen zudem auf die mitgelieferten Links, statt von ihnen
  wegzuführen.
- **Die Umsortierung der Code-Execution-Blöcke** (`buildText`) hat keine
  Referenzimplementierung hinter sich, nur das inhaltliche Argument, dass der
  Rechenweg ein Beleg ist und damit hinter die Antwort gehört statt davor. Das
  ist ein Argument, keine geklärte Frage, und wird hier als solches benannt.

### Die Lücke hinter dem Server

Die Terms verlangen, dass die Grounded Results dem Endnutzer angezeigt werden,
der die Anfrage gestellt hat.
Ein MCP-Server kann das nur anregen; er übergibt seine Antwort an einen Client
und hat keinen Einfluss darauf, was der Client davon zeigt.
Der einzige Hebel ist das `instructions`-Feld in `index.js`, das den Client
bittet, Quellenliste und Footer unangetastet zu lassen - durchsetzbar ist es
nicht.
Das ist eine echte Lücke und kein gelöstes Problem; sie steht hier, statt
übergangen zu werden.

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
hier funktionieren - in der weiter unten genannten Messung 60 insgesamt, davon
33 nutzbar. Gefiltert wird über zwei Angaben, die jedes Modell selbst
mitliefert:

| Feld | Bedingung | Andernfalls |
| --- | --- | --- |
| `supportedActions` | enthält `generateContent` | Modell erzeugt keinen Text - Embeddings, Imagen, Veo, Live/Audio |
| `thinking` | `true` | `400 Thinking level is not supported for this model.`, da `runSearch` immer ein `thinkingConfig` sendet |

Beide Felder sind im `Model`-Interface des SDK dokumentiert. Bewusst **nicht**
über Namensmuster gefiltert: Google vergibt Codenamen, die nichts über die
Fähigkeiten aussagen (`nano-banana-pro-preview` ist ein Bildmodell), sodass
jede Musterliste bei der nächsten Modellfamilie veraltet.

Grenzen, die der Filter nicht auflöst - beide sind der Grund für die weiter
unten beschriebene Ausschlussliste:

- Er trennt technische Lauffähigkeit, nicht Eignung. Bild-, Sprach- und
  Robotikmodelle erfüllen die Bedingungen teilweise ebenfalls.
- **Gelistet heißt nicht verfügbar.** Abgekündigte Modelle bleiben in der
  Antwort und liefern bei Nutzung `404 ... is no longer available` - nachweisbar
  an der 2.0-Generation. Ein Feld, das den Zustand vorab anzeigt, existiert
  nicht.

Deshalb ist `all` kein reiner Komfortschalter: Da die Liste ohnehin keine
Garantie gibt, darf die gefilterte Sicht nie die einzige sein. `all: true`
zeigt die vollständige Liste mit einer Statusspalte, die angebotenen Modelle
zuerst und als `offered` markiert; ein Modell ohne `generateContent` zeigt
`no text` und das, was es stattdessen tut, etwa `no text (embedContent)`.
Beide Ansichten beginnen mit einer Kopfzeile, die die Spalten benennt. Ergibt
der Filter kein einziges Modell - etwa weil die API die ausgewerteten Felder
nicht mehr liefert - fällt `listModels` selbsttätig auf die vollständige Liste
zurück und weist im Hinweistext darauf hin, statt eine leere Ausgabe zu
erzeugen.

### Die Ausschlussliste

`models-excluded.js` enthält die Modelle, die `isUsableModel` bestehen und
trotzdem nicht in eine Liste gehören, aus der jemand ein Recherchemodell
auswählt. Sie wird zusätzlich zu diesem Filter angewandt und nur in der
Standardansicht; `all: true` umgeht sie vollständig und trägt bei jedem Eintrag
die Sorte seines Ausschlusses als Status ein - `400 INVALID_ARGUMENT`,
`404 NOT_FOUND`, `deprecated`, `no sources` oder `unsuitable` -, der Ausschluss verlagert die
Information also, statt sie zu verlieren. Sie steuert die Anzeige und sonst
nichts: `gemini-set-config` und ein `model` pro Aufruf nehmen jede ID an, auch
eine ausgeschlossene.

Gemessen am 26.10.2026 mit `scripts/probe-models.js` gegen einen einzelnen
API-Key: 60 Modelle insgesamt, 33 nach `isUsableModel`, 25 ausgeschlossen, 8
angeboten.

**Vier Sorten Eintrag, nach Belastbarkeit geordnet.** Jede Begründung nennt
ihre Sorte, weil sie unterschiedlich altern:

| Sorte | Grundlage | Anzahl |
| --- | --- | --- |
| `400`/`404` | die Zurückweisung der API im Wortlaut | 18 |
| `deprecated` | der Hersteller leitet die ID auf ihren Nachfolger um, und `modelVersion` nennt diesen | 2 |
| `no sources` | das Modell antwortet und liefert keinen Grounding-Chunk | 3 |
| `unsuitable` | der Hersteller dokumentiert das Modell für einen anderen Zweck | 2 |

Die erste Sorte ist die stärkste und kommt ohne Beurteilung aus:
`Code execution is not enabled for this model` bei den Bildmodellen,
`Thinking level is not supported for this model.` bei Gemma,
`This model only supports Interactions API` bei den Deep-Research- und
Omni-Modellen, sowie `no longer available to new users` bei
`gemini-2.5-flash`, `-flash-lite` und `-pro`.

`deprecated` erfasst IDs, die Google ohne Fehler zurückzieht: Seit dem 08.10.2026 wird laut [Changelog](https://ai.google.dev/gemini-api/docs/changelog) `gemini-3.7-flash` serverseitig auf `gemini-3.8-flash` umgeleitet und `gemini-3.5-flash` auf `gemini-3.6-flash`.
Beide antworten und grounden, weder die Probe noch ein Statuscode fängt sie also; verraten werden sie durch `response.modelVersion`, das den Nachfolger nennt.
Sie anzubieten hieße, einen Namen in die Liste zu setzen, unter dem nie ein Aufruf läuft.
Der Eintrag blendet sie nur in der Liste aus - ein Aufruf, der eine davon nennt, funktioniert weiterhin, und der Footer zeigt dann beide Namen (siehe „Footer-Format im Tool-Ergebnis").
Die letzte Sorte ist die schwächste und bei einer Überprüfung als Erstes nachzuschlagen: Ein Modell ist nur so lange ungeeignet, wie seine Dokumentation das sagt.

**Exakte IDs, keine Wildcards.** Ein Muster wie `*-image` würde Nachfolger von
selbst fangen, aber ein künftiges Modell, das Bilder *versteht* und `image` im
Namen trägt, verschwände unbemerkt. Der Fehlermodus ist bewusst gewählt: Ein
nicht eingetragenes neues Modell erscheint in der Liste - sichtbar, folgenlos,
und es meldet sich selbst zur Pflege an. Nichts fällt je ungesehen heraus. Der
Preis ist das Nachtragen von Hand.

Ein Schwellwert auf `inputTokenLimit` wurde aus demselben Grund verworfen. Er
trennte die Messung perfekt - die brauchbaren Textmodelle erreichen 1M, die
Bild-, Robotik-, TTS- und Gemma-Modelle liegen bei 256k oder darunter -, würde
aber ein gutes Textmodell mit kleinerem Kontextfenster wortlos verstecken. Die
beiden Robotikmodelle zeigen, dass das nicht hypothetisch ist: Sie erreichen
128k, grounden korrekt und sind hier aus einem dokumentierten Grund
ausgeschlossen, nicht wegen ihrer Größe.

**Im Code, nicht in `config.json`.** Die Liste ist eine Projektentscheidung,
kein Nutzerzustand, und `config.json` ist auf Modellnamen, Thinking-Level und
Frist festgelegt. Im Code ist sie versioniert, testbar und trägt ihre Begründung im
Kommentar.

**Was sie ehrlich hält.** Eine ID mit Tippfehler wirkt nie, und nichts weist
darauf hin - derselbe stille Fehler, den die Liste vermeiden soll, nur
versetzt. `test/models.test.js` prüft drei Dinge gegen die gespeicherte
Antwort in `test/fixtures/models-list.json`: dass jeder Eintrag auf ein Modell
passt, dass kein Eintrag bereits von `isUsableModel` entfernt wird und damit
unerreichbar ist, und dass jede Begründung ihre Sorte nennt. Der Fixture ist
der rohe HTTP-Body und nicht das Objekt des SDK, weil der Mock der Tests
`fetch` ersetzt und das SDK ihn weiterhin parsen muss - auf der Leitung heißt
das Feld `supportedGenerationMethods`, das SDK benennt es in
`supportedActions` um.

Diese Prüfungen sehen die gespeicherte Antwort und sonst nichts: Ein Modell,
das Google später zurückzieht, kommt weiter durch, bis jemand das Fixture
erneuert, und die Live-API darf ein Test dafür nicht aufrufen. Diese Richtung
deckt `scripts/probe-models.js` ab: Bei einem vollständigen Lauf hält es die
Liste gegen das, was der Schlüssel gerade anbietet, und nennt jeden Eintrag,
auf den kein Modell mehr passt - ein Lauf meldet damit beides, was hinzukommt
und was wegfällt. Ein auf `--model` verengter Lauf lässt die Prüfung aus,
statt die Liste an IDs zu messen, die von der Kommandozeile stammen.

Erzeugt werden die Einträge von `scripts/probe-models.js`. Das Skript schickt
jedem Modell nach `isUsableModel` genau das, was `runSearch` schickt - alle
`SEARCH_TOOLS` plus ein Thinking-Level - und wertet nur einen `400` oder `404`
als Urteil; `429`, `503` und die übrigen transienten Codes werden wiederholt
und andernfalls ohne Urteil gemeldet. Dass die Tools eine gemeinsame Konstante
sind, ist keine Ordnungsliebe: Gemessen antworten die Bildmodelle auf eine
Anfrage mit nur `googleSearch` anstandslos und scheitern allein an Code
Execution, eine engere Prüfung meldet sie also als funktionierend. Das Skript
ist über die `files`-Liste in `package.json` vom veröffentlichten Paket
ausgenommen und hält nichts fest außer ID, Urteil, Status, Dauer und ob
Grounding-Metadaten kamen - nie den Antworttext und nie die Quellen
(Invariante I4, siehe "Terms-Konformität").

**Der Hinweistext nennt die Liste.** Ein Ausschluss, den der Nutzer nicht
sieht, ist so undurchsichtig wie die verkürzte Auswahl, aus der diese Liste
entstanden ist. Die Standardansicht nennt deshalb, wie viele Modelle verborgen
sind und dass eine vollständige Auflistung den Ausschluss umgeht.
Er sagt das in einer Zeile unter 80 Spalten: Den Hinweistext liest ein Mensch
am Terminal bei jedem einzelnen Aufruf, einen Absatz Begründung, der sich nie
ändert, lernt das Auge zu überspringen, und eine längere Zeile bricht mitten im
Wort um. Aus demselben Grund nennt er `models-excluded.js` nicht, eine Datei,
die jemand, der das Paket installiert hat, nie sieht; das tun nur die beiden
Rückfall-Hinweise, die sich an den richten, der die Liste pflegt. Die Begründung gehört hierher, wo sie einmal gelesen
wird; die Zahlen im Hinweistext stammen aus der Antwort, sodass keine
Formulierung nachzuziehen ist, wenn Modelle hinzukommen oder wegfallen.

Die Darstellungsregel für Agenten - die gelisteten Modelle nennen, bevor eine
engere Auswahl vorgeschlagen wird, diese Auswahl als Vorschlag kennzeichnen und
dazusagen, dass sich ebenso jede andere Modell-ID eintragen lässt - steht
stattdessen in der Tool-Beschreibung von `gemini-list-models`. Sie reiste
früher im Hinweistext mit, wo sie den Agenten im Moment der Entscheidung
erreichte, ohne Dauerkontext zu kosten, stellte damit aber jedem CLI-Nutzer eine
an Agenten gerichtete Anweisung vor die Nase. Die Tool-Beschreibung kostet
dauerhaft Kontext und ist der Preis für einen Hinweistext, der sich in einer
Zeile liest.

**Zu den Codenamen.** `models.list` liefert auch `displayName` und
`description`, und bei Codenamen tragen diese Felder tatsächlich Information:
`nano-banana-pro-preview` ist als "Gemini 3 Pro Image Preview" beschrieben.
Keines der beiden wird als automatischer Filter genutzt - das wäre dasselbe
Namensmuster ein Feld weiter rechts, mit demselben stillen Fehler, sobald ein
künftiges Textmodell eines der Stichwörter trägt. Als Hinweis für den
Menschen, der einen neuen Eintrag von Hand beurteilt, ist `description` bei
einem Codenamen die einzige verwertbare Quelle.

### gemini-set-config

Speichert Modell-ID, Thinking-Level, Backup-Modell und/oder Frist dauerhaft in
einer `config.json` (Ort siehe unten). Die Werte lassen sich unabhängig voneinander
setzen - ein Merge sorgt dafür, dass das Setzen des einen Werts die bereits
gespeicherten anderen nicht überschreibt. Diese Wahl bleibt über
Server-Neustarts hinweg bestehen, bis sie erneut geändert wird.

Bis 1.x hieß das Tool `gemini-set-model`.
Der Name passte nicht mehr, seit es auch eine Frist setzt, und es heißt nach der Datei, die es schreibt, statt nach einem ihrer Werte.
Die Umbenennung ist ein Breaking Change: Berechtigungsregeln und Anweisungen, die das alte Tool nennen, greifen ins Leere.

Drei der fünf Parameter kennen einen Zustand jenseits von „ein Wert":

| Parameter | `undefined` | Ein Wert | Besonderheit |
| --- | --- | --- | --- |
| `backupModel` | unangetastet lassen | Modell-ID | `false` schaltet den Fallback ab und hält fest, dass das Absicht war |
| `backupThinkingLevel` | unangetastet lassen, **außer** neben einem `backupModel`, dort wird es zurückgesetzt | Thinking-Level | `null` löscht den Schlüssel, das Backup erbt wieder das Level des Aufrufs |
| `deadlineSeconds` | unangetastet lassen | ganze Sekunden | `false` sendet keine Frist; siehe „Die Frist, die dieser Server mitschickt" |

`null` löscht bei allen fünf Schlüsseln, nicht nur bei `backupThinkingLevel` - eine Sonderregel für genau ein Feld kann später niemand mehr erklären.
`false` bei `backupModel` wird bewusst gespeichert statt gelöscht: Für das Verhalten sind „nie eingestellt" und „abgeschaltet" dasselbe, für den Leser von `gemini-grounding config` sind es zwei verschiedene Auskünfte.

Die Ausnahme in dieser Tabelle ist die Einheits-Regel aus dem Abschnitt „Implementierung": Ein `backupModel`, das ohne eigenes Level ankommt, setzt das gespeicherte zurück, damit ein für das vorherige Backup gewähltes Level nicht stillschweigend auf das neue Modell übergeht.
`setSavedConfig` liefert deshalb zurück, was es tatsächlich geschrieben hat, `null` eingeschlossen - nur so kann die Bestätigung das weggefallene Level nennen, statt es zu verschweigen.
`backupThinkingLevel` allein zu übergeben ist der Weg, das Level des gespeicherten Backups zu ändern, ohne das Modell anzufassen.
Dafür braucht es ein gespeichertes, eingeschaltetes Backup: Ein Level ohne sein Modell hat keinen Bezug, stünde wirkungslos in der Datei, und die Bestätigung nennte einen Wert, den der Zustandsblock zwei Zeilen darunter als `not set` oder `off` wieder einkassiert.
`findBackupLevelProblem` in `config.js` weist beide Fälle ab, bevor irgendetwas geschrieben wird - `null` bleibt ausgenommen, denn der Weg zurück auf „erbt vom Aufruf" muss auch dann offenstehen, wenn kein Backup mehr da ist.

Diese Prüfung und `findModelCollision` weiter unten haben aus demselben Grund dieselbe Bauform, und beide sichern beide Schnittstellen ab.
Die Regel lag zuerst allein in `cli.js`, wo `gemini-set-config` nicht vorbeikam: Ein Modell, das ein Backup-Level speichern soll, hat keinen Anlass, vorher den gespeicherten Zustand zu lesen.

**Standard und Backup dürfen nicht dasselbe Modell werden**, und `findModelCollision` in `config.js` weist das ab, bevor irgendetwas geschrieben wird.
Wären beide gleich, fände überhaupt kein Fallback mehr statt: `runSearch` lehnt ihn mit „it is the same model as the default" ab - ein Fangnetz, das erst beim nächsten fehlgeschlagenen Aufruf greift und das Backup bis dahin lautlos tot liegen lässt.

Geprüft wird der Zustand, den das Schreiben **erzeugen würde**, und nicht das einzelne Argument: Dieser Handler ist die einzige Stelle, die beide Werte in einem Aufruf setzen kann - `{ model: "x", backupModel: "x" }` besteht jede Einzelprüfung und hinterlässt die Konfiguration trotzdem kaputt.
Dieselbe Funktion sichert `set-model`, `set-thinking --model` und `set-backup` in der CLI ab; `set-thinking --model <id>` war der Pfad, dem sie fehlte, und deshalb steht die Regel jetzt dort, wo alle durchlaufen, statt in jedem Zweig.

Ein Aufruf, der gar kein Modell nennt, wird auch dann durchgelassen, wenn die gespeicherten Werte bereits kollidieren - er hat den Zustand nicht verursacht, und ihn zu blockieren stoppte ausgerechnet die Befehle, die nichts damit zu tun haben.

Die Bestätigung nennt den vollständigen Pfad, und der Aufruf liegt in einem
`try`/`catch`: Das Zielverzeichnis wird erst beim Speichern angelegt und kann je
nach Rechten oder verschobenem `%APPDATA%` unbeschreibbar sein. Ohne `catch`
liefe ein Schreibfehler ungefangen aus dem Handler statt als `isError`-Antwort
beim Client anzukommen.

```javascript
server.registerTool(
  "gemini-set-config",
  {
    inputSchema: z.object({
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
      backupModel: z
        .union([z.string(), z.literal(false)])
        .optional()
        .describe("Modell für den zweiten Versuch; false schaltet es ab"),
      backupThinkingLevel: z
        .enum(["minimal", "low", "medium", "high"])
        .nullable()
        .optional()
        .describe("Denktiefe des Backup-Modells"),
      deadlineSeconds: z
        .union([z.number().int().positive(), z.literal(false)])
        .optional()
        .describe("Sekunden, nach denen Google eine Suche abbricht; false sendet keine"),
    }),
    // annotations und _meta: siehe „Tool-Annotations"
  },
  async ({ model, thinkingLevel, backupModel, backupThinkingLevel, deadlineSeconds }) => {
    // mindestens ein Parameter ist Pflicht, sonst Fehler
    // findModelCollision und findBackupLevelProblem vor dem Schreiben - siehe config.js
    // Merge statt Überschreiben, außer bei der Backup-Einheit - siehe config.js
    const saved = setSavedConfig({
      model,
      thinkingLevel,
      backupModel,
      backupThinkingLevel,
      deadlineSeconds,
    });
    return {
      content: [
        {
          type: "text",
          text: `Saved to ${CONFIG_PATH} - ${formatSavedValues(saved)}\n\n` + formatConfigState(),
        },
      ],
    };
  },
);
```

### Was nach dem Speichern gemeldet wird

Jedes Speichern beantwortet zwei verschiedene Fragen, und beide werden gebraucht:

```text
Saved - Backup: gemini-3.5-flash, Backup thinking level: inherited from the call

Default:  gemini-flash-latest · high
Backup:   gemini-3.5-flash · high (inherited)
Deadline: 300 s
```

`formatSavedValues` nennt jeden geschriebenen Wert.
Diese Zeile existiert, weil ein gespeicherter Wert sonst von einem verworfenen Parameter nicht zu unterscheiden wäre - der Fehler, gegen den sie eingeführt wurde.
Sie läuft auf dem **Rückgabewert** von `setSavedConfig` und nicht auf den Argumenten, sodass ein von der Einheits-Regel entferntes Level erscheint, statt lautlos zu verschwinden.

`formatConfigState` nennt den vollständigen gespeicherten Zustand.
Ohne diese Zeilen müsste auf eine Änderung ein `config` folgen, um zu erfahren, womit die nächste Anfrage tatsächlich läuft - und genau in dieser Lücke arbeitet am Ende jemand mit einem Modell, das er nicht gemeint hat.
Für den MCP-Server erfüllt diese Zeile die Arbeitsregel aus `CLAUDE.md`, dass nach einer Modelländerung bestätigt wird, welches Modell ab jetzt gilt.

Beide Funktionen liegen in `config.js` und werden von der CLI und dem MCP-Handler gleichermaßen genutzt, die sich nur im Präfix unterscheiden.
Zwei getrennte Fassungen liefen auseinander, und dann sagte dieselbe Änderung je nach Schnittstelle etwas anderes.

Beim Backup steht das geerbte Level als Wert und nicht als bloßes Wort „inherited": Womit das Backup liefe, wenn es jetzt einspränge, ist die Auskunft, um die es geht.
Der Zusatz sagt dazu, dass der Wert nicht ihm gehört, sondern mitwandert - ein Aufruf mit eigenem `thinkingLevel` wird stattdessen geerbt.
Der Mittelpunkt trennt wie in `formatSearchQueries`: Modellnamen enthalten selbst Bindestriche und Ziffern, zwischen denen ein weiterer Bindestrich untergeht.

#### Ein zweifelhaftes Modell warnt nach dem Speichern

Nach jedem Schreiben eines Standard- oder Backup-Modells sucht `checkModelIds()` in `models.js` die ID in `models.list`, das kostenlos ist:

- nicht in der Liste - `"<id>" is not in the model list of this API key - a search with it will most likely fail.`
- in der Liste, aber nicht nutzbar - `"<id>" cannot run here: <Status>`, derselbe Status wie in `gemini-list-models` mit `all: true`
- auf der Ausschlussliste - der Grund aus `models-excluded.js`

Gespeichert wird das Modell trotzdem, und die Warnung folgt der Bestätigung: in der CLI auf stderr, in der MCP-Antwort als Absatz `Warning:`.
Die Kurzliste entscheidet über die Anzeige, nicht über die Erlaubnis, und eine ID, die der Key heute nicht listet, kann er morgen listen.
Lässt sich die Liste nicht abrufen - offline, kein Key -, gibt es gar keine Warnung, sodass ein Speichern nie an der Prüfung scheitert.
Der Text nennt keinen Befehl, weil beide Schnittstellen ihn teilen.

`gemini-grounding doctor` führt dieselbe Prüfung für die gespeicherten Modelle aus, neben der Node-Version, der Lesbarkeit der `config.json` und einem Aufruf von `models.list`, der zeigt, dass der Key angenommen wird und nicht nur gesetzt ist.
Seine Config-Zeile kommt aus `configProblems()` in `config.js`, das die Warnungen genau der Getter sammelt, die auch eine Suche durchläuft, sodass `doctor` nicht anderer Meinung sein kann als eine Suche.

### Speicherort der Konfiguration

Nicht `./config.json`: Das Arbeitsverzeichnis eines per stdio gestarteten
MCP-Servers ist nicht garantiert der Projektordner. Aber auch **nicht mehr
scriptrelativ** - das war richtig, solange der Code ausschließlich geklont
wurde, und wird mit der npm-Veröffentlichung falsch:

| Installationsart | Ort des Scripts | Folge für eine Datei daneben |
| --- | --- | --- |
| `npm install -g` | `…/npm/node_modules/<paket>/` | Verzeichnis gehört dem Paketmanager und wird beim Update neu geschrieben |
| `npx` | `~/.npm/_npx/<hash>/node_modules/…` | reiner Cache, dessen Hash sich mit der Version ändert - die Einstellung wäre praktisch flüchtig |

Stattdessen der plattformübliche Ort für Nutzer-State, aufgelöst in dieser
Reihenfolge:

1. `XDG_CONFIG_HOME`, wenn gesetzt - Linux-Konvention und zugleich das Ventil
   für alle, die den Standardort nicht wollen.
2. Unter Windows `%APPDATA%` (Rückfall `~/AppData/Roaming`), **nicht**
   `~/.config`.
3. Sonst `~/.config`.

Darunter jeweils `gemini-grounding-mcp/config.json`.
Ein leeres oder relatives `XDG_CONFIG_HOME` oder `%APPDATA%` gilt als nicht gesetzt, wie es die XDG Base Directory Specification verlangt: So übernommen, würde die Datei mit dem Arbeitsverzeichnis wandern, und jeder Ort, von dem aus der MCP-Server startet, bekäme seine eigene Konfiguration.

macOS wird bewusst wie Linux behandelt, obwohl der Apple-Standard
`~/Library/Application Support/` wäre: Dies ist ein Terminal-Werkzeug, und im
Terminal sucht niemand in einem Ordner, den der Finder ausblendet. Ein eigener
`darwin`-Zweig wird ausdrücklich nicht eingebaut.

Verworfen wurde eine zusätzliche eigene Umgebungsvariable für den Pfad -
`XDG_CONFIG_HOME` deckt den Bedarf ab, und jede weitere Variable ist nur ein
weiterer Ort, an dem man bei „warum ist mein Modell nicht gespeichert?"
nachsehen muss.

Das Verzeichnis wird ausschließlich im Schreibpfad angelegt (`mkdirSync` mit
`recursive` direkt vor dem `writeFileSync`). Damit erzeugt das Paket nichts
ungefragt: Solange niemand ein Modell setzt, entsteht weder Verzeichnis noch
Datei, und `readConfig()` fängt die fehlende Datei bereits ab. Auffindbarkeit
entsteht über die Ausgabe, nicht über den Ort - `CONFIG_PATH` ist deshalb
exportiert, die Bestätigung von `gemini-set-config` nennt ihn, und
`gemini-grounding config` zeigt ihn ebenfalls an.

Ebenfalls verworfen: Modell und Thinking-Level **zusätzlich** über
`GEMINI_MODEL`/`GEMINI_THINKING_LEVEL` vorgeben zu können. Der Code wären zwei
Zeilen gewesen, der Preis liegt woanders - eine zweite Konfigurationsquelle
erzeugt eine Rangfolge, die erklärt werden muss, und drei überraschende
Verhaltensweisen: ein einmaliges `gemini-set-config` hätte die Variable dauerhaft
wirkungslos gemacht, es wären Mischzustände entstanden (Modell aus der Datei,
Level aus der Umgebung), und Zurücksetzen ginge nur über das Löschen der Datei.
Es bleibt bei einer Quelle der Wahrheit: Was in der Datei steht, gilt - sonst
der Default.

Eine alte, scriptrelative `config.json` wird **nicht** automatisch übernommen.
Migrationscode müsste dauerhaft im Paket bleiben, um einen Zustand zu behandeln,
den es vor der ersten npm-Veröffentlichung nur bei den wenigen Klon-Nutzern gab.
Bemerkbar macht sich das ohnehin: Nach dem Update stehen wieder die Defaults im
Footer, und `gemini-grounding config` nennt den neuen Pfad. Der Weg dorthin ist
in der README beschrieben, das Zurücksetzen kostet einen Aufruf.

### Auflösung der Standardwerte pro Aufruf

Das Tool `gemini-search` nutzt die gespeicherten Werte als Standard, sofern
beim jeweiligen Aufruf nichts explizit angegeben wird. Die Auflösung passiert
bewusst **zur Aufrufzeit**, nicht als Zod-`.default()` im `inputSchema`: ein
Schema-Default würde einmal beim Registrieren des Tools ausgewertet und
eingefroren, sodass `gemini-set-config` erst nach einem Serverneustart wirken
würde. `model` und `thinkingLevel` sind im Schema deshalb `optional()`.

`resolveCallConfig` in `config.js` beantwortet die Frage für den MCP-Handler und die CLI gemeinsam, damit beide zu derselben Antwort kommen:

```javascript
export function resolveCallConfig({ model, thinkingLevel } = {}) {
  const backup = model === undefined ? getSavedBackup() : {};
  return {
    model: model ?? getSavedModel(), // "gemini-flash-latest" ohne config.json
    thinkingLevel: thinkingLevel ?? getSavedThinkingLevel(), // "medium" ohne config.json
    backupModel: backup.model,
    backupThinkingLevel: backup.thinkingLevel,
    deadlineSeconds: getSavedDeadline(), // 300 ohne config.json, kein Wert pro Aufruf
  };
}
```

**Ein beim Aufruf genanntes Modell bekommt kein Backup.**
Wer eines nennt, will dieses eine - häufig gerade, um zu prüfen, ob es überhaupt erreichbar ist.
Eine Antwort von einem anderen Modell beantwortet diese Frage nicht, sie verdeckt sie.

Die Regel ist syntaktisch und greift auch dann, wenn das genannte Modell zufällig dem gespeicherten Standard entspricht: Was zählt, ist die ausdrückliche Nennung, nicht der Wert.
Sonst verhielte sich derselbe Aufruf je nach gespeichertem Standard anders, und dem Aufruf sähe man nicht an, wie.
Ein ausdrückliches `thinkingLevel` berührt den Fallback nicht, weil das Modell dabei der gespeicherte Standard bleibt.

Die Regel steht in dieser einen Funktion und nicht in `runSearch` - genau das hält `gemini.js` frei von ihr: Dort wird ein Backup genutzt, wenn eines übergeben wurde, und das ist alles.
Als reine Funktion ohne Netzwerkzugriff ist `resolveCallConfig` zugleich der einzige Ort, an dem sich die Regel überhaupt prüfen lässt (`test/resolve.test.js`) - über die CLI bräuchte es dafür einen echten API-Aufruf.

Tatsächlich implementiert (inkl. `setSavedConfig` und `getSavedBackup`) in `config.js` - siehe „Implementierung" oben.

`readConfig()` fällt bei **jeder** unlesbaren Datei auf die Standardwerte zurück, schweigt aber nur über die fehlende.
Vor dem ersten gespeicherten Wert gibt es keine Datei, und die Standardwerte sind dann genau das Gewollte.
Alles andere - kaputtes JSON nach einem abgebrochenen Schreibvorgang, fehlende Leserechte - macht eine gespeicherte Einstellung wirkungslos, und ohne ein Wort liefe der Server einfach mit den Standardwerten weiter, während die Einstellung stillschweigend verschwunden wäre.
Ein solcher Fall erzeugt deshalb eine Warnung, die den Pfad und die Originalmeldung nennt.
Eine Datei, die sich parsen lässt, aber kein JSON-Objekt enthält - `null`, ein Array, eine Zahl -, gilt ebenfalls als unlesbar: `null` würde jeden Getter abstürzen lassen, und ein Array schluckt einen Schreibvorgang stillschweigend, weil `JSON.stringify` daran gesetzte Eigenschaften verwirft.

Das Schreiben ist strenger als das Lesen.
`setSavedConfig()` verweigert mit einem Fehler, wenn die Datei existiert, aber nicht lesbar ist, und speichert nichts.
Auf die Standardwerte zu schreiben würde jeden gespeicherten Wert durch den einen gerade gesetzten ersetzen - aus einer von Hand bearbeiteten Datei mit einem überzähligen Komma wären Modell, Backup und Frist verschwunden.
Hinter einem MCP-Client sieht niemand die Warnung auf stderr, deshalb kommt die Verweigerung als Fehlerantwort des Tools an.
Geschrieben wird in eine temporäre Datei neben `config.json`, die danach über sie umbenannt wird, sodass ein abgebrochener Schreibvorgang die alte Datei unversehrt lässt statt einer halben neuen.

Die Warnung geht nach **stderr**, nie nach stdout: Der MCP-Server spricht über stdout JSON-RPC, wo eine einzelne verirrte Zeile die Verbindung zum Client zerstört.
Eine Menge der schon ausgegebenen Warnungen auf Modulebene begrenzt jede auf ein Vorkommen, denn `readConfig()` läuft pro Aufruf viermal - einmal für das Modell, einmal für das Thinking-Level, einmal für das Backup, einmal für die Frist. Ohne sie stünde dieselbe Warnung viermal da und sähe nach vier Fehlern aus.

Auch eine lesbare Datei kann unbrauchbare Werte enthalten, und jeder wird beim Lesen geprüft: Das Standardmodell muss ein nicht leerer String sein, das Standard-Thinking-Level eines aus `THINKING_LEVELS`, und Backup und Frist haben ihre eigenen Prüfungen.
Ein unbrauchbarer Wert warnt einmal und wird durch seinen Standard ersetzt.
Ein unbekanntes Level käme sonst als 400 zurück, löste den Fallback aus und gäbe dasselbe unbrauchbare Level an das Backup weiter.

## MCP-Schnittstelle

### Beide Protokollrevisionen bedienen

Der Server baut auf `@modelcontextprotocol/server` 2.x auf, der Linie des MCP TypeScript SDK, die seit 27.07.2026 stabil ist.
Das 1.x-Paket `@modelcontextprotocol/sdk` implementiert das Protokoll nur bis zur Revision 2025-11-25 und ist in der Wartungsphase; die Revision 2026-07-28 gibt es nur in 2.x.

`index.js` verbindet keinen Server selbst mit einem Transport, sondern übergibt `createServer` an `serveStdio` aus `@modelcontextprotocol/server/stdio`.
`server.connect(new StdioServerTransport())` würde nur Clients der 2025er-Generation bedienen.
`serveStdio` liest die Revision aus der ersten Nachricht des Clients - `initialize` für 2025-11-25, `server/discover` für 2026-07-28 - und baut aus der Factory einen Server für die Verbindung.
Seit SDK 2.3.0 bedient ein Server-Objekt nur eine Verbindung zur Zeit, die Factory ist also auch die Form, die das SDK erwartet.

Die Revision wählt Claude Code selbst: Ab v2.1.232 fragt seine v2-Client-Runtime stdio-Server, ob sie 2026-07-28 unterstützen, und nutzt sie dann; `MCP_PROTOCOL_NEGOTIATION=legacy` hält es bei 2025-11-25.
Gemessen mit Claude Code 2.1.310: `auto` eröffnete mit `server/discover` und lief bei jedem Aufruf über 2026-07-28, `legacy` eröffnete mit `initialize` über 2025-11-25.
In beiden Fällen kamen Footer und Quellenliste wie bisher an.
Die Ergebnisse von `gemini-list-models`, von beiden Fehlerpfaden von `gemini-set-config` und von einer Anfrage an ein fehlendes Modell sind byteidentisch mit denen des 1.x-Servers.

Drei Dinge unterscheiden sich auf der Leitung, keines davon in einem Tool-Ergebnis:

- Die Eingabeschemas werden als JSON Schema 2020-12 statt draft-07 angekündigt; Properties und Beschreibungen sind unverändert.
- 1.x kündigte für jedes Tool `execution: { taskSupport: "forbidden" }` an, 2.x lässt es weg. Die Spec legt `"forbidden"` als Standard fest, wenn das Feld fehlt.
- Ein Aufruf, dessen Argumente am Schema scheitern, bekommt vom SDK einen leicht anderen Text (`query: Invalid input: ...` statt `Invalid input: ... at query`). Dieser Text stammt vom SDK, nicht von diesem Server.

Die Eingabeschemas werden als `z.object({...})` übergeben.
2.x nimmt ein rohes Shape wie `{ query: z.string() }` zwar noch an, aber nur über einen veralteten Overload, der es mit der SDK-eigenen Kopie von Zod umschließt.
Zod muss 4.2 oder neuer sein: Mit 4.0 und 4.1 weicht das SDK auf eine Umwandlung aus, die die `.describe()`-Texte verwirft, und das Modell verliert ohne jeden Fehler alle Parameterbeschreibungen.

`test/mcp.test.js` startet das echte `index.js` über stdio in beiden Revisionen, ohne Key und ohne die Gemini-API zu erreichen, und prüft unter anderem, dass jede Parameterbeschreibung ankommt.

### Tool-Annotations

Jedes Tool teilt dem Client mit, welche Art von Aktion es ist:

| Tool | `readOnlyHint` | `destructiveHint` | `idempotentHint` | `openWorldHint` |
| --- | --- | --- | --- | --- |
| `gemini-search` | `true` | - | - | `true` |
| `gemini-list-models` | `true` | - | - | `false` |
| `gemini-set-config` | `false` | `false` | `true` | `false` |

`destructiveHint` und `idempotentHint` haben nur Bedeutung, wenn `readOnlyHint` `false` ist, deshalb lassen die beiden lesenden Tools sie weg.
`gemini-list-models` ist nicht Open-World: `models.list` erreicht zwar Google, liefert aber nur die geschlossene Menge der Modelle hinter dem API-Key, während eine Suche jede Seite im Web berühren kann.
`gemini-set-config` ist idempotent, weil dieselben Argumente immer dieselbe `config.json` hinterlassen, und nicht destruktiv, weil es nur Werte ersetzt, die der Nutzer zurücksetzen kann.
Der Anzeigename bleibt im Feld `title` des Tools, das die Spec vor `annotations.title` stellt; Letzteres ist nicht gesetzt.

Die Spec nennt diese Werte Hinweise und sagt, dass Clients Sicherheitsentscheidungen nicht auf Hinweise nicht vertrauenswürdiger Server stützen dürfen.
Was Claude Code laut seiner MCP-Dokumentation damit tut:

- `readOnlyHint: true` lässt es die Aufrufe des Tools parallel zu anderen lesenden Aufrufen ausführen. Für `gemini-search` heißt das, dass mehrere Suchen in einem Zug mehrere gleichzeitig abgerechnete Anfragen sind, und das ist gewollt.
- `readOnlyHint` oder `idempotentHint` lässt es einen Aufruf wiederholen, der beim Schließen einer Verbindung noch offen war - aber nur bei HTTP-Servern und claude.ai-Connectoren, nicht bei einem stdio-Server wie diesem.

`gemini-set-config` trägt zusätzlich `_meta: { "anthropic/requiresUserInteraction": true }`, einen Schlüssel, den Claude Code außerhalb der Spec definiert.
Damit zeigt Claude Code bei jedem Aufruf den Berechtigungsdialog, auch in den Modi `acceptEdits`, `auto` und `bypassPermissions`, bietet kein „nicht mehr fragen" an, und Allow-Regeln überspringen den Dialog nicht.
Wo niemand antworten kann - Modus `dontAsk`, `claude -p` - wird der Aufruf abgelehnt.
Gemessen mit Claude Code 2.1.310: `claude -p --allowedTools mcp__gemini-grounding__gemini-set-config` antwortete „MCPTool requires permission"; ohne den Schlüssel erreichte derselbe Aufruf den Server.
Das ist das technische Gegenstück zur Regel in CLAUDE.md, dass Standardmodell, Backup-Modell und Frist sich nur auf ausdrückliche Anweisung des Nutzers ändern: Kein Agent und kein Skript ohne Mensch kann die Konfiguration über MCP ändern.
Die CLI (`gemini-grounding set-model ...`) ist nicht betroffen, und andere Clients ignorieren den Schlüssel.

`test/mcp.test.js` nagelt die Annotations und den Schlüssel fest.

## Vorübergehende Fehler und Wiederholungen

Zwei der Fehler, die die API zurückgibt, sind keine Defekte: Dieselbe Anfrage wäre kurz darauf durchgegangen.
`429 RESOURCE_EXHAUSTED` ist die Drosselung, `503 UNAVAILABLE` die vorübergehende Überlastung auf Google-Seite.
Tatsächlich beobachtet wurde hier nur der zweite - dreimal in Folge innerhalb einer Minute, jedes Mal mit der Meldung „This model is currently experiencing high demand".

### Ohne Konfiguration wiederholt das SDK nichts

`@google/genai` bringt einen vollständigen Retry mit, der aber ab Werk inaktiv ist.
`apiCall()` in `dist/index.mjs` beginnt mit `if (!retryOptions) { return fetch(url, requestInit); }`, und `retryOptions` wird ausschließlich aus `clientOptions.httpOptions` durchgereicht - einen Standardwert setzt das SDK nirgends.
Ein blankes `new GoogleGenAI({ apiKey })` wiederholt also nie eine Anfrage.

Das ist erwähnenswert, weil der [Gemini-Troubleshooting-Leitfaden](https://ai.google.dev/gemini-api/docs/troubleshooting) pauschal behauptet, die offiziellen Client-SDKs hätten „automatic retry logic with exponential backoff by default", und das dann ausschließlich am Python-SDK vorführt.
Fürs JavaScript-SDK trifft die Aussage nicht zu.

Der Server konfiguriert es deshalb ausdrücklich, als exportierte Konstante `RETRY_OPTIONS` in `gemini.js`:

```javascript
export const RETRY_OPTIONS = {
  attempts: 4,
  httpStatusCodes: [408, 500, 502, 503],
};
```

Ob diese Konfiguration den Client erreicht, prüft `test/retry.test.js` - und zwar am Verhalten statt an der Konstante: Der Test ersetzt das globale `fetch`, sodass die Zahl der Aufrufe die Zahl der Versuche ist.
Ein 503 mit nachfolgendem 200 muss genau zwei davon ergeben.
Zu behaupten, eine Liste enthalte, was sie enthält, bliebe auch dann wahr, wenn die `httpOptions` aus `getClient()` verschwänden - der eine Eingriff, der das alte Verhalten stillschweigend wiederherstellte.

### Warum 429 und 504 in dieser Liste fehlen

Googles eigener Standardwert ist `[408, 429, 500, 502, 503, 504]`.
Hier fehlen zwei Einträge, jeder aus einem eigenen Grund - und sie sind das Einzige an dieser Konfiguration, was sich nicht von selbst versteht.

Bei einem 429 liefert die API die Wartezeit selbst mit, als `RetryInfo`-Eintrag in `error.details`:

```json
{ "@type": "type.googleapis.com/google.rpc.RetryInfo", "retryDelay": "53s" }
```

Das SDK liest sie nicht aus.
Die Zeichenkette `RetryInfo` kommt im gesamten Bundle nicht vor; die wiederholbaren Codes sind eine flache Mitgliedschaftsliste, ein 429 bekommt also denselben blinden exponentiellen Backoff wie jeder 5xx.
Gegen geforderte 53 Sekunden wären alle vier Versuche nach rund 15 verbraucht - lange bevor die Sperre abläuft.
Dasselbe Verhalten im Python-SDK wird als [googleapis/python-genai#1875](https://github.com/googleapis/python-genai/issues/1875) geführt.

Ein 429 geht deshalb unverändert und sofort an den Client, statt die Antwort um Wartezeit zu verlängern, die nichts bewirken kann.

`504` fehlt aus einem anderen Grund, und erst seit dieser Server eine eigene Frist mitschickt (siehe unten).
Ein Gateway-Timeout ist dann nicht mehr überwiegend Googles Überlastung, sondern der Ablauf dieser Frist.
Ihn zu wiederholen hieße, dieselbe Generierung noch dreimal bis zum Fristende laufen zu lassen und jedes Mal zu bezahlen - denn abgerechnet wird eine abgebrochene Generierung trotzdem.
Die beiden Ursachen sind hier nicht zu trennen: Die Retry-Entscheidung fällt am Statuscode, lange bevor irgendwer das `DEADLINE_EXCEEDED` im Body zu sehen bekäme.
Von den beiden möglichen Ursachen ist die teure die wahrscheinlichere, also gibt die Liste den Code auf.

Für `500`, `502`, `503` und `408` gibt es keine solche Serverangabe - dort ist blinder Backoff das einzig Mögliche und damit das Richtige.
`408` steht der Vollständigkeit halber in der Liste: Eine abgelaufene Frist kommt als `504` zurück, und eine Anfrage, die ganz ins Leere läuft, bricht Node ohne jeden HTTP-Status ab.
Ein echter 408 käme nur von einer Zwischenstation.

Client-Fehler bleiben aus dem gewöhnlichen Grund draußen: Eine kaputte Anfrage, ein ungültiger Schlüssel oder ein zurückgezogenes Modell scheitern beim zweiten Mal genauso.
Das deckt sich mit Googles eigener Empfehlung, nur bei `408`, `429` und `5xx` zu wiederholen, nie bei `400` oder `403`.

### Was das an Wartezeit kostet

`attempts` zählt den Erstversuch mit, vier Versuche bedeuten also drei Wiederholungen.
Mit den SDK-Standardwerten - `initialDelay` 1 s, `expBase` 2, Jitter zwischen Faktor 1 und 2 - ergeben sich Wartezeiten von etwa 1-2 s, 2-4 s und 4-8 s, zusammen **7 bis 14 Sekunden**, bevor der Fehler ankommt.
Der Deckel `maxDelay` von 60 s greift bei diesen Werten nie; er würde erst ab der sechsten Wiederholung binden.

Die beobachteten drei 503 verteilten sich über etwa eine halbe Minute, ein Retry dieser Länge hätte sie also nicht zuverlässig aufgefangen.
Die Konfiguration verringert, wie oft ein vorübergehender Fehler den Client erreicht; sie schafft die Fehlerklasse nicht ab.

### Die Frist, die dieser Server mitschickt

Für eine Anfrage gelten drei Grenzen, und seit `@google/genai` 2.29 ist eine davon weggefallen:

| Grenze | Wert | Wirkung |
| --- | --- | --- |
| Node (`headersTimeout`) | **306,8 s** gemessen, bis `@google/genai` 2.28 | Kappte eine stille Verbindung und griff zuerst. Seit 2.29 übergibt das SDK einen eigenen Undici-Dispatcher mit `headersTimeout: 0` und `bodyTimeout: 0` (`createUndiciNoTimeoutDispatcher`) |
| MCP-Client (Claude Code 2.1.224) | **1800 s** gemessen | Jetzt die erste Grenze auf dieser Seite |
| Google ohne Frist | 10 min für eine unäre Anfrage, laut SDK-Kommentar an `createUndiciNoTimeoutDispatcher` | Generiert unabhängig davon bis zu dieser Grenze |

Alles, was Google erzeugt, wird bezahlt, ob es noch jemand entgegennimmt oder nicht: Input-Tokens voll, sobald die Verarbeitung beginnt, Output-Tokens bis zum tatsächlichen Ende des Laufs.
Kostenlos sind nur Ablehnungen vor der Ausführung (`400`, `401`, `403`, `429`).

`gemini.js` nennt dem Gateway deshalb eine eigene Frist, als gewöhnlichen Header, 300 s, sofern nichts anderes eingestellt ist:

```javascript
export const DEFAULT_DEADLINE_SECONDS = 300; // config.js
```

300 s liegen unter Googles eigener Grenze, der Header entscheidet also, und der Fehler kommt als `504` mit Begründung an.
Google übernimmt den Header als Ausführungsfrist und bricht die Generierung tatsächlich serverseitig ab; der Wert geht in ganzen Sekunden hinaus.
Bis `@google/genai` 2.28 lag der Wert bei 290 s, knapp unter Nodes Grenze; seit diese Grenze weg ist, gibt es nichts mehr zu unterbieten, und es gilt die runde Zahl.

**Einstellbar.** `deadlineSeconds` in der `config.json` enthält eine ganze Zahl von Sekunden von 1 bis `MAX_DEADLINE_SECONDS` (600) oder `false` für gar keinen Header - dann gilt Googles eigene Grenze.
Gesetzt wird sie über `gemini-set-config` oder `gemini-grounding set-deadline <seconds|off>`, und `false` wird aus demselben Grund gespeichert statt gelöscht wie bei `backupModel: false`: Löschen brächte den Standard zurück, das Gegenteil von „aus".
Einen Parameter pro Aufruf gibt es bewusst nicht: Ein Aufruf, der die Frist anheben kann, macht aus einem `504` eine Einladung, es länger zu versuchen, und die Frist ist eine Betriebseinstellung, kein Teil einer Frage.
Aus demselben Grund sagen Tool-Beschreibung und Server-Instructions einem Agenten, einen `504` zu melden, statt die Frist eigenständig anzuheben.
Ein unbrauchbarer Wert in einer von Hand bearbeiteten Datei erzeugt eine Warnung auf stderr, und es gilt der Standard - anders als ein unbekanntes Modell, das von der API als Fehler zurückkommt, zeigte sich eine Frist, die niemand anwendet, nirgends.
Die Obergrenze ist Googles eigene Grenze für eine unäre Anfrage: Darüber verspricht der Wert eine Grenze, die es nicht gibt, während die lokale Notbremse erst danach greifen würde und der MCP-Client nach 1800 s aufgibt.
Eine von Hand eingetragene ganze Zahl über 600 warnt deshalb und gilt als 600, nicht als Standard - wer 3600 schreibt, wollte die längste Frist, die es gibt.

**Die lokale Notbremse.** Ohne Nodes Grenze wartete eine Anfrage, die ins Leere läuft - stille Leitung, keine Antwort, kein Fehler -, bis der MCP-Client nach 1800 s aufgab.
`generate()` setzt deshalb einen `AbortController` auf Frist plus `LOCAL_BRAKE_MARGIN_SECONDS` (30 s) und übergibt sein Signal als `config.abortSignal`.
Der Fehler lautet dann:

```text
Error in gemini-search: no response within 330 s - aborted locally (deadline 300 s + 30 s margin)
```

Der Retry des SDK hört bei einem abgebrochenen Signal auf (`onFailedAttempt` in `apiCall()` wirft weiter), und das Backup wird nicht versucht (`backup not tried: no response within 330 s`): Die Anfrage kann die API durchaus erreicht haben, und nichts spricht dafür, dass die Leitung für ein zweites Modell besser ist.
Ein Backup, das nach einem anderen Fehler einspringt, bekommt eine eigene Bremse statt dessen, was das Standardmodell übrig gelassen hat.
Ohne Frist gibt es auch keine Bremse; wer die Frist abgeschaltet hat, wartet auf Googles eigene Grenze.

Die Bremse gilt für einen `generate()`-Aufruf als Ganzes, weil das SDK `config.abortSignal` an jede Fortsetzungs-Etappe und jeden Retry weitergibt.
Eine späte Etappe einer fortgesetzten Antwort kann deshalb abgeschnitten werden, während Google noch rechnet und abrechnet (siehe „Automatische Fortsetzung").
Eine Bremse pro Etappe hieße, die Fortsetzung in diesem Server statt im SDK zu steuern, samt Verschmelzen, und ließe die Gesamtdauer unbegrenzt.
`AbortController` plus `setTimeout` statt `AbortSignal.timeout()`, weil die Tests `setTimeout` mit `mock.timers` vorspulen, statt 330 echte Sekunden zu warten.

**Bewusst nicht über `httpOptions.timeout`**, obwohl das SDK denselben Header daraus baut.
Diese Option erzeugt aus **demselben** Wert zusätzlich einen clientseitigen `AbortController` - eine zweite Uhr, die mit Googles Antwort um die Wette läuft.
Wer gewinnt, ist Zufall, und gewinnt die eigene Uhr, kommt `This operation was aborted` an statt der Begründung.
Die lokale Notbremse bringt dieses Wettrennen nicht zurück: Mit 30 s Abstand kommt Googles `504` immer zuerst, solange die Leitung lebt, und die Bremse fängt nur die Leitung, die es nicht tut.

Die bis 2.28 gemessenen 306,8 s waren Undicis `headersTimeout` von 300 s plus Verbindungsaufbau - die Wartezeit auf die Antwort-Kopfzeilen, nicht die Gesamtdauer.
Da `generateContent` nicht streamt, lief beides aufs Gleiche hinaus - Google antwortet in einem Stück, sobald die Generierung fertig ist.

`httpOptions.headers` ersetzt die Header des SDK nicht: `patchHttpOptions()` mischt beide Objekte per `Object.assign`, `User-Agent` und `Content-Type` bleiben erhalten.
`test/retry.test.js` prüft das im selben Fall wie die Frist selbst - wäre das Mischen ein Ersetzen, schlügen die Anfragen am Server fehl, ohne dass ein Test es bemerkt hätte.
Bis 2.28 wurde ein Hänger in Kauf genommen, statt ihn mit einer zweiten Uhr zu erkaufen; seit Nodes Grenze weg ist, tritt die Bremse oben an ihre Stelle.

### Was beim Client ankommt, wenn eine Anfrage scheitert

Ein MCP-Tool kann eine Zeile Text zurückgeben. Welche das ist, entscheidet darüber, ob der aufrufende Agent dem Nutzer überhaupt etwas erklären kann.

Bei einem `ApiError` ist das unproblematisch: Seine `message` trägt den rohen JSON-Body der Fehlerantwort und damit Code, Status und Googles eigenen Wortlaut.
Ein Netzwerkfehler ist der umgekehrte Fall. Bei Node heißt jeder von ihnen `fetch failed` - abgelehnte Verbindung, unbekannter Host, Zeitüberschreitung, immer dieselben zwei Wörter -, und was tatsächlich geschah, steht ausschließlich in `error.cause`, die eine einzelne Zeile verlöre.

`describeError()` in `gemini.js` hängt die Ursache deshalb an, samt Code, wo es einen gibt (gemessen: `bad port` liefert keinen, `ECONNREFUSED` schon):

```text
Error in gemini-search: fetch failed (UND_ERR_HEADERS_TIMEOUT: Headers Timeout Error)
```

Dieses Beispiel ist das gemessene und keine erfundene Veranschaulichung: Genau das erzeugte der oben genannte Abbruch nach 306,8 s bis `@google/genai` 2.28.
Seit 2.29 endet eine stille Anfrage stattdessen an der lokalen Notbremse, deren Meldung keine Ursache braucht.

`test/errors.test.js` prüft das gegen einen **echten** `fetch`-Fehler statt gegen einen nachgebauten - die Form von `error.cause` ist eine Annahme über die Laufzeitumgebung, und die prüft man besser an ihr selbst.

Ein solcher Fehler wird **nicht** wiederholt - erwähnenswert, weil das Gegenteil die naheliegende Annahme ist. Gemessen kommt er in deutlich unter einer Sekunde an.
p-retry 4.6.2 bricht bei jedem `TypeError` ab, dessen Meldung nicht einem von vier fest eingebauten Browser-Wortlauten entspricht (`Failed to fetch`, `NetworkError when attempting to fetch resource.`, `The Internet connection appears to be offline.`, `Network request failed`).
Node wirft `TypeError: fetch failed`, und das steht dort nicht.

Die oben eingerichtete Wiederholung deckt damit ausschließlich die Statuscodes der API ab.
Ein DNS-Aussetzer oder eine abgerissene Verbindung erreicht den Client sofort und unwiederholt - womit die Meldung, die dort ankommt, das Einzige ist, woran er sich halten kann.

### Das optionale Backup-Modell

Der Retry senkt, wie oft ein vorübergehender Fehler beim Client ankommt; die Fehlerklasse schafft er nicht ab.
Der beobachtete dreifache 503 überlebte alle vier Versuche.
Was danach bleibt, ist ein zweites Modell - denn die Überlastung ist beobachtbar **modellabhängig**, offenbar sogar zwischen einem Alias und dem Modell, auf das er zeigt.

**Opt-in.** Ohne eingerichtetes `backupModel` ändert sich nichts: Der Fehler geht hinaus wie zuvor.
Genau das hält die Arbeitsregel „kein automatisches Fallback ohne Rückfrage" intakt - der Nutzer benennt das Ausweichmodell vorab, und jeder Aufruf, der es genutzt hat, sagt das im Footer.

Ablauf in `runSearch`, nachdem das SDK seine vier Versuche verbraucht hat:

1. `error.status` gegen `NO_FALLBACK_STATUS`; ein Netzwerkfehler trägt keinen Status und scheidet von selbst aus
2. dieselbe Anfrage an `backupModel`, mit `backupThinkingLevel ?? thinkingLevel`
3. der Retry des SDK greift automatisch erneut, weil er am Client hängt und nicht am Aufruf
4. scheitert auch der: ein Fehler, der beide Modelle und beide Ursachen nennt

#### Welche Fehler ihn auslösen

Eine **Negativliste**, und das ist hier die eigentliche Entscheidung.
Ein heute unbekannter, künftiger Fehlercode bekommt damit automatisch den Fallback, statt lautlos durch eine Positivliste zu fallen.

```javascript
export const NO_FALLBACK_STATUS = [401, 403, 504];
```

Die drei Ausnahmen haben zwei verschiedene Gründe.
`401` und `403` sind **aussichtslos**: Beide hängen am API-Schlüssel, und der zweite Aufruf nutzt denselben - das Modell kann die Ursache gar nicht sein.
`504` ist **zu teuer**: Bei diesem Server ist das im Regelfall die eigene Frist, also eine vollständig gelaufene und abgerechnete Generierung. Ein Fallback verdoppelt sie und legt die ganze Frist noch einmal drauf - standardmäßig 300 Sekunden.

Bewusst **nicht** dieselbe Liste wie `RETRY_OPTIONS`.
Die beiden beantworten verschiedene Fragen - der Retry „hilft Warten?", der Fallback „kann ein anderes Modell der Unterschied sein?".
Bei `429` gehen die Antworten auseinander: Warten bringt nichts, weil das SDK Googles `retryDelay` ignoriert, ausweichen dagegen sofort etwas, weil Kontingente pro Modell zählen.
`test/fallback.test.js` nagelt dieses Auseinandergehen fest, weil die beiden Listen einander ähnlich genug sehen, um zu einer „aufgeräumt" zu werden.

Eine gemessene Einzelheit schlägt den Statuscode als alleiniges Kriterium aus dem Feld: **Ein ungültiger API-Schlüssel kommt nicht als 401 oder 403, sondern als `400 INVALID_ARGUMENT`** mit `API key not valid`.
Ein 400 rechtfertigt sonst durchaus einen Fallback - dahinter kann ein Modell stehen, das das Thinking-Level nicht kennt, und dass ein anderes Modell dieselbe Anfrage annimmt, ist genau der Beweis dafür.
Der Schlüssel dagegen gilt für beide.
Dieser eine Fall wird deshalb am `reason: "API_KEY_INVALID"` in `error.details` erkannt - die einzige Stelle, an der dieser Server etwas unterhalb des Statuscodes auswertet.

#### Was der Footer sagt

Das `🤖`-Feld stimmt nach einem Fallback von allein, weil `formatFooter` das Modell und Level bekommt, das tatsächlich gelaufen ist.
Es zeigt aber nur, **was** geantwortet hat, nicht dass etwas schiefging - daher die zusätzliche Zeile:

```text
🔁 gemini-flash-latest does not exist (404) - answered by backup. Update your default.
```

Drei Codes bekommen einen Zusatz, weil bei ihnen etwas **zu tun** ist:

| Auslöser | Zeile |
| --- | --- |
| 404 | `does not exist (404) - answered by backup. Update your default.` |
| 429 | `hit its quota (429) - answered by backup.` |
| 400 | `rejected the request (400) - answered by backup. Check the thinking level of your default model.` |
| alles andere | `failed (503 UNAVAILABLE) - answered by backup.` |

Ohne diese Unterscheidung liest sich ein dauerhafter 404 wie eine vorübergehende Störung, und niemand korrigiert je das kaputte Standardmodell.
Der 400 ist der einzige, bei dem die Zeile echte Diagnose leistet.

Position innerhalb des Footers, aus drei Gründen: Der Footer bleibt letzter Bestandteil, zwischen Antwort und Links kommt weiterhin nichts vom Server dazwischen (siehe „Wo der Server Inhalt hinzufügt oder umstellt"), und die Zeile steht direkt neben dem `🤖`-Feld, das sie erklärt.

#### Die drei Fälle ohne Footer

Findet kein Fallback statt, gibt es keine Antwort und damit auch keinen Footer - der Grund muss dann in der Fehlermeldung mitreisen.
Ohne ihn bleibt die unbeantwortbare Frage „warum hat mein Backup nicht gegriffen?":

- **beide gescheitert** - beide Fehler, jeweils mit dem Modell davor. Stünde dort nur der zweite, suchte man am falschen Modell. Gebaut über das vorhandene `describeError()` auf beiden, damit die `cause` eines Netzwerkfehlers erhalten bleibt
- **Fallback bewusst ausgelassen** - `backup not tried: …` samt Grund, für die Ausnahmen oben
- **Backup identisch zum Standard** - ein Konfigurationsfehler; jeder Schreibpfad weist ihn vorher ab (`findModelCollision`, siehe „gemini-set-config"), und `runSearch` fängt ihn ein zweites Mal, weil eine von Hand bearbeitete `config.json` gar keinen Schreibpfad durchläuft

Ein beim Aufruf ausdrücklich genanntes Modell gehört **nicht** zu diesen Fällen und bekommt keinen Hinweis.
`resolveCallConfig` übergibt dann schlicht kein Backup, und dass ein selbst genanntes Modell nicht ersetzt wird, ist für den Aufrufer keine Überraschung.

### Warum der Retry nicht im Footer erscheint

Anders als der Fallback, der eigener Kontrollfluss dieses Servers und deshalb beobachtbar ist, laufen die Wiederholungen im SDK und hinterlassen keine Spur.
Weder `ApiError` noch die erfolgreiche `HttpResponse` trägt eine Versuchszahl, und `HttpOptions` bietet keinen Transport- oder Fetch-Einhängepunkt, an dem sie zu beobachten wäre - vorhanden sind dort nur `baseUrl`, `baseUrlResourceScope`, `apiVersion`, `headers`, `timeout`, `extraBody` und `retryOptions`.

Sie zu zählen hieße, das globale `fetch` zu umhüllen und einen Kontext pro Aufruf über `AsyncLocalStorage` zu propagieren, denn mehrere `gemini-search`-Aufrufe können parallel laufen und ein globaler Zähler würde sie vermischen.
Das stand nicht im Verhältnis zu einer Fußnote, deshalb weist der Footer weiterhin Modell, Thinking-Level und Tokenverbrauch aus - und die möglichen Zusatzsekunden stehen stattdessen hier.

### Abbruch durch den Client

Bricht der Nutzer einen laufenden `gemini-search` ab (Esc in Claude Code), schickt der Client `notifications/cancelled`.
Das MCP-SDK macht daraus das `AbortSignal` unter `ctx.mcpReq.signal`, und der Handler reicht es an `runSearch()` weiter.

- `generate()` verbindet es über `AbortSignal.any()` mit der lokalen Bremse, sodass jedes der beiden die Anfrage beendet.
  Die Anfrage und jeder Retry des SDK enden sofort, weil das SDK jedem Versuch dasselbe Signal mitgibt.
- `generate()` prüft für `LocalDeadlineError` nur das Signal der Bremse, ein Abbruch wird also nie als abgelaufene Frist gemeldet.
- `runSearch()` versucht kein Backup mehr, sobald das Signal des Clients ausgelöst hat.
  Auf die Antwort wartet niemand mehr, und das Backup wäre eine zweite abgerechnete Anfrage dafür.

Vorher lief eine abgebrochene Suche bis zu 330 s weiter, und scheiterte danach das Standardmodell, startete das Backup eine zweite abgerechnete Anfrage, die nie jemand lesen würde.

Nicht gemessen: ob Google eine bereits laufende Generierung noch abrechnet, wenn die Verbindung getrennt wird.
Sicher ist, dass Verbindung, Retries und Backup enden.
Festgenagelt in `test/fallback.test.js` und, über den echten stdio-Transport in beiden Protokollrevisionen, in `test/mcp.test.js`.

## Wöchentliches Abhängigkeits-Update

Dependabot öffnet nur Pull Requests; nichts mergt sie von selbst.
Einmal pro Woche, am Dienstagmorgen, führt `.github/workflows/weekly-update.yml` das Skript `scripts/weekly-update.js` aus, das die offenen gegen die echte API testet und mergt, was besteht.
Der Workflow lässt sich auch von Hand starten, wahlweise als Trockenlauf, der testet und berichtet, ohne zu mergen und ohne bezahlte Suche.

### Reihenfolge und Limit

1. **Updates der GitHub Actions**, gemergt ohne Smoke-Test: Sie ändern nur, wie die CI läuft, und erreichen den Server nie.
2. **Alle npm-Minor-, Patch- und Sicherheitsupdates gemeinsam**, mit einem Smoke-Test.
3. **npm-Majors einzeln**, die ältesten zuerst, mit je einem Smoke-Test, damit ein kaputter Major zuzuordnen ist.

Ein Lauf verbraucht höchstens drei Smoke-Tests (`MAX_SMOKE_TESTS`), alles Übrige wartet auf die folgende Woche.
Gab es nichts zu testen, wird main selbst einmal getestet; das fängt Änderungen auf Googles Seite ab, etwa ein abgeschaltetes Modell oder einen umgehängten Alias.

Die Gruppierung in `.github/dependabot.yml` ist auf diese Reihenfolge zugeschnitten.
Minor- und Patch-Updates bilden eine Gruppe, Majors bewusst keine, sodass jeder Major als eigener Pull Request kommt.
Sicherheitsupdates haben eine eigene Gruppe, weil sie bei npm der einzige Weg sind, auf dem transitive Abhängigkeiten überhaupt aktualisiert werden - Versionsupdates lassen diese unberührt.

Majors werden so erkannt wie bei `dependabot/fetch-metadata`: an den `update-type`-Zeilen in Dependabots Commit-Message und, wo diese fehlen wie bei Sicherheitsupdates, an den Versionen in den Zeilen `Bumps …` und `Updates …`.
Unter 1.0 zählt eine Änderung der zweiten Zahl als Major, weil SemVer dort brechende Änderungen erlaubt.
Ein Head-Commit ohne all das stammt von jemand anderem und zählt als Major; er wird also einzeln getestet, statt in das Sammelpaket zu rutschen.

### Erst testen, dann mergen

Die Kandidaten werden lokal in der Reihenfolge oben auf den aktuellen Stand von main gestapelt, und jeder Schritt durchläuft `npm ci`, `npm test` und den Smoke-Test auf genau diesem Stand.
GitHubs Squash-Merge eines konfliktfreien Pull Requests erzeugt denselben Stand, und `--match-head-commit` lehnt einen Pull Request ab, dessen Head sich seither bewegt hat; was getestet wurde, ist also das, was landet.
Ein Pull Request mit Konflikt wird übersprungen; Dependabot rebased ihn von selbst, und er kommt in der folgenden Woche dran.
Der erste Fehlschlag beendet das Testen, weil jeder spätere Schritt darauf aufbauen würde.

| Ergebnis | Was passiert |
| --- | --- |
| bestanden | gemergt |
| kaputt | bleibt offen mit dem Label `weekly-update-failed` und einem Kommentar mit Link auf den Lauf; der Lauf schlägt fehl, GitHub schickt also eine E-Mail |
| nicht erreichbar | nichts wird markiert, der Lauf stoppt, die folgende Woche versucht es erneut |

„Nicht erreichbar" umfasst einen Smoke-Test, der auf 408, 429, 5xx oder einen Netzwerkfehler traf, sowie ein scheiterndes `npm ci`: Ein überlastetes Google oder eine überlastete Registry sagt nichts über das Update aus.

Ein gescheiterter Pull Request wird nur übersprungen, solange sein Head-Commit unverändert ist - der Kommentar hält diesen Commit fest.
Eine neue Version oder ein Rebase durch Dependabot wird deshalb erneut versucht, ohne dass jemand das Label entfernen muss; das zählt, weil womöglich wochenlang niemand hinschaut.

### Zwei Jobs als Sicherheitsgrenze

Testen führt den Code der getesteten Updates aus - `npm ci`, `npm test` und der Smoke-Test tun das alle -, deshalb darf der testende Job nie ein Token halten, das ins Repository schreiben kann.
Das Token aus der Umgebung eines Kindprozesses zu entfernen, genügte nicht, weil unter Linux ein Kindprozess die Umgebung seines Elternprozesses aus `/proc` lesen kann.
Der Workflow teilt den Lauf deshalb auf:

| Job | Token | Führt Abhängigkeitscode aus | Tut |
| --- | --- | --- | --- |
| `test` | nur lesend | ja | stapelt, testet, schreibt einen Plan, was bestanden hat und was gescheitert ist |
| `merge` | schreibend | nein - kein `npm ci`, nur Node-Bordmittel | mergt und markiert nach dem Plan |

Der `test`-Job checkt ohne gespeicherte Zugangsdaten aus (`persist-credentials: false`), weil getesteter Code sie sonst aus `.git/config` lesen könnte.
`npm ci` läuft mit `--ignore-scripts`: Keine Abhängigkeit braucht ihr Installationsskript zur Laufzeit - das einzige vorhandene, in `protobufjs`, prüft nur das eigene Kommandozeilenwerkzeug.

Der Plan stammt aus dem Job, der den getesteten Code ausgeführt hat, deshalb prüft `merge` ihn, statt ihm zu vertrauen.
Jeder Eintrag muss ein offener Pull Request von Dependabot sein, dessen Head noch der getestete Commit ist.
Schlimmstenfalls mergt ein manipulierter Plan ein echtes Dependabot-Update ungetestet, und die Branch-Protection verlangt trotzdem den eigenen grünen `Tests`-Check dieses Pull Requests.

### Drift der Modellliste

Derselbe Workflow prüft jede Woche die Modellliste des Keys, unabhängig von den Updates, über `scripts/model-drift.js`.
Das kostet nichts: `models.list` wird nicht abgerechnet.
Der vollständige Probe-Lauf, der über die Ausschlussliste entscheidet, kostet etwa 33 abgerechnete Anfragen und bleibt ein manueller Lauf von `scripts/probe-models.js`; diese Prüfung sagt nur, wann einer fällig ist.

Sie meldet zweierlei, beides aus `findModelDrift()` in `models.js`:

- **stale** - Einträge der Ausschlussliste, deren Modell nicht mehr in `models.list` steht (`staleEntries()`, gemeinsam mit `probe-models.js`)
- **unprobed** - hier angebotene Modelle, die `test/fixtures/models-list.json` nicht enthält. Ein neues Modell besteht `isUsableModel()` und wird sofort angeboten, ungeprüft - so kamen im August 2026 zwei Modelle auf die Kurzliste, die mit `400` scheitern

Die Aufteilung folgt der Grenze oben.
`drift` führt `npm ci --ignore-scripts` und das SDK mit dem Gemini-Key und einem Token nur zum Lesen aus und gibt sein Ergebnis als Job-Output weiter.
`drift-report` hält `issues: write`, führt keinen Code aus Abhängigkeiten aus und prüft das Ergebnis, statt ihm zu vertrauen: nur Modell-IDs, nichts, was Markup oder Erwähnungen in das Issue tragen könnte.
Danach schreibt es in ein einziges Issue mit dem Titel "Model list drift" und ändert sonst nichts; ohne Drift und bei einem Probelauf tut es nichts.
Ist ein Issue mit diesem Titel offen, kommt der neue Befund als Kommentar dazu, sodass frühere Wochen lesbar bleiben; sonst entsteht ein neues Issue.
Ein geschlossenes Issue gilt als erledigt und wird nie wieder geöffnet.

Das offene Issue wird gefunden, indem die offenen Issues gelistet und nach Titel gefiltert werden, nicht über `--search`: Der Suchindex hinkt hinterher, und gemessen wurde ein drei Sekunden zuvor angelegtes Issue nicht gefunden, sodass ein zweites daneben entstand.

### Branch-Protection

Der Pflicht-Check heißt `Tests`, ein Job in `test.yml`, der von der Node-Matrix und dem Markdown-Lint abhängt.
Matrix-Jobs melden sich unter eigenem Namen (`Node 22`, …), eine Matrix allein liefert also nie einen Check namens `Tests` - genau diese Abweichung hat ab September 2026 jeden Dependabot-Pull-Request blockiert, bis es den Job gab.
Der Job läuft mit `if: always()`, weil ein übersprungener Pflicht-Check als bestanden gilt.

„Require branches to be up to date before merging" ist bewusst ausgeschaltet.
Der wöchentliche Lauf mergt mit dem `GITHUB_TOKEN` des Workflows, und Ereignisse dieses Tokens starten keine weiteren Workflow-Läufe.
Nach dem ersten Merge bräuchte der nächste Pull Request einen frischen CI-Lauf, den nichts starten könnte.
Der Test des zusammengeführten Stands übernimmt diese Rolle.

### Der Smoke-Test

`scripts/smoke-test.js` (`npm run smoke`) prüft den Server so, wie Claude Code ihn nutzt, über das MCP-Protokoll: Handshake über Revision 2026-07-28, Tool-Liste, `gemini-list-models`, eine grounded Suche mit Thinking-Level `low` und eine Anfrage an ein Modell, das es nicht gibt.
Genau hier hören die Unit-Tests auf - sie laufen ohne Key gegen nachgebaute Antworten, ein Update, das die Form echter Antworten oder Fehler ändert, besteht sie also.
Der Smoke-Test nutzt nur die Revision 2026-07-28, die Claude Code bevorzugt; Revision 2025-11-25, die Annotations und die Parameterbeschreibungen deckt `test/mcp.test.js` bei jedem CI-Lauf kostenlos ab.

Nur die Suche wird abgerechnet.
`models.list` ist kostenlos, und die Anfrage an das fehlende Modell wird vor der Ausführung mit 404 abgelehnt; das macht den Fehlerpfad kostenlos prüfbar.
Im Paid Tier kommt die Suche aus den 5.000 kostenlosen Suchanfragen pro Monat, die sich die Modelle ab Gemini 3 teilen; die Tokens kosten einen Bruchteil eines Cents.

Das Skript gibt Prüfnamen und Ergebnisse aus, nie den Antworttext oder die Quellen (Invariante I4, siehe „Terms-Konformität"): GitHub bewahrt das CI-Log auf, ein dort ausgegebenes Grounded Result landete also auf der Festplatte.
Der Gemini-Key ist das eine Geheimnis, das der getestete Code zwangsläufig sieht, weil der Smoke-Test genau diesen Code gegen die API laufen lässt.
Er bekommt deshalb einen eigenen Key, beschränkt auf die Generative Language API, statt des Keys für die alltägliche Suche.
`npm ci` und `npm test` erhalten eine Umgebung ganz ohne Token oder Key.
