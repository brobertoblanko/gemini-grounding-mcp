# gemini-grounding-mcp

Minimaler, eigener MCP-Server, der Claude Code Zugriff auf Google-Websuche
über die Gemini API mit Grounding gibt. Nutzt ausschließlich die offiziellen
SDKs `@google/genai` und `@modelcontextprotocol/sdk` — kein Community-Paket,
kein automatischer Versionswechsel im Hintergrund.

**Nutzungsrahmen:** Ausschließlich für Research- und Rechercheanfragen. Kein
produktiver Einsatz, keine Anbindung an sensible Systeme.

Details zu Architektur und Entscheidungen: siehe [specs.md](./docs/specs.md).
Verhaltensregeln für Claude Code in diesem Projekt: siehe [CLAUDE.md](./CLAUDE.md).

## Voraussetzungen

- **Node.js 20 oder neuer** — gefordert von `@google/genai` und dem MCP-SDK.
  Prüfen mit `node -v`.
- **Ein Gemini-API-Key**, kostenlos erhältlich im
  [Google AI Studio](https://aistudio.google.com/apikey).
- **Claude Code** oder ein anderer MCP-fähiger Client
  ([Model Context Protocol](https://modelcontextprotocol.io)).

**Hinweis zu Kosten:** Aufrufe der Gemini API sind nicht in jedem Fall
kostenlos. Es gibt ein Free Tier mit Ratenbegrenzungen; darüber hinaus wird
nach Tokens abgerechnet, und das Google-Search-Grounding kann je nach Modell
und Tarif zusätzlich berechnet werden. Maßgeblich sind die offiziellen Seiten
zu [Preisen](https://ai.google.dev/gemini-api/docs/pricing) und
[Ratenbegrenzungen](https://ai.google.dev/gemini-api/docs/rate-limits) — beide
ändern sich regelmäßig, daher stehen hier bewusst keine konkreten Zahlen.
Der Token-Footer unter jeder Antwort macht den Verbrauch pro Aufruf sichtbar.

## Installation

```bash
git clone https://github.com/srzsn22q6d-sys/gemini-grounding-mcp.git
cd gemini-grounding-mcp
npm install
```

## API-Key bereitstellen

Der API-Key wird ausschließlich über die Umgebungsvariable `GEMINI_API_KEY`
übergeben, niemals im Code oder in `config.json` hinterlegt. Er muss als
**persistente** Umgebungsvariable gesetzt sein, bevor der Client den Server
startet.

**Windows (PowerShell, User-Scope, einmalig):**

```powershell
[Environment]::SetEnvironmentVariable('GEMINI_API_KEY', '<dein-api-key>', 'User')
```

Danach die Shell neu öffnen, damit die Variable verfügbar ist.

**macOS / Linux** — in `~/.zshrc`, `~/.bashrc` o. ä. eintragen:

```bash
export GEMINI_API_KEY='<dein-api-key>'
```

## Registrierung bei Claude Code

**Windows (PowerShell):**

```powershell
claude mcp add gemini-grounding -s user `
  -e 'GEMINI_API_KEY=${GEMINI_API_KEY}' `
  -- node <path-to-repo>\index.js
```

**macOS / Linux (bash / zsh):**

```bash
claude mcp add gemini-grounding -s user \
  -e 'GEMINI_API_KEY=${GEMINI_API_KEY}' \
  -- node <path-to-repo>/index.js
```

`<path-to-repo>` durch den tatsächlichen absoluten Pfad zu diesem geklonten
Repository ersetzen — `claude mcp add` benötigt einen konkreten, auf dem
jeweiligen Rechner auflösbaren Pfad zu `index.js`, um den Server per stdio
zu starten.

Die Referenz `${GEMINI_API_KEY}` steht in **einfachen** Anführungszeichen,
damit die Shell sie nicht selbst auflöst. Claude Code expandiert sie erst beim
Laden der Konfiguration aus der bereits gesetzten Umgebungsvariable — dadurch
landet in `~/.claude.json` nur der Platzhalter, nicht der Key im Klartext.

Prüfen, ob der Server läuft:

```bash
claude mcp list
```

## Kommandozeilen-Werkzeug

Der Server lässt sich auch ohne MCP-Client bedienen — nützlich, um vor der
Registrierung zu prüfen, ob API-Key und Modellwahl funktionieren, und um beim
Entwickeln eine Änderung zu testen, ohne den Client neu zu starten. Sämtliche
Ausgaben der CLI sind englisch.

```bash
node cli.js config
```

Optional lässt sich der Befehl systemweit verfügbar machen:

```bash
npm link
gemini-grounding config
```

`npm link` legt im globalen npm-Ordner einen Verweis auf `cli.js` an (unter
Windows als `.cmd`/`.ps1`, sonst als Symlink). Da es ein Verweis und keine
Kopie ist, wirken Änderungen an `cli.js` sofort. Rückgängig machen mit
`npm unlink -g gemini-grounding-mcp` — npm erwartet dort den Paketnamen, nicht
den Befehlsnamen `gemini-grounding`. Mit dem Befehlsnamen meldet npm lediglich
`up to date` und entfernt nichts. Alle folgenden Beispiele funktionieren
genauso mit `node cli.js` statt `gemini-grounding`.

| Befehl | Wirkung |
|---|---|
| `gemini-grounding "<frage>"` | Suche mit den gespeicherten Standardwerten, Ausgabe inkl. Quellenliste und Token-Footer |
| `gemini-grounding config` | zeigt gespeichertes Modell, Thinking-Level und ob ein API-Key in der Umgebung liegt |
| `gemini-grounding models [--all]` | listet die mit diesem Server nutzbaren Modelle mit Token-Limits; `--all` zeigt alle |
| `gemini-grounding set-model <id>` | setzt das Standardmodell dauerhaft |
| `gemini-grounding set-thinking <level>` | setzt das Thinking-Level dauerhaft (`minimal`, `low`, `medium`, `high`) |
| `gemini-grounding help` | Kurzhilfe |

Alles, was kein bekannter Unterbefehl ist, wird als Suchanfrage behandelt — und
zwar als **genau ein Argument**. Eine Frage mit Leerzeichen gehört deshalb in
Anführungszeichen. Unquotiert bricht der Aufruf mit einer Meldung ab, statt eine
Anfrage abzuschicken, aus der die Optionserkennung einzelne Wörter
herausgeschnitten hat (`… was bedeutet --thinking high …` wäre sonst als
`was bedeutet …` gelaufen). Auch eine unbekannte Option (`--al` statt `--all`)
und überzählige Argumente sind ein Fehler mit Exit-Code 1 — nichts davon wird
stillschweigend übergangen.

**Einmalige Overrides.** Für einen einzelnen Aufruf lassen sich Modell und
Thinking-Level abweichend setzen, ohne den gespeicherten Standard zu ändern:

```bash
gemini-grounding "frage" --model gemini-3-pro-preview --thinking minimal
```

Welche Werte tatsächlich zum Einsatz kamen, steht im Footer unter jeder
Antwort.

**Gemeinsame Konfiguration.** CLI und MCP-Server lesen und schreiben dieselbe
`config.json`. Ein `set-model` im Terminal ändert damit auch, womit der
MCP-Server beim nächsten Aufruf arbeitet — beabsichtigt, denn so ist ein
Modellwechsel möglich, ohne den Client dazu aufzufordern.

**Fehler bleiben vollständig sichtbar.** Anders als der MCP-Server, der jeden
Fehler auf eine Zeile für den Client verdichten muss, gibt die CLI den
kompletten Stacktrace samt Original-Fehlermeldung der Google-API aus und endet
mit Exit-Code 1. Beim Testen ist genau das gewollt: Eine Meldung wie
`ApiError: {"error":{"code":503, ...}}` besagt, dass die Anfrage bei Google
nicht durchkam — kein Fehler der eigenen Installation. Ein reiner Bedienfehler
(falsches Argument, unbekannte Option, leere Anfrage) gibt dagegen nur die eine
erklärende Zeile aus, ebenfalls mit Exit-Code 1 — für einen Tippfehler auf der
Kommandozeile braucht niemand einen Stacktrace.

`config` prüft nur, ob überhaupt ein Key in der Umgebung ankommt, und gibt
dessen Länge aus — **nie den Wert selbst**. Ob der Key gültig ist, zeigt erst
eine echte Anfrage.

## Tools

- **`gemini-search`** — Recherche via Google Search, URL Context und Code
  Execution in einem Aufruf. Antwort enthält Quellenliste und Token-Footer.
  Hat Gemini dabei Code ausgeführt, stehen der Code und sein Ergebnis unter
  `Code execution:` hinter dem Antworttext — der Rechenweg ist ein Beleg und
  steht deshalb dort, wo auch die Quellen stehen. Lief die Antwort nicht
  regulär zu Ende — blockiert oder an der Token-Grenze
  abgeschnitten — weist eine Zeile mit ⚠️ und dem Grund darauf hin, statt eine
  leere oder halbe Antwort wie einen Erfolg aussehen zu lassen.
- **`gemini-list-models`** — Listet die für den API-Key verfügbaren Modelle mit
  Token-Limits. Standardmäßig nur die mit diesem Server nutzbaren (siehe unten),
  mit `all: true` alle.
- **`gemini-set-model`** — Legt Standardmodell und/oder Standard-Thinking-Level
  dauerhaft in `config.json` fest (nur diese beiden Werte, niemals der API-Key).

`config.json` wird erst beim ersten `gemini-set-model` angelegt und ist nicht
Teil des Repositorys. Ohne sie gelten die Defaults aus `config.js`
(`gemini-flash-latest`, Thinking-Level `medium`).

### Welche Modelle nutzbar sind

Der API-Key gibt deutlich mehr Modelle frei, als hier funktionieren. Die
Modellliste zeigt deshalb standardmäßig nur die, die zwei Bedingungen
erfüllen — beide aus den Angaben der API selbst, nicht aus dem Modellnamen:

- **`generateContent`** in `supportedActions` — das Modell erzeugt überhaupt
  Text. Embedding-, Bild- (Imagen), Video- (Veo) und Live-/Audio-Modelle
  fallen damit weg.
- **`thinking: true`** — das Modell akzeptiert ein Thinking-Level. Da jede
  Suche eines mitschickt, antwortet die API sonst mit
  `400 Thinking level is not supported for this model.`

Nach Namensmustern zu filtern wäre unzuverlässig: Google vergibt Codenamen,
die nichts über die Fähigkeiten verraten — `nano-banana-pro-preview` ist ein
Bildmodell.

Zwei Einschränkungen bleiben:

- Die Bedingungen sagen, was **technisch** durchläuft, nicht was für
  Recherche sinnvoll ist. Auch Bild-, Sprach- und Robotikmodelle erfüllen sie
  teilweise und erscheinen in der Liste.
- **Gelistet heißt nicht verfügbar.** Abgekündigte Modelle bleiben in der
  Liste und antworten mit `404 ... is no longer available`. Ein Feld, das das
  vorab anzeigt, gibt es nicht — Gewissheit gibt nur ein echter Aufruf.

Deshalb blendet `--all` bzw. `all: true` nichts aus, sondern zeigt die
vollständige Liste mit einer Statusspalte.

## Lizenz

[MIT](./LICENSE)
