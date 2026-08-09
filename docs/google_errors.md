# google_errors.md - Gemini API error codes

*Diese Seite auf [Deutsch](./google_errors.de.md).*

A reference for the errors that can reach this server: what the code means, whether it clears up on its own, whether it costs money, and how this server reacts to it.

Provenance is noted per entry.
"Measured" means: actually observed in this project and recorded in code or tests.
"Documented" means: taken from Google's troubleshooting page but never seen here.

## What an error looks like

The API answers with a JSON body that always has the same shape:

```json
{"error":{"code":503,"message":"This model is currently experiencing high demand.","status":"UNAVAILABLE"}}
```

The SDK turns this into an `ApiError`.
Its `message` is that JSON text **unchanged and in full**, and `error.status` is the number (`503`).
`describeError()` in `gemini.js` therefore passes it through untouched: code, status name and plain text are already in there.

The status name (`UNAVAILABLE`, `RESOURCE_EXHAUSTED`, ...) comes from `google.rpc.Code` and is the same across all Google APIs.
It is more reliable than the HTTP code, because several status names can share one HTTP code.

Some errors additionally carry a `details` array with a machine-readable `reason`.
That is the finest distinction available, and it is decisive in one place - see `400 INVALID_ARGUMENT` below.

An error **without** an HTTP code is not an API error but a network error: see the last section.

## Overview

| Code | Status | In short | Retry? | Backup? | Costs? |
| --- | --- | --- | --- | --- | --- |
| 400 | `INVALID_ARGUMENT` | broken request, or invalid key | no | **yes**, except on `API_KEY_INVALID` | no |
| 400 | `FAILED_PRECONDITION` | billing/region | no | yes | no |
| 401 | `UNAUTHENTICATED` | no valid key | no | no | no |
| 403 | `PERMISSION_DENIED` | key not allowed to do this | no | no | no |
| 404 | `NOT_FOUND` | model does not exist (any more) | no | **yes** | no |
| 408 | `REQUEST_TIMEOUT` | an intermediary gave up | **yes** | yes | unclear |
| 429 | `RESOURCE_EXHAUSTED` | quota exhausted | no | **yes** | no |
| 500 | `INTERNAL` | failure at Google | **yes** | yes | partly |
| 502 | `BAD_GATEWAY` | failure before Google | **yes** | yes | partly |
| 503 | `UNAVAILABLE` | model overloaded | **yes** | **yes** | no |
| 504 | `DEADLINE_EXCEEDED` | our own deadline | no | no | **yes** |
| - | `fetch failed` | connection dead | no | no | partly |

"Retry?" refers to the four attempts from `RETRY_OPTIONS` in `gemini.js`, which the SDK works through by itself.

"Backup?" refers to switching to a second model, if one is configured.
It only takes effect once the retries are exhausted, and it is a **negative list**: everything except the cases marked "no" here does fall back.
The two columns deliberately do not match, because they answer different questions - the retry asks "does waiting help?", the backup asks "can a different model be the difference?".
On `429` the answers diverge.

"Costs?" refers to tokens: whatever Google rejects **before** generation starts is rejected free of charge.
Once it starts, input tokens are billed in full and output tokens up to the actual end of the run, even if the answer no longer reaches anyone.

## The codes in detail

### 400 `INVALID_ARGUMENT` - the request itself is malformed

Documented, and recorded as non-retryable in `test/retry.test.js`.

A field is missing, a value is invalid, the format is wrong.
The most common case on this server is a model without thinking support: `Thinking level is not supported for this model.`
`runSearch()` always sends a thinking level, which is exactly what `gemini-list-models` filters on.

The second attempt fails identically.
Google's own advice: "Do not retry on client errors (like 400 or 403)."

**A backup model does apply here**, and for a good reason: that another model accepts the same request proves the request was not the problem, the model was - precisely the thinking case above.

