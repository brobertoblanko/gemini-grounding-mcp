// Handling of the command-line options, against the rule that an option either
// has an effect or raises an error, but never lapses silently.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { configFile, freshConfigHome, runCli } from "./helpers.js";

const { version } = createRequire(import.meta.url)("../package.json");

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
  assert.match(disabled.stdout, /Backup:\s+off$/m);
});

test("names the complete state after every save", () => {
  // The confirmation line says what changed; only these lines say what the
  // next search runs with. Without them every set command needs a "config" sent
  // after it.
  const { configHome } = runCli(["set-model", "gemini-x", "--thinking", "high"]);
  const result = runCli(["set-backup", "gemini-y"], { configHome });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Saved - /m, "what was written");
  assert.match(result.stdout, /^Default:  gemini-x · high$/m, "and what it runs with from now on");
  assert.match(result.stdout, /^Backup:   gemini-y · high \(inherited\)$/m);
  assert.match(result.stdout, /^Deadline: 300 s$/m, "the deadline is part of the state");
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

test("reports a missing API key without a stack trace", () => {
  // The first call of a fresh installation, and the one error nobody caused by
  // mistyping. The check sits in cli.js so it never reaches the catch there,
  // which prints everything that is not a UsageError with its full stack.
  const result = runCli(["what is an mcp server"], { apiKey: null });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /GEMINI_API_KEY is not set/);
  assert.doesNotMatch(result.stderr, /^\s+at /m, "the message carries it, not a stack");
});

test("names the same missing key in config", () => {
  // Same cause, same CLI - the two must not answer at different quality.
  const result = runCli(["config"], { apiKey: null });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /API key:  NOT SET/);
});

test("reports the version under all three spellings", () => {
  // "--version" needs its own exemption in the unknown-option filter, which
  // runs before the switch and would otherwise reject it before "-v" or
  // "version" ever reach a case.
  for (const arg of ["version", "--version", "-v"]) {
    const result = runCli([arg]);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `${version}\n`);
  }
});

test("names the version in config", () => {
  const result = runCli(["config"]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`Version:  ${version}$`, "m"));
});

test("requires a backup model before its level can be set", () => {
  // A level without a model has nothing to refer to, and "off" no longer has one.
  // Both messages come from config.js and read the same over MCP; the check used
  // to sit here in the CLI, and gemini-set-config let the same input through.
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

test("saves a deadline and reports it", () => {
  const result = runCli(["set-deadline", "120"]);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.savedConfig(), { deadlineSeconds: 120 });
  assert.match(result.stdout, /^Saved - Deadline: 120 s$/m);
  assert.match(result.stdout, /^Deadline: 120 s$/m);
});

test("switches the deadline off with false, not by deleting it", () => {
  // Deleting would bring back the default of 300 s - the opposite of "off".
  const result = runCli(["set-deadline", "off"]);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.savedConfig(), { deadlineSeconds: false });
  assert.match(result.stdout, /^Deadline: none \(Google's own limit applies\)$/m);
});

test("rejects a deadline that is not a positive whole number", () => {
  // "1e3" and "300.5" are numbers to Number(), and " 300" is one after
  // trimming - each would be stored as something nobody typed.
  for (const value of ["0", "-5", "300.5", "1e3", " 300", "abc", "false"]) {
    const result = runCli(["set-deadline", value]);

    assert.equal(result.status, 1, `"${value}" must be rejected`);
    assert.match(result.stderr, /Invalid deadline/);
    assert.deepEqual(result.savedConfig(), {}, "nothing is written on an error");
  }
});

test("warns about an unusable deadline in a hand-edited file", () => {
  // Unlike an unknown model, a deadline nobody applies shows nowhere: the search
  // would simply run under a different limit than the one in the file.
  const configHome = freshConfigHome();
  mkdirSync(path.dirname(configFile(configHome)), { recursive: true });
  writeFileSync(configFile(configHome), JSON.stringify({ deadlineSeconds: "600" }));

  const result = runCli(["config"], { configHome });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /deadlineSeconds .* must be a positive whole number or false/);
  assert.match(result.stdout, /^Deadline: 300 s$/m, "the default applies instead");
});

test("frames every usage error and points syntax errors at the help", () => {
  const syntax = runCli(["models", "--al"]);
  assert.equal(syntax.status, 1);
  assert.equal(
    syntax.stderr,
    'Error: Unknown option "--al".\nRun "gemini-grounding help" for usage.\n',
  );

  // A wrong argument count names the command's own usage rather than all of it.
  const count = runCli(["set-model"]);
  assert.match(count.stderr, /^Error: .*\nUsage: gemini-grounding set-model /);

  // An error about the values says what to do by itself.
  const value = runCli(["set-deadline", "0"]);
  assert.match(value.stderr, /^Error: Invalid deadline/);
  assert.doesNotMatch(value.stderr, /help/);
});

test("prints the help without an error frame when called without arguments", () => {
  const result = runCli([]);

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /^gemini-grounding - /);
});

test("shows a runtime error as one line, and its stack only on --debug", () => {
  // A file where the configuration directory belongs makes the write fail
  // without any network involved.
  const blocker = path.join(freshConfigHome(), "not-a-directory");
  writeFileSync(blocker, "");

  // Matched at the end, not the start: on Linux the read fails first with
  // ENOTDIR and prints the unreadable-file warning, on Windows it fails with
  // ENOENT and stays silent.
  const plain = runCli(["set-model", "gemini-x"], { configHome: blocker });
  assert.equal(plain.status, 1);
  assert.match(plain.stderr, /^Error: .+\nRun again with --debug for the full stack trace\.\n$/m);
  assert.doesNotMatch(plain.stderr, /^\s+at /m);

  const debug = runCli(["set-model", "gemini-x", "--debug"], { configHome: blocker });
  assert.equal(debug.status, 1);
  assert.match(debug.stderr, /^Error: /m);
  assert.match(debug.stderr, /^\s+at /m);
});

test("accepts --debug only where a runtime error can occur", () => {
  const result = runCli(["config", "--debug"]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /"config" takes no --debug option/);
});

test("ignores an empty or relative XDG_CONFIG_HOME and APPDATA", () => {
  // The XDG spec says to ignore such values. Taken as they are, the file would
  // move with the working directory, and every place the server is started
  // from would get its own configuration.
  for (const value of ["", "relative/dir"]) {
    const result = runCli(["config"], { env: { XDG_CONFIG_HOME: value, APPDATA: value } });
    const configPath = result.stdout.match(/^Config: +(.+)$/m)?.[1];

    assert.ok(path.isAbsolute(configPath), `"${value}" gave ${configPath}`);
  }
});
