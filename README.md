# gemini-grounding-mcp

Minimaler, eigener MCP-Server, der Claude Code Zugriff auf Google-Websuche
über die Gemini API mit Grounding gibt. Nutzt ausschließlich die offiziellen
SDKs `@google/genai` und `@modelcontextprotocol/sdk` — kein Community-Paket,
kein automatischer Versionswechsel im Hintergrund.

**Nutzungsrahmen:** Ausschließlich für Research- und Rechercheanfragen. Kein
produktiver Einsatz, keine Anbindung an sensible Systeme.

Details zu Architektur und Entscheidungen: siehe [specs.md](./specs.md).
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
`npm unlink -g gemini-grounding`. Alle folgenden Beispiele funktionieren
genauso mit `node cli.js` statt `gemini-grounding`.

| Befehl | Wirkung |
|---|---|
| `gemini-grounding "<frage>"` | Suche mit den gespeicherten Standardwerten, Ausgabe inkl. Quellenliste und Token-Footer |
| `gemini-grounding config` | zeigt gespeichertes Modell, Thinking-Level und ob ein API-Key in der Umgebung liegt |
| `gemini-grounding models` | listet die für den Key verfügbaren Modelle mit Token-Limit |
| `gemini-grounding set-model <id>` | setzt das Standardmodell dauerhaft |
| `gemini-grounding set-thinking <level>` | setzt das Thinking-Level dauerhaft (`minimal`, `low`, `medium`, `high`) |
| `gemini-grounding help` | Kurzhilfe |

Alles, was kein bekannter Unterbefehl ist, wird als Suchanfrage behandelt.

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
nicht durchkam — kein Fehler der eigenen Installation.

`config` prüft nur, ob überhaupt ein Key in der Umgebung ankommt, und gibt
dessen Länge aus — **nie den Wert selbst**. Ob der Key gültig ist, zeigt erst
eine echte Anfrage.

## Tools

- **`gemini-search`** — Recherche via Google Search, URL Context und Code
  Execution in einem Aufruf. Antwort enthält Quellenliste und Token-Footer.
- **`gemini-list-models`** — Listet die für den API-Key verfügbaren Modelle.
- **`gemini-set-model`** — Legt Standardmodell und/oder Standard-Thinking-Level
  dauerhaft in `config.json` fest (nur diese beiden Werte, niemals der API-Key).

`config.json` wird erst beim ersten `gemini-set-model` angelegt und ist nicht
Teil des Repositorys. Ohne sie gelten die Defaults aus `config.js`
(`gemini-flash-latest`, Thinking-Level `high`).

## Lizenz

[MIT](./LICENSE)