**The one exception: an invalid API key.**
Measured, it arrives **not** as 401 or 403 but as a 400 carrying `API key not valid. Please pass a valid API key.` and the reason `API_KEY_INVALID` in `details`.
The key applies to both models, so falling back would be pointless.
Because the status code does not tell this case apart from an ordinary 400, the server checks the `reason` here as the sole exception.

### 400 `FAILED_PRECONDITION` - billing or region

Documented, never seen here.

Same HTTP code, different cause: the free tier is not available in the caller's country, the project needs an active billing account.
Distinguishable from `INVALID_ARGUMENT` only by the status name, not by the code.

**The "yes" in the backup column is deliberate, even though a fallback here is hopeless**: the cause hangs on the Cloud project, which the second model uses too - the same argument that keeps 401 and 403 out.
Three reasons for leaving it in all the same.
The case has never been measured here, and the negative list only excludes what has been.
The second attempt is rejected before generation and therefore costs nothing, so what is lost is a moment of waiting rather than tokens.
And it would take a second check below the status code: `API_KEY_INVALID` is the only one, it exists out of necessity because it hides behind an ordinary 400, and a second one would quietly turn that necessity into a habit.

### 401 `UNAUTHENTICATED` - no valid key

No key sent, or one the API does not know.
Occurs before execution and is therefore free.

Rarely arrives in this form on this server, for two reasons: if `GEMINI_API_KEY` is missing entirely, `getClient()` aborts beforehand with a message of its own, without touching the API - and a key that is present but unusable comes back as a 400, see above.

No backup, because the same key applies to the second model too.

### 403 `PERMISSION_DENIED` - the key is not allowed to do this

Documented, and recorded as non-retryable in `test/retry.test.js`.

The key exists but has no permission for this model or resource.
Typical for a key from a different Cloud project than the intended one.

No backup, for the same reason as the 401.

### 404 `NOT_FOUND` - the model does not exist (any more)

Documented, and recorded as non-retryable in `test/retry.test.js`.

Important in combination with `gemini-list-models`: **being listed is no promise that a model still answers.**
Retired models stay in the list and return 404 when used.
There is no field that would reveal this state up front.

A backup does apply here, even though the condition is permanent: the request gets through, and the footer line asks you to fix the default on **every** call.
That is more persistent than an error that flashes once and is forgotten.

### 408 `REQUEST_TIMEOUT` - an intermediary gave up

Listed in `RETRY_OPTIONS` but never observed here, and there is a reason for that.

Google itself answers a timeout with a 504, not a 408.
A request that runs into nothing is aborted by Node without any HTTP status at all.
A genuine 408 could therefore only come from a proxy or load balancer in between.
It is in the retry list for completeness: should it occur, there is no server-supplied hint to go by, and blind backoff is the only thing available.

### 429 `RESOURCE_EXHAUSTED` - quota exhausted

Documented; the SDK's behaviour around it was verified in this project and is recorded in `test/retry.test.js`.

Too many requests per minute, too many tokens per minute, or the daily quota.
The limits apply **per model and project**, not per key: another model has a counter of its own.

**Deliberately not retried** by this server.
The API supplies the waiting time itself, as `RetryInfo` in `error.details` (measured: `"retryDelay": "53s"`).
The SDK does not read it - the string `RetryInfo` does not occur anywhere in the bundle - and instead backs off blindly and exponentially.
Against a demanded 53 seconds, all four attempts would be spent after roughly 15, long before the block expires.
A 429 therefore reaches the client immediately and unchanged, instead of padding the response with waiting time that cannot help.

**For the backup it is exactly the other way round**, and this is where the two lists differ most clearly: waiting achieves nothing, switching achieves something at once, because the second model's own counter still has room.

Occurs before execution and is therefore free.

### 500 `INTERNAL` - failure at Google

Documented, never seen here.
Retried, and a backup applies afterwards.

Can also mean the input context was too long.
Unlike a 503, the generation may already have run, in which case it is billed.

