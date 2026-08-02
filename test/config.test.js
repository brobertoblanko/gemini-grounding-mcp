// Verhalten bei einer Konfigurationsdatei, die sich nicht lesen laesst. Der
// Rueckfall auf die Defaults bleibt - er wird nur nicht mehr verschwiegen.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { configFile, freshConfigHome, runCli } from "./helpers.js";

/** Legt eine config.json an, deren Inhalt kein gueltiges JSON ist. */
function withBrokenConfig() {
  const configHome = freshConfigHome();
  const file = configFile(configHome);
  mkdirSync(path.dirname(file), { recursive: true });
  // So sieht die Datei nach einem abgebrochenen Schreibvorgang aus.
  writeFileSync(file, '{ "model": "gemini-x"');
  return configHome;
}

test("warnt genau einmal, wenn die Konfiguration unlesbar ist", () => {
  const result = runCli(["config"], { configHome: withBrokenConfig() });

  assert.equal(result.status, 0, "die Defaults tragen den Aufruf weiterhin");
  // Genau einmal: readConfig() laeuft pro Aufruf zweimal, einmal fuer das
  // Modell und einmal fuer das Thinking-Level. Zwei Zeilen saehen nach zwei
  // Fehlern aus.
  assert.equal((result.stderr.match(/Warning:/g) ?? []).length, 1);
  assert.match(result.stderr, /could not be read/);
});

test("nennt in der Warnung den Pfad der betroffenen Datei", () => {
  const configHome = withBrokenConfig();
  const result = runCli(["config"], { configHome });

  assert.ok(
    result.stderr.includes(configFile(configHome)),
    `Pfad fehlt in der Warnung: ${result.stderr}`,
  );
});

test("schreibt die Warnung nach stderr und niemals nach stdout", () => {
  // Ueber stdout laeuft beim MCP-Server das JSON-RPC-Protokoll. Eine Zeile
  // dort zerstoert die Verbindung zum Client - das ist der eigentliche Grund
  // fuer console.error in config.js.
  const result = runCli(["config"], { configHome: withBrokenConfig() });

  assert.doesNotMatch(result.stdout, /Warning/);
  // Der Rueckfall selbst ist unveraendert: die eingebauten Defaults.
  assert.match(result.stdout, /gemini-flash-latest/);
  assert.match(result.stdout, /medium/);
});

test("schweigt, solange es noch gar keine Konfiguration gibt", () => {
  // Der Normalfall vor dem ersten set-model. Eine Warnung waere hier falsch.
  const result = runCli(["config"], { configHome: freshConfigHome() });

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
});
