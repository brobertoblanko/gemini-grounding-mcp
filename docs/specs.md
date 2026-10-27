# specs.md - Architecture & Design

*Diese Seite auf [Deutsch](./specs.de.md).*

Details on the structure, the Gemini API tools in use, the response format and the technical references of the Gemini Grounding MCP server.
Working rules for Claude Code in this repository are in [CLAUDE.md](../CLAUDE.md), installation and registration in [README.md](../README.md).

## Why a custom MCP instead of an off-the-shelf npm package

Ready-made community MCP packages (for example via `npx package@latest`) pull the newest version from the npm registry on every start.
That means:

- The code being executed can change at any time without my knowledge
- There is no transparency about what the third-party code actually does
- No Google or Anthropic backing, only community maintenance of unknown quality

**Decision:** write a custom, extremely small wrapper instead, one that uses exactly two official, reputable SDKs:

- `@google/genai` - Google's official Gemini SDK
- `@modelcontextprotocol/server` - the official MCP SDK (Anthropic), server package of its 2.x line

This keeps the entire codebase local and auditable, and it changes only when I change something myself - no automatic version switch in the background.

### And published on npm all the same

Since version 1.1.0 this project is published on npm as `@brobertoblanko/gemini-grounding-mcp`, and the README recommends `npx -y` for registration.
That is precisely the mechanism the section above argues against - the objections do not disappear just because it is my own code.

Accepted deliberately, for one reason: without npm, every interested party needs a clone and an absolute path in their client configuration, which effectively excludes everyone who just wants to try the server out.
Anyone who shares the objections still has both routes - the clone route remains fully supported and documented in the README, and `npx @brobertoblanko/gemini-grounding-mcp@1.1.0` with a pinned version takes the fluidity out of `-y`.
What ships here is also inspectable: the same code as in the repository, no build step, packed via an explicit `files` list.

## Technical basis

- Node.js (22+, the oldest release still under security support), ES modules
  (`"type": "module"` in package.json)
- Communication over stdio (the standard MCP transport)
- The API key is passed exclusively through the `GEMINI_API_KEY` environment
  variable, never stored in the code

## Implementation

Implemented as flat modules without a `src/` layout and without a build step
(at this project size, `src/` brings no advantage in Node without a build step):

- `index.js` - server bootstrap, registers the three tools via
  `server.registerTool(...)` inside `createServer()` and hands that factory
  to `serveStdio` (see "Serving both protocol revisions").
- `gemini.js` - wraps the `GoogleGenAI` call including the three combined
  built-in tools, builds the source list and footer from the API response.
- `models.js` - everything about the key's model list: the filters behind
  `gemini-list-models`, the advice after a saved model, and the drift check.
- `citations.js` - inserts the citation markers into the response text. Its own
  file because this is the only code in the project that is **fully testable
  without network access and without an API key**: text and metadata go in, text
  comes out - no `getClient()`, no configuration, no randomness. Tested against
  a stored real response in `test/citations.test.js` (`npm test`, via Node's
  built-in test runner, without an additional dependency).
- `config.js` - reads and writes the persistent model choice and deadline in a `config.json`
  at the platform's conventional location for user state (see "Configuration
  file location" below). `resolveCallConfig` also lives here, the single answer
  to what a given call actually runs with, and so do `formatSavedValues` and
  `formatConfigState`, the single answer to what a save changed and what
  applies afterwards - all three shared by `index.js` and `cli.js`.
- `cli.js` - a second frontend on the same core: the same exports from
  `gemini.js` and `config.js` that `index.js` uses, reachable from the command
  line. Without an additional dependency (a `switch` over `process.argv` is
  enough), without a second home for the API key. Two deliberate differences
  from the MCP server: a runtime error is printed for a human - an `ApiError`
  as `<code> <status> - <Google's text>` through `formatRuntimeError()` in
  `gemini.js`, the full stack trace only on `--debug` - where `index.js`
  hands the client Google's raw body through `describeError()`, and output
  goes to stdout - which would be impossible with the stdio transport, because
  JSON-RPC runs over it. The stack stays behind `--debug` because it consists
  of SDK internals and carries absolute local paths into every bug report it is
  pasted into. Invocation and subcommands: see the README.

  The error would have to be caught via `try`/`catch` even with Node's own
  output: if Node terminates the process hard because of an unhandled rejection
  while a network connection is still open, libuv on Windows aborts with
  `Assertion failed ... src\win\async.c`, and the process ends with
  `0xC0000409` instead of code 1. Hence the output through `console.error` -
  on `--debug` `console.error(error)`, identical to Node's own output -
  followed by `process.exitCode = 1` rather than `process.exit()`, so that
  Node shuts down normally.

  This holds **without exception**: `cli.js` contains no `process.exit()`. A
  usage error throws a `UsageError` instead, which the same `catch` block picks
  up and prints with its message only, behind `Error:` like every other error
  - a stack trace is pointless for a typo on the command line. An error in the
  syntax of the call carries a second line with the command's usage or a
  pointer to `help`; an error about the values says what to do by itself. A second argument against `process.exit()`: on Windows,
  stdout and stderr are asynchronous on a TTY, and an immediate exit can cut off
  longer output such as the help text. Because `fail()` throws instead of
  exiting, argument parsing and the `switch` both live inside a `main()`
  function within the `try`.

  Arguments are validated strictly, because any leniency here fails silently: a
  search query must be **exactly one** argument - options are cut out of the
  argument list via `indexOf`, so a `--thinking high` in the middle of an
  unquoted question would otherwise have removed words from the query
  unnoticed. An empty argument (from an unset shell variable, say) is an error
  as well, rather than spending tokens on an empty query. Anything that still
  starts with `--` after parsing is an unknown option and aborts - `models
  --al` would otherwise have silently shown the filtered list that one takes
  for the complete one. `--help` and `--version` are the only exceptions,
  because both are handled as subcommands further down; a `case` for either in
  the `switch` would otherwise never be reached. Every subcommand rejects
  surplus arguments.

  A **known** option in the wrong place is rejected the same way. Options are
  cut from the argument list before the subcommand is known, so without a check
  no branch would notice them: `config --thinking low` used to accept the
  option and do nothing with it. Each branch therefore names the options that
  mean something to it (`allowFlags`, an allowlist so that a future option is
  not accidentally permitted everywhere), and for `models` that check runs
  before the API call, so a typo costs no request.

  The two `set-*` commands persist the respective **other** option: `set-model
  <id> --thinking <level>` saves both in one call, and `set-thinking <level>
  --model <id>` does the mirror image. Whoever asks for something to be stored
  does not want half the statement to expire. The command's own option stays an
  error - `set-model x --model y` names two models, and which one is meant only
  the caller knows. The confirmation line names every value that was written,
  so a stored value is never indistinguishable from a discarded one, and the
  stored state follows underneath (see "Reporting what was saved" below).

  The backup is the one thing that breaks that merge rule, deliberately: it is
  written **as a unit**, so naming a backup model without a level removes a
  previously stored one rather than leaving it in place. The level belongs to
  that one model - carried across a change of backup, it would silently apply
  to a model it was never chosen for. Leaving the model out and passing only a
  level is the way to change the level of the backup already stored.

  The rule sits in `setSavedConfig` rather than in `cli.js`, for the same
  reason `resolveCallConfig` does: the MCP handler writes the same file, and a
  model setting a new backup there has no reason to explicitly pass `null`. Two
  interfaces with opposing semantics on one file is not explainable later.

## Verified API facts (as of 07/2026)

