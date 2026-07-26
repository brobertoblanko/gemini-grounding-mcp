import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// Scriptrelativer Pfad, NICHT "./config.json" — das Arbeitsverzeichnis eines
// per stdio gestarteten MCP-Servers ist nicht garantiert der Projektordner.
const CONFIG_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "config.json",
);

const FALLBACK_MODEL = "gemini-flash-latest";
const FALLBACK_THINKING_LEVEL = "high";

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
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}
