import fs from "fs";
import os from "os";
import path from "path";

// Plattformueblicher Ort fuer Nutzer-State, NICHT "./config.json" - das
// Arbeitsverzeichnis eines per stdio gestarteten MCP-Servers ist nicht
// garantiert der Projektordner. Auch nicht scriptrelativ: bei "npm install -g"
// liegt das Script in einem Verzeichnis, das der Paketmanager verwaltet und
// beim Update neu schreibt, bei "npx" in einem Cache, dessen Hash sich mit
// jeder Version aendert - die Einstellung waere dort praktisch fluechtig.
//
// Reihenfolge: XDG_CONFIG_HOME gewinnt, wenn gesetzt (Linux-Konvention und
// zugleich das Ventil fuer alle, die den Standardort nicht wollen). Sonst
// unter Windows %APPDATA%, wo Nutzer-State hingehoert - nicht ~/.config.
// macOS wird bewusst wie Linux behandelt: Der Apple-Standard waere
// ~/Library/Application Support/, aber dies ist ein Terminal-Werkzeug, und im
// Terminal sucht niemand in einem im Finder ausgeblendeten Ordner.
const CONFIG_DIR = path.join(
  process.env.XDG_CONFIG_HOME ??
    (process.platform === "win32"
      ? (process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"))
      : path.join(os.homedir(), ".config")),
  "gemini-grounding-mcp",
);

/**
 * Vollstaendiger Pfad der Konfigurationsdatei. Exportiert, weil
 * Auffindbarkeit ueber die Ausgabe entsteht und nicht ueber den Ort: MCP-Server
 * und CLI nennen den Pfad, damit niemand raten muss, wo die Einstellung liegt.
 */
export const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");

const FALLBACK_MODEL = "gemini-flash-latest";
// Bewusst "medium" und nicht "high": der Fallback greift bei jedem neuen
// Nutzer ohne config.json, und ein hoeheres Level kostet ungefragt mehr
// Thinking-Tokens. Wer mehr will, setzt es per gemini-set-model dauerhaft
// oder pro Aufruf.
const FALLBACK_THINKING_LEVEL = "medium";

/**
 * Die von der Gemini-API akzeptierten Thinking-Level - einzige Quelle fuer
 * MCP-Server und CLI, damit beide dieselben Werte zulassen. index.js macht
 * daraus die Zod-Schemas (z.enum nimmt dieses Array direkt), cli.js prueft
 * damit seine Kommandozeilenargumente.
 */
export const THINKING_LEVELS = ["minimal", "low", "medium", "high"];

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
  } catch {
    return {};
  }
}

/**
 * Liest das dauerhaft gespeicherte Standardmodell.
 * Liefert FALLBACK_MODEL, falls keine oder eine kaputte config.json existiert.
 */
export function getSavedModel() {
  return readConfig().model ?? FALLBACK_MODEL;
}

/**
 * Liest das dauerhaft gespeicherte Standard-Thinking-Level.
 * Liefert FALLBACK_THINKING_LEVEL, falls keine oder eine kaputte config.json existiert.
 */
export function getSavedThinkingLevel() {
  return readConfig().thinkingLevel ?? FALLBACK_THINKING_LEVEL;
}

/**
 * Speichert Modell und/oder Thinking-Level dauerhaft, ohne den jeweils
 * anderen gespeicherten Wert zu ueberschreiben (undefined-Felder bleiben
 * unangetastet). Enthaelt ausschliesslich diese beiden Werte, niemals den
 * API-Key oder andere sensible Daten.
 */
export function setSavedConfig({ model, thinkingLevel }) {
  const config = readConfig();
  if (model !== undefined) config.model = model;
  if (thinkingLevel !== undefined) config.thinkingLevel = thinkingLevel;
  // Nur hier im Schreibpfad angelegt, damit das Paket nichts ungefragt
  // erzeugt: Solange niemand das Modell setzt, entsteht weder Verzeichnis noch
  // Datei - readConfig() faengt die fehlende Datei bereits ab.
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}
