# @brobertoblanko/gemini-grounding-mcp

A small, self-contained MCP server that gives Claude Code - or any other MCP
client - access to Google web search through the Gemini API with grounding.
It uses nothing but the official `@google/genai` and `@modelcontextprotocol/sdk`
packages: no community wrapper, no version silently changing under you.

**Scope of use:** research queries only. Not intended for production use or for
connecting to sensitive systems.

Architecture and design decisions: see [specs.md](./docs/specs.md), also
available [in German](./docs/specs.de.md).
Working rules for Claude Code in this repository: see [CLAUDE.md](./CLAUDE.md)
(German).

## Requirements

- **Node.js 20 or newer** - required by `@google/genai` and the MCP SDK.
  Check with `node -v`.
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

## Installation

Nothing to install up front if you use `npx` - the registration command below
fetches the package on demand. To install it permanently instead:

```bash
npm install -g @brobertoblanko/gemini-grounding-mcp
```

This provides two commands: `gemini-grounding-mcp` starts the MCP server over
stdio, and `gemini-grounding` is the command line tool described further down.

To work from the source instead:

```bash
git clone https://github.com/brobertoblanko/gemini-grounding-mcp.git
cd gemini-grounding-mcp
npm install
```

## Providing the API key

The API key is passed exclusively through the `GEMINI_API_KEY` environment
variable - never in the code, never in the config file. It must be set
**persistently** before the client starts the server.

**Windows (PowerShell, user scope, once):**

```powershell
[Environment]::SetEnvironmentVariable('GEMINI_API_KEY', '<your-api-key>', 'User')
```

Reopen the shell afterwards so the variable is available.

**macOS / Linux** - add to `~/.zshrc`, `~/.bashrc` or equivalent:

```bash
export GEMINI_API_KEY='<your-api-key>'
```

## Registering with Claude Code

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
itself. Claude Code resolves it later, when it loads its configuration, from the
environment variable you already set - that way only the placeholder ends up in
`~/.claude.json`, not the key in plain text.

If you installed globally with `npm install -g`, replace
`npx -y @brobertoblanko/gemini-grounding-mcp` with `gemini-grounding-mcp`.
If you cloned the repository, use `node <path-to-repo>/index.js` instead -
`claude mcp add` needs a concrete absolute path that resolves on the machine
in question.

## Verifying the installation

First check that the client sees the server at all:

```bash
claude mcp list
```

Then start a new conversation and ask something that cannot be answered from
training data alone:

- `"Which Node.js version is currently LTS?"`
- `"What changed in the Gemini API in the last few months?"`
- `"Read https://nodejs.org/en/about/previous-releases and tell me when Node 22 goes end-of-life"`

A working answer ends in three things: a `Sources:` list of real URLs, citation
markers such as `[1]` inside the text, and a footer naming the model, the
thinking level, the token count and the searches that were actually run. If the
footer is missing, you are reading the model's own memory rather than a
grounded answer.

If no answer arrives at all, run the same query through the command line tool
below - it prints the full error including the original Google API message,
which the MCP server has to condense into a single line.

## Command line tool

The server can also be driven without an MCP client - useful for checking that
your API key and model choice work before registering it, and for testing a
change during development without restarting the client.

```bash
gemini-grounding config
```

Working from a clone, use `node cli.js` in place of `gemini-grounding`, or run
`npm link` once to make the command available system-wide. `npm link` places a
link to `cli.js` in the global npm directory (a `.cmd`/`.ps1` pair on Windows, a
symlink elsewhere); because it is a link and not a copy, edits to `cli.js` take
effect immediately. Undo it with
`npm unlink -g @brobertoblanko/gemini-grounding-mcp` - npm expects the package
name there, not the command name `gemini-grounding`. Given the command name it
merely reports `up to date` and removes nothing.

| Command | Effect |
| --- | --- |
| `gemini-grounding "<query>"` | Search using the saved defaults; prints the answer including source list and token footer |
| `gemini-grounding config` | Shows the saved model, thinking level, whether an API key is present, and where the config file lives |
| `gemini-grounding models [--all]` | Lists the models usable with this server and their token limits; `--all` lists every one |
| `gemini-grounding set-model <id>` | Persists the default model |
| `gemini-grounding set-thinking <level>` | Persists the default thinking level (`minimal`, `low`, `medium`, `high`) |
| `gemini-grounding help` | Short help |

