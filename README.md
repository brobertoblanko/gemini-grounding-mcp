# gemini-grounding-mcp

Minimaler, eigener MCP-Server, der Claude Code Zugriff auf Google-Websuche
über die Gemini API mit Grounding gibt. Nutzt ausschließlich die offiziellen
SDKs `@google/genai` und `@modelcontextprotocol/sdk` — kein Community-Paket,
kein automatischer Versionswechsel im Hintergrund.

**Nutzungsrahmen:** Ausschließlich für Research- und Rechercheanfragen. Kein
produktiver Einsatz, keine Anbindung an sensible Systeme.

Details zu Architektur und Entscheidungen: siehe [CLAUDE.md](./CLAUDE.md).

## Installation

```powershell
npm install
```

## Registrierung bei Claude Code

```powershell
claude mcp add gemini-grounding -s user `
  -e 'GEMINI_API_KEY=${GEMINI_API_KEY}' `
  -- node <path-to-repo>\index.js
```

`<path-to-repo>` durch den tatsächlichen absoluten Pfad zu diesem geklonten
Repository ersetzen (z. B. `C:\Users\<name>\Projects\gemini-grounding-mcp`) —
`claude mcp add` benötigt einen konkreten, auf dem jeweiligen Rechner
auflösbaren Pfad zu `index.js`, um den Server per stdio zu starten.

Der API-Key wird ausschließlich über die Umgebungsvariable `GEMINI_API_KEY`
übergeben, niemals im Code oder in `config.json` hinterlegt. Die Referenz
`${GEMINI_API_KEY}` (in einfachen Anführungszeichen, damit PowerShell sie nicht
selbst auflöst) wird von Claude Code beim Laden der Konfiguration aus der
bereits gesetzten OS-Umgebungsvariable expandiert — dadurch landet in
`~/.claude.json` nur der Platzhalter, nicht der Key im Klartext.
Voraussetzung: `GEMINI_API_KEY` muss vorab als persistente
Windows-Umgebungsvariable (User-Scope) gesetzt sein.

## Tools

- **`gemini-search`** — Recherche via Google Search, URL Context und Code
  Execution in einem Aufruf. Antwort enthält Quellenliste und Token-Footer.
- **`gemini-list-models`** — Listet die für den API-Key verfügbaren Modelle.
- **`gemini-set-model`** — Legt Standardmodell und/oder Standard-Thinking-Level
  dauerhaft in `config.json` fest (nur diese beiden Werte, niemals der API-Key).
