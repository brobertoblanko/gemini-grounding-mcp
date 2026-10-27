// What reaches the calling agent when a request fails. An MCP tool can return
// only one line of text, and with nothing but "fetch failed" in it the agent has
// nothing to explain to the user.

import { test } from "node:test";
import assert from "node:assert/strict";
import { describeError, formatRuntimeError } from "../gemini.js";

test("appends the cause of a real network error", async () => {
  // A REAL error from Node's fetch instead of a rebuilt one: the shape of
  // error.cause is an assumption about the runtime, and that is best checked
  // against the runtime itself. The target is 127.0.0.1 with an invalid port,
  // which Node rejects before a socket exists, so nothing goes out.
  const error = await fetch("http://127.0.0.1:1/x").catch((e) => e);

  // The reason this function exists: message alone is worthless.
  assert.equal(error.message, "fetch failed");

  const described = describeError(error);
  assert.match(described, /^fetch failed \(/);
  assert.ok(
    described.length > error.message.length,
    "the cause must be in the line, not just the general term",
  );
});

test("puts the error code first when there is one", () => {
  // Measured, not every cause carries a code ("bad port" for instance does not),
  // while ECONNREFUSED and the timeouts do. It is therefore optional and produces
  // no empty parentheses without it.
  //
  // The wording here is not invented but the case that hit this server up to
  // @google/genai 2.28: a response that takes too long. Measured against a local
  // server that accepts the request and then stays silent - Node 24.15.0 aborts
  // after 306.8 s and returns exactly these two strings. Since 2.29 the SDK
  // switches that timeout off, but any other network error takes the same shape.
  const error = new TypeError("fetch failed", {
    cause: Object.assign(new Error("Headers Timeout Error"), {
      code: "UND_ERR_HEADERS_TIMEOUT",
    }),
  });

  assert.equal(
    describeError(error),
    "fetch failed (UND_ERR_HEADERS_TIMEOUT: Headers Timeout Error)",
  );
});

test("leaves an API error unchanged", () => {
  // An ApiError carries the raw JSON body of the error response as its message
  // and therefore already holds the API's code, status and plain text. There is
  // nothing to append, and the function is not meant to rewrite anything.
  const message =
    '{"error":{"code":503,"message":"This model is currently experiencing high demand.",' +
    '"status":"UNAVAILABLE"}}';

  assert.equal(describeError(new Error(message)), message);
});

test("renders an API error as code, status and Google's text for the command line", () => {
  // The shape of an ApiError: the raw body as message, the code as status.
  const error = Object.assign(
    new Error(
      '{"error":{"code":404,"message":"models/gemini-x is not found.","status":"NOT_FOUND"}}',
    ),
    { status: 404 },
  );

  assert.equal(formatRuntimeError(error), "404 NOT_FOUND - models/gemini-x is not found.");
});

test("keeps a 429's waiting time in the command line rendering", () => {
  const body = (retryDelay) =>
    JSON.stringify({
      error: {
        code: 429,
        message: "Quota exceeded.",
        status: "RESOURCE_EXHAUSTED",
        details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay }],
      },
    });
  const error = (retryDelay) => Object.assign(new Error(body(retryDelay)), { status: 429 });

  assert.equal(
    formatRuntimeError(error("53s")),
    "429 RESOURCE_EXHAUSTED - Quota exceeded. (retry in 53 s)",
  );
  assert.equal(
    formatRuntimeError(error("0.4s")),
    "429 RESOURCE_EXHAUSTED - Quota exceeded. (retry in 1 s)",
  );
  // The MCP side keeps the raw body, waiting time included.
  assert.equal(describeError(error("53s")), body("53s"));
});

test("leaves everything that is no API error to describeError", () => {
  const network = new TypeError("fetch failed", {
    cause: Object.assign(new Error("connect refused"), { code: "ECONNREFUSED" }),
  });
  assert.equal(formatRuntimeError(network), describeError(network));

  // A status without a JSON body, and a plain Error carrying one inside its
  // text.
  const noBody = Object.assign(new Error("Bad Gateway"), { status: 502 });
  assert.equal(formatRuntimeError(noBody), "Bad Gateway");
  const both = new Error('gemini-x: {"error":{}} | backup gemini-y: {"error":{}}');
  assert.equal(formatRuntimeError(both), both.message);
});
