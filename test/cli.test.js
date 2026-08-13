// Handling of the command-line options, against the rule that an option either
// has an effect or raises an error, but never lapses silently.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { configFile, freshConfigHome, runCli } from "./helpers.js";

test("saves model and thinking level in one call", () => {
  const result = runCli(["set-model", "gemini-x", "--thinking", "low"]);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.savedConfig(), { model: "gemini-x", thinkingLevel: "low" });
  // The confirmation must name both: what was saved without saying so is
  // indistinguishable from a discarded option.
  assert.match(result.stdout, /Model: gemini-x/);
  assert.match(result.stdout, /Thinking level: low/);
});

test("saves both the mirrored way from set-thinking", () => {
  const result = runCli(["set-thinking", "high", "--model", "gemini-y"]);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.savedConfig(), { model: "gemini-y", thinkingLevel: "high" });
});

test("names only the value that was actually saved", () => {
  const result = runCli(["set-model", "gemini-z"]);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.savedConfig(), { model: "gemini-z" });
  assert.doesNotMatch(result.stdout, /Thinking level/);
});

test("aborts when set-model names two models", () => {
  const result = runCli(["set-model", "gemini-a", "--model", "gemini-b"]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /--model/);
  assert.deepEqual(result.savedConfig(), {}, "nothing is written on an error");
});

test("aborts when an option has no effect for the command", () => {
  const result = runCli(["config", "--thinking", "low"]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /--thinking/);
});

test("checks the options before an API call comes about", () => {
  // "models" is the only command that would go to the API without the check. The
  // message has to name the option and must not be an API error.
  const result = runCli(["models", "--model", "gemini-x"]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /--model/);
  assert.doesNotMatch(result.stderr, /ApiError/);
});

test("does not let --all pass as a search query", () => {
  const result = runCli(["what is an mcp server", "--all"]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /--all/);
});

test("saves the backup with its own thinking level", () => {
  const result = runCli(["set-backup", "gemini-x", "--thinking", "low"]);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.savedConfig(), {
    backupModel: "gemini-x",
    backupThinkingLevel: "low",
  });
});

test("removes the level when set-backup runs without --thinking", () => {
  // The backup is written as a UNIT, unlike set-model and set-thinking, see
  // setSavedConfig in config.js.
  const { configHome } = runCli(["set-backup", "gemini-x", "--thinking", "high"]);
  const result = runCli(["set-backup", "gemini-y"], { configHome });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.savedConfig(), { backupModel: "gemini-y" });
  assert.match(result.stdout, /inherited/);
});

test("switches the backup off with off instead of forgetting it", () => {
  // false and not deleted, so the difference between "never set" and
  // "deliberately switched off" stays in the file.
  const { configHome } = runCli(["set-backup", "gemini-x"]);
  const result = runCli(["set-backup", "off"], { configHome });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.savedConfig(), { backupModel: false });
});

test("accepts no thinking level for a switched-off backup", () => {
  const result = runCli(["set-backup", "off", "--thinking", "low"]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /switched off/);
  assert.deepEqual(result.savedConfig(), {});
});

test("prevents default and backup from becoming the same model", () => {
  // From both sides, because silently there would be no fallback left afterwards.
  const { configHome } = runCli(["set-model", "gemini-x"]);

  const asBackup = runCli(["set-backup", "gemini-x"], { configHome });
  assert.equal(asBackup.status, 1);
  assert.match(asBackup.stderr, /already the default model/);

  runCli(["set-backup", "gemini-y"], { configHome });
  const asDefault = runCli(["set-model", "gemini-y"], { configHome });
  assert.equal(asDefault.status, 1);
  assert.match(asDefault.stderr, /currently the backup model/);
});

test("checks the collision on the detour via set-thinking as well", () => {
  // The third write path, and the only one that lacked the check before:
  // "set-thinking low --model <backup>" saves a model just like "set-model". That
  // is why the check now sits at the shared write site.
  const { configHome } = runCli(["set-model", "gemini-x"]);
  runCli(["set-backup", "gemini-y"], { configHome });

  const result = runCli(["set-thinking", "low", "--model", "gemini-y"], { configHome });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /currently the backup model/);
  assert.deepEqual(
    result.savedConfig(),
    { model: "gemini-x", backupModel: "gemini-y" },
    "on an error nothing is written, not even the level",
  );
});

test("lets a command without a model through, even with a colliding file", () => {
  // A hand-edited file is a state "set-thinking low" did not cause; it must not
  // fail on it and thereby block repairing the level.
  const configHome = freshConfigHome();
  const file = configFile(configHome);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ model: "gemini-x", backupModel: "gemini-x" }));

  const result = runCli(["set-thinking", "high"], { configHome });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.savedConfig().thinkingLevel, "high");
});

test("shows all three backup states in config", () => {
  const nothing = runCli(["config"]);
  assert.match(nothing.stdout, /Backup:\s+not set/);

  const { configHome } = runCli(["set-backup", "gemini-x"]);
  const inherited = runCli(["config"], { configHome });
  // For an inherited level the value is shown and not just "inherited": what the
  // backup would step in with is the information that matters.
  assert.match(inherited.stdout, /Backup:\s+gemini-x · medium \(inherited\)/);

  runCli(["set-backup", "gemini-x", "--thinking", "minimal"], { configHome });
  const own = runCli(["config"], { configHome });
  assert.match(own.stdout, /Backup:\s+gemini-x · minimal$/m, "an own level inherits nothing");

  runCli(["set-backup", "off"], { configHome });
  const disabled = runCli(["config"], { configHome });
  assert.match(disabled.stdout, /Backup:\s+disabled/);
});

test("names the complete state after every save", () => {
  // The confirmation line says what changed; only these two lines say what the
  // next search runs with. Without them every set command needs a "config" sent
  // after it.
  const { configHome } = runCli(["set-model", "gemini-x", "--thinking", "high"]);
  const result = runCli(["set-backup", "gemini-y"], { configHome });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Saved - /m, "what was written");
  assert.match(result.stdout, /^Primary: gemini-x · high$/m, "and what it runs with from now on");
  assert.match(result.stdout, /^Backup:  gemini-y · high \(inherited\)$/m);
});

test("changes the saved backup's level without naming the model", () => {
  // Otherwise the model has to be typed again to adjust its level, and a typo
  // while doing so silently hits a different model.
  const { configHome } = runCli(["set-backup", "gemini-x", "--thinking", "high"]);
  const result = runCli(["set-backup", "--thinking", "minimal"], { configHome });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.savedConfig(), {
    backupModel: "gemini-x",
    backupThinkingLevel: "minimal",
  });
});

test("requires a backup model before its level can be set", () => {
  // A level without a model has nothing to refer to, and "off" no longer has one.
  // Both messages come from config.js and read the same over MCP; the check used
  // to sit here in the CLI, and gemini-set-model let the same input through.
  const bare = runCli(["set-backup", "--thinking", "low"]);
  assert.equal(bare.status, 1);
  assert.match(bare.stderr, /no backup model is set/);
  assert.deepEqual(bare.savedConfig(), {});

  const { configHome } = runCli(["set-backup", "off"]);
  const disabled = runCli(["set-backup", "--thinking", "low"], { configHome });
  assert.equal(disabled.status, 1);
  assert.match(disabled.stderr, /switched off/, "switched off differs from never set");
  assert.deepEqual(disabled.savedConfig(), { backupModel: false });
});
