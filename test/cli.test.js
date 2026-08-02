// Behandlung der Optionen auf der Kommandozeile. Geprueft wird die Regel, dass
// eine Option entweder eine Wirkung hat oder einen Fehler ausloest - nie aber
// stillschweigend verfaellt.

import { test } from "node:test";
import assert from "node:assert/strict";
import { runCli } from "./helpers.js";

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
