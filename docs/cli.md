# cli.md - Command line tool

*Diese Seite auf [Deutsch](./cli.de.md).*

The package ships a command line tool alongside the MCP server.
Both run on the same core and share the same configuration file, so anything you check or change here applies to the server as well.

The [README](https://github.com/brobertoblanko/gemini-grounding-mcp#command-line-tool) covers the everyday commands.
This page collects the parts that only matter once something goes wrong or when you work from a clone.

## Why use it at all

Three situations where the CLI is the shorter path:

- **Before registering the server.** Checking that your API key works and that your model choice is valid takes one command and no client restart.
- **While developing.** A change can be tried out immediately, without restarting the MCP client that would otherwise hold the old code.
- **When something fails.** The CLI prints the full error including the original message from Google, which the MCP server has to condense into a single line for the client.

## How to run it

The examples on this page use the short form `gemini-grounding`.
It exists once the package has been installed globally:

```bash
npm install -g @brobertoblanko/gemini-grounding-mcp
```

Registering the MCP server through `npx` installs nothing, so the command is not on the `PATH` in that case.
Every command then works like this instead:

```bash
npx -p @brobertoblanko/gemini-grounding-mcp gemini-grounding config
```

The `-p` is what makes the difference: it names the package, and the argument after it names the command inside that package.
A plain `npx @brobertoblanko/gemini-grounding-mcp` runs the bin whose name matches the package - that is the MCP server, which then waits silently on stdio and looks like it hung.

Working from a clone, use `node cli.js` instead; see [Working from a clone](#working-from-a-clone).

## Argument handling

Anything that is not a known subcommand is treated as a search query - as **exactly one argument**.
A question containing spaces therefore has to be quoted.

```bash
gemini-grounding "which node version is currently lts"
```

Unquoted, the call aborts with a message rather than sending a query that option parsing has cut individual words out of.
Without that check, `… what does --thinking high mean …` would have run as `what does mean …`: a query that looks plausible, returns a plausible answer, and is quietly not the question you asked.

A long question with line breaks and quotes is easier to write into a file and pipe in.
A single `-` in place of the query reads it from stdin:

```powershell
Get-Content question.txt | gemini-grounding -
```

On Windows this is more than convenience.
Called through npm's `.cmd` wrapper - from `cmd.exe`, Windows PowerShell 5.1 or another program - a multi-line argument is cut at its first line break and loses its quotes, without any message.
stdin arrives intact on every route.
The same check for an empty query applies, and without anything piped in, `-` aborts instead of waiting for input.

Unknown options (`--al` instead of `--all`) and surplus arguments are errors with exit code 1 as well.
None of it is silently ignored.

```console
$ gemini-grounding models --al
Error: Unknown option "--al".
Run "gemini-grounding help" for usage.
```

An error in the syntax of the call adds this second line, or the usage of the command itself where a single command is concerned.
An error about the values - a model collision, an invalid deadline - says what to do by itself and gets none.

## Where an option applies

The same option means different things depending on the command, so each command accepts only the ones that do something there.
An option that has no meaning for the given command aborts with exit code 1 - it is never accepted and then quietly dropped.

| Call | Effect |
| --- | --- |
| `"<query>" --model <id> --thinking <level>` | Used for this call only, nothing is saved |
| `set-model <id> --thinking <level>` | Saves **both** |
| `set-thinking <level> --model <id>` | Saves **both** |
| `set-backup <id> --thinking <level>` | Saves the backup model **and** its own thinking level |
| `set-backup <id>` | Saves the backup model and **removes** a previously saved backup level |
| `set-backup --thinking <level>` | Changes only the level of the backup already saved |
| `set-backup off --thinking <level>` | Error - a backup that is off has no thinking level |
| `set-model <id> --model <id2>` | Error - two models, and only you know which one is meant |
| `set-deadline <seconds\|off>` | Saves after how many seconds Google aborts a search; takes no option besides `--debug` |
| `models --all` | Lists every model with a status column, past the shortlist the default view shows |
| `--debug` on a search, `models` or any `set-*` command | Prints the full stack trace if the command fails at runtime |
| `config`, `help`, `version` with any option, `models` with `--model` / `--thinking` | Error |

Every save answers twice - what changed, and what applies from now on:

```console
$ gemini-grounding set-model gemini-flash-latest --thinking low
Saved - Model: gemini-flash-latest, Thinking level: low

Default:  gemini-flash-latest · low
Backup:   gemini-3.5-flash · low (inherited)
Deadline: 300 s
```

The first line names every value that was actually written; whatever is not listed there did not end up in the file.
The lines below name the complete stored state, so a change never has to be followed by `config` to see what the next query will actually run with.

On the backup, the level is shown as the value rather than the bare word "inherited": what the backup would run with if it stepped in right now is the answer you are after.
The suffix says the value is not its own but travels along - hand a call its own `--thinking`, and the backup inherits that one instead.

## The backup model

`set-backup <id>` names a model that the same request is sent to when the default model fails, for instance because it is overloaded (`503`).
Off unless you set it; `set-backup off` switches it off again.
Which errors trigger it: [google_errors.md](./google_errors.md).

Unlike the default model and its level, the backup is written **as a unit**.
Naming a backup model without `--thinking` removes a previously saved backup level, and the backup inherits the level of the call it stands in for.
The level belongs to that one model - left lying around across a change of backup, it would silently apply to a model it was never chosen for.
The rule lives in `setSavedConfig` rather than in the CLI, so `gemini-set-config` on the MCP server follows it too.

To change only the level, leave the model out:

```console
$ gemini-grounding set-backup --thinking minimal
Saved - Backup thinking level: minimal

Default:  gemini-flash-latest · low
Backup:   gemini-3.5-flash · minimal
Deadline: 300 s
```

That needs a backup to already be saved and switched on - a level without its model has nothing to belong to:

```console
$ gemini-grounding set-backup --thinking minimal
Error: no backup model is set - a thinking level on its own has nothing to belong to. Name the backup model together with the level.
```

The same applies to `set-backup off --thinking <level>`, which aborts with `a backup that is switched off has no thinking level`.
Both messages come from `findBackupLevelProblem` in `config.js` and read identically on the MCP server, which is why they name no command of the CLI's.

Default and backup may not be the same model, and every command that writes a model rejects it - `set-model <id>`, `set-thinking <level> --model <id>` and `set-backup <id>` alike:

```console
$ gemini-grounding set-backup gemini-flash-latest
Error: "gemini-flash-latest" is already the default model - a backup only helps if it is a different one.
```

The check runs on the state the write **would produce**, which is why it sits at the one place all three commands pass through (`findModelCollision` in `config.js`, shared with the MCP server).
A command that names no model at all is let through even when the stored values already collide: `set-thinking low` did not cause that state and should not be blocked by it.
`runSearch` catches the collision a second time, but only on the next failing call - by then the backup has been silently dead for a while, which is what this check is for.

**`--model` on a search disables the backup for that call.**
Naming a model is usually a way of checking that particular model, and an answer from a different one does not answer that question.

`gemini-grounding config` shows all three states - a model, `off`, or `not set`.
The last two behave identically; the distinction records whether the decision was ever made.

## The deadline

`set-deadline <seconds>` sets after how many seconds Google aborts a search and answers `504` - 300 unless you set it.
`set-deadline off` sends no deadline at all, and Google's own limit applies.

```console
$ gemini-grounding set-deadline 600
Saved - Deadline: 600 s

Default:  gemini-flash-latest · low
Backup:   gemini-3.5-flash · low (inherited)
Deadline: 600 s
```

Only digits are accepted: `300.5`, `1e3` or `0` abort with `Invalid deadline`, because each would otherwise be stored as something nobody typed.
The largest value is 600, Google's own limit for a request; anything above it would promise a deadline that does not exist.
The smallest is 10: Google rejects a shorter deadline on every request with `400 INVALID_ARGUMENT`, the backup included.
There is no per-call option - the deadline is an operating setting, and raising it after a `504` costs a second full generation.

Thirty seconds after the deadline the server stops waiting by itself, in case the line went silent rather than Google answering.
Without a deadline there is no such brake either.
Why both exist and what they cost: [specs.md, "The deadline this server does send"](./specs.md#the-deadline-this-server-does-send).

## Checking the setup

`doctor` checks everything a search depends on, one line each, and exits with code 1 if any check fails:

```console
$ gemini-grounding doctor
Node:     ok - v24.15.0
Config:   ok - readable, every value valid
API key:  ok - accepted, 60 models listed
Default:  problem - "gemini-3-flsh" is not in the model list of this API key - a search with it will most likely fail.
Backup:   ok - not set
```

The key is checked through `models.list`, which is free and proves that Google accepts the key, not only that it is set.
The output names no path, so it can go into a bug report as it is; `config` shows where the file lives.

The same model check runs after every `set-model` and `set-backup`.
A model the key does not list, that cannot run here, or that is on the exclusion list is saved all the same, followed by a `Warning:` line on stderr.
Offline or without a key there is no warning.

## Back to the defaults

`reset` returns a saved value to its built-in default by removing it from `config.json`:

```console
$ gemini-grounding reset backup
Reset - backup is back to its built-in default

Default:  gemini-flash-latest · medium
Backup:   not set
Deadline: 300 s
```

The targets are `model`, `thinking`, `backup` (model and level together, as with `set-backup`) and `deadline`.
`reset all` deletes the file, which also works when it is broken and every other write refuses.
A reset that would make the built-in default model the saved backup is refused, like the same collision on `set-model`.
There is no MCP counterpart; a reset is rare, and `gemini-set-config` would need another kind of parameter for it.

## Errors in one readable line

When a request fails, the CLI prints Google's status code, status name and message on one line and exits with code 1:

```console
$ gemini-grounding "test" --model gemini-x
Error: 404 NOT_FOUND - models/gemini-x is not found for API version v1beta, ...
Run again with --debug for the full stack trace.
```

A `503 UNAVAILABLE` tells you the request did not get through to Google, which is a different problem from a broken installation - and one you can do nothing about except try again later.

A `429` keeps the waiting time Google sends along, rounded up to whole seconds:

```console
Error: 429 RESOURCE_EXHAUSTED - You exceeded your current quota, ... (retry in 53 s)
```

The CLI does not wait on its own; it only tells you when another attempt makes sense.

`--debug` adds the full stack trace and the raw error, including Google's complete response body.
It is off by default because the stack consists of SDK internals and contains absolute paths of your machine, which end up in every bug report the output is pasted into.
It is accepted wherever a runtime error can occur: on a search, on `models` and on every `set-*` command.

The MCP server does not use this rendering.
It hands Google's raw response body to the client, which reads it without effort, so nothing in it - such as the waiting time of a `429` - can get lost on the way.

A plain usage error (wrong argument, unknown option, empty query, or an unset `GEMINI_API_KEY`) also starts with `Error:` and exits with code 1, but never points to `--debug`.
Nobody needs a stack trace for a typo.

The key is checked before the request rather than left to the API call, which is why it lands in this group and not among the errors above.
Nothing has been sent at that point, the line already says what to do, and it is what a fresh installation runs into on its very first call.

## Checking the API key

```console
$ gemini-grounding config
Default:  gemini-flash-latest · medium
Backup:   gemini-3.5-flash · medium (inherited)
Deadline: 300 s
API key:  set (39 chars)
Config:   /home/you/.config/gemini-grounding-mcp/config.json
Version:  1.3.0
```

The first three lines are the same ones every save prints, so there is only one rendering of "which models am I using" to learn.
`config` adds the three things that are only of interest here - key status, config path, and the installed version, so a bug report needs no second command.

The key check only establishes whether a key arrives in the environment at all and prints its length - **never the value itself**, not even shortened.
Whether the key is actually valid is something only a real request can tell you, so a successful `config` is a necessary but not a sufficient condition.

## Working from a clone

Use `node cli.js` in place of `gemini-grounding`:

```bash
node cli.js "your query"
node cli.js config
```

To make the command available system-wide instead, run `npm link` once in the clone.
It places a link to `cli.js` in the global npm directory: a `.cmd`/`.ps1` pair on Windows, a symlink elsewhere.
Because it is a link and not a copy, edits to `cli.js` take effect immediately, which is the point of using it during development.

Undo it with:

```bash
npm unlink -g @brobertoblanko/gemini-grounding-mcp
```

Note the **package name**, not the command name `gemini-grounding`.
Given the command name, npm merely reports `up to date` and removes nothing - a failure mode that looks like success.

## Migrating from a clone older than 1.1.0

Before 1.1.0 the configuration file lived next to `index.js` inside the repository.
That file is no longer read and nothing is migrated for you.

Run `gemini-grounding config` to see where the file belongs now, then either move the old one there or simply set both values again:

```bash
gemini-grounding set-model <model-id>
gemini-grounding set-thinking medium
```

The leftover copy in the clone can be deleted.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | The command succeeded |
| 1 | Usage error, or the API call failed |

There is no separate code for API failures.
The distinction is in the output: an API failure names Google's status code and points to `--debug`, a usage error does neither.
