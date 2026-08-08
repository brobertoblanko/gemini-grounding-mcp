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
- `@modelcontextprotocol/sdk` - the official MCP SDK (Anthropic)

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
  `server.registerTool(...)`, sets up the stdio transport.
- `gemini.js` - wraps the `GoogleGenAI` call including the three combined
  built-in tools, builds the source list and footer from the API response.
- `citations.js` - inserts the citation markers into the response text. Its own
  file because this is the only code in the project that is **fully testable
  without network access and without an API key**: text and metadata go in, text
  comes out - no `getClient()`, no configuration, no randomness. Tested against
  a stored real response in `test/citations.test.js` (`npm test`, via Node's
  built-in test runner, without an additional dependency).
- `config.js` - reads and writes the persistent model choice in a `config.json`
  at the platform's conventional location for user state (see "Configuration
  file location" below).
- `cli.js` - a second frontend on the same core: the same exports from
  `gemini.js` and `config.js` that `index.js` uses, reachable from the command
  line. Without an additional dependency (a `switch` over `process.argv` is
  enough), without a second home for the API key. Two deliberate differences
  from the MCP server: runtime errors are printed with a full stack trace
  instead of being condensed into a single line for the client as in
  `index.js`, and output goes to stdout - which would be impossible with the
  stdio transport, because JSON-RPC runs over it. Invocation and subcommands:
  see the README.

  The error is still caught via `try`/`catch` even though the output stays the
  same: if Node terminates the process hard because of an unhandled rejection
  while a network connection is still open, libuv on Windows aborts with
  `Assertion failed ... src\win\async.c`, and the process ends with
  `0xC0000409` instead of code 1. Hence `console.error(error)` - identical to
  Node's own output - followed by `process.exitCode = 1` rather than
  `process.exit()`, so that Node shuts down normally.

  This holds **without exception**: `cli.js` contains no `process.exit()`. A
  usage error throws a `UsageError` instead, which the same `catch` block picks
  up and prints with its message only - a stack trace is pointless for a typo on
  the command line. A second argument against `process.exit()`: on Windows,
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
  for the complete one. Every subcommand rejects surplus arguments.

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
  so a stored value is never indistinguishable from a discarded one.

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
- In the MCP SDK the connection is established via
  `await server.connect(transport)` (not the other way round).
- `server.registerTool(name, { title?, description?, inputSchema }, handler)`
  is the currently recommended API; `inputSchema` accepts both a raw shape
  object (`{ query: z.string() }`) and a full `z.object({...})`.

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
  target position falls into one, the marker is discarded. Indented code blocks
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

