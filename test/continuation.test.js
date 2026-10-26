// An answer that arrives in two requests. Since @google/genai 2.29
// generateContent() resends the request on finishReason "CONTINUATION" and
// merges the answers itself; everything this server evaluates afterwards runs
// on the merged response, so that response is what these cases check - through
// the real SDK, against a replaced fetch (mockFetch in helpers.js).

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { formatContinuationNote, runSearch } from "../gemini.js";
import { mockFetch, okResponse } from "./helpers.js";

process.env.GEMINI_API_KEY = "test-key-never-sent";

const SEARCH = { query: "irrelevant", model: "gemini-test", thinkingLevel: "low" };

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

const json = (body) => () =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

/** One hop: its text, one chunk with a support over the whole text, its queries. */
const hop = ({ text, uri, queries, prompt, output, finishReason, continuationToken }) =>
  json({
    candidates: [
      {
        content: { parts: [{ text }] },
        finishReason,
        continuationToken,
        groundingMetadata: {
          groundingChunks: [{ web: { uri, title: uri } }],
          groundingSupports: [
            {
              segment: { startIndex: 0, endIndex: Buffer.byteLength(text), text },
              groundingChunkIndices: [0],
            },
          ],
          webSearchQueries: queries,
        },
      },
    ],
    usageMetadata: { promptTokenCount: prompt, candidatesTokenCount: output },
  });

test("merges two hops into one answer and says so in the footer", async () => {
  const calls = mockFetch(
    hop({
      text: "First part.",
      uri: "https://example.com/a",
      queries: ["node lts"],
      prompt: 100,
      output: 10,
      finishReason: "CONTINUATION",
      continuationToken: "token-1",
    }),
    hop({
      text: "Second part.",
      uri: "https://example.com/b",
      queries: ["node lts", "node release schedule"],
      prompt: 120,
      output: 20,
      finishReason: "STOP",
    }),
  );

  const result = await runSearch(SEARCH);

  assert.equal(calls.length, 2, "the SDK resent the request");
  assert.equal(JSON.parse(calls[1].init.body).continuationToken, "token-1");

  // Both parts, each with its marker pointing at its own source: the SDK shifts
  // partIndex and groundingChunkIndices of the second hop.
  assert.match(result, /^First part\.\[1\]\n\nSecond part\.\[2\]/);
  assert.match(result, /^\[1\] https:\/\/example\.com\/a - https:\/\/example\.com\/a$/m);
  assert.match(result, /^\[2\] https:\/\/example\.com\/b - https:\/\/example\.com\/b$/m);

  // Summed over both hops, because that is what is billed.
  assert.match(result, /🔢 220 input \/ 30 output/);
  assert.match(result, /^↪ Continued in further requests - .*\(first request: 100\)$/m);
  // The SDK concatenates the query lists; the repeated one appears once.
  assert.match(result, /^🔎 Searched: node lts · node release schedule$/m);
  // finishReason is the last hop's, so the answer is not flagged incomplete.
  assert.doesNotMatch(result, /incomplete/);
});

test("adds no line to an answer that took a single request", async () => {
  mockFetch(okResponse);

  const result = await runSearch(SEARCH);

  assert.doesNotMatch(result, /Continued/);
});

test("adds no line when the usage figures are missing", () => {
  assert.equal(formatContinuationNote(undefined), "");
  assert.equal(formatContinuationNote({ promptTokenCount: 5 }), "");
});
