// Behandlung der Optionen auf der Kommandozeile. Geprueft wird die Regel, dass
// eine Option entweder eine Wirkung hat oder einen Fehler ausloest - nie aber
// stillschweigend verfaellt.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { configFile, freshConfigHome, runCli } from "./helpers.js";

test("speichert Modell und Thinking-Level in einem Aufruf", () => {
  const result = runCli(["set-model", "gemini-x", "--thinking", "low"]);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.savedConfig(), { model: "gemini-x", thinkingLevel: "low" });
  // Die Bestaetigung muss beides nennen: Was gespeichert wurde, ohne dass es
  // dasteht, ist von einer verworfenen Option nicht zu unterscheiden.
  assert.match(result.stdout, /Model: gemini-x/);
  assert.match(result.stdout, /Thinking level: low/);
});

test("speichert aus set-thinking heraus spiegelbildlich beides", () => {
  const result = runCli(["set-thinking", "high", "--model", "gemini-y"]);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.savedConfig(), { model: "gemini-y", thinkingLevel: "high" });
});

test("nennt nur den Wert, der auch wirklich gespeichert wurde", () => {
  const result = runCli(["set-model", "gemini-z"]);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.savedConfig(), { model: "gemini-z" });
  assert.doesNotMatch(result.stdout, /Thinking level/);
});

test("bricht ab, wenn set-model zwei Modelle nennt", () => {
  const result = runCli(["set-model", "gemini-a", "--model", "gemini-b"]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /--model/);
  assert.deepEqual(result.savedConfig(), {}, "nichts wird bei einem Fehler geschrieben");
});

test("bricht ab, wenn eine Option beim Befehl nichts bewirkt", () => {
  const result = runCli(["config", "--thinking", "low"]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /--thinking/);
});

test("prueft die Optionen, bevor ein API-Aufruf entsteht", () => {
  // "models" ist der einzige Befehl, der ohne die Pruefung an die API ginge.
  // Die Meldung muss die Option nennen und darf kein API-Fehler sein.
  const result = runCli(["models", "--model", "gemini-x"]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /--model/);
  assert.doesNotMatch(result.stderr, /ApiError/);
});

test("laesst --all nicht als Suchanfrage durchgehen", () => {
  const result = runCli(["was ist ein mcp server", "--all"]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /--all/);
});

test("speichert das Backup mit eigenem Thinking-Level", () => {
  const result = runCli(["set-backup", "gemini-x", "--thinking", "low"]);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.savedConfig(), {
    backupModel: "gemini-x",
    backupThinkingLevel: "low",
  });
});

test("entfernt das Level, wenn set-backup ohne --thinking laeuft", () => {
  // Das Backup wird als EINHEIT geschrieben, anders als bei set-model und
  // set-thinking: Bliebe das Level beim Wechsel des Backup-Modells liegen,
  // gaelte es stillschweigend fuer ein anderes Modell als das, fuer das es
  // gesetzt wurde.
  const { configHome } = runCli(["set-backup", "gemini-x", "--thinking", "high"]);
  const result = runCli(["set-backup", "gemini-y"], { configHome });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.savedConfig(), { backupModel: "gemini-y" });
  assert.match(result.stdout, /inherited/);
});

test("schaltet das Backup mit off ab, statt es zu vergessen", () => {
  // false und nicht geloescht: Der Unterschied zwischen "nie eingestellt" und
  // "bewusst abgeschaltet" bleibt damit in der Datei stehen.
  const { configHome } = runCli(["set-backup", "gemini-x"]);
  const result = runCli(["set-backup", "off"], { configHome });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.savedConfig(), { backupModel: false });
});

test("nimmt bei einem abgeschalteten Backup kein Thinking-Level entgegen", () => {
  const result = runCli(["set-backup", "off", "--thinking", "low"]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /switched off/);
  assert.deepEqual(result.savedConfig(), {});
});

test("verhindert, dass Standard und Backup dasselbe Modell werden", () => {
  // Von beiden Seiten, denn lautlos gaebe es danach kein Ausweichen mehr.
  const { configHome } = runCli(["set-model", "gemini-x"]);

  const asBackup = runCli(["set-backup", "gemini-x"], { configHome });
  assert.equal(asBackup.status, 1);
  assert.match(asBackup.stderr, /already the default model/);

  runCli(["set-backup", "gemini-y"], { configHome });
  const asDefault = runCli(["set-model", "gemini-y"], { configHome });
  assert.equal(asDefault.status, 1);
  assert.match(asDefault.stderr, /currently the backup model/);
});

