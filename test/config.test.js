// Behavior with a configuration file that cannot be read. The fall back to the
// defaults stays, it is only no longer kept quiet.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { configFile, freshConfigHome, runCli } from "./helpers.js";

/**
 * Creates a config.json the defaults have to stand in for. The default content
 * is what the file looks like after an interrupted write.
 */
function withBrokenConfig(content = '{ "model": "gemini-x"') {
  const configHome = freshConfigHome();
  const file = configFile(configHome);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
  return configHome;
}

test("warns exactly once when the configuration is unreadable", () => {
  const result = runCli(["config"], { configHome: withBrokenConfig() });

  assert.equal(result.status, 0, "the defaults still carry the call");
  // Exactly once: readConfig() runs twice per call, once for the model and once
  // for the thinking level. Two lines would look like two errors.
  assert.equal((result.stderr.match(/Warning:/g) ?? []).length, 1);
  assert.match(result.stderr, /could not be read/);
});

test("names the affected file's path in the warning", () => {
  const configHome = withBrokenConfig();
  const result = runCli(["config"], { configHome });

  assert.ok(
    result.stderr.includes(configFile(configHome)),
    `path missing from the warning: ${result.stderr}`,
  );
});

test("writes the warning to stderr and never to stdout", () => {
  // In the MCP server the JSON-RPC protocol runs over stdout, and one line there
  // destroys the connection to the client. That is the reason for console.error
  // in config.js.
  const result = runCli(["config"], { configHome: withBrokenConfig() });

  assert.doesNotMatch(result.stdout, /Warning/);
  // The fall back itself is unchanged: the built-in defaults.
  assert.match(result.stdout, /gemini-flash-latest/);
  assert.match(result.stdout, /medium/);
});

test("stays silent as long as there is no configuration at all", () => {
  // The normal case before the first set-model, where a warning would be wrong.
  const result = runCli(["config"], { configHome: freshConfigHome() });

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
});

test("leaves an unreadable configuration untouched instead of overwriting it", () => {
  // Writing on top of the defaults would replace every value in the broken file
  // with the single one just set - the only path that loses data.
  const configHome = withBrokenConfig();
  const before = readFileSync(configFile(configHome), "utf8");
  const result = runCli(["set-thinking", "high"], { configHome });

  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stdout, /Saved/);
  assert.match(result.stderr, /^Error: .*could not be read .*nothing was saved/m);
  assert.equal(readFileSync(configFile(configHome), "utf8"), before);
});

test("treats a configuration that is no JSON object as unreadable", () => {
  for (const content of ["null", "[]", "42"]) {
    const configHome = withBrokenConfig(content);

    const shown = runCli(["config"], { configHome });
    assert.equal(shown.status, 0, `config with ${content}`);
    assert.match(shown.stderr, /not a JSON object/);
    assert.match(shown.stdout, /gemini-flash-latest · medium/);

    // JSON.stringify drops properties set on an array, so "[]" used to report a
    // save that never happened.
    const saved = runCli(["set-thinking", "low"], { configHome });
    assert.equal(saved.status, 1, `set-thinking with ${content}`);
    assert.equal(readFileSync(configFile(configHome), "utf8"), content);
  }
});
