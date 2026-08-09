#!/usr/bin/env node
// Kommandozeilen-Frontend auf denselben Kern, den auch index.js nutzt:
// gemini.js fuer die API-Aufrufe, config.js fuer die gespeicherten Defaults.
// Die relativen Imports loesen in ES-Modulen relativ zu DIESER Datei auf,
// nicht zum Arbeitsverzeichnis - die CLI funktioniert daher aus jedem Ordner.

import { runSearch, listModels } from "./gemini.js";
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

const HELP = `gemini-grounding - CLI for the Gemini grounding MCP server

Usage:
  gemini-grounding "<query>" [--model <id>] [--thinking <level>]
  gemini-grounding <command> [argument]

Commands:
  config                 Show saved model, thinking level, backup and API key
                         status
  models [--all]         List models usable with this server; --all lists every
                         model the API key exposes, including unusable ones
  set-model <id>         Persist the default model; add --thinking <level> to
                         persist both in one call
  set-thinking <level>   Persist the default thinking level; add --model <id> to
                         persist both in one call
  set-backup <id|off>    Persist a model to retry a failed request with; add
                         --thinking <level> to give it its own level, leave it
                         out to inherit the level of the call. "off" disables it
  set-backup --thinking <level>
                         Change only the level of the backup already saved
  help                   Show this help

Options:
  --model <id>           On a search: use for this call only, nothing is saved.
                         Also disables the backup model for that call
  --thinking <level>     On a search: use for this call only, nothing is saved

Thinking levels: ${THINKING_LEVELS.join(", ")}

An option that has no meaning for the given command is an error, never silently
ignored. Anything that is not a known command is treated as a search query. The
query must be a single argument - put it in quotes if it contains spaces.
The API key is read from the GEMINI_API_KEY environment variable.
The saved defaults are shared with the MCP server; "config" prints their location.`;

/**
 * Bedienfehler - falsche Argumente, unbekannte Option, leere Anfrage. Wird
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

/**
 * Schreibt und meldet in einem: erst was sich geaendert hat, dann was ab jetzt
 * gilt. Beide Zeilen kommen aus config.js, damit der MCP-Handler dieselbe
 * Auskunft gibt.
 *
 * Die zweite Haelfte ist der Grund fuer diese Funktion: Ohne sie muesste man
 * nach jedem set-Befehl "config" hinterherschicken, um zu sehen, womit die
 * naechste Recherche tatsaechlich laeuft.
 */
function saveAndReport(values) {
  // Standard und Backup duerfen nicht dasselbe Modell werden - lautlos gaebe
  // es danach kein Ausweichen mehr. Die Pruefung sitzt hier und nicht in den
  // einzelnen Zweigen, damit sie keinen Schreibpfad auslassen kann: "set-model
  // x", "set-thinking low --model x" und "set-backup x" schreiben alle ein
  // Modell, und der zweite hatte sie frueher nicht.
  const collision = findModelCollision(values);
  if (collision) fail(collision);

  // Aus demselben Grund an derselben Stelle: ein Backup-Level ohne sein Modell.
  // Beide Pruefungen liegen in config.js, weil gemini-set-model dieselbe Datei
  // schreibt und beide Werte sogar in einem Aufruf setzen kann.
  const levelProblem = findBackupLevelProblem(values);
  if (levelProblem) fail(levelProblem);

  console.log(`Saved - ${formatSavedValues(setSavedConfig(values))}`);
  console.log(`\n${formatConfigState()}`);
}

