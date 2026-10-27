// The MCP interface as a client sees it, in both protocol revisions the server
// serves. Runs the real index.js over stdio; no case reaches the Gemini API.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { configFile, freshConfigHome } from "./helpers.js";

const SERVER = fileURLToPath(new URL("../index.js", import.meta.url));

const ANNOTATIONS = {
  "gemini-search": { readOnlyHint: true, openWorldHint: true },
  "gemini-list-models": { readOnlyHint: true, openWorldHint: false },
  "gemini-set-config": {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};

// "legacy" opens with a plain initialize, "auto" asks for the newest revision
// first - the same choice Claude Code makes with MCP_PROTOCOL_NEGOTIATION.
const REVISIONS = [
  ["2025-11-25", "legacy"],
  ["2026-07-28", "auto"],
];

async function connect(mode, configHome) {
  const client = new Client({ name: "mcp-test", version: "0" }, { versionNegotiation: { mode } });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [SERVER],
      // A fresh config home per connection keeps every case away from this
      // machine's real configuration; the key is a placeholder that is never sent.
      env: { ...process.env, XDG_CONFIG_HOME: configHome, GEMINI_API_KEY: "test-key-never-sent" },
    }),
  );
  return client;
}

for (const [revision, mode] of REVISIONS) {
  test(`negotiates ${revision} and lists all tools with their annotations`, async () => {
    const client = await connect(mode, freshConfigHome());
    try {
      assert.equal(client.getNegotiatedProtocolVersion(), revision);
      assert.equal(client.getServerVersion()?.name, "gemini-grounding");
      assert.ok(client.getInstructions()?.includes("gemini-set-config"), "instructions missing");

      const { tools } = await client.listTools();
      assert.deepEqual(
        Object.fromEntries(tools.map((t) => [t.name, t.annotations])),
        ANNOTATIONS,
      );
      const setConfig = tools.find((t) => t.name === "gemini-set-config");
      assert.equal(setConfig._meta?.["anthropic/requiresUserInteraction"], true);
      // Zod 4.0 and 4.1 drop .describe() texts when the SDK converts the schema.
      for (const tool of tools) {
        for (const [name, schema] of Object.entries(tool.inputSchema.properties)) {
          assert.ok(schema.description, `${tool.name}.${name} has no description`);
        }
      }
    } finally {
      await client.close();
    }
  });

  test(`gemini-set-config saves and confirms over ${revision}`, async () => {
    const configHome = freshConfigHome();
    const client = await connect(mode, configHome);
    try {
      const empty = await client.callTool({ name: "gemini-set-config", arguments: {} });
      assert.equal(empty.isError, true);
      assert.match(empty.content[0].text, /^Error in gemini-set-config: at least one of/);

      const saved = await client.callTool({
        name: "gemini-set-config",
        arguments: { model: "gemini-x", deadlineSeconds: 120 },
      });
      assert.notEqual(saved.isError, true, saved.content[0].text);
      assert.match(saved.content[0].text, /^Saved to /);
      assert.deepEqual(JSON.parse(readFileSync(configFile(configHome), "utf8")), {
        model: "gemini-x",
        deadlineSeconds: 120,
      });
    } finally {
      await client.close();
    }
  });
}

test("gemini-set-config refuses to overwrite an unreadable config.json", async () => {
  // Nobody sees the warning on stderr behind an MCP client, so the refusal has
  // to arrive as the tool's answer.
  const configHome = freshConfigHome();
  const file = configFile(configHome);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, '{ "model": "gemini-x", }');
  const client = await connect("auto", configHome);
  try {
    const result = await client.callTool({
      name: "gemini-set-config",
      arguments: { thinkingLevel: "high" },
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /^Error in gemini-set-config: could not save - .*nothing was saved/);
    assert.equal(readFileSync(file, "utf8"), '{ "model": "gemini-x", }');
  } finally {
    await client.close();
  }
});

test("rejects empty strings for query, model and backupModel", async () => {
  // An empty query costs a billed request for nothing, and an empty model is
  // saved and sent to the API on every search after it.
  const configHome = freshConfigHome();
  const client = await connect("auto", configHome);
  try {
    const calls = [
      ["gemini-search", { query: "   " }],
      ["gemini-search", { query: "x", model: "" }],
      ["gemini-set-config", { model: " " }],
      ["gemini-set-config", { backupModel: "" }],
    ];
    for (const [name, args] of calls) {
      const result = await client.callTool({ name, arguments: args });
      assert.equal(result.isError, true, `${name} ${JSON.stringify(args)}`);
    }
    assert.throws(() => readFileSync(configFile(configHome)), { code: "ENOENT" });
  } finally {
    await client.close();
  }
});

test("gemini-set-config rejects a deadline above 600 s", async () => {
  const configHome = freshConfigHome();
  const client = await connect("auto", configHome);
  try {
    const result = await client.callTool({
      name: "gemini-set-config",
      arguments: { deadlineSeconds: 601 },
    });
    assert.equal(result.isError, true);
    assert.throws(() => readFileSync(configFile(configHome)), { code: "ENOENT" });
  } finally {
    await client.close();
  }
});