const footer =
  `\n\n---\n🔢 ${inputTokens} input / ${outputTokens} output / ${thinkingTokens} thinking tokens ` +
  `| 🔍 ${sources.length} sources | 🤖 ${model} (thinking: ${thinkingLevel})${droppedNote}${skippedNote}` +
  formatSearchQueries(searchQueries);

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
🔢 245 input / 89 output / 40 thinking tokens | 🔍 2 sources | 🤖 gemini-flash-latest (thinking: high)
🔎 Searched: gemini api models list · google genai sdk models.list pagination
```

The number of dropped markers belongs in the footer because it changes how much the response can be relied on: if a marker is missing, the passage may be ungrounded - or the verification discarded it.
That matches the purpose of the footer, which is to make the actual state of each individual call visible.

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

Actually implemented in `gemini.js` (`buildText`, `formatNotice`, `buildSourceList`, `formatSourcesBlock`, `formatFooter`, `formatSearchQueries`) and `citations.js` (`insertCitations`).
`buildSourceList`, `formatSourcesBlock`, `formatFooter` and `formatSearchQueries` are exported and, like `insertCitations`, testable without an API key (`test/sources.test.js`, `test/search-queries.test.js`).
`gemini.js` can be imported without `GEMINI_API_KEY` because `getClient()` is only called inside `runSearch` and `listModels`, not at module load.

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
| I4 | Nothing is cached | Grounded Results never touch the disk; `config.json` holds the model name and thinking level, nothing else |

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

The MCP server offers two additional tools for setting the default model and the default thinking level persistently, without having to edit the code.

### gemini-list-models

Fetches the models available to the current API key, including token limits, via the official `models.list` endpoint ([API reference: Models](https://ai.google.dev/api/models)).
The SDK's pager fetches further pages on its own; `pageSize` only determines the size of the individual request, not the total count.

**Filtered by default.**
The key exposes considerably more models than work here - 58 in total at the time of this measurement, 32 of them usable.
Filtering goes through two pieces of information that every model reports itself:

| Field | Condition | Otherwise |
| --- | --- | --- |
| `supportedActions` | contains `generateContent` | model produces no text - embeddings, Imagen, Veo, Live/Audio |
| `thinking` | `true` | `400 Thinking level is not supported for this model.`, since `runSearch` always sends a `thinkingConfig` |

Both fields are documented in the SDK's `Model` interface.
Deliberately **not** filtered by name patterns: Google assigns code names that say nothing about capabilities (`nano-banana-pro-preview` is an image model), so any list of patterns goes stale with the next model family.

Limits the filter does not resolve:

- It separates technical usability, not suitability. Image, speech and robotics
  models partly satisfy the conditions as well.
- **Listed does not mean available.** Deprecated models stay in the response and
  return `404 ... is no longer available` when used - demonstrable on the 2.0
  generation. A field that would indicate this state up front does not exist.

`all` is therefore not merely a convenience switch: since the list gives no guarantee anyway, the filtered view must never be the only one.
`all: true` shows the complete list with a status column.
If the filter yields no model at all - because the API no longer provides the fields being evaluated, say - `listModels` falls back to the complete list on its own and says so in the notice text, rather than producing empty output.

### gemini-set-model

Stores the model ID and/or thinking level persistently in a `config.json` (location see below).
The two values can be set independently of one another - a merge makes sure that setting one does not overwrite the other already-stored value.
This choice survives server restarts until it is changed again.

The confirmation names the full path, and the call sits inside a `try`/`catch`: the target directory is only created when saving and may be unwritable depending on permissions or a relocated `%APPDATA%`.
Without the `catch`, a write error would escape the handler uncaught instead of arriving at the client as an `isError` response.

```javascript
server.registerTool(
  "gemini-set-model",
  {
    inputSchema: {
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
    },
  },
  async ({ model, thinkingLevel }) => {
    // at least one parameter is required, otherwise an error
    setSavedConfig({ model, thinkingLevel }); // merge instead of overwrite, see config.js
    return {
      content: [
        {
          type: "text",
          text: `Saved - model: ${model}, thinking level: ${thinkingLevel}`,
        },
      ],
    };
  },
);
```

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

macOS is deliberately treated like Linux, even though the Apple standard would be `~/Library/Application Support/`: this is a terminal tool, and in the terminal nobody goes looking in a folder that Finder hides.
A separate `darwin` branch is explicitly not built in.

An additional environment variable of our own for the path was rejected - `XDG_CONFIG_HOME` covers the need, and every further variable is just one more place to check when asking "why is my model not saved?".

The directory is created exclusively on the write path (`mkdirSync` with `recursive` immediately before the `writeFileSync`).
That way the package creates nothing unasked: as long as nobody sets a model, neither the directory nor the file comes into existence, and `readConfig()` already handles the missing file.
Discoverability comes from the output rather than from the location - which is why `CONFIG_PATH` is exported, the confirmation from `gemini-set-model` names it, and `gemini-grounding config` displays it too.

Also rejected: being able to specify the model and thinking level **additionally** via `GEMINI_MODEL`/`GEMINI_THINKING_LEVEL`.
The code would have been two lines, but the price lies elsewhere - a second configuration source creates a precedence order that has to be explained, plus three surprising behaviours: a single `gemini-set-model` would have rendered the variable permanently ineffective, mixed states would arise (model from the file, level from the environment), and resetting would only work by deleting the file.
One source of truth it is: what the file says applies - otherwise the default.

An old, script-relative `config.json` is **not** migrated automatically.
Migration code would have to stay in the package permanently in order to handle a state that, before the first npm release, existed only for the handful of clone users.
It makes itself noticed anyway: after the update the footer shows the defaults again, and `gemini-grounding config` names the new path.
The way there is described in the README, and resetting costs a single call.

### Resolving the defaults per call

The `gemini-search` tool uses the stored values as defaults, provided nothing is passed explicitly on the call.
Resolution deliberately happens **in the handler at call time** (`model ?? getSavedModel()`) rather than as a Zod `.default()` in the `inputSchema`: a schema default would be evaluated once when the tool is registered and then frozen, so `gemini-set-model` would only take effect after a server restart.
`model` and `thinkingLevel` are therefore `optional()` in the schema.

```javascript
function getSavedModel() {
  return readConfig().model ?? FALLBACK_MODEL; // "gemini-flash-latest" without config.json
}