### 502 `BAD_GATEWAY` - failure before Google

Not documented, never seen here, part of Google's default retry list.
Retried, and a backup applies afterwards.

An intermediary passed on an invalid response.
As with the 500, whether compute time is behind it is unclear.

### 503 `UNAVAILABLE` - the model is overloaded

**The only error ever observed on this server**: three times in a row within a minute, each with `This model is currently experiencing high demand.` and the note that this is usually temporary.

Retried, and the reason `RETRY_OPTIONS` exists at all.
Without that configuration the SDK repeats **nothing**, even though Google's documentation claims the opposite in general terms.

Two properties make it the most harmless of all errors and at the same time the most rewarding target for countermeasures:

- It comes back **immediately**, because Google rejects the request rather than processing it. Four attempts therefore cost only the backoff pauses, not four generations.
- It is **free**, because nothing was computed.

The overload is observably **model-dependent**, apparently even between an alias and the model it points to.
That is exactly where the backup model comes from: once the retries are exhausted, the same request goes to a second, pre-selected model.

### 504 `DEADLINE_EXCEEDED` - our own deadline expired

Documented, and recorded as non-retryable in `test/retry.test.js`.

On this server a 504 is usually **not** Google's overloaded gateway but the deadline the server sends itself: `X-Server-Timeout: 290` (see `SERVER_DEADLINE_SECONDS` in `gemini.js`).
After 290 seconds Google's gateway aborts the generation instead of computing on.

**Deliberately not retried**, and **no backup** applies either.
Both would mean another full generation up to the deadline, and it is billed regardless.
The two possible causes cannot be told apart here: the decision is made on the status code, long before anyone gets to see the body of the response.
Of the two, the expensive one is the more likely, so the list gives up the code.

The only error that is **certainly** billed.

### Without a code: `fetch failed`

Recorded against a real Node error in `test/errors.test.js`.

Not an API error but a network error.
Node's `fetch` calls **every** one of them `fetch failed`: refused connection, unknown host, timeout, all the same two words.
What actually happened lives solely in `error.cause`, and that would be lost, because an MCP tool can only return a single line of text.
`describeError()` therefore appends it:

```text
fetch failed (UND_ERR_HEADERS_TIMEOUT: Headers Timeout Error)
```

The most important case behind it is `UND_ERR_HEADERS_TIMEOUT`: Node severs a silent connection after **306.8 seconds** (Undici's `headersTimeout` of 300 seconds plus connection setup).
That is the shortest link in the chain, shorter than the 1800 seconds Claude Code's MCP client waits, and without the deadline header Google knows no limit at all.
That is exactly why the 290 seconds sit just below it: so Google stops before the line is cut, and the failure arrives as a 504 with a reason rather than a bare connection abort.

Whatever is generated beyond that limit can no longer be received by anyone; it is paid for all the same.
A connection that never reached Google at all - refused, unknown host, wrong port - costs nothing, which is why the table says "partly" here and 504 remains the only error that is certainly billed.
A backup therefore does not apply, just as with the 504.

A `code` is not guaranteed: measured, `ECONNREFUSED` supplies one, an invalid port does not.

## Where this lives in the code

| What | Where |
| --- | --- |
| Retry list including why codes are left out | `RETRY_OPTIONS` in `gemini.js` |
| Exceptions to the backup model | `NO_FALLBACK_STATUS` in `gemini.js` |
| The server's own deadline and its derivation | `SERVER_DEADLINE_SECONDS` in `gemini.js` |
| Preparing the message for the client | `describeError()` in `gemini.js` |
| Verified retry behaviour per code | `test/retry.test.js` |
| Verified backup behaviour per code | `test/fallback.test.js` |
| Verified error messages | `test/errors.test.js` |

How to configure the backup model and what the footer says about it: section [The optional backup model](./specs.md#the-optional-backup-model) in the specs.
