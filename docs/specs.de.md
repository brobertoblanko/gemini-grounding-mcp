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
- `@modelcontextprotocol/sdk` - das offizielle MCP-SDK (Anthropic)

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
  `server.registerTool(...)`, baut den stdio-Transport auf.
- `gemini.js` - kapselt den `GoogleGenAI`-Aufruf inkl. der drei kombinierten
  Built-in-Tools, baut Quellenliste und Footer aus der API-Antwort.
- `citations.js` - setzt die Belegmarker in den Antworttext. Eigene Datei, weil
  dieser Code als einziger im Projekt **ohne Netzwerk und ohne API-Key
  vollständig prüfbar** ist: Rein gehen Text und Metadaten, heraus kommt Text -
  kein `getClient()`, keine Konfiguration, kein Zufall. Getestet gegen eine
  gespeicherte echte Antwort in `test/citations.test.js` (`npm test`, über
  Nodes eingebauten Test-Runner, ohne zusätzliche Abhängigkeit).
- `config.js` - liest/schreibt die dauerhafte Modellwahl in einer `config.json`
  am plattformüblichen Ort für Nutzer-State (siehe „Speicherort der
  Konfiguration" unten).
- `cli.js` - zweites Frontend auf denselben Kern: dieselben Exporte aus
  `gemini.js` und `config.js`, die auch `index.js` nutzt, über die
  Kommandozeile erreichbar. Ohne zusätzliche Abhängigkeit (ein `switch` über
  `process.argv` genügt), ohne zweiten Ort für den API-Key. Zwei bewusste
  Unterschiede zum MCP-Server: Laufzeitfehler werden mit vollem Stacktrace
  ausgegeben statt wie in `index.js` auf eine Zeile für den Client verdichtet,
  und die Ausgabe geht auf stdout - beim stdio-Transport wäre das unmöglich,
  weil dort JSON-RPC darüber läuft. Aufruf und Unterbefehle: siehe README.

  Der Fehler wird dabei trotzdem per `try`/`catch` abgefangen, obwohl die
  Ausgabe dieselbe bleibt: Beendet Node den Prozess wegen einer unbehandelten
  Rejection hart, während noch eine Netzwerkverbindung offen ist, bricht libuv
  unter Windows mit `Assertion failed ... src\win\async.c` ab, und der Prozess
  endet mit `0xC0000409` statt mit Code 1. Deshalb `console.error(error)` -
  identisch zu Nodes eigener Ausgabe - gefolgt von `process.exitCode = 1`
  statt `process.exit()`, damit Node regulär herunterfährt.

  Das gilt **ausnahmslos**: `cli.js` enthält kein `process.exit()`. Ein
  Bedienfehler wirft stattdessen einen `UsageError`, den derselbe `catch`-Block
  abfängt und mit nur seiner Meldung ausgibt - für einen Tippfehler auf der
  Kommandozeile ist ein Stacktrace sinnlos. Zweiter Grund gegen `process.exit()`:
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
  vollständige hält. Überzählige Argumente lehnt jeder Unterbefehl ab.

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
  unterscheiden ist.

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
  fällt die Zielposition hinein, wird der Marker verworfen. Nicht erkannt werden eingerückte Codeblöcke (vier Leerzeichen) -
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

const footer =
  `\n\n---\n🔢 ${inputTokens} input / ${outputTokens} output / ${thinkingTokens} thinking tokens ` +
  `| 🔍 ${sources.length} sources | 🤖 ${model} (thinking: ${thinkingLevel})${droppedNote}${skippedNote}` +
  formatSearchQueries(searchQueries);

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
🔢 245 input / 89 output / 40 thinking tokens | 🔍 2 sources | 🤖 gemini-flash-latest (thinking: high)
🔎 Searched: gemini api models list · google genai sdk models.list pagination
```

Die Zahl der verworfenen Marker gehört in den Footer, weil sie die
Aussagekraft der Antwort verändert: Fehlt ein Marker, kann die Stelle
ungegroundet sein - oder die Prüfung hat ihn verworfen. Das entspricht dem
Zweck des Footers, den tatsächlichen Zustand jedes einzelnen Aufrufs sichtbar
zu machen.

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

Tatsächlich implementiert in `gemini.js` (`buildText`, `formatNotice`,
`buildSourceList`, `formatSourcesBlock`, `formatFooter`, `formatSearchQueries`)
und `citations.js` (`insertCitations`).
`buildSourceList`, `formatSourcesBlock`, `formatFooter` und
`formatSearchQueries` sind exportiert und wie `insertCitations` ohne API-Key
prüfbar (`test/sources.test.js`, `test/search-queries.test.js`).
`gemini.js` lässt sich ohne `GEMINI_API_KEY` importieren, weil `getClient()`
erst in `runSearch` und `listModels` aufgerufen wird, nicht beim Laden des
Moduls.

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
| I4 | Nichts wird zwischengespeichert | Grounded Results berühren nie die Festplatte; `config.json` enthält Modellname und Thinking-Level, sonst nichts |

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
hier funktionieren - beim Stand dieser Messung 58 insgesamt, davon 32
nutzbar. Gefiltert wird über zwei Angaben, die jedes Modell selbst
mitliefert:

| Feld | Bedingung | Andernfalls |
| --- | --- | --- |
| `supportedActions` | enthält `generateContent` | Modell erzeugt keinen Text - Embeddings, Imagen, Veo, Live/Audio |
| `thinking` | `true` | `400 Thinking level is not supported for this model.`, da `runSearch` immer ein `thinkingConfig` sendet |

Beide Felder sind im `Model`-Interface des SDK dokumentiert. Bewusst **nicht**
über Namensmuster gefiltert: Google vergibt Codenamen, die nichts über die
Fähigkeiten aussagen (`nano-banana-pro-preview` ist ein Bildmodell), sodass
jede Musterliste bei der nächsten Modellfamilie veraltet.

Grenzen, die der Filter nicht auflöst:

- Er trennt technische Lauffähigkeit, nicht Eignung. Bild-, Sprach- und
  Robotikmodelle erfüllen die Bedingungen teilweise ebenfalls.
- **Gelistet heißt nicht verfügbar.** Abgekündigte Modelle bleiben in der
  Antwort und liefern bei Nutzung `404 ... is no longer available` - nachweisbar
  an der 2.0-Generation. Ein Feld, das den Zustand vorab anzeigt, existiert
  nicht.

Deshalb ist `all` kein reiner Komfortschalter: Da die Liste ohnehin keine
Garantie gibt, darf die gefilterte Sicht nie die einzige sein. `all: true`
zeigt die vollständige Liste mit einer Statusspalte. Ergibt der Filter kein
einziges Modell - etwa weil die API die ausgewerteten Felder nicht mehr
liefert - fällt `listModels` selbsttätig auf die vollständige Liste zurück und
weist im Hinweistext darauf hin, statt eine leere Ausgabe zu erzeugen.

### gemini-set-model

Speichert Modell-ID und/oder Thinking-Level dauerhaft in einer `config.json`
(Ort siehe unten). Beide Werte lassen sich unabhängig voneinander setzen - ein
Merge sorgt dafür, dass das Setzen des einen Werts den bereits gespeicherten
anderen Wert nicht überschreibt. Diese Wahl bleibt über Server-Neustarts hinweg
bestehen, bis sie erneut geändert wird.

Die Bestätigung nennt den vollständigen Pfad, und der Aufruf liegt in einem
`try`/`catch`: Das Zielverzeichnis wird erst beim Speichern angelegt und kann je
nach Rechten oder verschobenem `%APPDATA%` unbeschreibbar sein. Ohne `catch`
liefe ein Schreibfehler ungefangen aus dem Handler statt als `isError`-Antwort
beim Client anzukommen.

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
          text: `Gespeichert - Modell: ${model}, Thinking-Level: ${thinkingLevel}`,
        },
      ],
    };
  },
);
```

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
exportiert, die Bestätigung von `gemini-set-model` nennt ihn, und
`gemini-grounding config` zeigt ihn ebenfalls an.

Ebenfalls verworfen: Modell und Thinking-Level **zusätzlich** über
`GEMINI_MODEL`/`GEMINI_THINKING_LEVEL` vorgeben zu können. Der Code wären zwei
Zeilen gewesen, der Preis liegt woanders - eine zweite Konfigurationsquelle
erzeugt eine Rangfolge, die erklärt werden muss, und drei überraschende
Verhaltensweisen: ein einmaliges `gemini-set-model` hätte die Variable dauerhaft
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

Tatsächlich implementiert (inkl. `setSavedConfig`) in `config.js` - siehe „Implementierung" oben.

`readConfig()` fällt bei **jeder** unlesbaren Datei auf die Standardwerte zurück, schweigt aber nur über die fehlende.
Vor dem ersten gespeicherten Wert gibt es keine Datei, und die Standardwerte sind dann genau das Gewollte.
Alles andere - kaputtes JSON nach einem abgebrochenen Schreibvorgang, fehlende Leserechte - macht eine gespeicherte Einstellung wirkungslos, und ohne ein Wort liefe der Server einfach mit den Standardwerten weiter, während die Einstellung stillschweigend verschwunden wäre.
Ein solcher Fall erzeugt deshalb eine Warnung, die den Pfad und die Originalmeldung nennt.

Sie geht nach **stderr**, nie nach stdout: Der MCP-Server spricht über stdout JSON-RPC, wo eine einzelne verirrte Zeile die Verbindung zum Client zerstört.
Ein Flag auf Modulebene begrenzt sie auf ein Vorkommen, denn `readConfig()` läuft pro Aufruf zweimal - einmal für das Modell, einmal für das Thinking-Level.

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

Für eine Anfrage gelten drei Grenzen, und nur eine davon entscheidet. Alle drei sind gemessen, nicht geschätzt:

| Grenze | Wert | Wirkung |
| --- | --- | --- |
| Node (`headersTimeout`) | **306,8 s** gemessen | Kappt die Verbindung - **greift zuerst** |
| MCP-Client (Claude Code 2.1.224) | **1800 s** gemessen | Sechsmal geduldiger, wird nie erreicht |
| Google ohne Frist | keine | Generiert unabhängig davon zu Ende |

Node kappt zuerst, alles was Google darüber hinaus erzeugt, kann niemand mehr entgegennehmen.
Bezahlt wird es trotzdem: Input-Tokens voll, sobald die Verarbeitung beginnt, Output-Tokens bis zum tatsächlichen Ende des Laufs.
Kostenlos sind nur Ablehnungen vor der Ausführung (`400`, `401`, `403`, `429`).

`gemini.js` nennt dem Gateway deshalb eine eigene Frist, als gewöhnlichen Header:

```javascript
export const SERVER_DEADLINE_SECONDS = 290;
```

290 s liegen knapp unter Nodes Grenze, damit Google aufhört, bevor die Leitung gekappt wird - und der Fehler als `504` mit Begründung ankommt statt als bloßer Verbindungsabbruch.
Google übernimmt den Header als Ausführungsfrist und bricht die Generierung tatsächlich serverseitig ab; der Wert geht in ganzen Sekunden hinaus.

**Bewusst nicht über `httpOptions.timeout`**, obwohl das SDK denselben Header daraus baut.
Diese Option erzeugt aus demselben Wert zusätzlich einen clientseitigen `AbortController` - eine zweite Uhr, die mit Googles Antwort um die Wette läuft.
Wer gewinnt, ist Zufall, und gewinnt die eigene Uhr, kommt `This operation was aborted` an statt der Begründung.
Ein Header allein hat kein zweites bewegliches Teil.

Der gemessene Timer misst übrigens nicht das, was sein Name nahelegt: `headersTimeout` ist die Wartezeit auf die Antwort-Kopfzeilen, nicht die Gesamtdauer.
Da `generateContent` nicht streamt, läuft hier beides aufs Gleiche hinaus - Google antwortet in einem Stück, sobald die Generierung fertig ist.

`httpOptions.headers` ersetzt die Header des SDK nicht: `patchHttpOptions()` mischt beide Objekte per `Object.assign`, `User-Agent` und `Content-Type` bleiben erhalten.
`test/retry.test.js` prüft das im selben Fall wie die Frist selbst - wäre das Mischen ein Ersetzen, schlügen die Anfragen am Server fehl, ohne dass ein Test es bemerkt hätte.
Ein Hänger wird deshalb in Kauf genommen, statt ihn mit drei beweglichen Teilen zu erkaufen. Geblieben ist aus dem Versuch die Fehlermeldung - siehe unten.

### Was beim Client ankommt, wenn eine Anfrage scheitert

Ein MCP-Tool kann eine Zeile Text zurückgeben. Welche das ist, entscheidet darüber, ob der aufrufende Agent dem Nutzer überhaupt etwas erklären kann.

Bei einem `ApiError` ist das unproblematisch: Seine `message` trägt den rohen JSON-Body der Fehlerantwort und damit Code, Status und Googles eigenen Wortlaut.
Ein Netzwerkfehler ist der umgekehrte Fall. Bei Node heißt jeder von ihnen `fetch failed` - abgelehnte Verbindung, unbekannter Host, Zeitüberschreitung, immer dieselben zwei Wörter -, und was tatsächlich geschah, steht ausschließlich in `error.cause`, die eine einzelne Zeile verlöre.

`describeError()` in `gemini.js` hängt die Ursache deshalb an, samt Code, wo es einen gibt (gemessen: `bad port` liefert keinen, `ECONNREFUSED` schon):

```text
Error in gemini-search: fetch failed (UND_ERR_HEADERS_TIMEOUT: Headers Timeout Error)
```

Dieses Beispiel ist das gemessene und keine erfundene Veranschaulichung: Genau das erzeugt der oben genannte Abbruch nach 306,8 s.

`test/errors.test.js` prüft das gegen einen **echten** `fetch`-Fehler statt gegen einen nachgebauten - die Form von `error.cause` ist eine Annahme über die Laufzeitumgebung, und die prüft man besser an ihr selbst.

Ein solcher Fehler wird **nicht** wiederholt - erwähnenswert, weil das Gegenteil die naheliegende Annahme ist. Gemessen kommt er in deutlich unter einer Sekunde an.
p-retry 4.6.2 bricht bei jedem `TypeError` ab, dessen Meldung nicht einem von vier fest eingebauten Browser-Wortlauten entspricht (`Failed to fetch`, `NetworkError when attempting to fetch resource.`, `The Internet connection appears to be offline.`, `Network request failed`).
Node wirft `TypeError: fetch failed`, und das steht dort nicht.

Die oben eingerichtete Wiederholung deckt damit ausschließlich die Statuscodes der API ab.
Ein DNS-Aussetzer oder eine abgerissene Verbindung erreicht den Client sofort und unwiederholt - womit die Meldung, die dort ankommt, das Einzige ist, woran er sich halten kann.

### Warum der Retry nicht im Footer erscheint

Die Wiederholungen laufen im SDK und hinterlassen keine Spur.
Weder `ApiError` noch die erfolgreiche `HttpResponse` trägt eine Versuchszahl, und `HttpOptions` bietet keinen Transport- oder Fetch-Einhängepunkt, an dem sie zu beobachten wäre - vorhanden sind dort nur `baseUrl`, `baseUrlResourceScope`, `apiVersion`, `headers`, `timeout`, `extraBody` und `retryOptions`.

Sie zu zählen hieße, das globale `fetch` zu umhüllen und einen Kontext pro Aufruf über `AsyncLocalStorage` zu propagieren, denn mehrere `gemini-search`-Aufrufe können parallel laufen und ein globaler Zähler würde sie vermischen.
Das stand nicht im Verhältnis zu einer Fußnote, deshalb weist der Footer weiterhin Modell, Thinking-Level und Tokenverbrauch aus - und die möglichen Zusatzsekunden stehen stattdessen hier.
