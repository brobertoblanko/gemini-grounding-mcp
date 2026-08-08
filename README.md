# Gemini Grounding MCP

[![npm version](https://img.shields.io/npm/v/@brobertoblanko/gemini-grounding-mcp)](https://www.npmjs.com/package/@brobertoblanko/gemini-grounding-mcp)
[![Tests](https://github.com/brobertoblanko/gemini-grounding-mcp/actions/workflows/test.yml/badge.svg)](https://github.com/brobertoblanko/gemini-grounding-mcp/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

Give Claude Code and other MCP clients current Google Search results through the
Gemini API - with inline citation markers and a numbered source list under every
answer.

Use it when an assistant needs web-grounded research instead of relying on
training data alone. It builds on nothing but the official `@google/genai` and
`@modelcontextprotocol/sdk` packages, pinned to exact versions.

> **Scope of use:** research queries only. Not intended for production workloads
> or for connecting to sensitive systems.

## What it offers

- **Citations you can check.** Markers such as `[1]` sit in the answer text,
  numbered to match the source list below it. A marker can be missing, but it is
  never placed where the API does not support it - so an unmarked sentence is a
  reason to look closer.
- **The queries Gemini actually ran.** The footer lists what was typed into
  Google, which answers what no source list can: whether the search covered your
  question at all.
- **Token usage for every call**, split into input, output and thinking tokens.
  What they cost is on Google's
  [pricing page](https://ai.google.dev/gemini-api/docs/pricing).
- **Model and thinking level are yours to set.** Both persist, both can be
  overridden for a single request, and both are read at call time, so a change
  applies to the next answer rather than after a client restart. The thinking
  level is the main lever on how many tokens a query consumes.
- **Failures stay visible.** An answer cut off at the token limit or stopped by a
  filter is marked as such, dropped citation markers are counted, and a failing
  model returns an error instead of a quiet switch to a different one.
- **Search, URL Context and Code Execution in one call.** Gemini can read a page
  you name and run code; if it did, the code and its output are part of the
  answer. The only instruction the server adds is today's date - what gets
  researched follows from your question.
- **A command line tool on the same core.** Verify your API key and model choice
  before registering the server, and read the full error text when a call fails.

## What an answer looks like

**Question:** `"Which Node.js version is currently LTS?"`

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

The redirect URL is abbreviated here for readability; the real output carries it
in full.

## Quick start

Nothing to install up front: the client starts the server through `npx`, which
fetches the package on first use and caches it - only that first call takes a
few seconds longer. A permanent install is optional and mainly of interest for
the [command line tool](#command-line-tool) (see
[Installing globally](#installing-globally)).

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

Then start a new conversation and ask `"Which Node.js version is currently
LTS?"`. The reply should look like the
[example above](#what-an-answer-looks-like): citation markers in the text, a
source list, and the footer. The server appends that footer to every answer it
produces, so if there is none, the tool was not called at all and you are
reading the model's own memory.

<details>
<summary>If no answer arrives at all</summary>

Run the same query through the [command line tool](#command-line-tool), which
needs no installation of its own:

```bash
npx -p @brobertoblanko/gemini-grounding-mcp gemini-grounding "your query"
```

It prints the full error including the original Google API message, which the
MCP server has to condense into a single line for the client. An
`ApiError: {"error":{"code":503, ...}}` means the request did not get through to
Google, which is a different problem from a broken installation. That one is
worth simply retrying: 503 is temporary overload on Google's side, and the
server already tries such a request up to four times on its own before reporting
it - which is also why an answer can take some ten seconds longer than usual
when the service is busy.

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
here. The token footer under every answer makes the consumption of each
individual call visible.

## Tools

- **`gemini-search`** - research via Google Search, URL Context and Code
  Execution in one call. Besides the query it accepts an optional `model` and
  `thinkingLevel` that apply to this one call; left out, the saved defaults are
  used. The answer contains inline citation markers, a source
  list and a token footer. If Gemini executed code, the code and its result
  appear under `Code execution:` after the answer text - the calculation is
  evidence, so it belongs where the sources are. If the answer did not finish
  normally, a line marked ⚠️ says so along with the reason.
- **`gemini-list-models`** - lists the models available for your API key with
  their token limits. By default only those usable with this server; with
  `all: true`, every one.
- **`gemini-set-model`** - persists the default model and/or default thinking
  level (only those two values, never the API key).

## Citations and searches

### Citation markers

Markers appear in groups such as `[1][3]` when several sources support the same
passage. A sentence carrying none may well come from the model's own memory
rather than from the search - precisely the kind of sentence you would not want
to write code against unchecked.

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

### Why the source URLs are long

Google hands out its sources as redirect URLs, and the server passes them on
unchanged. Shortening or resolving them is not permitted under the
[terms for Google Search grounding](https://ai.google.dev/gemini-api/terms#grounding-with-google-search),
so it does not happen: the length is deliberate rather than missing polish.

### Which searches were actually run

Very broad questions produce a lot of searches, so the footer's last line is
capped at roughly 300 characters and ends with `(+n more)` when there were more.
If the line is missing entirely, no search was run.

<details>
<summary>The case that made this necessary</summary>

Asked to compare six web frameworks by version _and_ bundle size, Gemini
searched six times for `<framework> current version` and once for bundle sizes.
Rendering strategy and learning curve were answered from its own knowledge.
Nothing in the answer itself gave that away - the source list was long and every
sentence looked equally well supported.

</details>

## Command line tool

The server can also be driven without an MCP client - useful for checking that
your API key and model choice work before registering it, and for testing a
change during development without restarting the client.

The short command `gemini-grounding` exists once the package is
[installed globally](#installing-globally). If you registered the server through
`npx`, nothing was installed and the same commands run like this instead:

```bash
npx -p @brobertoblanko/gemini-grounding-mcp gemini-grounding config
```

`-p` names the package, the argument after it the command. Without it,
`npx @brobertoblanko/gemini-grounding-mcp` starts the MCP server rather than the
CLI - it then waits silently on stdio, which looks like a hang.

| Command                                 | Effect                                                                                                |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `gemini-grounding "<query>"`            | Search using the saved defaults; `--model <id>` and `--thinking <level>` apply to this call only      |
| `gemini-grounding config`               | Shows the saved model, thinking level, whether an API key is present, and where the config file lives |
| `gemini-grounding models [--all]`       | Lists the models usable with this server and their token limits; `--all` lists every one              |
| `gemini-grounding set-model <id>`       | Persists the default model; add `--thinking <level>` to save both in one call                         |
| `gemini-grounding set-thinking <level>` | Persists the default thinking level (`minimal`, `low`, `medium`, `high`); `--model <id>` saves both   |
| `gemini-grounding help`                 | Short help                                                                                            |

Which model and thinking level a call actually used is shown in the footer under
every answer.

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

## Installing globally

To install the package permanently instead of fetching it via `npx`:

```bash
npm install -g @brobertoblanko/gemini-grounding-mcp
```

This puts two commands on your `PATH`: `gemini-grounding-mcp` starts the MCP
server over stdio, and `gemini-grounding` is the
[command line tool](#command-line-tool).

The trade-off is the usual one: the version stays put until you run
`npm update -g`, which is an advantage when you want a known state and a chore
otherwise.

Registration then names that command directly, without `npx`.

<details>
<summary>Registering the installed command</summary>

**Windows (PowerShell):**

```powershell
claude mcp add gemini-grounding -s user `
  -e 'GEMINI_API_KEY=${GEMINI_API_KEY}' `
  -- gemini-grounding-mcp
```

**macOS / Linux (bash / zsh):**

```bash
claude mcp add gemini-grounding -s user \
  -e 'GEMINI_API_KEY=${GEMINI_API_KEY}' \
  -- gemini-grounding-mcp
```

For another client, `command` becomes the installed command and `args` can be
dropped:

```json
{
  "mcpServers": {
    "gemini-grounding": {
      "command": "gemini-grounding-mcp",
      "env": {
        "GEMINI_API_KEY": "${GEMINI_API_KEY}"
      }
    }
  }
}
```

</details>

<details>
<summary>Running from a clone</summary>

To work from the source:

```bash
git clone https://github.com/brobertoblanko/gemini-grounding-mcp.git
cd gemini-grounding-mcp
npm install
```

Then use `node <path-to-repo>/index.js` as the command. `claude mcp add` needs a
concrete absolute path that resolves on the machine in question.

</details>

## Removing it

```bash
claude mcp remove gemini-grounding
```

That unregisters the server; with `npx` nothing else was installed. A global
install is removed with
`npm uninstall -g @brobertoblanko/gemini-grounding-mcp`. If you ever saved a
default, its file stays behind - see
[Where settings are stored](#where-settings-are-stored).

## Data and privacy

Search queries, and anything included in a request, are sent to the Gemini API
and processed under Google's applicable terms and data handling policies.

This server adds no anonymization and no enterprise data isolation. Do not use
it with confidential, personal or regulated data unless you have verified that
the service terms and your configuration are appropriate for it.

## Where settings are stored

`gemini-set-model` and the CLI's `set-*` commands write the default model and
thinking level to:

| Platform                         | Location                                            |
| -------------------------------- | --------------------------------------------------- |
| Linux, macOS                     | `~/.config/gemini-grounding-mcp/config.json`        |
| Windows                          | `%APPDATA%\gemini-grounding-mcp\config.json`        |
| Any, if `XDG_CONFIG_HOME` is set | `$XDG_CONFIG_HOME/gemini-grounding-mcp/config.json` |

Neither the file nor its directory is created until you save a setting for the
first time. Delete the file to return to the built-in defaults
(`gemini-flash-latest`, thinking level `medium`). It holds nothing but those two
values - **never the API key**. Run `gemini-grounding config` to see the exact
path on your machine.

## Which models are usable

Your API key exposes considerably more models than will work here. The model
list therefore shows, by default, only those that produce text and accept a
thinking level - judged by what the API reports about each model, not by its
name.

Two limits to that filter are worth knowing: it separates what runs technically
from what does not, not what is sensible for research, and **listed does not
mean available** - a retired model stays in the list and answers with
`404 ... is no longer available`. That is why `--all` / `all: true` hides
nothing but shows the complete list with a status column instead.

Why the filter goes by capabilities rather than name patterns, and what each
condition prevents:
[specs.md](https://github.com/brobertoblanko/gemini-grounding-mcp/blob/main/docs/specs.md#gemini-list-models).

## Documentation

- [specs.md](https://github.com/brobertoblanko/gemini-grounding-mcp/blob/main/docs/specs.md) - architecture and design decisions, also [in German](https://github.com/brobertoblanko/gemini-grounding-mcp/blob/main/docs/specs.de.md)
- [cli.md](https://github.com/brobertoblanko/gemini-grounding-mcp/blob/main/docs/cli.md) - the command line tool in detail, also [in German](https://github.com/brobertoblanko/gemini-grounding-mcp/blob/main/docs/cli.de.md)
- [CLAUDE.md](https://github.com/brobertoblanko/gemini-grounding-mcp/blob/main/CLAUDE.md) - working rules for Claude Code in this repository (German)

## License

[MIT](./LICENSE)