function getSavedThinkingLevel() {
  return readConfig().thinkingLevel ?? FALLBACK_THINKING_LEVEL; // "medium" without config.json
}
```

Actually implemented (including `setSavedConfig`) in `config.js` - see "Implementation" above.

`readConfig()` falls back to the defaults for **any** unreadable file, but it only stays silent about the missing one.
Before the first stored value there is no file, and the defaults are exactly what is wanted then.
Everything else - broken JSON after an interrupted write, missing read permissions - renders a stored setting ineffective, and without a word the server would simply keep running on the defaults while the setting had silently vanished.
Such a case therefore produces one warning naming the path and the original message.

It goes to **stderr**, never to stdout: the MCP server speaks JSON-RPC over stdout, where a single stray line breaks the connection to the client.
A module-level flag limits it to one occurrence, because `readConfig()` runs twice per call - once for the model, once for the thinking level.

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

Three limits apply to a request, and only one of them decides. All three are measured, not estimated:

| Limit | Value | Effect |
| --- | --- | --- |
| Node (`headersTimeout`) | **306.8 s** measured | Severs the connection - **cuts in first** |
| MCP client (Claude Code 2.1.224) | **1800 s** measured | Six times more patient, never reached |
| Google without a deadline | none | Generates to the end regardless |

Node cuts first, so everything Google produces beyond that point can no longer be received by anyone.
Billed it is all the same: input tokens in full once processing starts, output tokens up to the actual end of the run.
Only rejections before execution (`400`, `401`, `403`, `429`) are free.

`gemini.js` therefore tells the gateway a deadline of its own, as an ordinary header:

```javascript
export const SERVER_DEADLINE_SECONDS = 290;
```

290 s sits just below Node's limit, so Google stops before the line is cut - and the failure arrives as a `504` with a reason instead of a bare connection abort.
Google honours the header as an execution deadline and does abort the generation server-side; the value goes out in whole seconds.

**Deliberately not via `httpOptions.timeout`**, even though the SDK builds the same header from it.
That option produces a client-side `AbortController` from the same value - a second clock, racing Google's answer.
Which one wins is chance, and when the local one wins, what surfaces is `This operation was aborted` instead of the reason.
A header alone has no second moving part.

The measured timer, incidentally, does not meter what its name suggests: `headersTimeout` is the wait for the response headers, not the total duration.
Since `generateContent` does not stream, both amount to the same thing here - Google answers in one piece once generation is done.

Setting `httpOptions.headers` does not replace the SDK's own headers: `patchHttpOptions()` merges both objects with `Object.assign`, so `User-Agent` and `Content-Type` survive.
`test/retry.test.js` asserts that in the same case as the deadline itself - if the merge were a replacement, the requests would fail at the server and no test would have noticed.
A hang is therefore accepted rather than paid for with three moving parts. What was kept from the attempt is the error message - see below.

### What reaches the client when a request fails

An MCP tool can return a single line of text. Which line that is decides whether the calling agent can explain anything to the user.

For an `ApiError` this is unproblematic: its `message` carries the raw JSON body of the error response and thus code, status and Google's own wording.
A network error is the opposite case. In Node every one of them is called `fetch failed` - refused connection, unknown host, timeout, all the same two words - and what actually happened lives solely in `error.cause`, which a single line would drop.

`describeError()` in `gemini.js` therefore appends the cause, with its code where one exists (measured: `bad port` supplies none, `ECONNREFUSED` does):

```text
Error in gemini-search: fetch failed (UND_ERR_HEADERS_TIMEOUT: Headers Timeout Error)
```

That example is the measured one, not an invented illustration: it is exactly what the 306.8 s abort above produces.

`test/errors.test.js` checks this against a **real** `fetch` error rather than a hand-built one - the shape of `error.cause` is an assumption about the runtime and is best verified against it.

Such an error is **not** retried, which is worth stating because the opposite is the natural assumption - measured, it surfaces in well under a second.
p-retry 4.6.2 stops on any `TypeError` whose message is not one of four hardcoded browser wordings (`Failed to fetch`, `NetworkError when attempting to fetch resource.`, `The Internet connection appears to be offline.`, `Network request failed`).
Node throws `TypeError: fetch failed`, which is not among them.

The retry configured above therefore covers the API's status codes only.
A DNS hiccup or a reset connection reaches the client immediately and unrepeated - which makes the message that reaches it the only thing it has to go on.

### Why the retry does not appear in the footer

The repeats happen inside the SDK and leave no trace.
Neither `ApiError` nor the successful `HttpResponse` carries an attempt count, and `HttpOptions` offers no transport or fetch hook that could observe one - it exposes `baseUrl`, `baseUrlResourceScope`, `apiVersion`, `headers`, `timeout`, `extraBody` and `retryOptions`, nothing else.

Counting them would mean wrapping the global `fetch` and propagating a per-call context through `AsyncLocalStorage`, because several `gemini-search` calls can run in parallel and a global counter would mix them up.
That was judged out of proportion to a footnote, so the footer reports model, thinking level and token usage as before - and the possible extra seconds are documented here instead.
