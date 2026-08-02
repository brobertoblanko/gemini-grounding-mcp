# Gemini Grounding MCP

[![npm version](https://img.shields.io/npm/v/@brobertoblanko/gemini-grounding-mcp)](https://www.npmjs.com/package/@brobertoblanko/gemini-grounding-mcp)
[![Tests](https://github.com/brobertoblanko/gemini-grounding-mcp/actions/workflows/test.yml/badge.svg)](https://github.com/brobertoblanko/gemini-grounding-mcp/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

Give Claude Code and other MCP clients current Google Search results through the
Gemini API - with inline citation markers, a source list, and the exact cost of
every single call.

Use it when an assistant needs web-grounded research instead of relying on
training data alone. It uses nothing but the official `@google/genai` and
`@modelcontextprotocol/sdk` packages: no community wrapper, no version silently
changing under you.

> **Scope of use:** research queries only. Not intended for production workloads
> or for connecting to sensitive systems.

## What an answer looks like

```text
The current Node.js release versions are as follows [1]:

* Latest LTS: v24.18.1 (recommended for most users)
* Latest Current release: v26.5.1

Sources:
[1] nodejs.org - https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQG52u...

---
🔢 30 input / 86 output / 0 thinking tokens | 🔍 1 sources | 🤖 gemini-flash-latest (thinking: minimal)
🔎 Searched: Node js latest LTS version
```

Five things are visible here that a plain search result does not give you:
which sentences are actually backed by a source, where those sources are, what
the call cost, which model produced it, and what the model actually typed into
Google.

## What makes it different

- **You choose the model and the thinking level.** Both are saved, both can be
  overridden for a single call, and both are resolved at call time - a change
  takes effect on the next request, not after a client restart.
- **Every claim carries a marker, or visibly does not.** The point is less
  *which* source backs a sentence than *whether* one does at all.
- **You see what it actually searched for.** The footer lists the queries sent
  to Google, which answers something no source list can: whether the search
  covered your question in the first place.
- **You see what each call cost**, split into input, output and thinking tokens,
  instead of finding out at the end of the month.
- **Truncated or blocked answers say so.** Without that check, an answer cut off
  at the token limit looks like a success, because the source list and footer
  are still printed underneath it.
- **No silent fallback.** If a model fails, you get the error - not a quiet
  switch to a different model that changes the answer's quality unnoticed.
- **Three Gemini tools in one call:** Google Search, URL Context for reading a
  page you name, and Code Execution. If code ran, the code and its result appear
  in the answer rather than just the number it produced.
- **One search tool, not five.** Variants that merely append fixed words to your
  query ("documentation", "reddit") are three more entries in the context window
  and one more thing to pick wrong, for a model that writes its own query anyway.

## Quick start

### 1. Set your API key

The key is passed exclusively through the `GEMINI_API_KEY` environment variable,
never in code and never in the config file. It has to be set **persistently**,
before the client starts the server.

**Windows (PowerShell, user scope, once):**

```powershell
[Environment]::SetEnvironmentVariable('GEMINI_API_KEY', '<your-api-key>', 'User')
```

Reopen the shell afterwards so the variable is available.

**macOS / Linux** - add to `~/.zshrc`, `~/.bashrc` or equivalent:

```bash
export GEMINI_API_KEY='<your-api-key>'
```

### 2. Register the server

Nothing to install up front: `npx` fetches the package on demand.

**Windows (PowerShell):**

```powershell
claude mcp add gemini-grounding -s user `
  -e 'GEMINI_API_KEY=${GEMINI_API_KEY}' `
  -- npx -y @brobertoblanko/gemini-grounding-mcp
```

**macOS / Linux (bash / zsh):**

```bash
claude mcp add gemini-grounding -s user \
  -e 'GEMINI_API_KEY=${GEMINI_API_KEY}' \
  -- npx -y @brobertoblanko/gemini-grounding-mcp
```

Write `${GEMINI_API_KEY}` in **single** quotes so your shell does not expand it
itself. Claude Code resolves it later, when it loads its configuration - that
way only the placeholder ends up in `~/.claude.json`, not the key in plain text.

### 3. Verify

```bash
claude mcp list
```

Then start a new conversation and ask something that cannot be answered from
training data alone:

- `"Which Node.js version is currently LTS?"`
- `"What changed in the Gemini API in the last few months?"`
- `"Read https://nodejs.org/en/about/previous-releases and tell me when Node 24 goes end-of-life"`

A working answer ends in a source list, citation markers such as `[1]` inside
the text, and the footer shown above. If the footer is missing, you are reading
the model's own memory rather than a grounded answer.

<details>
<summary>If no answer arrives at all</summary>

Run the same query through the [command line tool](#command-line-tool). It
prints the full error including the original Google API message, which the MCP
server has to condense into a single line for the client. An
`ApiError: {"error":{"code":503, ...}}` means the request did not get through to
Google, which is a different problem from a broken installation.

</details>

## Requirements

- **Node.js 22 or newer** - the oldest release still receiving security updates.
  Check with `node -v`. The dependencies would technically still run on Node 20,
  but it reached end-of-life in April 2026, so it is not supported here.
- **A Gemini API key**, available for free at
  [Google AI Studio](https://aistudio.google.com/apikey).
- **Claude Code** or any other MCP-capable client
  ([Model Context Protocol](https://modelcontextprotocol.io)).

**A note on cost:** Gemini API calls are not free in every case. There is a free
tier with rate limits; beyond that you are billed per token, and Google Search
grounding may be charged separately depending on model and plan. The official
[pricing](https://ai.google.dev/gemini-api/docs/pricing) and
[rate limit](https://ai.google.dev/gemini-api/docs/rate-limits) pages are
authoritative - both change regularly, which is why no concrete figures appear
here. The token footer under every answer makes the cost of each individual call
visible.

## Tools

- **`gemini-search`** - research via Google Search, URL Context and Code
  Execution in one call. The answer contains inline citation markers, a source
  list and a token footer. If Gemini executed code, the code and its result
  appear under `Code execution:` after the answer text - the calculation is
  evidence, so it belongs where the sources are. If the answer did not finish
  normally, a line marked ⚠️ says so along with the reason.
- **`gemini-list-models`** - lists the models available for your API key with
  their token limits. By default only those usable with this server; with
  `all: true`, every one.
- **`gemini-set-model`** - persists the default model and/or default thinking
  level (only those two values, never the API key).

## How the answer is built

### Citation markers

Markers such as `[1]` or `[1][3]` sit in the answer text at the positions for
which the API reports a source, using the same numbering as the source list at
the end.

The guarantee runs one way only: a marker that is present is reliable, a marker
that is missing is an indication, not proof. A sentence without a marker may
well come from the model's own memory rather than from the search - and that is
precisely the kind of sentence you would not want to write code against
unchecked.

<details>
<summary>How the verification works, and why markers get dropped</summary>

Markers are verified against the text segment the API supplies. If the computed
span does not match what the API names as the supported passage, the marker is
dropped rather than guessed. Whenever that happens, the footer says so - a
missing marker would otherwise be misread as "not backed by a source".

They are never placed inside code spans or fenced blocks. A `[3]` in the middle
of `copy.replace(obj, x=1)` would produce syntactically valid, factually wrong
code.

Sources are deduplicated and renumbered accordingly. The API returns search
hits, not sources: one measured answer had 17 hits for 14 unique URLs, and naive
numbering would have produced markers pointing nowhere.

Full details in [specs.md](https://github.com/brobertoblanko/gemini-grounding-mcp/blob/main/docs/specs.md).

</details>

### Which searches were actually run

The last line of the footer lists the queries Gemini sent to Google:

```text
🔎 Searched: nodejs current lts version 2026 · nodejs release schedule
```

This answers a question neither the source list nor the markers can: whether the
search covered your question at all.

<details>
<summary>The case that made this necessary</summary>

Asked to compare six web frameworks by version *and* bundle size, Gemini
searched six times for `<framework> current version` and once for bundle sizes.
Rendering strategy and learning curve were answered from its own knowledge.
Nothing in the answer itself gave that away - the source list was long and every
sentence looked equally well supported.

Very broad questions produce a lot of searches, so the line is capped at roughly
300 characters and ends with `(+n more)` when there were more. If the line is
missing entirely, no search was run.

</details>

## Command line tool

The server can also be driven without an MCP client - useful for checking that
your API key and model choice work before registering it, and for testing a
change during development without restarting the client.

| Command | Effect |
| --- | --- |
| `gemini-grounding "<query>"` | Search using the saved defaults; prints the answer including source list and token footer |
| `gemini-grounding config` | Shows the saved model, thinking level, whether an API key is present, and where the config file lives |
| `gemini-grounding models [--all]` | Lists the models usable with this server and their token limits; `--all` lists every one |
| `gemini-grounding set-model <id>` | Persists the default model |
| `gemini-grounding set-thinking <level>` | Persists the default thinking level (`minimal`, `low`, `medium`, `high`) |
| `gemini-grounding help` | Short help |

**Per-call overrides.** For a single call, model and thinking level can be set
differently without touching the saved defaults:

```bash
gemini-grounding "query" --model gemini-3-pro-preview --thinking minimal
```

Which values were actually used is shown in the footer under every answer.

**Shared configuration.** The CLI and the MCP server read and write the same
config file. A `set-model` in the terminal therefore also changes what the MCP
server uses on its next call - intentionally so, because it makes a model switch
possible without having to ask the client to do it.

Argument handling, error output, `npm link`, and migrating from an older clone:
see the [CLI documentation](https://github.com/brobertoblanko/gemini-grounding-mcp/blob/main/docs/cli.md),
also available [in German](https://github.com/brobertoblanko/gemini-grounding-mcp/blob/main/docs/cli.de.md).

## Client configuration

The commands in the quick start cover Claude Code. Other clients that support
local `stdio` servers need the equivalent entry in their own configuration:

```json
{
  "mcpServers": {
    "gemini-grounding": {
      "command": "npx",
      "args": ["-y", "@brobertoblanko/gemini-grounding-mcp"],
      "env": {
        "GEMINI_API_KEY": "${GEMINI_API_KEY}"
      }
    }
  }
}
```

**One caveat:** expanding `${GEMINI_API_KEY}` from the surrounding environment
is a Claude Code feature, not part of the MCP standard. A client without
variable expansion will send the placeholder to the API verbatim and the request
will fail. If yours does not expand variables, consult its documentation for how
it handles secrets rather than pasting the key here.

<details>
<summary>Installing globally or running from a clone</summary>

To install the package permanently instead of fetching it via `npx`:

```bash
npm install -g @brobertoblanko/gemini-grounding-mcp
```

This provides two commands: `gemini-grounding-mcp` starts the MCP server over
stdio, and `gemini-grounding` is the command line tool. Replace
`npx -y @brobertoblanko/gemini-grounding-mcp` with `gemini-grounding-mcp` in the
registration command above.

To work from the source:

```bash
git clone https://github.com/brobertoblanko/gemini-grounding-mcp.git
cd gemini-grounding-mcp
npm install
```

Then use `node <path-to-repo>/index.js` as the command. `claude mcp add` needs a
concrete absolute path that resolves on the machine in question.

</details>

## Data and privacy

Search queries, and anything included in a request, are sent to the Gemini API
and processed under Google's applicable terms and data handling policies.

This server adds no anonymization and no enterprise data isolation. Do not use
it with confidential, personal or regulated data unless you have verified that
the service terms and your configuration are appropriate for it.

## Configuration

`gemini-set-model` and the CLI's `set-*` commands write the default model and
thinking level to:

| Platform | Location |
| --- | --- |
| Linux, macOS | `~/.config/gemini-grounding-mcp/config.json` |
| Windows | `%APPDATA%\gemini-grounding-mcp\config.json` |
| Any, if `XDG_CONFIG_HOME` is set | `$XDG_CONFIG_HOME/gemini-grounding-mcp/config.json` |

Neither the file nor its directory is created until you save a setting for the
first time. Delete the file to return to the built-in defaults
(`gemini-flash-latest`, thinking level `medium`). It holds nothing but those two
values - **never the API key**. Run `gemini-grounding config` to see the exact
path on your machine.

## Which models are usable

Your API key exposes considerably more models than will work here. The model
list therefore shows, by default, only those that produce text
(`generateContent`) and accept a thinking level (`thinking: true`) - both taken
from what the API reports about each model, not from its name.

Two limitations are worth knowing:

- The conditions say what runs **technically**, not what is sensible for
  research. Some image, speech and robotics models meet them too.
- **Listed does not mean available.** Retired models stay in the list and answer
  with `404 ... is no longer available`. No field announces this in advance.

This is why `--all` / `all: true` hides nothing, but shows the complete list with
a status column instead.

<details>
<summary>Why the filter uses capabilities instead of name patterns</summary>

Filtering by name would be unreliable: Google assigns code names that say
nothing about capabilities - `nano-banana-pro-preview` is an image model.

The two conditions are checked because both are load-bearing. Without
`generateContent` in `supportedActions`, embedding, image (Imagen), video (Veo)
and live/audio models would appear in a list of models meant for research.
Without `thinking: true`, the API answers every search with
`400 Thinking level is not supported for this model.`, because this server sends
a thinking level on every call.

</details>

## Documentation

- [specs.md](https://github.com/brobertoblanko/gemini-grounding-mcp/blob/main/docs/specs.md) - architecture and design decisions, also [in German](https://github.com/brobertoblanko/gemini-grounding-mcp/blob/main/docs/specs.de.md)
- [cli.md](https://github.com/brobertoblanko/gemini-grounding-mcp/blob/main/docs/cli.md) - the command line tool in detail, also [in German](https://github.com/brobertoblanko/gemini-grounding-mcp/blob/main/docs/cli.de.md)
- [CLAUDE.md](https://github.com/brobertoblanko/gemini-grounding-mcp/blob/main/CLAUDE.md) - working rules for Claude Code in this repository (German)

## License

[MIT](./LICENSE)