Anything that is not a known subcommand is treated as a search query - as
**exactly one argument**. A question containing spaces therefore has to be
quoted. Unquoted, the call aborts with a message rather than sending a query
that option parsing has cut individual words out of (`… what does --thinking
high mean …` would otherwise have run as `what does mean …`). An unknown option
(`--al` instead of `--all`) and surplus arguments are errors with exit code 1 as
well - none of it is silently ignored.

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

**Errors stay fully visible.** Unlike the MCP server, which has to condense
every error into a single line for the client, the CLI prints the full stack
trace including the original Google API error and exits with code 1. When
testing, that is exactly what you want: a message like
`ApiError: {"error":{"code":503, ...}}` says the request did not get through to
Google - not that your installation is broken. A plain usage error (wrong
argument, unknown option, empty query) prints only the one explanatory line,
also with exit code 1 - nobody needs a stack trace for a typo.

`config` only checks whether a key arrives in the environment at all and prints
its length - **never the value itself**. Whether the key is valid is something
only a real request can tell you.

## Tools

- **`gemini-search`** - research via Google Search, URL Context and Code
  Execution in one call. The answer contains inline citation markers, a source
  list and a token footer. If Gemini executed code, the code and its result
  appear under `Code execution:` after the answer text - the calculation is
  evidence, so it belongs where the sources are. If the answer did not finish
  normally - blocked, or cut off at the token limit - a line marked ⚠️ says so
  along with the reason, instead of letting an empty or half answer look like a
  success.
- **`gemini-list-models`** - lists the models available for your API key with
  their token limits. By default only those usable with this server (see below);
  with `all: true`, every one.
- **`gemini-set-model`** - persists the default model and/or default thinking
  level (only those two values, never the API key).

### Citation markers

Markers such as `[1]` or `[1][3]` are placed in the answer text at the positions
for which the API reports a source, using the same numbering as the source list
at the end. Their point is less *which* source backs a sentence than *whether*
it is backed at all: a sentence without a marker may well come from the model's
own memory rather than from the search - and that is precisely the kind of
sentence you would not want to write code against unchecked.

The guarantee runs one way only. A marker that is present is reliable; a marker
that is missing is an indication, not proof. Markers are verified against the
text segment the API supplies and are dropped rather than guessed if they do not
match, and they are never placed inside code spans or fenced blocks. Whenever
markers were dropped, the footer says so. See
[specs.md](./docs/specs.md) for the details.

### Which searches were actually run

The last line of the footer lists the queries Gemini sent to Google:

```text
🔎 Searched: nodejs current lts version 2026 · nodejs release schedule
```

This answers a question neither the source list nor the markers can: whether the
search covered your question at all. Asked to compare six web frameworks by
version *and* bundle size, Gemini searched six times for `<framework> current
version` and once for bundle sizes - the remaining aspects were answered from
its own knowledge. Nothing in the answer itself gives that away.

Very broad questions produce a lot of searches, so the line is capped at roughly
300 characters and ends with `(+n more)` when there were more. If the line is
missing entirely, no search was run.

### Where the configuration is stored

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
values - never the API key. Run `gemini-grounding config` to see the exact path
on your machine.

**Coming from a clone older than 1.1.0:** back then the file lived next to
`index.js` inside the repository. It is no longer read and nothing is migrated
for you - run `gemini-grounding config` to see where the file belongs now, then
either move the old one there or simply set both values again. The leftover copy
in the clone can be deleted.

### Which models are usable

Your API key exposes considerably more models than will work here. The model
list therefore shows, by default, only those meeting two conditions - both taken
from what the API reports about each model, not from its name:

- **`generateContent`** in `supportedActions` - the model produces text at all.
  This rules out embedding, image (Imagen), video (Veo) and live/audio models.
- **`thinking: true`** - the model accepts a thinking level. Since every search
  sends one, the API would otherwise answer with
  `400 Thinking level is not supported for this model.`

Filtering by name patterns would be unreliable: Google assigns code names that
say nothing about capabilities - `nano-banana-pro-preview` is an image model.

Two limitations remain:

- The conditions say what runs **technically**, not what is sensible for
  research. Some image, speech and robotics models meet them too and show up in
  the list.
- **Listed does not mean available.** Retired models stay in the list and answer
  with `404 ... is no longer available`. No field announces this in advance -
  only a real call gives you certainty.

This is why `--all` / `all: true` hides nothing but instead shows the complete
list with a status column.

## License

[MIT](./LICENSE)