test("prueft die Kollision auch auf dem Umweg ueber set-thinking", () => {
  // Der dritte Schreibpfad, und der einzige, der die Pruefung frueher nicht
  // hatte: "set-thinking low --model <backup>" speichert genauso ein Modell wie
  // "set-model". Deshalb sitzt sie jetzt an der gemeinsamen Schreibstelle.
  const { configHome } = runCli(["set-model", "gemini-x"]);
  runCli(["set-backup", "gemini-y"], { configHome });

  const result = runCli(["set-thinking", "low", "--model", "gemini-y"], { configHome });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /currently the backup model/);
  assert.deepEqual(
    result.savedConfig(),
    { model: "gemini-x", backupModel: "gemini-y" },
    "bei einem Fehler wird nichts geschrieben, auch nicht das Level",
  );
});

test("laesst einen Befehl ohne Modell auch bei kollidierender Datei durch", () => {
  // Eine von Hand gleichgesetzte Datei ist ein Zustand, den "set-thinking low"
  // nicht verursacht hat - er soll nicht an ihr scheitern und damit die
  // Reparatur des Levels blockieren.
  const configHome = freshConfigHome();
  const file = configFile(configHome);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ model: "gemini-x", backupModel: "gemini-x" }));

  const result = runCli(["set-thinking", "high"], { configHome });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.savedConfig().thinkingLevel, "high");
});

test("zeigt in config alle drei Zustaende des Backups", () => {
  const nothing = runCli(["config"]);
  assert.match(nothing.stdout, /Backup:\s+not set/);

  const { configHome } = runCli(["set-backup", "gemini-x"]);
  const inherited = runCli(["config"], { configHome });
  // Beim geerbten Level steht der Wert und nicht bloss "inherited": Womit das
  // Backup einspraenge, ist die Auskunft, um die es geht.
  assert.match(inherited.stdout, /Backup:\s+gemini-x · medium \(inherited\)/);

  runCli(["set-backup", "gemini-x", "--thinking", "minimal"], { configHome });
  const own = runCli(["config"], { configHome });
  assert.match(own.stdout, /Backup:\s+gemini-x · minimal$/m, "ein eigenes Level erbt nichts");

  runCli(["set-backup", "off"], { configHome });
  const disabled = runCli(["config"], { configHome });
  assert.match(disabled.stdout, /Backup:\s+disabled/);
});

test("nennt nach jedem Speichern den vollstaendigen Zustand", () => {
  // Die Bestaetigungszeile sagt, was sich geaendert hat; erst diese beiden
  // Zeilen sagen, womit die naechste Recherche laeuft. Ohne sie muesste man
  // nach jedem set-Befehl "config" hinterherschicken.
  const { configHome } = runCli(["set-model", "gemini-x", "--thinking", "high"]);
  const result = runCli(["set-backup", "gemini-y"], { configHome });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Saved - /m, "was geschrieben wurde");
  assert.match(result.stdout, /^Primary: gemini-x · high$/m, "und womit es ab jetzt laeuft");
  assert.match(result.stdout, /^Backup:  gemini-y · high \(inherited\)$/m);
});

test("aendert das Level des gespeicherten Backups, ohne das Modell zu nennen", () => {
  // Sonst muesste man das Modell erneut abtippen, um an seinem Level etwas zu
  // drehen - und ein Vertipper dabei traefe stillschweigend ein anderes Modell.
  const { configHome } = runCli(["set-backup", "gemini-x", "--thinking", "high"]);
  const result = runCli(["set-backup", "--thinking", "minimal"], { configHome });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.savedConfig(), {
    backupModel: "gemini-x",
    backupThinkingLevel: "minimal",
  });
});

test("verlangt ein Backup-Modell, bevor dessen Level gesetzt werden kann", () => {
  // Ein Level ohne Modell haette keinen Bezug - und "off" hat keines mehr.
  // Beide Meldungen kommen aus config.js und lauten ueber MCP genauso: Die
  // Pruefung lag frueher hier in der CLI, und gemini-set-model liess dieselbe
  // Eingabe durch.
  const bare = runCli(["set-backup", "--thinking", "low"]);
  assert.equal(bare.status, 1);
  assert.match(bare.stderr, /no backup model is set/);
  assert.deepEqual(bare.savedConfig(), {});

  const { configHome } = runCli(["set-backup", "off"]);
  const disabled = runCli(["set-backup", "--thinking", "low"], { configHome });
  assert.equal(disabled.status, 1);
  assert.match(disabled.stderr, /switched off/, "abgeschaltet ist etwas anderes als nie gesetzt");
  assert.deepEqual(disabled.savedConfig(), { backupModel: false });
});
