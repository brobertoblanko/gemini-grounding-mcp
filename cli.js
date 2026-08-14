#!/usr/bin/env node
// Command line frontend on the same core index.js uses: gemini.js for the API
// calls, config.js for the stored defaults. Relative imports in ES modules
// resolve against THIS file and not against the working directory, so the CLI
// works from any folder.
// Full derivation: docs/specs.md, "Implementation".

import { createRequire } from "node:module";

import { runSearch, listModels, API_KEY_MISSING_MESSAGE } from "./gemini.js";
import {
  CONFIG_PATH,
  findBackupLevelProblem,
  findModelCollision,
  formatConfigState,
  formatSavedValues,
  resolveCallConfig,
  setSavedConfig,
  THINKING_LEVELS,
} from "./config.js";

// Read the same way index.js does; the reasoning for createRequire over
// Import Attributes sits there.
const { version } = createRequire(import.meta.url)("./package.json");

const HELP = `gemini-grounding - CLI for the Gemini grounding MCP server

Usage:
  gemini-grounding "<query>" [--model <id>] [--thinking <level>]
  gemini-grounding <command> [argument]

Commands:
  config                 Show saved model, thinking level, backup and API key
                         status
  models [--all]         List the models suggested for use here; --all lists
                         every model the API key exposes, with a status column.
                         Either way set-model accepts any of them
  set-model <id>         Persist the default model; add --thinking <level> to
                         persist both in one call
  set-thinking <level>   Persist the default thinking level; add --model <id> to
                         persist both in one call
  set-backup <id|off>    Persist a model to retry a failed request with; add
                         --thinking <level> to give it its own level, leave it
                         out to inherit the level of the call. "off" disables it
  set-backup
    --thinking <level>   Change only the level of the backup already saved
  help                   Show this help
  version                Show the installed version

Options:
  --model <id>           On a search: use for this call only, nothing is saved.
                         Also disables the backup model for that call
  --thinking <level>     On a search: use for this call only, nothing is saved

Thinking levels: ${THINKING_LEVELS.join(", ")}

Anything that is not a known command is treated as a search query - one single
argument, so quote it if it contains spaces. An option a command has no meaning
for is an error, never silently ignored.

The API key comes from GEMINI_API_KEY. The saved defaults are shared with the
MCP server; "config" prints where they live.`;

/**
 * Usage error - wrong arguments, unknown option, empty query. Handled
 * differently from a real runtime error: the message only, no stack trace,
 * because a typo on the command line does not need one.
 */
class UsageError extends Error {}

function fail(message) {
  throw new UsageError(message);
}

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
    fail(`Missing value for --${name}`);
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
  if (unknownOption) fail(`Unknown option "${unknownOption}".`);

  const [command, ...rest] = args;

  // Every branch checks that nothing surplus is left over - otherwise
  // "set-thinking low nonsense" would save without complaint and drop the rest.
  const requireNoArgs = () => {
    if (rest.length > 0) fail(`"${command}" takes no arguments.`);
  };

  const givenFlags = [];
  if (modelFlag !== undefined) givenFlags.push("model");
  if (thinkingFlag !== undefined) givenFlags.push("thinking");
  if (allFlag) givenFlags.push("all");

  // Counterpart to requireNoArgs for the options: every branch names the ones
  // that mean something to it, everything else aborts. Without this check
  // "config --thinking low" accepted the option without comment and did nothing
  // with it.
  //
  // An allowlist and not a denylist, so an option added later is not
  // accidentally permitted everywhere.
  const allowFlags = (...allowed) => {
    const unexpected = givenFlags.find((name) => !allowed.includes(name));
    if (unexpected) fail(`"${command}" takes no --${unexpected} option.`);
  };

  switch (command) {
    case undefined:
      // A call without arguments is a usage error: help to stderr, exit 1.
      fail(HELP);
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
      // Three states of the backup stay distinguishable: a model, "disabled",
      // "not set".
      console.log(formatConfigState());
      console.log(`API key: ${keyStatus}`);
      // The path is always named, even when the file does not exist yet - it
      // then states where it will appear on the first set-model, and the values
      // above are the built-in defaults.
      console.log(`Config:  ${CONFIG_PATH}`);
      console.log(`Version: ${version}`);
      break;
    }

    case "models":
      // Before listModels, so a typo costs no API call.
      allowFlags("all");
      requireNoArgs();
      console.log(await listModels({ all: allFlag, allOption: "--all" }));
      break;

    // With both set commands the respective other option is persisted too:
    // whoever asks for something to be stored does not want part of the entry to
    // expire. The command's own option is an error - "set-model x --model y"
    // names two models, and which one is meant only the caller can know.
    case "set-model": {
      allowFlags("thinking");
      if (rest.length !== 1) {
        fail("Usage: gemini-grounding set-model <model-id> [--thinking <level>]");
      }
      saveAndReport({ model: rest[0], thinkingLevel: thinkingFlag });
      break;
    }

    case "set-thinking": {
      allowFlags("model");
      if (rest.length !== 1) {
        fail(
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
      allowFlags("thinking");

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
        fail("Usage: gemini-grounding set-backup <model-id|off> [--thinking <level>]");
      }
      // false and not deleting: the difference between "never set" and
      // "deliberately switched off" stays in the file. A --thinking alongside is
      // caught by saveAndReport as well - a switched-off backup has no level, and
      // the option does not expire silently.
      const backupModel = rest[0] === "off" ? false : rest[0];
      saveAndReport({ backupModel, backupThinkingLevel: thinkingFlag });
      break;
    }

    default: {
      // Anything that is not a known subcommand counts as a search query, and as
      // exactly one argument. Reassembling an unquoted question would be
      // deceptive: takeFlag has cut a "--thinking high" out of the middle of it
      // beforehand, so a distorted query would be sent off unnoticed. An own
      // message instead of allowFlags: there the command name would stand in the
      // quotes, and here that name is the search query itself.
      if (allFlag) fail('--all is only valid for the "models" command.');

      if (rest.length > 0) {
        fail("The query must be a single argument - put it in quotes.");
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
  // On a real runtime error, console.error(error) prints the same full stack
  // trace Node would show for an unhandled error - while testing that is exactly
  // what is wanted, unlike index.js, which has to condense the error into a
  // single line for the client. A usage error needs no stack trace, only the
  // message.
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
  console.error(error instanceof UsageError ? error.message : error);
  process.exitCode = 1;
}
