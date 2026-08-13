// Behavior with a configuration file that cannot be read. The fall back to the
// defaults stays, it is only no longer kept quiet.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { configFile, freshConfigHome, runCli } from "./helpers.js";

/** Creates a config.json whose content is not valid JSON. */
function withBrokenConfig() {
  const configHome = freshConfigHome();
  const file = configFile(configHome);
  mkdirSync(path.dirname(file), { recursive: true });
  // This is what the file looks like after an interrupted write.
  writeFileSync(file, '{ "model": "gemini-x"');
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
