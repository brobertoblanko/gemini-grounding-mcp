// Falling back to a backup model, checked throughout against behavior: how many
// requests the SDK issued, which model the second one went to, and what the
// footer says afterwards.
//
// Same basis as retry.test.js - the global fetch is replaced, so the number of
// calls IS the number of attempts.
//
// Most cases use 404: it is absent from RETRY_OPTIONS, so it is not retried and
// comes back immediately. One case uses 503, which costs real seconds and is
// needed for exactly that reason, see there.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { NO_FALLBACK_STATUS, formatFallbackNote, runSearch } from "../gemini.js";
import { errorResponse, mockFetch, okResponse } from "./helpers.js";

process.env.GEMINI_API_KEY = "test-key-never-sent";

const PRIMARY = "gemini-primary";
const BACKUP = "gemini-backup";

/** A call with a configured backup - the normal case of this file. */
const withBackup = (overrides = {}) => ({
  query: "irrelevant",
  model: PRIMARY,
  thinkingLevel: "low",
  backupModel: BACKUP,
  ...overrides,
});

/** The model an intercepted request went to - it is part of the URL. */
const modelOf = (call) => String(call.url).match(/models\/([^:]+):/)?.[1];

/** The thinking level from the body of an intercepted request. */
const thinkingOf = (call) => JSON.parse(call.init.body).generationConfig?.thinkingConfig?.thinkingLevel;

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

test("falls back to the backup and returns its response", async () => {
  const calls = mockFetch(() => errorResponse(404, "NOT_FOUND"), okResponse);

  const result = await runSearch(withBackup());

  assert.equal(calls.length, 2, "the backup should have taken over after the error");
  assert.equal(modelOf(calls[0]), PRIMARY);
  assert.equal(modelOf(calls[1]), BACKUP, "the second attempt must go to the backup");
  assert.match(result, /^answer/);
});

test("names the fallback in the footer, with the reason", async () => {
  // Without this line the response looks like any other and the user gets a
  // different model without learning about it. The 🤖 field alone is not enough:
  // it shows WHAT answered, not that something went wrong.
  mockFetch(() => errorResponse(404, "NOT_FOUND"), okResponse);

  const result = await runSearch(withBackup());

  assert.match(result, /🔁 gemini-primary does not exist \(404\)/);
  assert.match(result, /Update your default\./);
  assert.match(result, /🤖 gemini-backup/, "the footer must name the model that answered");
});

test("leaves the footer unchanged when no fallback was needed", async () => {
  // The normal case must not lengthen the footer, see formatSearchQueries in
  // gemini.js.
  mockFetch(okResponse);

  const result = await runSearch(withBackup());

  assert.doesNotMatch(result, /🔁/);
});

test("falls back only once all retries are used up", async () => {
  // 503 is the only error ever observed here, and it is in RETRY_OPTIONS, so all
  // four attempts must fail before the backup takes over; otherwise the fallback
  // skips a retry that would have helped.
  //
  // This case waits a real 7 to 14 seconds (the three SDK backoffs). That is the
  // price of checking the order against behavior instead of against a constant,
  // which is why every other case here uses 404.
  const calls = mockFetch(
    () => errorResponse(503, "UNAVAILABLE"),
    () => errorResponse(503, "UNAVAILABLE"),
    () => errorResponse(503, "UNAVAILABLE"),
    () => errorResponse(503, "UNAVAILABLE"),
    okResponse,
  );

  const result = await runSearch(withBackup());

  assert.equal(calls.length, 5, "four attempts on the primary model, then the backup");
  assert.equal(modelOf(calls[3]), PRIMARY, "the fourth attempt still belongs to the primary model");
  assert.equal(modelOf(calls[4]), BACKUP);
  assert.match(result, /🔁 gemini-primary failed \(503 UNAVAILABLE\)/);
});

test("does not fall back when no backup is configured", async () => {
  // The feature is opt-in. Without backupModel nothing changes compared to the
  // state before it existed, not even the error message.
  const calls = mockFetch(() => errorResponse(404, "NOT_FOUND"));

  await assert.rejects(
    () => runSearch(withBackup({ backupModel: undefined })),
    (error) => {
      assert.doesNotMatch(error.message, /backup/i, "without a backup there is nothing to say about one");
      return true;
    },
  );

  assert.equal(calls.length, 1);
});

test("does not fall back on 401, 403 and 504 and says why", async () => {
  // The three exceptions from NO_FALLBACK_STATUS, for two different reasons: 401
  // and 403 hang on the key, which the backup uses as well, so a second attempt
  // is hopeless; 504 is the server's own deadline, a billed generation that a
  // second attempt would double.
  //
  // The reason has to reach the user, otherwise "why did my backup not kick in?"
  // cannot be answered.
  for (const [code, status] of [
    [401, "UNAUTHENTICATED"],
    [403, "PERMISSION_DENIED"],
    [504, "DEADLINE_EXCEEDED"],
  ]) {
    const calls = mockFetch(() => errorResponse(code, status));

    await assert.rejects(
      () => runSearch(withBackup()),
      (error) => {
        assert.match(error.message, /backup not tried/, `${code} must name the reason`);
        return true;
      },
    );

    assert.equal(calls.length, 1, `${code} must not trigger a backup`);
  }
});

