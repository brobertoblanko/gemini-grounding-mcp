#!/usr/bin/env node
// Kommandozeilen-Frontend auf denselben Kern, den auch index.js nutzt:
// gemini.js fuer die API-Aufrufe, config.js fuer die gespeicherten Defaults.
// Die relativen Imports loesen in ES-Modulen relativ zu DIESER Datei auf,
// nicht zum Arbeitsverzeichnis — die CLI funktioniert daher aus jedem Ordner.

import { runSearch, listModels } from "./gemini.js";
import { getSavedModel, getSavedThinkingLevel, setSavedConfig } from "./config.js";

// Spiegelt bewusst das z.enum([...]) aus index.js (gemini-search und
// gemini-set-model). Ein gemeinsamer Export wuerde die CLI an zod koppeln,
// das sie sonst nicht braucht. Bei einer Erweiterung: beide Stellen anpassen.
const THINKING_LEVELS = ["minimal", "low", "medium", "high"];

const HELP = `gemini-grounding — CLI for the Gemini grounding MCP server

Usage:
  gemini-grounding "<query>" [--model <id>] [--thinking <level>]
  gemini-grounding <command> [argument]

Commands:
  config                 Show saved model, thinking level and API key status
  models                 List models available for the current API key
  set-model <id>         Persist the default model
  set-thinking <level>   Persist the default thinking level
  help                   Show this help

Options (search only, never persisted):
  --model <id>           Use this model for this call only
  --thinking <level>     Use this thinking level for this call only

Thinking levels: ${THINKING_LEVELS.join(", ")}

Anything that is not a known command is treated as a search query.
The API key is read from the GEMINI_API_KEY environment variable.
The saved defaults live in config.json and are shared with the MCP server.`;

function fail(message) {
  console.error(message);
  process.exit(1);
}

function requireThinkingLevel(value, origin) {
  if (!THINKING_LEVELS.includes(value)) {
    fail(`Invalid thinking level "${value}" for ${origin}. Allowed: ${THINKING_LEVELS.join(", ")}`);
  }
  return value;
}

/**
 * Holt "--name <wert>" aus der Argumentliste und ENTFERNT beides daraus.
 * Dadurch ist die Position der Flags beliebig und der uebrig bleibende Rest
 * ist sauber Unterbefehl bzw. Suchanfrage.
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

// argv[0] ist der Node-Interpreter, argv[1] das Skript selbst — erst ab
// Index 2 stehen die vom Benutzer uebergebenen Argumente.
const args = process.argv.slice(2);

const modelFlag = takeFlag(args, "model");
const thinkingFlag = takeFlag(args, "thinking");
if (thinkingFlag !== undefined) requireThinkingLevel(thinkingFlag, "--thinking");

const [command, ...rest] = args;

try {
  switch (command) {
    case undefined:
      // Aufruf ohne Argumente ist ein Bedienfehler: Hilfe nach stderr, Exit 1.
      console.error(HELP);
      process.exit(1);

    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      break;

    case "config": {
      const apiKey = process.env.GEMINI_API_KEY;
      // Der Wert des Keys wird nie ausgegeben, auch nicht gekuerzt — nur seine
      // Laenge, weil sich daran ein abgeschnittenes Einfuegen erkennen laesst.
      const keyStatus = apiKey
        ? `set (${apiKey.length} chars)`
        : "NOT SET — set the GEMINI_API_KEY environment variable";
      console.log(`${"Model:".padEnd(16)}${getSavedModel()}`);
      console.log(`${"Thinking level:".padEnd(16)}${getSavedThinkingLevel()}`);
      console.log(`${"API key:".padEnd(16)}${keyStatus}`);
      break;
    }

    case "models":
      console.log(await listModels());
      break;

    case "set-model": {
      const model = rest[0];
      if (model === undefined) fail("Usage: gemini-grounding set-model <model-id>");
      setSavedConfig({ model });
      console.log(`Saved — Model: ${model}`);
      break;
    }

    case "set-thinking": {
      const level = rest[0];
      if (level === undefined) {
        fail(`Usage: gemini-grounding set-thinking <${THINKING_LEVELS.join("|")}>`);
      }
      requireThinkingLevel(level, "set-thinking");
      setSavedConfig({ thinkingLevel: level });
      console.log(`Saved — Thinking level: ${level}`);
      break;
    }

    default: {
      // Alles, was kein bekannter Unterbefehl ist, gilt als Suchanfrage. Das
      // join(" ") setzt eine unquotierte Frage wieder zusammen, die die Shell
      // an den Leerzeichen in mehrere Argumente zerlegt hat.
      const query = args.join(" ");

      // Gleiches Muster wie im MCP-Handler (index.js): ein Flag gilt nur fuer
      // diesen Aufruf, sonst greift der gespeicherte Standard. config.json wird
      // dabei nicht angefasst.
      const text = await runSearch({
        query,
        model: modelFlag ?? getSavedModel(),
        thinkingLevel: thinkingFlag ?? getSavedThinkingLevel(),
      });
      console.log(text);
    }
  }
} catch (error) {
  // console.error(error) gibt denselben vollstaendigen Stacktrace aus, den Node
  // bei einem unbehandelten Fehler zeigen wuerde — beim Testen ist genau das
  // gewollt, im Gegensatz zu index.js, das den Fehler fuer den Client auf eine
  // Zeile verdichten muss.
  //
  // Gefangen wird er trotzdem, weil Node den Prozess bei einer unbehandelten
  // Rejection hart beendet: haengt dabei noch eine offene Netzwerkverbindung,
  // bricht libuv unter Windows mit "Assertion failed ... src\win\async.c" ab
  // und der Prozess endet mit 0xC0000409 statt mit dem vereinbarten Code 1.
  // process.exitCode statt process.exit(), damit Node regulaer herunterfaehrt.
  console.error(error);
  process.exitCode = 1;
}