These values were checked against the current Gemini API and `@google/genai` SDK documentation before implementation, so that the codebase does not build on stale training data.
The official sources are always authoritative: [Gemini API Docs](https://ai.google.dev/gemini-api/docs), [js-genai SDK](https://googleapis.github.io/js-genai/) and the [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk).

- `gemini-flash-latest` is an alias maintained by Google and currently points to
  `gemini-3.5-flash`. The alias is re-pointed automatically with every new Flash
  release.
- `thinkingLevel` enum: `minimal` | `low` | `medium` | `high`. On Flash models
  `medium` is the API default - so `high` has to be set explicitly.
- Grounding metadata lives under `response.candidates?.[0]?.groundingMetadata`
  (do not forget the array index `[0]`). Every source in `groundingChunks[i].web`
  has `uri`, `title` and `domain` (per the SDK type documentation, `domain` is
  not supported by the Gemini Developer API and is `undefined` in practice).
- Pages read via URL Context additionally report their source under
  `candidates[0].urlContextMetadata.urlMetadata[].retrievedUrl`.
- Token counts live under `response.usageMetadata`: `promptTokenCount`,
  `candidatesTokenCount`, `totalTokenCount`, plus `thoughtsTokenCount` for the
  thinking tokens alone.
- MCP SDK 2.x (as of 10/2026, version 2.4.0): `McpServer` comes from
  `@modelcontextprotocol/server`, `serveStdio` and `StdioServerTransport` from
  the subpath `@modelcontextprotocol/server/stdio`. `@modelcontextprotocol/node`
  is HTTP middleware and not needed for stdio.
- `server.registerTool(name, { title?, description?, inputSchema?, annotations?, _meta? }, handler)`;
  `inputSchema` is a Standard Schema such as `z.object({...})`. A raw shape
  (`{ query: z.string() }`) is only accepted through a deprecated overload.

## Gemini API calls already tested (reference)

These calls were tested successfully beforehand and form the basis for the logic in the MCP server.

### Direct REST call (PowerShell / curl)

```powershell
curl "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent" `
  -H "Content-Type: application/json" `
  -H "X-goog-api-key: $env:GEMINI_API_KEY" `
  -X POST `
  -d '{
    "contents": [{"parts": [{"text": "Test query"}]}],
    "tools": [{"googleSearch": {}}],
    "generationConfig": {
      "thinkingConfig": {"thinkingLevel": "high"}
    }
  }'
```

## Gemini API tools in use

This MCP server uses exactly three of the six official, Google-managed built-in tools of the Gemini API.
All three are available on the current default model (`gemini-flash-latest`) and are activated **together in a single MCP tool, `gemini-search`** - there is deliberately only this one entry point, and Gemini decides within the call which of the three capabilities (search → read → evaluate) it actually needs for the given query ([docs: Tools](https://ai.google.dev/gemini-api/docs/tools)).

Deliberately not used: Google Maps (not relevant for web research), File Search (only for your own uploaded documents), Computer Use (experimental, browser control, not a research use case) and Function Calling (custom functions, not needed here).

### 1. Google Search (grounding)

Connects the model to current web content in real time.
Gemini decides on its own when a search is needed, formulates the search queries itself and returns an answer with source attributions (citations) ([docs: Grounding with Google Search](https://ai.google.dev/gemini-api/docs/google-search)).

```javascript
tools: [{ googleSearch: {} }];
```

**Purpose in this project:** initial, broad research on a topic - the default case within the `gemini-search` tool.

### 2. URL Context

Lets Gemini read and evaluate the content of one or more specific URLs - including PDFs, images and HTML, up to 34 MB per request ([docs: URL Context](https://ai.google.dev/gemini-api/docs/url-context)).
It runs entirely inside the API call, without Claude having to fetch the page itself.

```javascript
tools: [{ urlContext: {} }];
```

**Purpose in this project:** deeper analysis of a source found earlier via Google Search (for example when Claude wants to know what exactly a particular result page says) - within the same `gemini-search` tool, with Gemini invoking this built-in automatically when needed.

### 3. Code Execution

Lets Gemini write Python code on its own and run it in an isolated sandbox, in order to produce calculations, data analyses or simple statistics from data found or read earlier ([docs: Code Execution](https://ai.google.dev/gemini-api/docs/code-execution)).
The sandbox has no internet access of its own - it works only with data already present in the context (from Google Search or URL Context, for instance).

```javascript
tools: [{ codeExecution: {} }];
```

**Purpose in this project:** an optional third capability within `gemini-search` for cases where data that was found or read still needs to be evaluated numerically (averages, comparisons, simple chart data).

### Combined use

All three tools can and should be activated simultaneously in a single call, so that Gemini itself decides which steps (search → read → evaluate) the given query requires ([docs: Tools](https://ai.google.dev/gemini-api/docs/tools)):

```javascript
config: {
  tools: [
    { googleSearch: {} },
    { urlContext: {} },
    { codeExecution: {} }
  ],
  thinkingConfig: { thinkingLevel: 'high' },
}
```

### Reference example using the official Node SDK

A simplified example of the pattern that `gemini.js` actually implements:

```javascript
import { GoogleGenAI } from "@google/genai";

const genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const response = await genAI.models.generateContent({
  model: "gemini-flash-latest",
  contents: "Test query",
  config: {
    systemInstruction: `Today's date is ${new Date().toLocaleDateString("en-CA")}.`,
    tools: [{ googleSearch: {} }, { urlContext: {} }, { codeExecution: {} }],
    thinkingConfig: { thinkingLevel: "high" },
    store: false,
  },
});

console.log(response.text);
```

Important parameter notes from the documentation:

- `thinkingLevel` replaces the older `thinkingBudget` (integer) - on
  `gemini-3.5-flash` the enum value applies (`minimal`, `low`, `medium`, `high`)
- Without an explicit setting, thinking defaults to `medium` on this model. This
  server always sends a level anyway, so that the footer can report the value
  actually used - without a `config.json` that is `medium` as well
- The API key can be passed as a header (`X-goog-api-key`) or as a query
  parameter (`?key=...`); the header variant is preferred

### The current date as the only system instruction

The model has a training cutoff of its own and interprets "the latest version" against that, not against today.
Measured before this instruction existed, it searched for `2025 2026` in four out of six calls - it knows the year only approximately.
For a server whose entire purpose is to bypass training knowledge, that is the wrong kind of vagueness.

```javascript
systemInstruction: `Today's date is ${new Date().toLocaleDateString("en-CA")}.`,
```

Three decisions behind that one line:

- **`systemInstruction` rather than a prefix in `contents`.** The user's question stays untouched; the date is context, not part of the query.
- **The date and nothing else.** Content-level instructions - "prefer official documentation, GitHub, Stack Overflow", as comparable servers send - tint every answer and narrow research into OS behaviour or recent events. A date is a fact; a source preference is an opinion.
- **`toLocaleDateString("en-CA")` rather than `toISOString()`.** Both yield `YYYY-MM-DD`, but `toISOString()` is UTC and would report the previous day in Central Europe between 00:00 and 02:00 - in the very function meant to guarantee the correct date.

Verified after the change: the query `Which Node.js version is currently LTS?` produced the search `nodejs current lts version 2026` instead of the earlier `2025 2026`, and asked directly, the model names the correct date.
The effect is real but not absolute - for broad questions the model still hedges with two years in some searches.

### Logging at Google: store

```javascript
store: false,
```

Since 2026-10-26 the Generate Content API stores requests and responses by default for **newly created** projects; for older ones it does so only if logging was switched on in AI Studio ([Logs and datasets](https://ai.google.dev/gemini-api/docs/logs-datasets), as of 2026-10-26).
Logs exist for paid-tier projects only and are kept for 55 days by default.
The request-level `store` takes precedence over the project setting, so `false` keeps every request out of those logs, however and whenever the project was set up.
That matters here because research queries regularly carry context from the work they were asked in.

`store` is not invariant I4: I4 is about this server's disk, `store` about Google's logs.
The 30-day storage for grounding under the terms is unaffected by it.

`scripts/probe-models.js` sends the field as well, so the probe asks no less than the server does.

## Response: source list and token footer

Beyond the answer text itself, every response from the MCP server contains four additional parts read straight out of the Gemini API response (not computed or estimated by the server):

1. A **source list** (title + URL) at the end of the text - Claude should be
   able to see and act on the sources (to dig into a specific URL, say, or to
   attribute a statement to a source), not just a bare count. It merges Google
   Search hits and pages read via URL Context and deduplicates by URL.
2. **Citation markers** (`[1]`, `[1][3]`) inline in the text at the positions
   for which the API reports a source - making it visible which statements are
   backed by a source and which the model added from its own knowledge.
3. A **footer** with input/output/thinking tokens, the number of sources and the
   model and thinking level used, for transparency about the actual resource
   consumption and the model/thinking choice of that tool call - the user should
   never have to guess what was used.
4. The **search queries actually sent** to Google on a second footer line,
   because they answer something the other three cannot: whether the search
   covered the question at all.

### Answer text: assembled by hand instead of `response.text`

`gemini.js` assembles the answer text itself from `candidates[0].content.parts` (`buildText`) instead of using the SDK's `.text` getter.
The getter concatenates text parts only, discards everything else and writes a warning to stderr on every call.
With Code Execution enabled, that drops exactly the part which shows how a computed result came about - the answer asserts a result without evidence of the path to it.
`buildText` therefore also picks up `executableCode` and `codeExecutionResult` as code blocks.
Parts marked `thought: true` are left out; their volume is already reported as thinking tokens in the footer.

The order is deliberately rearranged: the API returns the parts in execution order, so code and result come **before** the explanatory text - the answer would begin with a code block and the actual information would follow underneath.
`buildText` collects text and code blocks separately and appends the code blocks at the end under the heading `Code execution:`.
The computation is evidence, and so it goes where the source list goes: after the answer, not before it.

The length of `codeExecutionResult.output` is deliberately **not** capped: long output is part of the computation too, and a volume that would actually get in the way in a research context is the rare exception.

### Citation markers inline

In addition to the source list at the end, markers sit directly in the answer text at the positions for which the API reports a source via `groundingMetadata.groundingSupports`:

```text
In Python 3.13, `date_parser` was removed[1]. The type code 'w' is new[1][3].
The default behaviour of the C parser is unchanged.
```

Format: `[1]` immediately at the end of the cited passage, multiple sources as `[1][3]` (matching Google's reference implementation in the Gemini CLI).
The numbers are the same as in the source list.

**The point is not primarily *which* source backs a sentence, but *whether* it is backed at all.**
Measured against a real response, 27 % of the text was covered by no support at all - statements from the model's memory, visually indistinguishable from the researched ones.
The reader of this server goes on to write code against sentences like those.

#### Semantics - important

| Statement | Holds |
| --- | --- |
| Marker present ⇒ passage is backed | reliably |
| Marker absent ⇒ passage is unbacked | **only an indication, not proof** |

A marker can be missing for four reasons, only the first of which carries the intended meaning:

1. The passage genuinely is ungrounded.
2. Verification against `segment.text` failed (see below).
3. The position fell inside a Markdown code section.
4. The source comes **exclusively** from `urlContextMetadata` - the API provides
   no `groundingSupports` for such entries, so they cannot carry a marker.

Cases 2 and 3 are countable and appear as `⚠️ n markers dropped` in the footer once they exceed zero.
Case 4 is recognisable from the source list.

On case 4, a measurement that came out against the obvious expectation: for a query with a concrete URL, URL Context demonstrably fired (`urlRetrievalStatus: URL_RETRIEVAL_STATUS_SUCCESS`) - but the page that was read appeared **additionally as a `groundingChunk`** in the response, with a direct URL instead of a vertexaisearch redirect and three `groundingSupports` of its own.
It was therefore fully covered by markers and never reached the URL Context branch, having been removed by the deduplication on URL.

Case 4 thus only applies when a page read via URL Context does **not** also show up among the `groundingChunks`.
Whether and when that happens is an open question - so far only the favourable case has been observed.
"No marker ⇒ unbacked" therefore remains an indication, but it is less blunt than assumed when this rule was written.

#### Implementation (`citations.js`)

- **Byte offsets, not character positions.** Per the SDK type definition,
  `startIndex`/`endIndex` are "measured in bytes". On a German test response not
  a single one of 28 positions matched on a character basis, and all 28 matched
  on a byte basis; text and bytes had drifted 44 places apart by the end.
  Insertion therefore goes through `Buffer`. Google made this very mistake in
  the Gemini CLI ([PR #5956](https://github.com/google-gemini/gemini-cli/pull/5956),
  noticed on Japanese text).
- **Per part, before joining.** The offsets count from the start of each
  individual part (`Segment.partIndex`, "Offset from the start of the Part"),
  not from the start of the assembled text. `buildText` therefore inserts the
  markers inside the loop over the parts - before the `join("\n\n")` and before
  the code execution blocks, which are produced by the server and do not exist
  in the API's counting at all.
- **Verification against `segment.text`.** The API includes the expected
  excerpt. If it does not match the computed position, the marker is discarded
  rather than guessed. Consequence: **a marker can never end up in the wrong
  place - it can only be missing.** This is at the same time the safety net
  against a silent change of the offset semantics by Google.
- **No markers inside code sections.** A marker in the middle of a code example
  turns `copy.replace(obj, x=1)` into `copy.replace(obj[3], x=1)` -
  syntactically valid, factually wrong, and inconspicuous. Fenced blocks and
  inline code are determined as intervals in a single pass (the fences come
  first in the alternation and therefore swallow everything inside them); if the
  target position falls into one, the marker is discarded. A fence that is
  never closed runs to the end of the text, as in CommonMark - an answer cut
  off by `MAX_TOKENS` often ends inside a block. Indented code blocks
  (four spaces) are not detected - the only known gap.
- **Numbers via `chunkNumbers`, never via `index + 1`.** See "Building the
  source list" below.

Protobuf omits default values: `startIndex` and `partIndex` are absent from the JSON when they are 0 - both need `?? 0`.
`confidenceScores` and `renderedParts` were evaluated as quality filters and rejected: on Gemini 3.x they are empty in practice (0 of 28 populated).

Redundant markers at **different** positions are deliberately not merged.
Nested supports (measured: four supports with the same start, different ends and the same source) produce several identical markers in one paragraph.
Merging those would throw away resolution, and for a machine reader noise is cheaper than a missing mark.

What is merged is what sits at the **same** position.
Deduplication happens per byte offset rather than per support: two supports ending on the same byte have no resolution to lose, and kept apart they would write the same number twice (`[1][1]`).

### Notice for a response that did not finish normally

If the text is missing entirely or breaks off, the response would still look like a success with its source list and footer.
`formatNotice` therefore inserts a line with ⚠️ between the text and the source list when one of these cases applies:

| Condition | Notice |
| --- | --- |
| `response.promptFeedback.blockReason` set | request blocked by the API |
| text empty | response without text, with `candidates[0].finishReason` |
| `finishReason` set and ≠ `STOP` | incomplete response, above all `MAX_TOKENS` |

`STOP` is the regular completion; the remaining values of the `FinishReason` enum (`MAX_TOKENS`, `SAFETY`, `RECITATION`, `BLOCKLIST`, …) mean an abort.
The footer stays the last element of the response in every case.

### Where the values come from

Every `generateContent` response automatically provides a `usageMetadata` object with the token breakdown ([docs: Token counting](https://ai.google.dev/gemini-api/docs/tokens)) as well as - with the Google Search tool enabled - a `groundingMetadata` object with the sources found ([docs: Grounding with Google Search](https://ai.google.dev/gemini-api/docs/google-search)).
With the URL Context tool enabled, the pages that were read are additionally available under `urlContextMetadata`.
**Important:** both metadata objects hang off the first candidate (`candidates[0]`), not off `candidates` directly.

```javascript
const response = await genAI.models.generateContent({...})

const inputTokens = response.usageMetadata.promptTokenCount
const outputTokens = response.usageMetadata.candidatesTokenCount
const thinkingTokens = response.usageMetadata.thoughtsTokenCount

const candidate = response.candidates?.[0]
const searchChunks = candidate?.groundingMetadata?.groundingChunks ?? []
const urlContextEntries = candidate?.urlContextMetadata?.urlMetadata ?? []
```

### Fields in detail

| Field              | Path in the response                                           | Meaning                                                        |
| ------------------ | -------------------------------------------------------------- | -------------------------------------------------------------- |
| Input tokens       | `usageMetadata.promptTokenCount`                               | tokens of the request sent                                     |
| Output tokens      | `usageMetadata.candidatesTokenCount`                           | tokens of the generated response                               |
| Thinking tokens    | `usageMetadata.thoughtsTokenCount`                             | reasoning tokens alone, reported separately                    |
| Search queries     | `candidates[0].groundingMetadata.webSearchQueries`             | array of the queries actually sent to Google                   |
| Search sources     | `candidates[0].groundingMetadata.groundingChunks`              | array of the web sources found by the Google search            |
| Search source URL  | `groundingChunks[i].web.uri`                                   | URL of the individual search source                            |
| Search source title| `groundingChunks[i].web.title`                                 | title of the individual search source                          |
| Citation mapping   | `candidates[0].groundingMetadata.groundingSupports`            | passage → source, the basis for the citation markers           |
| Cited passage      | `groundingSupports[i].segment`                                 | `startIndex`/`endIndex` (in **bytes**), `text`, `partIndex`    |
| Cited sources      | `groundingSupports[i].groundingChunkIndices`                   | indices into `groundingChunks` - **not** into the source list  |
| URL Context source | `candidates[0].urlContextMetadata.urlMetadata[i].retrievedUrl` | URL of a page Gemini read on purpose (not grounding)           |

Both source arrays are present only if the respective tool was actually used - otherwise they are empty or absent, so always guard them with `?? []`.

### Building the source list

Search hits and URL Context pages are merged into one list and deduplicated by URL.
Search hits take precedence, because only they bring `groundingSupports` along and can therefore carry citation markers; a URL Context entry that arrives second would take that away from them.
What they do **not** bring is a descriptive title: measured, `groundingChunks[i].web.title` holds the bare domain name (`npmjs.com`, `github.com`, `dev.to`, `snyk.io`), which is no more informative than the `retrievedUrl` of a URL Context entry.

`buildSourceList` returns **two** things: the list itself and `chunkNumbers`, the mapping from the index in `groundingChunks` to the number in the emitted list.
The two counts diverge, because `groundingChunks` represents search hits rather than sources - measured: 17 hits for 14 distinct URLs, and in an earlier run 14 for 4.
Citation markers must therefore **never** be numbered via `index + 1`; they would run past the end of the source list or point at the wrong source.

```javascript
const numberByUri = new Map();
const chunkNumbers = new Map();
const sources = [];

const addSource = (title, uri) => {
  if (!numberByUri.has(uri)) {
    sources.push({ title, uri });
    numberByUri.set(uri, sources.length);
  }
  return numberByUri.get(uri);
};

searchChunks.forEach((chunk, index) => {
  const uri = chunk.web?.uri;
  // The one path on which a link could go missing - hence the counter.
  if (!uri) {
    skipped++;
    return;
  }
  chunkNumbers.set(index, addSource(chunk.web?.title ?? uri, uri));
});

// URL Context sources come after the search hits and produce no markers -
// so they do not affect the numbering.
for (const entry of urlContextEntries) {
  if (entry.retrievedUrl) addSource(entry.retrievedUrl, entry.retrievedUrl);
}

const sourceList = sources
  .map((s, i) => `[${i + 1}] ${s.title} - ${s.uri}`)
  .join("\n");
```

Chunks without a `uri` make it neither into the list nor into `chunkNumbers` and consequently produce no marker.
They are counted, though, and reported in the footer as `⚠️ n sources omitted (unknown chunk type)` once the count exceeds zero.
So far the API has only ever delivered `web` chunks; if a second type were added, its links would silently drop out of the list, which is the one path in this code where a source can be lost (see "Terms compliance" below).
Counting is all that can be done without knowing the unfamiliar type - but it turns a silent loss into a visible one.

### Footer format in the tool result

```javascript
// Dropped citation markers only when there were any - the normal case should
// not make the footer longer. Same rule for omitted chunks.
const droppedNote = dropped > 0 ? ` | ⚠️ ${dropped} markers dropped` : "";
const skippedNote =
  skipped > 0 ? ` | ⚠️ ${skipped} sources omitted (unknown chunk type)` : "";

// The model that answered, where it is not the one requested.
const served = modelVersion && modelVersion !== model ? ` → ${modelVersion}` : "";

const footer =
  `\n\n---\n🔢 ${inputTokens} input / ${outputTokens} output / ${thinkingTokens} thinking tokens ` +
  `| 🔍 ${sources.length} sources | 🤖 ${model}${served} (thinking: ${thinkingLevel})` +
  `${droppedNote}${skippedNote}` +
  formatSearchQueries(searchQueries) +
  formatContinuationNote(usageMetadata) +
  formatFallbackNote(fallback);

const sourcesBlock = sourceList ? `\n\nSources:\n${sourceList}` : "";

return {
  content: [{ type: "text", text: text + notice + sourcesBlock + footer }],
};
```

`text` and `dropped` come from `buildText(candidate, { supports, chunkNumbers })`, `notice` from `formatNotice(...)` - see the sections above.

Example output at the end of every response:

```text
Sources:
[1] Gemini API Docs - https://ai.google.dev/gemini-api/docs/models
[2] Google Gen AI SDK - https://googleapis.github.io/js-genai/

---
🔢 245 input / 89 output / 40 thinking tokens | 🔍 2 sources | 🤖 gemini-flash-latest → gemini-3.8-flash (thinking: high)
🔎 Searched: gemini api models list · google genai sdk models.list pagination
```

The `🤖` field names the requested model and, after an arrow, the one that actually answered, taken from `response.modelVersion`.
The two differ in two cases, measured on 2026-10-26: an alias resolves to a concrete model (`gemini-flash-latest` answers as `gemini-3.8-flash`, `gemini-pro-latest` as `gemini-3.1-pro-preview`), and a deprecated id is routed to its successor without an error (`gemini-3.7-flash` answers as `gemini-3.8-flash`).
Without the arrow the footer would name a model that never ran, and the rule that the model actually used is always visible would hold only for concrete, current ids.
The comparison is exact string equality; where the two names match, or the response carries no `modelVersion`, the field looks as before.
After a fallback, `model` already holds the backup, so the arrow compares against the model that was actually asked.

The number of dropped markers belongs in the footer because it changes how much the response can be relied on: if a marker is missing, the passage may be ungrounded - or the verification discarded it.
That matches the purpose of the footer, which is to make the actual state of each individual call visible.

`formatFallbackNote` follows the same pattern as `formatSearchQueries`: with no fallback it returns an empty string, so the line disappears entirely.
It uses 🔁 rather than ⚠️, because a successful fallback is not a degraded answer - the warning sign stays reserved for cases where something is wrong with the answer itself.
Details in "The optional backup model" below.
`formatContinuationNote` follows the same pattern for an answer that took more than one request - see "Automatic continuation" below.

### The search queries line

`webSearchQueries` holds the queries Gemini actually sent to Google - not the query the user asked.
The two differ, and the difference is the point.

Asked to compare six web frameworks by version **and** bundle size, the model searched six times for `<framework> current version 2025 2026 npm` and once for bundle sizes; rendering strategy and learning curve, also part of the question, were never searched for and came out of the model's own knowledge.
Neither the source list nor the citation markers reveal that: markers show whether a *sentence* is backed, not whether the *search* covered the question.
This makes the line the only place where an under-researched answer is recognisable as such.

Format and capping:

- **Its own line** below the metrics, not appended to them. Together they would run to 385 characters in a measured case and wrap over four terminal lines - in exactly the long answers where the footer is supposed to provide orientation.
- **`·` as separator**, not `,`. The queries contain quotation marks and digit sequences of their own, between which a comma disappears.
- **Capped at 300 characters**, with `(+n more)` for the remainder. Measured: usually 2 to 6 queries totalling 73 to 270 characters, a single query 29 to 84 characters - but 11 queries and over 500 characters for a deliberately overbroad question. The API documents no upper bound, hence the cap.
- **The query that breaks the budget is still written in full** rather than truncated mid-word: half a search query carries no information, and the overshoot is bounded by the length of one query.
- **An empty array produces no line at all**, following the same rule as the dropped-marker note: the normal case must not lengthen the footer. That no search happened is already visible as `🔍 0 sources`.
- **Identical queries appear once.** After a continuation the SDK concatenates the query lists of all hops, and a hop may repeat a search of the one before. Unlike the source list, this line falls under no invariant - it reports what was searched, and a repetition adds nothing to that.

Actually implemented in `gemini.js` (`buildText`, `formatNotice`, `buildSourceList`, `formatSourcesBlock`, `formatFooter`, `formatSearchQueries`) and `citations.js` (`insertCitations`).
`buildSourceList`, `formatSourcesBlock`, `formatFooter` and `formatSearchQueries` are exported and, like `insertCitations`, testable without an API key (`test/sources.test.js`, `test/search-queries.test.js`).
`gemini.js` and `models.js` can be imported without `GEMINI_API_KEY` because `getClient()` is only called inside `runSearch` and `fetchModels`, not at module load.

### Automatic continuation

Since `@google/genai` 2.26/2.29, `generateContent()` resends a request whose response ends with `finishReason: "CONTINUATION"`, carrying the response's `continuationToken`, and merges the answers (`generateContentWithContinuation`).
It is on by default; `automaticContinuation: false` would turn it off.
The server leaves it on: a truncated answer is worse than a long one.

What the merge does, read from the SDK source (`mergeContinuationResponses`):

- the parts are concatenated, and `segment.partIndex` and `groundingChunkIndices` of later hops are shifted, so `buildText` places the markers per part as before
- `groundingChunks` are concatenated; `buildSourceList` deduplicates identical URIs, which I1 allows
- `usageMetadata` is summed, the prompt included, because every hop resends and bills it; `initialPromptTokenCount` keeps the first hop's figure
- `webSearchQueries` are concatenated, so `formatSearchQueries` writes identical queries once
- `finishReason` is the last hop's
- there is no limit on the number of hops, and timeouts, retries and billing apply to each request (SDK documentation of `automaticContinuation`)

The token line shows the sums, because that is what is billed.
A line below it says why the input figure can be a multiple of what the question cost on its own:

```text
↪ Continued in further requests - input tokens summed over all of them (first request: 2405)
```

The SDK records no hop count, so `promptTokenCount > initialPromptTokenCount` is the one trace a continuation leaves (`formatContinuationNote`).
It is a `↪` and not a `⚠️`: the answer is complete, it only cost more.

The local brake covers all hops together (see "The deadline this server does send").
A late hop can therefore be cut off while Google still computes and bills it.

Not measured: whether the Gemini API returns `CONTINUATION` for this server's requests at all - no real response has carried it so far, and it cannot be provoked on purpose.
`test/continuation.test.js` covers the path with two stubbed hops through the real SDK.

## Terms compliance

The source list is not a feature that could be tuned; it is the condition under which this server may use Grounding with Google Search at all.
The [Gemini API Additional Terms of Service](https://ai.google.dev/gemini-api/terms#grounding-with-google-search) protect not the API but the publishers whose content ends up summarised in an answer.
The link back to the source is the only thing that flows to them, and Google's redirect is what makes that flow verifiable.

Four invariants follow from this.
They are met today, and they are binding from here on: **anyone considering a change that touches one of them does not implement it, but asks first** - including when the change comes dressed up as cleanup, shortening or optimisation.

| # | Invariant | Why |
| --- | --- | --- |
| I1 | No link is ever omitted | Every `groundingChunk` with a URI appears in the list, even when no marker points at it. No cap, no selection, no deduplication by domain |
| I2 | No link is altered, URI **and** title | Redirect URLs go out byte for byte; the title counts as part of the link |
| I3 | No redirect is resolved | The only outgoing traffic is the SDK call to the Gemini API |
| I4 | Nothing is cached | Grounded Results never touch the disk; `config.json` holds model names, thinking levels and the deadline, nothing else |

Deduplicating by identical URI violates none of them, because no destination is lost in the process.
Deduplicating by domain would violate I1.

### What the terms actually say

That the title belongs to the link is explicit, and it is the part most easily overlooked:

> "Links" are any other means to fetch web pages (including hyperlinks and URLs), which may be contained in a Grounded Result or Search Suggestion.
> Links also include titles or labels provided with those means to fetch web pages.

The decisive sentence for a server like this one is the "for clarity" sentence in the use restrictions, not the enumeration before it:

> For clarity, Grounded Results, Search Suggestions, and Links are intended to be used in combination to respond to a given end user prompt and it is a violation of these terms to use Grounding with Google Search to extract or collect one or more of these components for another purpose (for example, using programmatic or automated means to collect Links, using Links to build an index, or **using Links to identify destination pages for crawling or scraping**).

Two things follow from it.
First, it names I3 by name, which spares the derivation.
Second, it settles from the wording - rather than by interpretation - the question of whether a server may process the results at all: what is forbidden is pulling components out **for another purpose**.
Without that sentence, the preceding list ("cache, frame, syndicate, resell, analyze, train on, or otherwise learn from") reads as though the intended use were prohibited too.

One clause is regularly cited as a prohibition and is none: "you do not allow Grounded Results to be accessed or collected by automated or programmatic means" sits **inside an exception**, namely the one permitting an end user to copy results.
The standalone prohibitions are the "for clarity" restriction quoted above and the one against modifying or interspersing content.

### Why the source list is not capped

The source list costs more tokens than the answer text.
That is known, measured and accepted - it is the price of the exchange grounding rests on, and **not an invitation to optimise** ([issue #6](https://github.com/brobertoblanko/gemini-grounding-mcp/issues/6)).

Measured on a response with 22 sources, the obvious savings turn out to be small or unavailable:

| Idea | Effect | Verdict |
| --- | --- | --- |
| Cap the list | - | violates I1 |
| List only cited sources | none - 22 of 22 were backed by at least one support | pointless |
| Deduplicate by domain | about 1,000 tokens | violates I1 |
| Resolve redirects to short URLs | - | violates I3, the case the terms name outright |
| Move the list into an MCP resource | separates markers from destinations, client support uncertain | does not solve the actual problem: a list of the same domain name fifteen times does not get more useful by being moved |

### Where the server adds or rearranges content

The terms forbid interspersing "any other content" with the Grounded Results.
The server does two things that touch on this, and they are worth different amounts:

- **Citation markers** (`citations.js`) are inserted into the answer text.
  Google's own reference implementation in the Gemini CLI sets the same markers,
  so the clause cannot be aimed at them but at foreign content such as
  advertising. The markers also point at the supplied links rather than away
  from them.
- **Reordering the code execution blocks** (`buildText`) has no reference
  implementation behind it, only the substantive argument that the computation
  is evidence and belongs with the sources rather than in front of the answer.
  That is an argument, not a settled question, and it is named here as such.

### The gap behind the server

The terms require the Grounded Results to be displayed to the end user who submitted the prompt.
An MCP server can only encourage that; it hands its answer to a client and has no say in what the client shows.
The only lever is the `instructions` field in `index.js`, which asks the client to keep the source list and footer intact - and it is not enforceable.
This is a genuine gap, not a solved problem, and it is recorded here rather than papered over.

## Configurable model and thinking level

The MCP server offers two additional tools for setting the default model, thinking level, backup model and deadline persistently, without having to edit the code.

### gemini-list-models

Fetches the models available to the current API key, including token limits, via the official `models.list` endpoint ([API reference: Models](https://ai.google.dev/api/models)).
The SDK's pager fetches further pages on its own; `pageSize` only determines the size of the individual request, not the total count.

**Filtered by default.**
The key exposes considerably more models than work here - 60 in total in the measurement below, 33 of them usable.
Filtering goes through two pieces of information that every model reports itself:

| Field | Condition | Otherwise |
| --- | --- | --- |
| `supportedActions` | contains `generateContent` | model produces no text - embeddings, Imagen, Veo, Live/Audio |
| `thinking` | `true` | `400 Thinking level is not supported for this model.`, since `runSearch` always sends a `thinkingConfig` |

Both fields are documented in the SDK's `Model` interface.
Deliberately **not** filtered by name patterns: Google assigns code names that say nothing about capabilities (`nano-banana-pro-preview` is an image model), so any list of patterns goes stale with the next model family.

Limits the filter does not resolve - both are the reason for the exclusion list described below:

- It separates technical usability, not suitability. Image, speech and robotics
  models partly satisfy the conditions as well.
- **Listed does not mean available.** Deprecated models stay in the response and
  return `404 ... is no longer available` when used - demonstrable on the 2.0
  generation. A field that would indicate this state up front does not exist.

`all` is therefore not merely a convenience switch: since the list gives no guarantee anyway, the filtered view must never be the only one.
`all: true` shows the complete list with a status column, the offered models first and marked `offered`; a model without `generateContent` shows `no text` and what it does instead, for example `no text (embedContent)`.
Both views start with a header row naming the columns.
If the filter yields no model at all - because the API no longer provides the fields being evaluated, say - `listModels` falls back to the complete list on its own and says so in the notice text, rather than producing empty output.

### The exclusion list

`models-excluded.js` holds the models that pass `isUsableModel` and still do not belong in a list somebody picks a research model from.
It is applied on top of that filter and only in the default view; `all: true` bypasses it entirely and gives each entry the kind of its exclusion as its status - `400 INVALID_ARGUMENT`, `404 NOT_FOUND`, `deprecated`, `no sources` or `unsuitable` - so the exclusion moves the information rather than losing it.
It shapes the display and nothing else: `gemini-set-config` and a per-call `model` accept any id, an excluded one included.

Measured on 2026-10-26 with `scripts/probe-models.js` against a single API key: 60 models in total, 33 past `isUsableModel`, 25 excluded, 8 offered.

**Four kinds of entry, ordered by how solid they are.**
Every reason states its kind, because they age differently:

| Kind | Basis | Count |
| --- | --- | --- |
| `400`/`404` | the API's own refusal, verbatim | 18 |
| `deprecated` | the vendor routes the id to its successor, and `modelVersion` names that successor | 2 |
| `no sources` | the model answers and returns no grounding chunk | 3 |
| `unsuitable` | the vendor documents the model as built for something else | 2 |

The first kind is the strongest and needs no judgement: `Code execution is not enabled for this model` from the image models, `Thinking level is not supported for this model.` from Gemma, `This model only supports Interactions API` from the Deep Research and Omni models, and `no longer available to new users` from `gemini-2.5-flash`, `-flash-lite` and `-pro`.
`deprecated` covers ids Google retires without an error: since 2026-10-08 `gemini-3.7-flash` is routed server-side to `gemini-3.8-flash` and `gemini-3.5-flash` to `gemini-3.6-flash`, according to the [changelog](https://ai.google.dev/gemini-api/docs/changelog).
Both answer and ground, so neither the probe nor a status code catches them; what gives them away is `response.modelVersion`, which names the successor.
Offering them would put a name in the list that no call ever runs under.
The entry hides them from the list only - a call that names one still works, and the footer then shows both names (see "Footer format in the tool result").
The last kind is the weakest and is the first thing to recheck on review: a model is unsuitable only for as long as its documentation says so.

**Exact ids, no wildcards.**
A pattern such as `*-image` would catch successors by itself, but a future model that *understands* images and carries `image` in its name would vanish unnoticed.
The failure mode is chosen deliberately: an unlisted new model appears in the list, which is visible, harmless, and asks to be maintained.
Nothing ever falls off the list unseen.
The price is entering new ones by hand.

A threshold on `inputTokenLimit` was considered and rejected for the same reason.
It separated the measurement perfectly - the usable text models reach 1M, the image, robotics, TTS and Gemma models sit at 256k or below - but it would hide a good text model with a smaller context window without a word. The two robotics models show this is not hypothetical: they reach 128k, ground correctly, and are excluded here for a documented reason rather than for their size.

**In code, not in `config.json`.**
The list is a project decision, not user state, and `config.json` is fixed to model names, thinking levels and the deadline.
In code it is versioned, testable, and carries its reason in the comment.

**What keeps it honest.**
An id with a typo never takes effect, and nothing points at it - the same silent failure the list exists to avoid, one step removed.
`test/models.test.js` checks three things against the stored response in `test/fixtures/models-list.json`: that every entry matches a model, that no entry is already removed by `isUsableModel` and therefore unreachable, and that every reason names its kind.
The fixture is the raw HTTP body rather than the SDK's objects, because the test mock replaces `fetch` and the SDK still has to parse it - on the wire the field is `supportedGenerationMethods`, and the SDK renames it to `supportedActions`.

Those checks see the stored response and nothing else, so a model Google retires later keeps passing until somebody renews the fixture, and a test may not call the live API for it.
`scripts/probe-models.js` covers that direction: on a full run it holds the list against what the key currently offers and names every entry no model matches any more, which makes one run report both what to add and what to remove.
A run narrowed to `--model` skips the check rather than judging the list by ids the command line supplied.

`scripts/probe-models.js` produces the entries.
It sends every model past `isUsableModel` exactly what `runSearch` sends - all of `SEARCH_TOOLS` plus a thinking level - and only a `400` or `404` counts as a verdict; `429`, `503` and the other transient codes are retried and otherwise reported without one.
That the tools are a shared constant is not tidiness: measured, the image models answer a request carrying only `googleSearch` without complaint and fail solely on code execution, so a narrower probe reports them as working.
The script is excluded from the published package by the `files` list in `package.json` and records nothing but id, verdict, status, duration and whether grounding metadata came back - never the answer text or the sources (invariant I4, see "Terms compliance").

**The notice names the list.**
An exclusion the user cannot see is as opaque as the shortened choice this list came from, so the default view states how many models are hidden and that a full listing bypasses the exclusion.
It says that in one line under 80 columns: the notice is read by a human at the terminal on every single call, a paragraph of reasoning that never changes is one the eye learns to skip, and a longer line wraps mid-word.
For the same reason it does not name `models-excluded.js`, a file somebody who installed the package never sees; only the two fallback notices, which address whoever maintains the list, do.
The reasoning belongs here, where it is read once; the numbers in the notice come from the response, so no wording has to be revised when models come and go.

The display rule for agents - name the listed models before proposing a shorter selection, mark that selection as a suggestion, and say that any other model id can be set as well - sits in the tool description of `gemini-list-models` instead.
It used to travel in the notice, which reached the agent at the moment of choosing at no cost in permanent context, but it also put an instruction aimed at agents in front of every CLI user.
The tool description costs context permanently and is the price for a notice that reads as one line.

**On code names.**
`models.list` also returns `displayName` and `description`, and for code names those do carry information: `nano-banana-pro-preview` is described as "Gemini 3 Pro Image Preview".
Neither field is used as an automatic filter - that would be the same name pattern one field further right, with the same silent failure once a future text model carries one of the keywords.
As a hint for whoever assesses a new entry by hand, `description` is the only usable source for a code name.

### gemini-set-config

Stores the model ID, thinking level, backup model and/or deadline persistently in a `config.json` (location see below).
The values can be set independently of one another - a merge makes sure that setting one does not overwrite the others already stored.
This choice survives server restarts until it is changed again.

Up to 1.x the tool was called `gemini-set-model`.
The name stopped fitting once it set a deadline as well, and it is named for the file it writes rather than for one of its values.
The rename is a breaking change: permission rules and instructions naming the old tool no longer match anything.

Three of the five parameters have a state beyond "a value":

| Parameter | `undefined` | A value | Special |
| --- | --- | --- | --- |
| `backupModel` | leave untouched | model ID | `false` switches the fallback off, and records that this was deliberate |
| `backupThinkingLevel` | leave untouched, **except** alongside a `backupModel`, where it resets | thinking level | `null` deletes the key, so the backup inherits the level of the call again |
| `deadlineSeconds` | leave untouched | whole seconds | `false` sends no deadline; see "The deadline this server does send" |

`null` deletes for all five keys, not just for `backupThinkingLevel` - a special rule for exactly one field is not explainable later.
`false` for `backupModel` is deliberately stored rather than deleted: for behaviour, "never configured" and "switched off" are the same thing, but for the reader of `gemini-grounding config` they are two different statements.

The exception in that table is the unit rule described under "Implementation": a `backupModel` arriving without a level of its own resets the stored one, so a level chosen for the previous backup does not silently carry over to the new model.
`setSavedConfig` therefore returns what it actually wrote, `null` included - only then can the confirmation name the level that fell away instead of concealing it.
Passing `backupThinkingLevel` on its own is how the level of the stored backup is changed without touching the model.
That requires a stored backup that is switched on: a level without its model has nothing to belong to, would sit in the file without effect, and the confirmation would name a value that the state block two lines below revokes as `not set` or `off`.
`findBackupLevelProblem` in `config.js` rejects both cases before anything is written - `null` stays exempt, because the way back to "inherits from the call" must remain open even when no backup is left.

That check and `findModelCollision` below are the same shape for the same reason, and both guard both interfaces.
The rule used to live in `cli.js` alone, where `gemini-set-config` did not pass it: a model told to store a backup level has no reason to read the stored state first.

**Default and backup may not become the same model**, and `findModelCollision` in `config.js` rejects that before anything is written.
Were they equal, no fallback would take place at all: `runSearch` refuses it with "it is the same model as the default" - a safety net that only fires on the next failing call, leaving the backup silently dead until then.

The check runs on the state the write **would produce**, not on the individual argument, because this handler is the only place that can set both values in a single call - `{ model: "x", backupModel: "x" }` passes every per-argument check and still leaves the configuration broken.
The same function guards the CLI's `set-model`, `set-thinking --model` and `set-backup`; `set-thinking --model <id>` was the path that used to be missing one, which is why the rule now sits where all of them pass through rather than in each branch.

A call that names no model at all is let through even when the stored values already collide - it did not cause that state, and blocking it would stop exactly the commands that have nothing to do with it.

The confirmation names the full path, and the call sits inside a `try`/`catch`: the target directory is only created when saving and may be unwritable depending on permissions or a relocated `%APPDATA%`.
Without the `catch`, a write error would escape the handler uncaught instead of arriving at the client as an `isError` response.

```javascript
server.registerTool(
  "gemini-set-config",
  {
    inputSchema: z.object({
      model: z
        .string()
        .optional()
        .describe(
          "Model ID, e.g. gemini-flash-latest or a pinned model such as gemini-3.5-flash",
        ),
      thinkingLevel: z
        .enum(["minimal", "low", "medium", "high"])
        .optional()
        .describe("Reasoning depth of the model"),
      backupModel: z
        .union([z.string(), z.literal(false)])
        .optional()
        .describe("Model to retry the same request with; false switches it off"),
      backupThinkingLevel: z
        .enum(["minimal", "low", "medium", "high"])
        .nullable()
        .optional()
        .describe("Reasoning depth of the backup model"),
      deadlineSeconds: z
        .union([z.number().int().positive(), z.literal(false)])
        .optional()
        .describe("Seconds after which Google aborts a search; false sends none"),
    }),
    // annotations and _meta: see "Tool annotations"
  },
  async ({ model, thinkingLevel, backupModel, backupThinkingLevel, deadlineSeconds }) => {
    // at least one parameter is required, otherwise an error
    // findModelCollision and findBackupLevelProblem before writing - see config.js
    // merge instead of overwrite, except for the backup unit - see config.js
    const saved = setSavedConfig({
      model,
      thinkingLevel,
      backupModel,
      backupThinkingLevel,
      deadlineSeconds,
    });
    return {
      content: [
        {
          type: "text",
          text: `Saved to ${CONFIG_PATH} - ${formatSavedValues(saved)}\n\n` + formatConfigState(),
        },
      ],
    };
  },
);
```

### Reporting what was saved

Every save answers two different questions, and both are needed:

```text
Saved - Backup: gemini-3.5-flash, Backup thinking level: inherited from the call

Default:  gemini-flash-latest · high
Backup:   gemini-3.5-flash · high (inherited)
Deadline: 300 s
```

`formatSavedValues` names each value that was written.
That line exists because a stored value would otherwise be indistinguishable from a discarded parameter - the failure it was introduced against.
It runs on the **return value** of `setSavedConfig`, not on the arguments, so a level dropped by the unit rule appears rather than vanishing silently.

`formatConfigState` names the complete stored state.
Without it, a change would have to be followed by `config` to find out what the next query actually runs with, and that gap is exactly where somebody ends up working with a model they did not mean.
For the MCP server this line is what satisfies the working rule in `CLAUDE.md` that a model change is confirmed by naming the default now in force.

Both functions live in `config.js` and are used by the CLI and the MCP handler alike, which differ only in their prefix.
Two separate copies would drift, and then the same change would say different things depending on which interface made it.

On the backup, the inherited level is printed as its value rather than as the bare word "inherited": what the backup would run with if it stepped in right now is the information being asked for.
The suffix says the value is not its own but travels along - a call carrying its own `thinkingLevel` is inherited instead.
The middle dot separates as it does in `formatSearchQueries`: model names contain hyphens and digits of their own, between which another hyphen would disappear.

#### A doubtful model warns after the save

After every write of a default or backup model, `checkModelIds()` in `models.js` looks the id up in `models.list`, which is free:

- not in the list - `"<id>" is not in the model list of this API key - a search with it will most likely fail.`
- in the list but unusable - `"<id>" cannot run here: <status>`, the same status as in `gemini-list-models` with `all: true`
- on the exclusion list - the reason from `models-excluded.js`

The model is saved all the same, and the warning follows the confirmation: on stderr in the CLI, as a `Warning:` paragraph in the MCP response.
The short list decides what is shown, not what is allowed, and an id the key does not list today may be listed tomorrow.
When the list cannot be fetched - offline, no key - there is no warning at all, so a save never fails on the check.
The text names no command, because both interfaces share it.

`gemini-grounding doctor` runs the same check on the saved models, next to the Node version, the readability of `config.json` and a `models.list` call that proves the key is accepted rather than only set.
Its config line comes from `configProblems()` in `config.js`, which collects the warnings of the very getters a search runs, so `doctor` cannot disagree with what a search actually does.

### Configuration file location

Not `./config.json`: the working directory of an MCP server started over stdio is not guaranteed to be the project folder.
But **no longer script-relative** either - that was right as long as the code was only ever cloned, and it becomes wrong with the npm release:

| Installation | Location of the script | Consequence for a file next to it |
| --- | --- | --- |
| `npm install -g` | `…/npm/node_modules/<package>/` | directory belongs to the package manager and is rewritten on update |
| `npx` | `~/.npm/_npx/<hash>/node_modules/…` | pure cache whose hash changes with the version - the setting would be effectively ephemeral |

Instead, the platform's conventional location for user state, resolved in this order:

1. `XDG_CONFIG_HOME` if set - the Linux convention and at the same time the
   escape hatch for anyone who does not want the default location.
2. On Windows `%APPDATA%` (falling back to `~/AppData/Roaming`), **not**
   `~/.config`.
3. Otherwise `~/.config`.

With `gemini-grounding-mcp/config.json` underneath, in each case.
An empty or relative `XDG_CONFIG_HOME` or `%APPDATA%` counts as unset, as the XDG Base Directory Specification demands: taken as it is, the file would move with the working directory, and every place the MCP server is started from would get its own configuration.

macOS is deliberately treated like Linux, even though the Apple standard would be `~/Library/Application Support/`: this is a terminal tool, and in the terminal nobody goes looking in a folder that Finder hides.
A separate `darwin` branch is explicitly not built in.

An additional environment variable of our own for the path was rejected - `XDG_CONFIG_HOME` covers the need, and every further variable is just one more place to check when asking "why is my model not saved?".

The directory is created exclusively on the write path (`mkdirSync` with `recursive` immediately before the `writeFileSync`).
That way the package creates nothing unasked: as long as nobody sets a model, neither the directory nor the file comes into existence, and `readConfig()` already handles the missing file.
Discoverability comes from the output rather than from the location - which is why `CONFIG_PATH` is exported, the confirmation from `gemini-set-config` names it, and `gemini-grounding config` displays it too.

Also rejected: being able to specify the model and thinking level **additionally** via `GEMINI_MODEL`/`GEMINI_THINKING_LEVEL`.
The code would have been two lines, but the price lies elsewhere - a second configuration source creates a precedence order that has to be explained, plus three surprising behaviours: a single `gemini-set-config` would have rendered the variable permanently ineffective, mixed states would arise (model from the file, level from the environment), and resetting would only work by deleting the file.
One source of truth it is: what the file says applies - otherwise the default.

An old, script-relative `config.json` is **not** migrated automatically.
Migration code would have to stay in the package permanently in order to handle a state that, before the first npm release, existed only for the handful of clone users.
It makes itself noticed anyway: after the update the footer shows the defaults again, and `gemini-grounding config` names the new path.
The way there is described in the README, and resetting costs a single call.

### Resolving the defaults per call

The `gemini-search` tool uses the stored values as defaults, provided nothing is passed explicitly on the call.
Resolution deliberately happens **at call time** rather than as a Zod `.default()` in the `inputSchema`: a schema default would be evaluated once when the tool is registered and then frozen, so `gemini-set-config` would only take effect after a server restart.
`model` and `thinkingLevel` are therefore `optional()` in the schema.

`resolveCallConfig` in `config.js` answers the question for the MCP handler and the CLI alike, so both give the same answer:

```javascript
export function resolveCallConfig({ model, thinkingLevel } = {}) {
  const backup = model === undefined ? getSavedBackup() : {};
  return {
    model: model ?? getSavedModel(), // "gemini-flash-latest" without config.json
    thinkingLevel: thinkingLevel ?? getSavedThinkingLevel(), // "medium" without config.json
    backupModel: backup.model,
    backupThinkingLevel: backup.thinkingLevel,
    deadlineSeconds: getSavedDeadline(), // 300 without config.json, no per-call override
  };
}
```

**A model named on the call gets no backup.**
Whoever names one wants that one - frequently in order to check whether it is reachable at all.
An answer from a different model does not answer that question, it hides it.

The rule is syntactic and applies even when the named model happens to equal the stored default: what counts is the explicit naming, not the value.
Otherwise the same call would behave differently depending on what is stored, and nothing about the call would show which.
An explicit `thinkingLevel` does not affect the fallback, because the model then still is the stored default.

The rule lives in this one function rather than in `runSearch`, which is what keeps `gemini.js` free of any notion of it: there, a backup is used if one was passed, and that is all.
As a pure function without network access, `resolveCallConfig` is also the only place where the rule can be tested at all (`test/resolve.test.js`) - through the CLI it would take a real API call to observe.

Actually implemented (including `setSavedConfig` and `getSavedBackup`) in `config.js` - see "Implementation" above.

`readConfig()` falls back to the defaults for **any** unreadable file, but it only stays silent about the missing one.
Before the first stored value there is no file, and the defaults are exactly what is wanted then.
Everything else - broken JSON after an interrupted write, missing read permissions - renders a stored setting ineffective, and without a word the server would simply keep running on the defaults while the setting had silently vanished.
Such a case therefore produces one warning naming the path and the original message.
A file that parses but holds no JSON object - `null`, an array, a number - counts as unreadable too: `null` would crash every getter, and an array swallows a write silently, because `JSON.stringify` drops properties set on it.

Writing is stricter than reading.
`setSavedConfig()` refuses with an error when the file exists but cannot be read, and nothing is saved.
Writing on top of the defaults would replace every stored value with the single one just set - from a hand-edited file with one surplus comma, model, backup and deadline would be gone.
Behind an MCP client nobody sees the warning on stderr, so the refusal arrives as the tool's error answer.
The write itself goes to a temporary file beside `config.json` and is then renamed over it, so an interrupted write leaves the old file intact instead of half a new one.

The warning goes to **stderr**, never to stdout: the MCP server speaks JSON-RPC over stdout, where a single stray line breaks the connection to the client.
A module-level set of the warnings already given limits each to one occurrence, because `readConfig()` runs four times per call - once for the model, once for the thinking level, once for the backup, once for the deadline. Without it the same warning would stand there four times over and look like four separate faults.

A readable file can still hold unusable values, and each one is checked on reading: the default model has to be a non-empty string, the default thinking level one of `THINKING_LEVELS`, and backup and deadline have their own checks.
An unusable value warns once and is replaced by its default.
An unknown level would otherwise come back as a 400, trigger the fallback, and hand the same unusable level on to the backup.

## MCP interface

### Serving both protocol revisions

The server is built on `@modelcontextprotocol/server` 2.x, the line of the MCP TypeScript SDK that has been stable since 2026-07-27.
The 1.x package `@modelcontextprotocol/sdk` implements the protocol only up to revision 2025-11-25 and is in maintenance; revision 2026-07-28 exists only in 2.x.

`index.js` does not connect a server to a transport itself but hands `createServer` to `serveStdio` from `@modelcontextprotocol/server/stdio`.
`server.connect(new StdioServerTransport())` would serve 2025-era clients only.
`serveStdio` reads the revision from the client's opening message - `initialize` for 2025-11-25, `server/discover` for 2026-07-28 - and builds one server for the connection from the factory.
Since SDK 2.3.0 a server object serves one connection at a time, so the factory is also the form the SDK expects.

Claude Code picks the revision itself: from v2.1.232 on, its v2 client runtime asks stdio servers whether they support 2026-07-28 and uses it when they do; `MCP_PROTOCOL_NEGOTIATION=legacy` keeps it on 2025-11-25.
Measured with Claude Code 2.1.310: `auto` opened with `server/discover` and ran every call on 2026-07-28, `legacy` opened with `initialize` on 2025-11-25.
In both, footer and source list arrived as before.
The results of `gemini-list-models`, of both error paths of `gemini-set-config` and of a request for a missing model are byte-identical to those of the 1.x server.

Three things differ on the wire, none of them in a tool result:

- The input schemas are announced as JSON Schema 2020-12 instead of draft-07; properties and descriptions are unchanged.
- 1.x announced `execution: { taskSupport: "forbidden" }` for every tool, 2.x leaves it out. The spec defines `"forbidden"` as the default when it is absent.
- A call whose arguments fail the schema gets a slightly different text from the SDK (`query: Invalid input: ...` instead of `Invalid input: ... at query`). That text comes from the SDK, not from this server.

The input schemas are passed as `z.object({...})`.
2.x still accepts a raw shape such as `{ query: z.string() }`, but only through a deprecated overload that wraps it with the SDK's own copy of Zod.
Zod has to be 4.2 or newer: with 4.0 and 4.1 the SDK falls back to a conversion that drops the `.describe()` texts, and the model loses every parameter description without any error.

`test/mcp.test.js` runs the real `index.js` over stdio in both revisions, without a key and without reaching the Gemini API, and checks among other things that every parameter description arrives.

### Tool annotations

Each tool tells the client what kind of action it is:

| Tool | `readOnlyHint` | `destructiveHint` | `idempotentHint` | `openWorldHint` |
| --- | --- | --- | --- | --- |
| `gemini-search` | `true` | - | - | `true` |
| `gemini-list-models` | `true` | - | - | `false` |
| `gemini-set-config` | `false` | `false` | `true` | `false` |

`destructiveHint` and `idempotentHint` only carry meaning when `readOnlyHint` is `false`, so the two read-only tools leave them out.
`gemini-list-models` is not open-world: `models.list` reaches Google, but returns only the closed set of models behind the API key, while a search can touch any page on the web.
`gemini-set-config` is idempotent because the same arguments always leave the same `config.json`, and not destructive because it only replaces values the user can set back.
The display name stays in the tool's `title` field, which the spec ranks ahead of `annotations.title`; the latter is not set.

The spec calls these values hints and says clients must not base security decisions on hints from untrusted servers.
What Claude Code does with them, according to its MCP documentation:

- `readOnlyHint: true` lets it run the tool's calls in parallel with other read-only calls. For `gemini-search` this means that several searches in one turn are several billed requests at the same time, which is intended.
- `readOnlyHint` or `idempotentHint` lets it repeat a call that was pending when a connection closed - but only for HTTP servers and claude.ai connectors, not for a stdio server like this one.

`gemini-set-config` additionally carries `_meta: { "anthropic/requiresUserInteraction": true }`, a key Claude Code defines outside the spec.
With it, Claude Code shows the permission prompt on every call, even in the `acceptEdits`, `auto` and `bypassPermissions` modes, offers no "don't ask again", and allow rules do not skip the prompt.
Where no person can answer - `dontAsk` mode, `claude -p` - the call is denied.
Measured with Claude Code 2.1.310: `claude -p --allowedTools mcp__gemini-grounding__gemini-set-config` answered "MCPTool requires permission"; without the key, the same call reached the server.
This is the technical counterpart of the rule in CLAUDE.md that default model, backup model and deadline change only on the user's explicit instruction: no agent and no script without a person can change the configuration through MCP.
The CLI (`gemini-grounding set-model ...`) is not affected, and other clients ignore the key.

`test/mcp.test.js` pins the annotations and the key.

## Transient errors and retries

Two of the errors the API returns are not defects: the request would have succeeded a moment later.
`429 RESOURCE_EXHAUSTED` is throttling, `503 UNAVAILABLE` is temporary overload on Google's side.
Only the second one has actually been observed here - three times in a row within a minute, each time with the message "This model is currently experiencing high demand".

### The SDK retries nothing unless told to

`@google/genai` ships a complete retry, but it is inactive by default.
`apiCall()` in `dist/index.mjs` begins with `if (!retryOptions) { return fetch(url, requestInit); }`, and `retryOptions` is only ever passed through from `clientOptions.httpOptions` - no default is set anywhere.
A plain `new GoogleGenAI({ apiKey })` therefore never repeats a request.

This is worth stating because the [Gemini troubleshooting guide](https://ai.google.dev/gemini-api/docs/troubleshooting) claims the official client SDKs "include automatic retry logic with exponential backoff by default" and then illustrates it with the Python SDK only.
For the JavaScript SDK the claim does not hold.

The server therefore configures it explicitly, as the exported constant `RETRY_OPTIONS` in `gemini.js`:

```javascript
export const RETRY_OPTIONS = {
  attempts: 4,
  httpStatusCodes: [408, 500, 502, 503],
};
```

Whether that configuration reaches the client is what `test/retry.test.js` checks, and it checks it at the behaviour rather than at the constant: it replaces the global `fetch`, so the number of calls is the number of attempts.
A 503 followed by a 200 has to produce exactly two of them.
Asserting that a list contains what it contains would stay true even with the `httpOptions` removed from `getClient()` - the one edit that would silently restore the old behaviour.

### Why 429 and 504 are missing from that list

Google's own default is `[408, 429, 500, 502, 503, 504]`.
Two entries are left out here, each for its own reason - and they are the only things about this configuration that are not self-evident.

On a 429 the API supplies the waiting time itself, as a `RetryInfo` entry inside `error.details`:

```json
{ "@type": "type.googleapis.com/google.rpc.RetryInfo", "retryDelay": "53s" }
```

The SDK does not read it.
The string `RetryInfo` does not occur anywhere in the bundle; the retryable codes are a flat membership list, so a 429 gets the same blind exponential backoff as any 5xx.
Against a demanded 53 seconds all four attempts would be spent after roughly 15 - long before the block expires.
The same behaviour in the Python SDK is tracked as [googleapis/python-genai#1875](https://github.com/googleapis/python-genai/issues/1875).

A 429 is therefore passed straight to the client, unchanged and immediately, instead of padding the response with waiting time that cannot help.

`504` is left out for a different reason, and only since this server sends a deadline of its own (see below).
A gateway timeout is then no longer predominantly Google's overload - it is that deadline expiring.
Retrying it would mean running the same generation to the deadline three more times and paying for each, because an aborted generation is billed all the same.
The two causes cannot be told apart here: the retry decision is made on the status code, long before anyone gets to see the `DEADLINE_EXCEEDED` in the body.
Of the two possible causes the expensive one is the more likely, so the list gives up the code.

For `500`, `502`, `503` and `408` no server-supplied hint exists - there, blind backoff is the only thing available and hence the right thing.
`408` is in the list for completeness: an expired deadline comes back as `504`, and a request that runs into nothing is aborted by Node without any HTTP status at all.
A genuine 408 would have to come from an intermediary.

Client errors are excluded for the ordinary reason: a broken request, an invalid key or a withdrawn model fails identically on the second try.
This matches Google's own guidance to retry only on `408`, `429` and `5xx`, never on `400` or `403`.

### What this costs in waiting time

`attempts` counts the initial call, so four attempts mean three repeats.
With the SDK defaults - `initialDelay` 1 s, `expBase` 2, jitter between factor 1 and 2 - the delays are roughly 1-2 s, 2-4 s and 4-8 s, adding **7 to 14 seconds** before the error surfaces.
The 60 s `maxDelay` cap never comes into play at these settings; it would first bind from the sixth repeat onwards.

The observed triple 503 spanned about half a minute, so a retry of this length would not reliably have rescued it.
The configuration reduces how often a transient error reaches the client; it does not remove the error class.

### The deadline this server does send

Three limits apply to a request, and since `@google/genai` 2.29 one of them is gone:

| Limit | Value | Effect |
| --- | --- | --- |
| Node (`headersTimeout`) | **306.8 s** measured, up to `@google/genai` 2.28 | Severed a silent connection and cut in first. Since 2.29 the SDK passes its own undici dispatcher with `headersTimeout: 0` and `bodyTimeout: 0` (`createUndiciNoTimeoutDispatcher`) |
| MCP client (Claude Code 2.1.224) | **1800 s** measured | Now the first limit on this side |
| Google without a deadline | 10 min for a unary request, per the SDK comment on `createUndiciNoTimeoutDispatcher` | Generates to that limit regardless |

Everything Google produces is billed whether or not anyone still receives it: input tokens in full once processing starts, output tokens up to the actual end of the run.
Only rejections before execution (`400`, `401`, `403`, `429`) are free.

`gemini.js` therefore tells the gateway a deadline of its own, as an ordinary header, 300 s unless configured:

```javascript
export const DEFAULT_DEADLINE_SECONDS = 300; // config.js
```

300 s sits below Google's own limit, so the header decides, and the failure arrives as a `504` with a reason.
Google honours the header as an execution deadline and does abort the generation server-side; the value goes out in whole seconds.
Up to `@google/genai` 2.28 the value was 290 s, just below Node's limit; with that limit gone, there is nothing left to stay under, and the round number applies.

**Configurable.** `deadlineSeconds` in `config.json` holds a whole number of seconds from 1 to `MAX_DEADLINE_SECONDS` (600), or `false` for no header at all - Google's own limit applies then.
It is set via `gemini-set-config` or `gemini-grounding set-deadline <seconds|off>`, and `false` is stored rather than deleted for the same reason as `backupModel: false`: deleting would bring back the default, the opposite of "off".
There is deliberately no per-call parameter: a call that could raise the deadline turns a `504` into an invitation to retry longer, and the deadline is an operating setting rather than part of a question.
For the same reason the tool description and the server instructions tell an agent to report a `504` instead of raising the deadline on its own.
An unusable value in a hand-edited file produces one warning on stderr and the default applies - unlike an unknown model, which comes back from the API as an error, a deadline nobody applies would show nowhere.
The cap is Google's own limit for a unary request: above it the value promises a limit that does not exist, while the local brake would only fire after it and the MCP client gives up after 1800 s.
A hand-edited whole number above 600 therefore warns and is read as 600, not as the default - whoever wrote 3600 wanted the longest deadline there is.

**The local brake.** Without Node's limit, a request that runs into nothing - a silent line, no answer, no error - waited until the MCP client gave up after 1800 s.
`generate()` therefore arms an `AbortController` at the deadline plus `LOCAL_BRAKE_MARGIN_SECONDS` (30 s) and passes its signal as `config.abortSignal`.
The error then reads:

```text
Error in gemini-search: no response within 330 s - aborted locally (deadline 300 s + 30 s margin)
```

The SDK's retry stops on an aborted signal (`onFailedAttempt` in `apiCall()` rethrows), and the backup is not tried (`backup not tried: no response within 330 s`): the request may well have reached the API, and nothing says the line is any better for a second model.
A backup that steps in after a different error gets a brake of its own rather than what the default left over.
Without a deadline there is no brake either; whoever switched the deadline off waits for Google's own limit.

The brake covers one `generate()` call as a whole, because the SDK passes `config.abortSignal` to every continuation hop and every retry.
A late hop of a continued answer can therefore be cut off while Google still computes and bills it (see "Automatic continuation").
Arming one brake per hop would mean steering the continuation in this server instead of the SDK, including the merge, and it would leave the total duration unbounded.
`AbortController` plus `setTimeout` rather than `AbortSignal.timeout()`, because the tests advance `setTimeout` with `mock.timers` instead of waiting 330 real seconds.

**Deliberately not via `httpOptions.timeout`**, even though the SDK builds the same header from it.
That option produces a client-side `AbortController` from the **same** value - a second clock, racing Google's answer.
Which one wins is chance, and when the local one wins, what surfaces is `This operation was aborted` instead of the reason.
The local brake does not bring that race back: 30 s apart, Google's `504` arrives first whenever the line is alive, and the brake catches only the line that is not.

The 306.8 s measured up to 2.28 were undici's `headersTimeout` of 300 s plus connection setup - the wait for the response headers, not the total duration.
Since `generateContent` does not stream, both amounted to the same thing - Google answers in one piece once generation is done.

Setting `httpOptions.headers` does not replace the SDK's own headers: `patchHttpOptions()` merges both objects with `Object.assign`, so `User-Agent` and `Content-Type` survive.
`test/retry.test.js` asserts that in the same case as the deadline itself - if the merge were a replacement, the requests would fail at the server and no test would have noticed.
Up to 2.28 a hang was accepted rather than paid for with a second clock; since Node's limit is gone, the brake above takes its place.

### What reaches the client when a request fails

An MCP tool can return a single line of text. Which line that is decides whether the calling agent can explain anything to the user.

For an `ApiError` this is unproblematic: its `message` carries the raw JSON body of the error response and thus code, status and Google's own wording.
A network error is the opposite case. In Node every one of them is called `fetch failed` - refused connection, unknown host, timeout, all the same two words - and what actually happened lives solely in `error.cause`, which a single line would drop.

`describeError()` in `gemini.js` therefore appends the cause, with its code where one exists (measured: `bad port` supplies none, `ECONNREFUSED` does):

```text
Error in gemini-search: fetch failed (UND_ERR_HEADERS_TIMEOUT: Headers Timeout Error)
```

That example is the measured one, not an invented illustration: it is what the 306.8 s abort above produced up to `@google/genai` 2.28.
Since 2.29 a silent request ends at the local brake instead, whose message needs no cause.

`test/errors.test.js` checks this against a **real** `fetch` error rather than a hand-built one - the shape of `error.cause` is an assumption about the runtime and is best verified against it.

Such an error is **not** retried, which is worth stating because the opposite is the natural assumption - measured, it surfaces in well under a second.
p-retry 4.6.2 stops on any `TypeError` whose message is not one of four hardcoded browser wordings (`Failed to fetch`, `NetworkError when attempting to fetch resource.`, `The Internet connection appears to be offline.`, `Network request failed`).
Node throws `TypeError: fetch failed`, which is not among them.

The retry configured above therefore covers the API's status codes only.
A DNS hiccup or a reset connection reaches the client immediately and unrepeated - which makes the message that reaches it the only thing it has to go on.

### The optional backup model

The retry reduces how often a transient error reaches the client; it does not remove the error class.
The observed triple 503 outlasted all four attempts.
What remains after that is a second model - because the overload is observably **model-dependent**, apparently even between an alias and the model it points to.

**Opt-in.** Without a configured `backupModel` nothing changes: the error goes out exactly as before.
That is what keeps the working rule "no automatic fallback without asking" intact - the user names the evasive model in advance, and every call that used it says so in the footer.

Sequence in `runSearch`, once the SDK has exhausted its four attempts:

1. `error.status` against `NO_FALLBACK_STATUS`; a network error carries no status and drops out by itself
2. same request to `backupModel`, with `backupThinkingLevel ?? thinkingLevel`
3. the SDK's retry applies again automatically, because it hangs on the client rather than on the call
4. if that fails too: one error naming both models and both causes

#### Which errors trigger it

A **negative list**, and that is the actual decision here.
An unknown future error code gets the fallback automatically, instead of dropping silently through a positive list.

```javascript
export const NO_FALLBACK_STATUS = [401, 403, 504];
```

The three exceptions come from two different reasons.
`401` and `403` are **hopeless**: both hang on the API key, and the second call uses the same one, so the model cannot possibly be the cause.
`504` is **too expensive**: on this server it is usually the server's own deadline, hence a generation that ran in full and is billed. A fallback would double it and add the whole deadline again - 300 seconds by default.

Deliberately **not** the same list as `RETRY_OPTIONS`.
The two answer different questions - the retry "does waiting help?", the fallback "can a different model be the difference?".
On `429` the answers diverge: waiting achieves nothing, because the SDK ignores Google's `retryDelay`, while switching achieves something at once, because quotas count per model.
`test/fallback.test.js` pins that divergence down, because the two lists look similar enough to be "tidied up" into one.

One measured detail defeats the status code as the sole criterion: **an invalid API key does not arrive as 401 or 403 but as a `400 INVALID_ARGUMENT`** carrying `API key not valid`.
A 400 otherwise does justify a fallback - behind it can be a model that does not know the thinking level, and that another model accepts the same request is precisely the proof.
The key, however, applies to both.
This one case is therefore recognised by `reason: "API_KEY_INVALID"` in `error.details`, the only place where this server evaluates anything below the status code.

#### What the footer says

The `🤖` field is correct after a fallback all by itself, because `formatFooter` receives the model and level that actually ran.
It only shows **what** answered, though, not that anything went wrong - hence the extra line:

```text
🔁 gemini-flash-latest does not exist (404) - answered by backup. Update your default.
```

Three codes get a suffix, because with them there is something **to do**:

| Trigger | Line |
| --- | --- |
| 404 | `does not exist (404) - answered by backup. Update your default.` |
| 429 | `hit its quota (429) - answered by backup.` |
| 400 | `rejected the request (400) - answered by backup. Check the thinking level of your default model.` |
| everything else | `failed (503 UNAVAILABLE) - answered by backup.` |

Without that distinction, a permanent 404 reads like a transient glitch and nobody ever fixes the broken default.
The 400 is the only one where the line performs real diagnosis.

Position inside the footer, for three reasons: the footer stays the last component, nothing from the server comes between the answer and its links (see "Where the server adds or rearranges content"), and the line sits right next to the `🤖` field it explains.

#### The three cases without a footer

When no fallback happens there is no answer, so there is no footer either - the reason has to travel in the error message.
Without it, the unanswerable question "why did my backup not kick in?" is what remains:

- **both failed** - both errors, each with its model in front of it. With only the second one there, you would go looking at the wrong model. Built through the existing `describeError()` on both, so the `cause` of a network error survives
- **fallback deliberately skipped** - `backup not tried: …` plus the reason, for the exceptions above
- **backup identical to the default** - a configuration mistake; every write path rejects it beforehand (`findModelCollision`, see "gemini-set-config"), and `runSearch` catches it a second time, because a hand-edited `config.json` reaches no write path at all

A model named explicitly on the call is **not** among these cases and gets no note.
`resolveCallConfig` then simply passes no backup, and that a self-named model is not replaced comes as no surprise to the caller.

### Why the retry does not appear in the footer

Unlike the fallback, which is this server's own control flow and therefore observable, the repeats happen inside the SDK and leave no trace.
Neither `ApiError` nor the successful `HttpResponse` carries an attempt count, and `HttpOptions` offers no transport or fetch hook that could observe one - it exposes `baseUrl`, `baseUrlResourceScope`, `apiVersion`, `headers`, `timeout`, `extraBody` and `retryOptions`, nothing else.

Counting them would mean wrapping the global `fetch` and propagating a per-call context through `AsyncLocalStorage`, because several `gemini-search` calls can run in parallel and a global counter would mix them up.
That was judged out of proportion to a footnote, so the footer reports model, thinking level and token usage as before - and the possible extra seconds are documented here instead.

### Cancellation by the client

When the user cancels a running `gemini-search` (Esc in Claude Code), the client sends `notifications/cancelled`.
The MCP SDK turns that into the `AbortSignal` at `ctx.mcpReq.signal`, and the handler passes it to `runSearch()`.

- `generate()` combines it with the local brake through `AbortSignal.any()`, so either one ends the request.
  The request and every SDK retry stop at once, because the SDK hands the same signal to each attempt.
- `generate()` checks only the brake's own signal for `LocalDeadlineError`, so a cancellation is never reported as an expired deadline.
- `runSearch()` tries no backup once the client's signal has fired.
  Nobody waits for the answer any more, and the backup would be a second billed request for it.

Before this, a cancelled search ran on for up to 330 s, and if the default model then failed, the backup started a second billed request that nobody would ever read.

Not measured: whether Google still bills a generation that is already running when the connection is cut.
What is certain is that the connection, the retries and the backup stop.
Pinned by `test/fallback.test.js` and, over the real stdio transport in both protocol revisions, by `test/mcp.test.js`.

## Weekly dependency update

Dependabot only opens pull requests; nothing merges them on its own.
Once a week, on Tuesday morning, `.github/workflows/weekly-update.yml` runs `scripts/weekly-update.js`, which tests the open ones against the live API and merges what passes.
The workflow can also be started by hand, optionally as a dry run that tests and reports without merging and without a billed search.

### Order and limit

1. **GitHub Actions updates**, merged without a smoke test: they only change how CI runs and never reach the server.
2. **All npm minor, patch and security updates together**, with one smoke test.
3. **npm majors one at a time**, oldest first, with one smoke test each, so a broken major is attributable.

A run uses at most three smoke tests (`MAX_SMOKE_TESTS`), and whatever is left waits for the following week.
If nothing needed testing, main itself is tested once, which catches changes on Google's side such as a retired model or a moved alias.

The grouping in `.github/dependabot.yml` is shaped for this order.
Minor and patch updates form one group, majors deliberately none, so each major arrives as its own pull request.
Security updates have a group of their own, because for npm they are the only path by which transitive dependencies are ever updated - version updates leave those alone.

Majors are recognised the way `dependabot/fetch-metadata` does it: from the `update-type` lines of Dependabot's commit message, and where those are missing, as with security updates, from the versions in the `Bumps …` and `Updates …` lines.
Below 1.0 a change of the second number counts as a major, as SemVer allows breaking changes there.
A head commit without any of this was pushed by someone else and counts as a major, so it is tested on its own rather than slipped into the batch.

### Test before merge

The candidates are stacked locally onto the current main in the order above, and each step runs `npm ci`, `npm test` and the smoke test on exactly that tree.
GitHub's squash merge of a conflict-free pull request produces the same tree, and `--match-head-commit` refuses a pull request whose head moved since, so what was tested is what lands.
A pull request that conflicts is skipped; Dependabot rebases it on its own and it comes up the following week.
The first failure ends the testing, because every later step would build on it.

| Verdict | What happens |
| --- | --- |
| passed | merged |
| broken | left open with the label `weekly-update-failed` and a comment linking the run; the run fails, so GitHub sends an e-mail |
| unavailable | nothing is marked, the run stops and the following week tries again |

"Unavailable" covers a smoke test that hit 408, 429, 5xx or a network error, and a failing `npm ci`: an overloaded Google or registry says nothing about the update.

A failed pull request is skipped only while its head commit is unchanged - the comment records that commit.
A new version or a rebase by Dependabot is therefore tried again without anyone having to remove the label, which matters because nobody may be watching for weeks.

### Two jobs as a security boundary

Testing executes the code of the updates under test - `npm ci`, `npm test` and the smoke test all run it - so the job that tests must never hold a token that can write to the repository.
Removing the token from a child process's environment would not be enough, because on Linux a child can read its parent's environment from `/proc`.
The workflow therefore splits the run:

| Job | Token | Runs dependency code | Does |
| --- | --- | --- | --- |
| `test` | read-only | yes | stacks, tests, writes a plan of what passed and what failed |
| `merge` | write | no - no `npm ci`, Node built-ins only | merges and marks according to the plan |

The `test` job checks out without stored credentials (`persist-credentials: false`), since code under test could read them from `.git/config`.
`npm ci` runs with `--ignore-scripts`: no dependency needs its install script at runtime - the one present, in `protobufjs`, only checks its own command-line tooling.

The plan comes from the job that ran the code under test, so `merge` checks it rather than trusting it.
Each entry must be an open pull request by Dependabot whose head is still the tested commit.
At worst a tampered plan merges a genuine Dependabot update untested, and branch protection still demands that pull request's own green `Tests` check.

### Model list drift

The same workflow checks the key's model list every week, independently of the updates, through `scripts/model-drift.js`.
It costs nothing: `models.list` is not billed.
The full probe that decides what goes on the exclusion list costs about 33 billed requests and stays a manual run of `scripts/probe-models.js`; this check only says when one is due.

It reports two things, both from `findModelDrift()` in `models.js`:

- **stale** - exclusion entries whose model is no longer in `models.list` (`staleEntries()`, shared with `probe-models.js`)
- **unprobed** - models offered here that `test/fixtures/models-list.json` does not contain. A new model passes `isUsableModel()` and is offered at once, untried, which is how two models that fail with `400` reached the short list in August 2026

The split follows the boundary above.
`drift` runs `npm ci --ignore-scripts` and the SDK with the Gemini key and a read-only token, and passes its result on as a job output.
`drift-report` holds `issues: write`, runs no dependency code and checks the result rather than trusting it: model ids only, nothing that could carry markup or mentions into the issue.
It then writes into a single issue titled "Model list drift" and changes nothing else; without drift, and on a dry run, it does nothing.
If an issue with that title is open, the new finding is added to it as a comment, so earlier weeks stay readable; otherwise a new issue is opened.
A closed issue counts as done and is never reopened.

The open issue is found by listing the open issues and filtering by title, not through `--search`: the search index lags behind, and measured, an issue opened three seconds earlier was not found, so a second one was opened next to it.

### Branch protection

The required check is `Tests`, a job in `test.yml` that depends on the Node matrix and the Markdown lint.
Matrix jobs report under their own names (`Node 22`, …), so a matrix alone never delivers a check called `Tests` - that mismatch kept every Dependabot pull request blocked from September 2026 until the job existed.
The job runs with `if: always()`, because a skipped required check counts as passed.

"Require branches to be up to date before merging" is off, deliberately.
The weekly run merges with the workflow's `GITHUB_TOKEN`, and events caused by that token start no further workflow runs.
After the first merge, the next pull request would need a fresh CI run that nothing could start.
The test of the merged tree takes over that role.

### The smoke test

`scripts/smoke-test.js` (`npm run smoke`) checks the server the way Claude Code uses it, through the MCP protocol: handshake on revision 2026-07-28, tool list, `gemini-list-models`, one grounded search at thinking level `low`, and one request for a model that does not exist.
The unit tests stop short of exactly this - they run without a key against stubbed responses, so an update that changes the shape of real responses or errors passes them.
The smoke test uses only revision 2026-07-28, the one Claude Code prefers; revision 2025-11-25, the annotations and the parameter descriptions are covered by `test/mcp.test.js` on every CI run at no cost.

Only the search is billed.
`models.list` is free, and the request for the missing model is rejected with 404 before execution, which makes the error path testable at no cost.
On the Paid Tier the search comes out of the 5,000 free search requests per month shared by Gemini 3 and newer models; the tokens cost a fraction of a cent.

The script prints check names and verdicts, never the answer text or the sources (invariant I4, see "Terms compliance"): GitHub keeps the CI log, so printing a Grounded Result there would write it to disk.
The Gemini key is the one secret the code under test necessarily sees, since the smoke test runs that code against the API.
It therefore gets a key of its own, restricted to the Generative Language API, rather than the key used for everyday searches.
`npm ci` and `npm test` get an environment without any token or key.
