// What a single call actually runs with. resolveCallConfig() is the shared
// answer for the MCP server and the CLI, and the only place that holds the rule
// that an explicitly named model gets no backup.
//
// Checkable without a network, which is the reason for the separate function:
// through the CLI this rule is observable only with a real API call.
//
// config.js fixes CONFIG_PATH once at import time, so XDG_CONFIG_HOME is set
// before the dynamic import. The file's CONTENT, in contrast, is re-read on
// every access, which is why the cases below simply rewrite it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { configFile, freshConfigHome } from "./helpers.js";

const CONFIG_HOME = freshConfigHome();
process.env.XDG_CONFIG_HOME = CONFIG_HOME;

const {
  resolveCallConfig,
  getSavedBackup,
  setSavedConfig,
  findModelCollision,
  findBackupLevelProblem,
} = await import("../config.js");

function writeConfig(config) {
  const file = configFile(CONFIG_HOME);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(config));
}

const SAVED = {
  model: "gemini-saved",
  thinkingLevel: "medium",
  backupModel: "gemini-backup",
  backupThinkingLevel: "low",
};

test("passes default and backup through when the call specifies nothing", () => {
  writeConfig(SAVED);

  assert.deepEqual(resolveCallConfig({}), {
    model: "gemini-saved",
    thinkingLevel: "medium",
    backupModel: "gemini-backup",
    backupThinkingLevel: "low",
  });
});

test("switches the backup off as soon as the call names a model", () => {
  // Whoever names a model wants that one, often precisely to check whether it is
  // reachable. An answer from a different model does not answer that question,
  // it hides it.
  writeConfig(SAVED);

  const resolved = resolveCallConfig({ model: "gemini-explicit" });

  assert.equal(resolved.model, "gemini-explicit");
  assert.equal(resolved.backupModel, undefined, "a named model gets no backup");
  assert.equal(resolved.backupThinkingLevel, undefined);
});

test("switches it off even when the named model is the default", () => {
  // The rule is syntactic: what counts is being named explicitly, not the value.
  // Otherwise the same call behaves differently depending on the saved default,
  // and the call itself does not show which way.
  writeConfig(SAVED);

  assert.equal(resolveCallConfig({ model: "gemini-saved" }).backupModel, undefined);
});

test("keeps the backup active for an explicit thinking level", () => {
  // Only the model decides about the fallback. With a level, the primary model
  // stays the saved default, and that one may fall back.
  writeConfig(SAVED);

  const resolved = resolveCallConfig({ thinkingLevel: "high" });

  assert.equal(resolved.thinkingLevel, "high");
  assert.equal(resolved.backupModel, "gemini-backup");
});

test("returns no backup when it is explicitly switched off", () => {
  writeConfig({ ...SAVED, backupModel: false });

  assert.equal(resolveCallConfig({}).backupModel, undefined);
  // For the behavior "switched off" equals "never set", for the output of
  // "config" it does not, so the difference stays readable.
  assert.deepEqual(getSavedBackup(), {
    model: undefined,
    thinkingLevel: "low",
    disabled: true,
  });
});

test("ignores unusable values in a hand-written file", () => {
  // A level the API does not know would otherwise go out on the very path meant
  // to catch an error, and come back as a 400.
  writeConfig({ ...SAVED, backupModel: "", backupThinkingLevel: "sehr hoch" });

  const resolved = resolveCallConfig({});

  assert.equal(resolved.backupModel, undefined, "an empty string is not a model");
  assert.equal(resolved.backupThinkingLevel, undefined);
});

test("drops the level when the backup model changes", () => {
  // The backup is written as a UNIT, see setSavedConfig in config.js. Without
  // that rule "gemini-neu" here carries a level somebody chose for "gemini-alt",
  // and resolveCallConfig passes it on to a fallback.
  writeConfig({});
  setSavedConfig({ backupModel: "gemini-alt", backupThinkingLevel: "high" });
  assert.equal(resolveCallConfig({}).backupThinkingLevel, "high");

  const saved = setSavedConfig({ backupModel: "gemini-neu" });

  assert.equal(resolveCallConfig({}).backupThinkingLevel, undefined);
  // The derived value comes back so that the caller's confirmation can name the
  // loss instead of hiding it.
  assert.equal(saved.backupThinkingLevel, null);
});