test("keeps the exceptions separate from the retry list", async () => {
  // The two lists look similar and answer different questions: the retry list
  // "does waiting help?", the fallback list "can another model make the
  // difference?". On 429 they diverge - no retry, but a fallback. Aligning the
  // lists later loses exactly that.
  assert.ok(!NO_FALLBACK_STATUS.includes(429), "429 must be allowed to fall back");

  const calls = mockFetch(() => errorResponse(429, "RESOURCE_EXHAUSTED"), okResponse);

  const result = await runSearch(withBackup());

  assert.equal(calls.length, 2, "the 429 must not be retried, but replaced");
  assert.match(result, /🔁 gemini-primary hit its quota \(429\)/);
});

test("does not fall back on an unusable API key", async () => {
  // Measured against the real API: an invalid key comes back as 400
  // INVALID_ARGUMENT, not as 401 or 403, so the status code alone does not
  // identify this case, and a 400 otherwise rightly triggers a fallback. It is
  // recognized by the reason in error.details.
  //
  // Without this exception the most common setup mistake of all sends a second,
  // guaranteed hopeless request and answers with the same message twice.
  const body = JSON.stringify({
    error: {
      code: 400,
      message: "API key not valid. Please pass a valid API key.",
      status: "INVALID_ARGUMENT",
      details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "API_KEY_INVALID" }],
    },
  });
  const calls = mockFetch(
    () => new Response(body, { status: 400, headers: { "content-type": "application/json" } }),
  );

  await assert.rejects(
    () => runSearch(withBackup()),
    (error) => {
      assert.match(error.message, /backup not tried: the API key is not valid/);
      return true;
    },
  );

  assert.equal(calls.length, 1);
});

test("does not fall back to the same model", async () => {
  const calls = mockFetch(() => errorResponse(404, "NOT_FOUND"));

  await assert.rejects(
    () => runSearch(withBackup({ backupModel: PRIMARY })),
    (error) => {
      assert.match(error.message, /same model as the default/);
      return true;
    },
  );

  assert.equal(calls.length, 1);
});

test("names both errors when the backup fails as well", async () => {
  // With only the second error, troubleshooting starts at the wrong model.
  const calls = mockFetch(
    () => errorResponse(404, "NOT_FOUND"),
    () => errorResponse(400, "INVALID_ARGUMENT"),
  );

  await assert.rejects(
    () => runSearch(withBackup()),
    (error) => {
      assert.match(error.message, /gemini-primary: .*404/s);
      assert.match(error.message, /backup gemini-backup: .*400/s);
      return true;
    },
  );

  assert.equal(calls.length, 2);
});

test("inherits the call's thinking level when the backup has none", async () => {
  // What is inherited is the level used for THIS call, not the saved default:
  // whoever passed "high" wants it on the fallback model too.
  const calls = mockFetch(() => errorResponse(404, "NOT_FOUND"), okResponse);

  await runSearch(withBackup({ thinkingLevel: "high" }));

  assert.equal(thinkingOf(calls[1]), "high");
});

test("uses the backup's own thinking level when one is set", async () => {
  const calls = mockFetch(() => errorResponse(404, "NOT_FOUND"), okResponse);

  const result = await runSearch(
    withBackup({ thinkingLevel: "high", backupThinkingLevel: "minimal" }),
  );

  assert.equal(thinkingOf(calls[0]), "high", "the primary model keeps its own");
  assert.equal(thinkingOf(calls[1]), "minimal");
  // The footer must show the level actually used, not the first attempt's, or it
  // states a value that never applied.
  assert.match(result, /🤖 gemini-backup \(thinking: minimal\)/);
});

test("formats the fallback line differently per error class", () => {
  // An addition only where there is something TO DO. Without that distinction a
  // permanent 404 reads like a transient outage and nobody ever corrects the
  // broken default model.
  const note = (status, statusName) => formatFallbackNote({ model: "m", status, statusName });

  assert.match(note(404), /does not exist.*Update your default/);
  assert.match(note(429), /hit its quota/);
  assert.match(note(400), /Check the thinking level/);
  assert.match(note(503, "UNAVAILABLE"), /failed \(503 UNAVAILABLE\)/);
  // Without a status name the bare number remains - no empty parentheses.
  assert.match(note(502), /failed \(502\)/);
  assert.equal(formatFallbackNote(undefined), "", "no line without a fallback");
});
