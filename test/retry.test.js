// The retries on transient API errors, checked against behavior rather than
// against the constant: whether the list contains a given code says nothing on
// its own, what matters is that it reaches the client at all. Without the
// httpOptions in getClient() the configuration has no effect and every claim
// about it stays true anyway.
//
// The global fetch is replaced for that (mockFetch in helpers.js). The SDK calls
// it directly in apiCall(), so the number of calls IS the number of attempts.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { RETRY_OPTIONS, SERVER_DEADLINE_SECONDS, runSearch } from "../gemini.js";
import { errorResponse, mockFetch, okResponse } from "./helpers.js";

process.env.GEMINI_API_KEY = "test-key-never-sent";

const SEARCH = { query: "irrelevant", model: "gemini-test", thinkingLevel: "low" };

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

test("retries a 503 and returns the second attempt's response", async () => {
  // The only case that covers the wiring: without httpOptions.retryOptions on
  // the client the SDK repeats NOTHING - apiCall() starts with
  // "if (!retryOptions) return fetch(...)" - so the second call never happens
  // and the 503 reaches the user.
  //
  // 503 is the only error ever observed here: three times in a row within one
  // minute, each "high demand ... usually temporary".
  //
  // This case waits a real one to two seconds, the SDK's first backoff
  // (initialDelay 1s, jitter between factor 1 and 2). That is the price of
  // checking behavior instead of an object literal.
  const calls = mockFetch(() => errorResponse(503, "UNAVAILABLE"), okResponse);

  const result = await runSearch(SEARCH);

  assert.equal(calls.length, 2, "the 503 should have been retried");
  assert.match(result, /^answer/);
});

test("does not retry a 429 but reports it immediately", async () => {
  // Google's default would be [408, 429, 500, 502, 503, 504]; aligning the list
  // with it makes the configuration worse without being noticed, because on 429
  // the API names the wait itself (RetryInfo.retryDelay), the SDK does not read
  // it and would burn its four attempts before the block expires. See
  // RETRY_OPTIONS in gemini.js.
  const calls = mockFetch(() => errorResponse(429, "RESOURCE_EXHAUSTED"));

  await assert.rejects(() => runSearch(SEARCH));

  assert.equal(calls.length, 1, "429 must not be retried");
});

test("does not retry a 504 because that is the server's own deadline", async () => {
  // The second code missing from Google's default list. Since this server sends
  // a deadline along, a 504 usually is that deadline, and then every retry means
  // another full generation that is billed without ever arriving. See
  // RETRY_OPTIONS in gemini.js.
  const calls = mockFetch(() => errorResponse(504, "DEADLINE_EXCEEDED"));

  await assert.rejects(() => runSearch(SEARCH));

  assert.equal(calls.length, 1, "504 must not be retried");
});

test("sends the deadline without losing the default headers", async () => {
  // Two things in one case because they belong together: the deadline has to
  // arrive, and it must not replace the SDK's headers. httpOptions are merged
  // via Object.assign; were that wrong, content-type and user-agent would be
  // missing here and the request would fail at the server unnoticed.
  const calls = mockFetch(okResponse);

  await runSearch(SEARCH);

  const headers = new Headers(calls[0].init.headers);
  assert.equal(headers.get("x-server-timeout"), String(SERVER_DEADLINE_SECONDS));
  assert.equal(headers.get("content-type"), "application/json");
  assert.ok(headers.get("user-agent"), "the SDK's user-agent must be preserved");
});

test("does not retry what cannot fix itself", async () => {
  // 400 (broken request), 403 (key) and 404 (model withdrawn) fail the same way
  // on the second try. Google's own recommendation: "Do not retry on client
  // errors (like 400 or 403)."
  for (const [code, status] of [
    [400, "INVALID_ARGUMENT"],
    [403, "PERMISSION_DENIED"],
    [404, "NOT_FOUND"],
  ]) {
    const calls = mockFetch(() => errorResponse(code, status));

    await assert.rejects(() => runSearch(SEARCH));

    assert.equal(calls.length, 1, `${code} must not be retried`);
  }
});

test("caps the number of attempts", async () => {
  // The only value checked against the constant instead of against behavior:
  // waiting out four attempts takes 7 to 14 seconds with the SDK backoffs, and
  // that time is an assurance about Google's timers, not about this server.
  //
  // The cap is the wait the client sits through without any signal: attempts
  // counts the first try, and the SDK default would be 5.
  assert.equal(RETRY_OPTIONS.attempts, 4);
});
