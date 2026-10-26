#!/usr/bin/env node
/**
 * End-to-end check against the real Gemini API, through the MCP protocol the
 * way Claude Code uses the server: handshake, tool list, gemini-list-models,
 * one grounded search and one deliberate error. The unit tests stop short of
 * exactly this - they run without a key and against stubbed responses, so
 * an update that changes the shape of real responses or errors passes them.
 *
 * Run by scripts/weekly-update.js before a dependency update is merged, and by
 * hand via "npm run smoke". NOT part of the server: excluded from the published
 * package by the "files" list in package.json.
 *
 * Costs one billed search per run. models.list is free, and so is the request
 * for a model that does not exist: Google rejects it with 404 before execution,
 * which is what makes the error path testable at no cost.
 *
 * INVARIANT I4 (see CLAUDE.md and docs/specs.md, "Terms compliance"): the
 * output is check names and verdicts - never the answer text, never the
 * sources. In CI GitHub keeps the log, so printing a Grounded Result there
 * would write it to disk.
 *
 * Exit codes: 0 passed, 1 broken, 75 the API was unavailable (EX_TEMPFAIL).
 * The weekly update blocks an update on 1 and simply tries again a week later
 * on 75 - an overloaded Google says nothing about the update.
 */
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { DEFAULT_DEADLINE_SECONDS } from "../config.js";
import { LOCAL_BRAKE_MARGIN_SECONDS } from "../gemini.js";

export const EXIT_PASSED = 0;
export const EXIT_BROKEN = 1;
export const EXIT_UNAVAILABLE = 75;

const SERVER = fileURLToPath(new URL("../index.js", import.meta.url));
const TOOLS = ["gemini-search", "gemini-list-models", "gemini-set-config"];

/**
 * Needs a real search to be answerable, so an answer without sources fails the
 * check instead of passing silently. Short, to keep output tokens near the floor.
 */
const QUERY = "What is the current stable version of Node.js? Answer in a single sentence.";

const MISSING_MODEL = "smoke-test-nonexistent-model";

/**
 * The revision Claude Code prefers when the server offers it. The one billed
 * search runs over this revision only; test/mcp.test.js covers both for free.
 */
const PROTOCOL_REVISION = "2026-07-28";

/** Statuses that describe Google's availability rather than this code. */
const UNAVAILABLE_STATUS = [408, 429, 500, 502, 503, 504];

/**
 * The client's own default is 60 s, while a search may legitimately run up to
 * the server's local brake - the default deadline plus its margin, 330 s. Ten
 * seconds on top, so the brake's message arrives rather than the client's.
 * Assumes the default deadline, as on CI, where no config.json exists.
 */
const CALL_TIMEOUT_MS = (DEFAULT_DEADLINE_SECONDS + LOCAL_BRAKE_MARGIN_SECONDS + 10) * 1000;

class Unavailable extends Error {}

const textOf = (result) => result.content?.find((part) => part.type === "text")?.text ?? "";

/** The HTTP status inside an error text, which carries Google's raw JSON body. */
const apiStatus = (text) => Number(text.match(/"code":\s*(\d{3})/)?.[1]) || undefined;

function check(condition, message) {
  if (!condition) throw new Error(message);
}

const call = (client, name, args) =>
  client.callTool({ name, arguments: args }, { timeout: CALL_TIMEOUT_MS });

// Messages name what is missing, never what arrived - see I4 above.
const CHECKS = [
  [
    "handshake",
    async (client) => {
      const name = client.getServerVersion()?.name;
      check(name === "gemini-grounding", `unexpected server name "${name}"`);
      const revision = client.getNegotiatedProtocolVersion();
      check(revision === PROTOCOL_REVISION, `negotiated "${revision}"`);
    },
  ],
  [
    "tools",
    async (client) => {
      const { tools } = await client.listTools();
      const missing = TOOLS.filter((tool) => !tools.some((t) => t.name === tool));
      check(missing.length === 0, `missing: ${missing.join(", ")}`);
    },
  ],
  [
    "gemini-list-models",
    async (client) => {
      const result = await call(client, "gemini-list-models", {});
      check(!result.isError, `tool error, status ${apiStatus(textOf(result)) ?? "none"}`);
      check(/^gemini-/m.test(textOf(result)), "no model in the list");
    },
  ],
  [
    "gemini-search",
    async (client) => {
      const result = await call(client, "gemini-search", { query: QUERY, thinkingLevel: "low" });
      const text = textOf(result);
      if (result.isError) {
        const status = apiStatus(text);
        // "no response within" is the local brake (LocalDeadlineError in
        // gemini.js): a silent line says nothing about the update either.
        const silent = text.includes("fetch failed") || text.includes("no response within");
        if (UNAVAILABLE_STATUS.includes(status) || silent) {
          throw new Unavailable(`API unavailable, status ${status ?? "none (network)"}`);
        }
        throw new Error(`tool error, status ${status ?? "none"}`);
      }
      const [answer, rest] = text.split("\n\nSources:\n");
      check(answer.trim(), "empty answer text");
      check(rest, "no source list");
      check(/^\[1\] /m.test(rest), "source list without entry [1]");
      check(Number(rest.match(/🔍 (\d+) sources/)?.[1]) > 0, "footer reports no sources");
      // The arrow and the model that answered appear whenever that differs from
      // the requested one - with the default alias, every time.
      check(
        /🤖 \S+( → \S+)? \(thinking: low\)/.test(rest),
        "footer without model and thinking level",
      );
    },
  ],
  [
    "error path",
    async (client) => {
      // Naming the model also disables a configured backup, so the error is
      // guaranteed to reach the client instead of being answered by the backup.
      const result = await call(client, "gemini-search", { query: "smoke test", model: MISSING_MODEL });
      const text = textOf(result);
      check(result.isError, "no error reported for a nonexistent model");
      check(text.startsWith("Error in gemini-search:"), "error text without its prefix");
      const status = apiStatus(text);
      check(status >= 400 && status < 500, `expected a 4xx status, got ${status ?? "none"}`);
    },
  ],
];

async function main() {
  if (!process.env.GEMINI_API_KEY) {
    console.error("GEMINI_API_KEY is not set.");
    return EXIT_BROKEN;
  }
  // Without env the transport passes only a minimal default environment, and
  // the server would start without the key.
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    env: { ...process.env },
  });
  const client = new Client(
    { name: "smoke-test", version: "1.0.0" },
    { versionNegotiation: { mode: "auto" } },
  );
  try {
    await client.connect(transport);
    // Sequential and stopping at the first failure: every check presupposes
    // the one before it.
    for (const [name, run] of CHECKS) {
      try {
        await run(client);
        console.log(`✔ ${name}`);
      } catch (error) {
        console.log(`✘ ${name} - ${error.message}`);
        return error instanceof Unavailable ? EXIT_UNAVAILABLE : EXIT_BROKEN;
      }
    }
    return EXIT_PASSED;
  } catch (error) {
    console.log(`✘ connect - ${error.message}`);
    return EXIT_BROKEN;
  } finally {
    await client.close();
  }
}

process.exitCode = await main();