async function main() {
  // argv[0] ist der Node-Interpreter, argv[1] das Skript selbst - erst ab
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

  // Jeder Zweig prueft, dass nichts Ueberzaehliges uebrig bleibt - sonst
  // wuerde "set-thinking low unsinn" klaglos speichern und den Rest verwerfen.
  const requireNoArgs = () => {
    if (rest.length > 0) fail(`"${command}" takes no arguments.`);
  };

  const givenFlags = [];
  if (modelFlag !== undefined) givenFlags.push("model");
  if (thinkingFlag !== undefined) givenFlags.push("thinking");
  if (allFlag) givenFlags.push("all");

  // Gegenstueck zu requireNoArgs fuer die Optionen: Jeder Zweig nennt die, die
  // bei ihm eine Bedeutung haben, alles andere bricht ab. Ohne diese Pruefung
  // nahm "config --thinking low" die Option kommentarlos entgegen und tat
  // nichts damit - derselbe stille Verlust, den die Pruefung auf unbekannte
  // Optionen weiter oben schon verhindert.
  //
  // Positivliste und nicht Verbotsliste, damit eine spaeter hinzukommende
  // Option nicht versehentlich ueberall erlaubt ist.
  const allowFlags = (...allowed) => {
    const unexpected = givenFlags.find((name) => !allowed.includes(name));
    if (unexpected) fail(`"${command}" takes no --${unexpected} option.`);
  };

  switch (command) {
    case undefined:
      // Aufruf ohne Argumente ist ein Bedienfehler: Hilfe nach stderr, Exit 1.
      fail(HELP);
      break;

    case "help":
    case "--help":
    case "-h":
      allowFlags();
      requireNoArgs();
      console.log(HELP);
      break;

    case "config": {
      allowFlags();
      requireNoArgs();
      const apiKey = process.env.GEMINI_API_KEY;
      // Der Wert des Keys wird nie ausgegeben, auch nicht gekuerzt - nur seine
      // Laenge, weil sich daran ein abgeschnittenes Einfuegen erkennen laesst.
      const keyStatus = apiKey
        ? `set (${apiKey.length} chars)`
        : "NOT SET - set the GEMINI_API_KEY environment variable";
      // Dieselben zwei Zeilen wie nach jedem set-Befehl - "config" ist damit
      // nicht eine zweite Darstellung derselben Sache, sondern dieselbe plus
      // das, was nur hier interessiert. Drei Zustaende des Backups bleiben
      // dabei unterscheidbar: ein Modell, "disabled", "not set".
      console.log(formatConfigState());
      console.log(`API key: ${keyStatus}`);
      // Der Pfad wird immer genannt, auch wenn die Datei noch gar nicht
      // existiert - dann steht dort, wo sie beim ersten set-model entstehen
      // wird, und die obigen Werte sind die eingebauten Defaults.
      console.log(`Config:  ${CONFIG_PATH}`);
      break;
    }

    case "models":
      // Vor listModels, damit ein Tippfehler keinen API-Aufruf kostet.
      allowFlags("all");
      requireNoArgs();
      console.log(await listModels({ all: allFlag }));
      break;

    // Bei den beiden set-Befehlen persistiert die jeweils andere Option mit:
    // Wer speichern will, will nicht, dass ein Teil der Angabe wieder
    // verfaellt. Die eigene Option ist dagegen ein Fehler - "set-model x
    // --model y" nennt zwei Modelle, und welches gemeint ist, kann nur der
    // Aufrufer wissen.
    case "set-model": {
      allowFlags("thinking");
      if (rest.length !== 1) {
        fail("Usage: gemini-grounding set-model <model-id> [--thinking <level>]");
      }
      // Die Kollisionspruefung sitzt in saveAndReport und gilt damit fuer
      // set-model, set-thinking --model und set-backup gleichermassen.
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

    // Anders als bei den beiden set-Befehlen oben wird das Backup als EINHEIT
    // geschrieben: Ohne --thinking entfernt setSavedConfig() ein zuvor
    // gespeichertes Level, statt es stehen zu lassen. Das Level gehoert zu
    // diesem einen Modell - bliebe es beim Wechsel des Backups liegen, gaelte
    // es stillschweigend fuer ein anderes Modell als das, fuer das es gesetzt
    // wurde. Die Regel steht in config.js, weil sie fuer den MCP-Handler
    // genauso gilt.
    case "set-backup": {
      allowFlags("thinking");

      // Ohne Modellargument gilt der Befehl dem bereits gespeicherten Backup
      // und aendert nur dessen Level. Ohne diesen Zweig muesste man das Modell
      // erneut abtippen, um an seinem Level etwas zu drehen - und ein Vertipper
      // dabei traefe stillschweigend ein anderes Modell.
      //
      // Nur eine Weiche, keine Pruefung: Dass es dafuer ein gespeichertes,
      // eingeschaltetes Backup braucht, weist findBackupLevelProblem() in
      // saveAndReport ab - und zwar mit demselben Wortlaut wie fuer den
      // MCP-Handler, der diesen Zweig nicht durchlaeuft.
      if (rest.length === 0 && thinkingFlag !== undefined) {
        saveAndReport({ backupThinkingLevel: thinkingFlag });
        break;
      }

      if (rest.length !== 1) {
        fail("Usage: gemini-grounding set-backup <model-id|off> [--thinking <level>]");
      }
      // false und nicht loeschen: Der Unterschied zwischen "nie eingestellt"
      // und "bewusst abgeschaltet" bleibt damit in der Datei erhalten. Ein
      // --thinking dazu faengt ebenfalls saveAndReport ab: Ein abgeschaltetes
      // Backup hat kein Level, und die Option verfaellt nicht stillschweigend.
      const backupModel = rest[0] === "off" ? false : rest[0];
      saveAndReport({ backupModel, backupThinkingLevel: thinkingFlag });
      break;
    }

    default: {
      // Alles, was kein bekannter Unterbefehl ist, gilt als Suchanfrage - und
      // zwar als genau ein Argument. Eine unquotiert getippte Frage wieder
      // zusammenzusetzen waere truegerisch: takeFlag hat vorher ein
      // "--thinking high" mitten aus ihr herausgeschnitten, sodass eine
      // sinnentstellte Anfrage abgeschickt wuerde, ohne dass es auffaellt.
      // Eigene Meldung statt allowFlags: Dort stuende der Befehlsname in den
      // Anfuehrungszeichen, und der ist hier die Suchanfrage selbst.
      if (allFlag) fail('--all is only valid for the "models" command.');

      if (rest.length > 0) {
        fail("The query must be a single argument - put it in quotes.");
      }
      const query = command.trim();
      // Ohne diese Pruefung ginge ein leeres Argument - etwa aus einer nicht
      // gesetzten Shell-Variablen - als Anfrage an die API und kostet Tokens.
      if (query === "") fail("The query is empty.");

      // Gleiches Muster wie im MCP-Handler (index.js), und ueber dieselbe
      // Funktion: ein Flag gilt nur fuer diesen Aufruf, sonst greift der
      // gespeicherte Standard. config.json wird dabei nicht angefasst. Aus
      // resolveCallConfig kommt zugleich die Regel, dass --model das Backup
      // fuer diesen Aufruf abschaltet.
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
  // Bei einem echten Laufzeitfehler gibt console.error(error) denselben
  // vollstaendigen Stacktrace aus, den Node bei einem unbehandelten Fehler
  // zeigen wuerde - beim Testen ist genau das gewollt, im Gegensatz zu
  // index.js, das den Fehler fuer den Client auf eine Zeile verdichten muss.
  // Ein Bedienfehler braucht dagegen keinen Stacktrace, nur die Meldung.
  //
  // Gefangen wird er trotzdem, weil Node den Prozess bei einer unbehandelten
  // Rejection hart beendet: haengt dabei noch eine offene Netzwerkverbindung,
  // bricht libuv unter Windows mit "Assertion failed ... src\win\async.c" ab
  // und der Prozess endet mit 0xC0000409 statt mit dem vereinbarten Code 1.
  //
  // process.exitCode statt process.exit(), damit Node regulaer herunterfaehrt -
  // das gilt ausnahmslos, deshalb wirft auch fail() nur einen UsageError,
  // statt selbst zu beenden: stdout und stderr sind unter Windows auf einem
  // TTY asynchron, sodass process.exit() eine laengere Ausgabe wie HELP
  // abschneiden koennte.
  console.error(error instanceof UsageError ? error.message : error);
  process.exitCode = 1;
}
