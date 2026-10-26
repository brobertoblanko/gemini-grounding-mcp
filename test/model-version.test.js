// The 🤖 field against response.modelVersion, checked through runSearch with a
// replaced fetch, so the field arrives the way the SDK parses it.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { runSearch } from "../gemini.js";
import { errorResponse, mockFetch } from "./helpers.js";

process.env.GEMINI_API_KEY = "test-key-never-sent";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** The smallest successful response, answered by the given model version. */
const answeredBy = (modelVersion) => () =>
  new Response(
    JSON.stringify({
      candidates: [{ content: { parts: [{ text: "answer" }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
      ...(modelVersion && { modelVersion }),
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

const call = (model, overrides = {}) => ({
  query: "irrelevant",
  model,
  thinkingLevel: "low",
  ...overrides,
});

test("names the routed model next to the requested one", async () => {
  // Measured 2026-10-26: a deprecated id answers without an error under its
  // successor's name. Without the arrow the footer names a model that never ran.
  mockFetch(answeredBy("gemini-3.8-flash"));

  const result = await runSearch(call("gemini-3.7-flash"));

  assert.match(result, /🤖 gemini-3\.7-flash → gemini-3\.8-flash \(thinking: low\)/);
});

test("adds nothing when the requested model answered itself", async () => {
  mockFetch(answeredBy("gemini-3.8-flash"));

  const result = await runSearch(call("gemini-3.8-flash"));

  assert.match(result, /🤖 gemini-3\.8-flash \(thinking: low\)/);
  assert.doesNotMatch(result, /→/);
});

test("adds nothing when the response carries no model version", async () => {
  mockFetch(answeredBy(undefined));

  const result = await runSearch(call("gemini-flash-latest"));

  assert.match(result, /🤖 gemini-flash-latest \(thinking: low\)/);
  assert.doesNotMatch(result, /→/);
});

test("compares against the backup after a fallback", async () => {
  mockFetch(() => errorResponse(404, "NOT_FOUND"), answeredBy("gemini-backup"));

  const result = await runSearch(call("gemini-primary", { backupModel: "gemini-backup" }));

  assert.match(result, /🤖 gemini-backup \(thinking: low\)/);
  assert.doesNotMatch(result, /→/);
});
