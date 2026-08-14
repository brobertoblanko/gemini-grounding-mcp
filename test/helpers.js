// Shared helpers for the tests that start the CLI as a separate process. This
// file holds no test cases, so the test script loads "test/*.test.js"
// explicitly; the default of "node --test" takes everything below test/ and
// reported this file like a test case.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../cli.js", import.meta.url));

/** An error response in the format the Gemini API returns. */
export const errorResponse = (code, status) =>
  new Response(JSON.stringify({ error: { code, message: "test", status } }), {
    status: code,
    headers: { "content-type": "application/json" },
  });

/** The smallest successful response that passes through runSearch. */
export const okResponse = () =>
  new Response(
    JSON.stringify({
      candidates: [{ content: { parts: [{ text: "answer" }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

/**
 * Replaces the global fetch with a sequence of prepared responses and returns
 * the list of calls made against it. The SDK calls fetch directly in apiCall(),
 * so the number of calls IS the number of attempts.
 *
 * Each call takes the next response; once the sequence is exhausted, the last
 * one repeats. A case aiming at permanent failure therefore need not know how
 * many attempts that takes.
 *
 * No case reaches the API: the key is a placeholder, and the replacement
 * intercepts every request before it sees the network.
 */
export function mockFetch(...responses) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return responses[Math.min(calls.length - 1, responses.length - 1)]();
  };
  return calls;
}

/** A fresh, empty directory to serve as XDG_CONFIG_HOME for one case. */
export function freshConfigHome() {
  return mkdtempSync(path.join(tmpdir(), "gemini-grounding-test-"));
}

/** Where config.js creates its file below a given XDG_CONFIG_HOME. */
export function configFile(configHome) {
  return path.join(configHome, "gemini-grounding-mcp", "config.json");
}

/**
 * Starts the CLI as a separate process and returns exit code, stdout and
 * stderr.
 *
 * The separate process is required, not a convenience: config.js fixes its path
 * once at import time, and so does the flag that limits the warning about an
 * unreadable file to a single occurrence. Every case therefore needs a fresh
 * process.
 *
 * XDG_CONFIG_HOME points at a temp directory; without that isolation every set
 * case would write into this machine's real configuration. The API key is
 * replaced by a placeholder so that no case can reach the API by accident;
 * apiKey: null removes the variable instead, for the cases about a missing key.
 */
export function runCli(
  args,
  { configHome = freshConfigHome(), apiKey = "test-key-never-sent" } = {},
) {
  const env = { ...process.env, XDG_CONFIG_HOME: configHome, GEMINI_API_KEY: apiKey };
  // Deleting and not setting to "": spawnSync turns every value into a string,
  // so null would reach the CLI as the four characters "null" and pass the check.
  if (apiKey === null) delete env.GEMINI_API_KEY;

  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env,
  });

  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    configHome,
    /** The saved configuration, or {} when none was created. */
    savedConfig() {
      try {
        return JSON.parse(readFileSync(configFile(configHome), "utf8"));
      } catch {
        return {};
      }
    },
  };
}
