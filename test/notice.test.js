// The closing notice and the code execution part, checked through runSearch with
// a replaced fetch, so both arrive the way the SDK parses them.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { runSearch } from "../gemini.js";
import { mockFetch } from "./helpers.js";

process.env.GEMINI_API_KEY = "test-key-never-sent";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** A successful response with the given body fields. */
const respond = (body) => () =>
  new Response(
    JSON.stringify({ usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 }, ...body }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

const candidate = (parts, finishReason = "STOP") => ({
  candidates: [{ content: { parts }, finishReason }],
});

const search = () =>
  runSearch({ query: "irrelevant", model: "gemini-flash-latest", thinkingLevel: "low" });

test("flags a request the API blocked", async () => {
  mockFetch(respond({ promptFeedback: { blockReason: "SAFETY" } }));

  assert.match(await search(), /Request blocked by the API - blockReason: SAFETY/);
});

test("flags a response without text", async () => {
  mockFetch(respond(candidate([], "RECITATION")));

  assert.match(await search(), /contained no text - finishReason: RECITATION/);
});

test("flags a truncated response that would otherwise look complete", async () => {
  mockFetch(respond(candidate([{ text: "The answer breaks off mid" }], "MAX_TOKENS")));

  const result = await search();

  assert.match(result, /The answer breaks off mid/);
  assert.match(result, /incomplete - finishReason: MAX_TOKENS/);
});

test("adds no notice to a regular completion", async () => {
  mockFetch(respond(candidate([{ text: "answer" }])));

  assert.doesNotMatch(await search(), /⚠️/);
});

test("appends executed code and its result after the answer text", async () => {
  mockFetch(
    respond(
      candidate([
        { text: "The sum is 3." },
        { executableCode: { language: "PYTHON", code: "print(1 + 2)\n" } },
        { codeExecutionResult: { outcome: "OUTCOME_OK", output: "3\n" } },
      ]),
    ),
  );

  const result = await search();

  assert.ok(
    result.includes(
      "The sum is 3.\n\nCode execution:\n\n```python\nprint(1 + 2)\n```\n\nResult (OK):\n```\n3\n```",
    ),
    result,
  );
});

test("leaves the language tag off when the API names none", async () => {
  mockFetch(
    respond(
      candidate([
        { text: "answer" },
        { executableCode: { language: "LANGUAGE_UNSPECIFIED", code: "x = 1" } },
      ]),
    ),
  );

  assert.match(await search(), /Code execution:\n\n```\nx = 1\n```/);
});