test("changes only the level when no backup model comes along", () => {
  // The counterpart: without backupModel the unit rule does not apply, otherwise
  // the level of a configured backup could never be changed again.
  writeConfig({});
  setSavedConfig({ backupModel: "gemini-alt", backupThinkingLevel: "high" });
  setSavedConfig({ backupThinkingLevel: "minimal" });

  assert.deepEqual(getSavedBackup(), {
    model: "gemini-alt",
    thinkingLevel: "minimal",
    disabled: false,
  });
});

test("detects the collision even when one call sets both values", () => {
  // The case only gemini-set-model can produce; the CLI has no command that
  // writes default and backup at once. What is checked is therefore the state
  // AFTER the write, not the single value against the file.
  writeConfig(SAVED);

  assert.match(
    findModelCollision({ model: "gemini-neu", backupModel: "gemini-neu" }),
    /cannot be both/,
  );
  // Setting both to DIFFERENT models at once must not fail on the old saved
  // values.
  assert.equal(findModelCollision({ model: "gemini-backup", backupModel: "gemini-saved" }), undefined);
});

test("lets a call without a model through, even with a colliding file", () => {
  // "set-thinking low" did not cause the situation and must not fail on it,
  // otherwise a hand-edited file blocks the very commands unrelated to it.
  writeConfig({ model: "gemini-gleich", backupModel: "gemini-gleich" });

  assert.equal(findModelCollision({ thinkingLevel: "low" }), undefined);
  assert.match(findModelCollision({ model: "gemini-gleich" }), /currently the backup model/);
});

test("never lets a switched-off backup collide", () => {
  writeConfig({ model: "gemini-saved", backupModel: false });

  assert.equal(findModelCollision({ model: "gemini-saved" }), undefined);
  assert.equal(findModelCollision({ backupModel: false }), undefined);
});

test("rejects a backup level without its model", () => {
  // A level belongs to exactly one model. Without that model it sits in the file
  // with no effect, and the confirmation reports a value that the state block two
  // lines later takes back as "not set".
  writeConfig({ model: "gemini-saved" });

  assert.match(findBackupLevelProblem({ backupThinkingLevel: "low" }), /no backup model is set/);
  // With a saved backup this is exactly the way to change its level without
  // naming the model again.
  writeConfig(SAVED);
  assert.equal(findBackupLevelProblem({ backupThinkingLevel: "low" }), undefined);
});

test("rejects a level for a switched-off backup", () => {
  // Two ways into the same state, and both must be recognized: the saved false
  // and the one passed in this call. Only gemini-set-model can produce the
  // second, setting model and level at once.
  writeConfig({ backupModel: false });
  assert.match(findBackupLevelProblem({ backupThinkingLevel: "low" }), /switched off/);

  writeConfig(SAVED);
  assert.match(
    findBackupLevelProblem({ backupModel: false, backupThinkingLevel: "low" }),
    /switched off/,
  );
});

test("lets the backup as a complete unit and the deletion through", () => {
  // Model and level together are the normal case and need nothing saved. null
  // deletes the level and needs no model either: the way back to "inherits from
  // the call" must stay open even when no backup is left, otherwise a remnant
  // left by hand can no longer be cleaned up.
  writeConfig({});

  assert.equal(
    findBackupLevelProblem({ backupModel: "gemini-neu", backupThinkingLevel: "high" }),
    undefined,
  );
  assert.equal(findBackupLevelProblem({ backupThinkingLevel: null }), undefined);
  assert.equal(findBackupLevelProblem({ model: "gemini-x" }), undefined);
});

test("works without any saved configuration", () => {
  writeConfig({});

  assert.deepEqual(resolveCallConfig({}), {
    model: "gemini-flash-latest",
    thinkingLevel: "medium",
    backupModel: undefined,
    backupThinkingLevel: undefined,
  });
});
