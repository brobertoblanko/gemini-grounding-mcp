#!/usr/bin/env node
// Command line frontend on the same core index.js uses: gemini.js for the API
// calls, config.js for the stored defaults. Relative imports in ES modules
// resolve against THIS file and not against the working directory, so the CLI
// works from any folder.
// Full derivation: docs/specs.md, "Implementation".

import { createRequire } from "node:module";

import { runSearch, listModels, formatRuntimeError, API_KEY_MISSING_MESSAGE } from "./gemini.js";
import {
  CONFIG_PATH,
  DEFAULT_DEADLINE_SECONDS,
  findBackupLevelProblem,
  findModelCollision,
  formatConfigState,
  formatSavedValues,
  isValidDeadline,
  resolveCallConfig,
  setSavedConfig,
  THINKING_LEVELS,
} from "./config.js";

// Read the same way index.js does; the reasoning for createRequire over
// Import Attributes sits there.
const { version } = createRequire(import.meta.url)("./package.json");

const HELP = `gemini-grounding - Google search through Gemini, from the command line

Usage:
  gemini-grounding "<query>" [--model <id>] [--thinking <level>]
  gemini-grounding <command> [arguments]

Commands:
  config                         Show the saved settings and the API key status
  models [--all]                 List the models offered here; --all lists all
                                 models the API key exposes, with their status
  set-model <id>                 Save the default model
  set-thinking <level>           Save the default thinking level
  set-backup <id|off>            Save a model to retry a failed search with;
                                 "off" switches the backup off
  set-backup --thinking <level>  Change only the backup's thinking level
  set-deadline <seconds|off>     Save after how many seconds Google aborts a
                                 search (default ${DEFAULT_DEADLINE_SECONDS}); "off" sends none
  help                           Show this help
  version                        Show the installed version

Options:
  --model <id>                   On a search: use this model for this call
                                 only, without the backup. With set-thinking:
                                 save it as well
  --thinking <level>             On a search: use this level for this call
                                 only. With set-model or set-backup: save it
                                 as well - a backup saved without one inherits
                                 the level of the call
  --debug                        On an error, also print the full stack trace

Thinking levels: ${THINKING_LEVELS.join(", ")}

Examples:
  gemini-grounding "which node version is the current lts"
  gemini-grounding "explain css nesting" --thinking high
  gemini-grounding set-model gemini-flash-latest --thinking low
  gemini-grounding set-backup gemini-3.6-flash

The query is one argument - quote it if it contains spaces. The API key comes
from GEMINI_API_KEY. Settings are shared with the MCP server; "config" shows
where they are stored.`;

/** The second line of a syntax error, for when the message alone does not say how. */
const SEE_HELP = 'Run "gemini-grounding help" for usage.';

/**
 * Usage error - wrong arguments, unknown option, empty query. Handled
 * differently from a real runtime error: the message only, no stack trace,
 * because a typo on the command line does not need one.
 *
 * hint is an optional second line - the usage of the command or SEE_HELP - for
 * errors in the syntax of the call. An error about the values, such as a
 * model collision, says what to do by itself and gets none.
 */
class UsageError extends Error {
  constructor(message, hint) {
    super(message);
    this.hint = hint;
  }
}

function fail(message, hint) {
  throw new UsageError(message, hint);
}

// Module scope because the catch at the end of the file reads it, outside
// main(), where it is parsed.
let debug = false;

function requireThinkingLevel(value, origin) {
  if (!THINKING_LEVELS.includes(value)) {
    fail(`Invalid thinking level "${value}" for ${origin}. Allowed: ${THINKING_LEVELS.join(", ")}`);
  }
  return value;
}

/**
 * Takes "--name <value>" out of the argument list and REMOVES both from it.
 * That makes the position of the flags arbitrary and leaves a remainder that is
 * cleanly subcommand or search query.
 */
function takeFlag(args, name) {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    fail(`Missing value for --${name}.`, SEE_HELP);
  }
  args.splice(index, 2);
  return value;
}

/** Like takeFlag, but for switches without a value. */
function takeSwitch(args, name) {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return false;
  args.splice(index, 1);
  return true;
}

/**
 * Writes and reports in one: first what changed, then what applies from now on.
 * Both lines come from config.js so that the MCP handler gives the same
 * information.
 *
 * The second half is the reason for this function: without it every set command
 * would need a "config" behind it to see what the next search actually runs
 * with.
 */
function saveAndReport(values) {
  // Default and backup must not become the same model - silently there would be
  // nothing left to fall back to. The check sits here and not in the individual
  // branches so it cannot miss a write path: "set-model x", "set-thinking low
  // --model x" and "set-backup x" all write a model, and the second one used to
  // skip it.
  const collision = findModelCollision(values);
  if (collision) fail(collision);

  // Same place for the same reason: a backup level without its model.
  const levelProblem = findBackupLevelProblem(values);
  if (levelProblem) fail(levelProblem);

  console.log(`Saved - ${formatSavedValues(setSavedConfig(values))}`);
  console.log(`\n${formatConfigState()}`);
}

