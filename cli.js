#!/usr/bin/env node
// Kommandozeilen-Frontend auf denselben Kern, den auch index.js nutzt:
// gemini.js fuer die API-Aufrufe, config.js fuer die gespeicherten Defaults.
// Die relativen Imports loesen in ES-Modulen relativ zu DIESER Datei auf,
// nicht zum Arbeitsverzeichnis — die CLI funktioniert daher aus jedem Ordner.

import { runSearch, listModels } from "./gemini.js";
import {
  getSavedModel,
  getSavedThinkingLevel,
  setSavedConfig,
  THINKING_LEVELS,
} from "./config.js";

const HELP = `gemini-grounding — CLI for the Gemini grounding MCP server

Usage:
  gemini-grounding "<query>" [--model <id>] [--thinking <level>]
  gemini-grounding <command> [argument]

Commands:
  config                 Show saved model, thinking level and API key status
  models [--all]         List models usable with this server; --all lists every
                         model the API key exposes, including unusable ones
  set-model <id>         Persist the default model
  set-thinking <level>   Persist the default thinking level
  help                   Show this help

Options (search only, never persisted):
  --model <id>           Use this model for this call only
  --thinking <level>     Use this thinking level for this call only

Thinking levels: ${THINKING_LEVELS.join(", ")}

Anything that is not a known command is treated as a search query. The query
must be a single argument — put it in quotes if it contains spaces.
The API key is read from the GEMINI_API_KEY environment variable.
The saved defaults live in config.json and are shared with the MCP server.`;

/**
 * Bedienfehler — falsche Argumente, unbekannte Option, leere Anfrage. Wird
 * anders behandelt als ein echter Laufzeitfehler: nur die Meldung, kein
 * Stacktrace, weil ein Tippfehler auf der Kommandozeile keinen braucht.
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

/** Wie takeFlag, aber fuer Schalter ohne Wert. */
function takeSwitch(args, name) {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return false;
  args.splice(index, 1);
  return true;
}

async function main() {
  // argv[0] ist der Node-Interpreter, argv[1] das Skript selbst — erst ab
  // Index 2 stehen die vom Benutzer uebergebenen Argumente.
  const args = process.argv.slice(2);

  const modelFlag = takeFlag(args, "model");
  const thinkingFlag = takeFlag(args, "thinking");
  const allFlag = takeSwitch(args, "all");
  if (thinkingFlag !== undefined) requireThinkingLevel(thinkingFlag, "--thinking");

  // Was jetzt noch wie eine Option aussieht, kennt die CLI nicht. Ohne diese
  // Pruefung bliebe ein Tippfehler folgenlos liegen: "models --al" haette
  // stillschweigend die gefilterte Liste gezeigt, die man fuer die
  // vollstaendige haelt. Bewusst nur "--", damit eine Anfrage wie
  // "-5 Grad in Fahrenheit" weiterhin durchgeht; "--help" ist ausgenommen,
  // weil es unten als Unterbefehl behandelt wird.
  const unknownOption = args.find((arg) => arg.startsWith("--") && arg !== "--help");
  if (unknownOption) fail(`Unknown option "${unknownOption}".`);

  const [command, ...rest] = args;

  // Jeder Zweig prueft, dass nichts Ueberzaehliges uebrig bleibt — sonst
  // wuerde "set-thinking low unsinn" klaglos speichern und den Rest verwerfen.
  const requireNoArgs = () => {
    if (rest.length > 0) fail(`"${command}" takes no arguments.`);
  };

  switch (command) {
    case undefined:
      // Aufruf ohne Argumente ist ein Bedienfehler: Hilfe nach stderr, Exit 1.
      fail(HELP);
      break;

    case "help":
    case "--help":
    case "-h":
      requireNoArgs();
      console.log(HELP);
      break;

    case "config": {
      requireNoArgs();
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
      requireNoArgs();
      console.log(await listModels({ all: allFlag }));
      break;

    case "set-model": {
      if (rest.length !== 1) fail("Usage: gemini-grounding set-model <model-id>");
      const model = rest[0];
      setSavedConfig({ model });
      console.log(`Saved — Model: ${model}`);
      break;
    }

    case "set-thinking": {
      if (rest.length !== 1) {
        fail(`Usage: gemini-grounding set-thinking <${THINKING_LEVELS.join("|")}>`);
      }
      const level = requireThinkingLevel(rest[0], "set-thinking");
      setSavedConfig({ thinkingLevel: level });
      console.log(`Saved — Thinking level: ${level}`);
      break;
    }

    default: {
      // Alles, was kein bekannter Unterbefehl ist, gilt als Suchanfrage — und
      // zwar als genau ein Argument. Eine unquotiert getippte Frage wieder
      // zusammenzusetzen waere truegerisch: takeFlag hat vorher ein
      // "--thinking high" mitten aus ihr herausgeschnitten, sodass eine
      // sinnentstellte Anfrage abgeschickt wuerde, ohne dass es auffaellt.
      if (rest.length > 0) {
        fail("The query must be a single argument — put it in quotes.");
      }
      const query = command.trim();
      // Ohne diese Pruefung ginge ein leeres Argument — etwa aus einer nicht
      // gesetzten Shell-Variablen — als Anfrage an die API und kostet Tokens.
      if (query === "") fail("The query is empty.");

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
}

try {
  await main();
} catch (error) {
  // Bei einem echten Laufzeitfehler gibt console.error(error) denselben
  // vollstaendigen Stacktrace aus, den Node bei einem unbehandelten Fehler
  // zeigen wuerde — beim Testen ist genau das gewollt, im Gegensatz zu
  // index.js, das den Fehler fuer den Client auf eine Zeile verdichten muss.
  // Ein Bedienfehler braucht dagegen keinen Stacktrace, nur die Meldung.
  //
  // Gefangen wird er trotzdem, weil Node den Prozess bei einer unbehandelten
  // Rejection hart beendet: haengt dabei noch eine offene Netzwerkverbindung,
  // bricht libuv unter Windows mit "Assertion failed ... src\win\async.c" ab
  // und der Prozess endet mit 0xC0000409 statt mit dem vereinbarten Code 1.
  //
  // process.exitCode statt process.exit(), damit Node regulaer herunterfaehrt —
  // das gilt ausnahmslos, deshalb wirft auch fail() nur einen UsageError,
  // statt selbst zu beenden: stdout und stderr sind unter Windows auf einem
  // TTY asynchron, sodass process.exit() eine laengere Ausgabe wie HELP
  // abschneiden koennte.
  console.error(error instanceof UsageError ? error.message : error);
  process.exitCode = 1;
}