async function main() {
  // argv[0] is the Node interpreter, argv[1] the script itself - the arguments
  // passed by the user start at index 2.
  const args = process.argv.slice(2);

  // First, so that it is known whatever goes wrong after it.
  debug = takeSwitch(args, "debug");
  const modelFlag = takeFlag(args, "model");
  const thinkingFlag = takeFlag(args, "thinking");
  const allFlag = takeSwitch(args, "all");
  if (thinkingFlag !== undefined) requireThinkingLevel(thinkingFlag, "--thinking");

  // Whatever still looks like an option is unknown to the CLI. Without this
  // check a typo would go unnoticed: "models --al" would silently have shown the
  // filtered list that one takes for the complete one. Deliberately only "--",
  // so a query like "-5 degrees in Fahrenheit" still gets through; "--help" and
  // "--version" are exempt because both are handled as subcommands below - a
  // case for either in the switch would otherwise never be reached.
  const unknownOption = args.find(
    (arg) => arg.startsWith("--") && arg !== "--help" && arg !== "--version",
  );
  if (unknownOption) fail(`Unknown option "${unknownOption}".`, SEE_HELP);

  const [command, ...rest] = args;

  // Every branch checks that nothing surplus is left over - otherwise
  // "set-thinking low nonsense" would save without complaint and drop the rest.
  const requireNoArgs = () => {
    if (rest.length > 0) fail(`"${command}" takes no arguments.`, SEE_HELP);
  };

  const givenFlags = [];
  if (modelFlag !== undefined) givenFlags.push("model");
  if (thinkingFlag !== undefined) givenFlags.push("thinking");
  if (allFlag) givenFlags.push("all");
  if (debug) givenFlags.push("debug");

  // Counterpart to requireNoArgs for the options: every branch names the ones
  // that mean something to it, everything else aborts. Without this check
  // "config --thinking low" accepted the option without comment and did nothing
  // with it.
  //
  // An allowlist and not a denylist, so an option added later is not
  // accidentally permitted everywhere.
  const allowFlags = (...allowed) => {
    const unexpected = givenFlags.find((name) => !allowed.includes(name));
    if (unexpected) fail(`"${command}" takes no --${unexpected} option.`, SEE_HELP);
  };

  // --debug is allowed wherever a runtime error can occur: the search, the
  // model list and every command that writes the file.
  switch (command) {
    case undefined:
      // A call without arguments is a usage error: help to stderr, exit 1. Not
      // through fail(), which would put "Error: " in front of the help.
      console.error(HELP);
      process.exitCode = 1;
      break;

    case "help":
    case "--help":
    case "-h":
      allowFlags();
      requireNoArgs();
      console.log(HELP);
      break;

    case "version":
    case "--version":
    case "-v":
      allowFlags();
      requireNoArgs();
      console.log(version);
      break;

    case "config": {
      allowFlags();
      requireNoArgs();
      const apiKey = process.env.GEMINI_API_KEY;
      // The key's value is never printed, not even shortened - only its length,
      // because a truncated paste shows up in it.
      const keyStatus = apiKey
        ? `set (${apiKey.length} chars)`
        : "NOT SET - set the GEMINI_API_KEY environment variable";
      // The same two lines as after every set command - "config" is not a second
      // rendering of the same thing, but that one plus what only matters here.
      // Three states of the backup stay distinguishable: a model, "off",
      // "not set".
      console.log(formatConfigState());
      console.log(`API key:  ${keyStatus}`);
      // The path is always named, even when the file does not exist yet - it
      // then states where it will appear on the first set-model, and the values
      // above are the built-in defaults.
      console.log(`Config:   ${CONFIG_PATH}`);
      console.log(`Version:  ${version}`);
      break;
    }

    case "models":
      // Before listModels, so a typo costs no API call.
      allowFlags("all", "debug");
      requireNoArgs();
      console.log(await listModels({ all: allFlag, allOption: "--all" }));
      break;

    // With both set commands the respective other option is persisted too:
    // whoever asks for something to be stored does not want part of the entry to
    // expire. The command's own option is an error - "set-model x --model y"
    // names two models, and which one is meant only the caller can know.
    case "set-model": {
      allowFlags("thinking", "debug");
      if (rest.length !== 1) {
        fail(
          '"set-model" takes exactly one model id.',
          "Usage: gemini-grounding set-model <id> [--thinking <level>]",
        );
      }
      saveAndReport({ model: rest[0], thinkingLevel: thinkingFlag });
      break;
    }

    case "set-thinking": {
      allowFlags("model", "debug");
      if (rest.length !== 1) {
        fail(
          '"set-thinking" takes exactly one thinking level.',
          `Usage: gemini-grounding set-thinking <${THINKING_LEVELS.join("|")}> [--model <id>]`,
        );
      }
      const level = requireThinkingLevel(rest[0], "set-thinking");
      saveAndReport({ model: modelFlag, thinkingLevel: level });
      break;
    }

    // Unlike the two set commands above, the backup is written as a UNIT:
    // without --thinking, setSavedConfig() expires a previously stored level
    // instead of leaving it in place (see setSavedConfig).
    case "set-backup": {
      allowFlags("thinking", "debug");

      // Without a model argument the command applies to the backup already
      // stored and changes only its level. Without this branch the model would
      // have to be typed out again to adjust its level, and a typo while doing so
      // would silently hit a different model.
      //
      // A switch only, no check: that this needs a stored, enabled backup is
      // rejected by findBackupLevelProblem() in saveAndReport, in the same
      // wording as for the MCP handler, which does not run through this branch.
      if (rest.length === 0 && thinkingFlag !== undefined) {
        saveAndReport({ backupThinkingLevel: thinkingFlag });
        break;
      }

      if (rest.length !== 1) {
        fail(
          '"set-backup" takes exactly one model id, or "off".',
          "Usage: gemini-grounding set-backup <id|off> [--thinking <level>]",
        );
      }
      // false and not deleting: the difference between "never set" and
      // "deliberately switched off" stays in the file. A --thinking alongside is
      // caught by saveAndReport as well - a switched-off backup has no level, and
      // the option does not expire silently.
      const backupModel = rest[0] === "off" ? false : rest[0];
      saveAndReport({ backupModel, backupThinkingLevel: thinkingFlag });
      break;
    }

    case "set-deadline": {
      allowFlags("debug");
      if (rest.length !== 1) {
        fail(
          '"set-deadline" takes exactly one value.',
          "Usage: gemini-grounding set-deadline <seconds|off>",
        );
      }
      // Digits only, so "1e3", "300.5" or " 300" fail here instead of turning
      // into a number Number() would quietly accept. "off" becomes false for
      // the same reason as on set-backup.
      let deadlineSeconds = NaN;
      if (rest[0] === "off") deadlineSeconds = false;
      else if (/^\d+$/.test(rest[0])) deadlineSeconds = Number(rest[0]);
      if (!isValidDeadline(deadlineSeconds)) {
        fail(`Invalid deadline "${rest[0]}" - a positive whole number of seconds, or "off".`);
      }
      saveAndReport({ deadlineSeconds });
      break;
    }

    default: {
      // Anything that is not a known subcommand counts as a search query, and as
      // exactly one argument. Reassembling an unquoted question would be
      // deceptive: takeFlag has cut a "--thinking high" out of the middle of it
      // beforehand, so a distorted query would be sent off unnoticed. An own
      // message instead of allowFlags: there the command name would stand in the
      // quotes, and here that name is the search query itself.
      if (allFlag) fail('--all is only valid for the "models" command.', SEE_HELP);

      if (rest.length > 0) {
        fail(
          "The query must be a single argument - put it in quotes.",
          'Example: gemini-grounding "what is an mcp server"',
        );
      }
      const query = command.trim();
      // Without this check an empty argument - from an unset shell variable, say
      // - would go to the API as a query and cost tokens.
      if (query === "") fail("The query is empty.");

      // An unset key is a usage error like a mistyped option, and "config"
      // already reports it as one. Left to gemini.js it arrives at the catch
      // below as a plain Error and prints a stack trace over the one line that
      // says what to do - on the very first call of a fresh installation.
      if (!process.env.GEMINI_API_KEY) fail(API_KEY_MISSING_MESSAGE);

      // Same pattern as in the MCP handler (index.js), and through the same
      // function: a flag applies to this call only, otherwise the stored default
      // takes over, and config.json is not touched. resolveCallConfig also
      // carries the rule that --model switches off the backup for this call.
      // Full derivation: docs/specs.md, "Resolving the defaults per call".
      const text = await runSearch({
        query,
        ...resolveCallConfig({ model: modelFlag, thinkingLevel: thinkingFlag }),
      });
      console.log(text);
    }
  }
}

try {
  await main();
} catch (error) {
  // A runtime error prints one readable line, and the full stack trace only on
  // --debug: the stack consists of SDK internals and carries absolute local
  // paths, which end up in every bug report it is pasted into. With --debug,
  // console.error(error) prints what Node would show for an unhandled error. A
  // usage error needs no stack trace at all, only the message.
  //
  // It is caught all the same, because Node ends the process hard on an
  // unhandled rejection: with a network connection still open, libuv on Windows
  // aborts with "Assertion failed ... src\win\async.c" and the process ends with
  // 0xC0000409 instead of the agreed code 1.
  //
  // process.exitCode instead of process.exit(), so that Node shuts down normally
  // - that holds without exception, which is why fail() only throws a UsageError
  // instead of exiting itself: stdout and stderr are asynchronous on a Windows
  // TTY, so process.exit() could cut off a longer output such as HELP.
  if (error instanceof UsageError) {
    console.error(`Error: ${error.message}`);
    if (error.hint) console.error(error.hint);
  } else {
    console.error(`Error: ${formatRuntimeError(error)}`);
    console.error(debug ? error : "Run again with --debug for the full stack trace.");
  }
  process.exitCode = 1;
}
