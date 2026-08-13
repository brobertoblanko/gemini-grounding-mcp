import fs from "fs";
import os from "os";
import path from "path";

// The platform's conventional location for user state, NOT "./config.json" -
// the working directory of an MCP server started over stdio is not guaranteed
// to be the project folder. Script-relative was rejected as well: with "npm
// install -g" the script sits in a directory the package manager rewrites on
// update, with "npx" in a cache whose hash changes with every version - the
// setting would be effectively ephemeral there.
//
// Order: XDG_CONFIG_HOME wins when set - the Linux convention and at the same
// time the escape hatch for anyone who does not want the default location.
// Otherwise %APPDATA% on Windows, where user state belongs, not ~/.config.
// macOS is deliberately treated like Linux although the Apple standard would be
// ~/Library/Application Support/: this is a terminal tool, and in the terminal
// nobody goes looking in a folder that Finder hides.
// Full derivation: docs/specs.md, "Configuration file location".
const CONFIG_DIR = path.join(
  process.env.XDG_CONFIG_HOME ??
    (process.platform === "win32"
      ? (process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"))
      : path.join(os.homedir(), ".config")),
  "gemini-grounding-mcp",
);

/**
 * Full path of the configuration file. Exported because discoverability comes
 * from the output rather than from the location: MCP server and CLI name the
 * path so nobody has to guess where the setting lives.
 */
export const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");

// DEFAULT_ and not FALLBACK_: in gemini.js "fallback" means the switch to the
// backup model after a failed request. These two are the built-in values for a
// missing config.json and have nothing to do with it.
const DEFAULT_MODEL = "gemini-flash-latest";
// Deliberately "medium" and not "high": this default applies to every new user
// without a config.json, and a higher level spends more thinking tokens
// unasked. Whoever wants more sets it per call or permanently via
// gemini-set-model.
const DEFAULT_THINKING_LEVEL = "medium";

/**
 * The thinking levels the Gemini API accepts - single source for MCP server and
 * CLI so both allow the same values. index.js turns them into the Zod schemas
 * (z.enum takes this array directly), cli.js validates its command line
 * arguments against them.
 */
export const THINKING_LEVELS = ["minimal", "low", "medium", "high"];

// readConfig() runs three times per call - from getSavedModel(), from
// getSavedThinkingLevel() and from getSavedBackup(). Without this flag the same
// warning would stand there three times over and look like three separate
// faults.
let warned = false;

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
  } catch (error) {
    // The missing file is the normal case and no error: before the first stored
    // value it does not exist, and the defaults are exactly what is wanted then.
    // Everything else - broken JSON after an interrupted write, missing read
    // permissions - renders a stored setting ineffective, and without a word the
    // server would simply keep running on the defaults.
    //
    // console.error and not console.log: the MCP server speaks JSON-RPC over
    // stdout, where a single line breaks the connection to the client. stderr
    // lands in the client's log and, on the command line, straight in front of
    // the user.
    if (error.code !== "ENOENT" && !warned) {
      warned = true;
      console.error(
        `Warning: ${CONFIG_PATH} could not be read (${error.message}) - using defaults.`,
      );
    }
    return {};
  }
}

/**
 * Reads the persistently stored default model.
 * Returns DEFAULT_MODEL when no or a broken config.json exists.
 */
export function getSavedModel() {
  return readConfig().model ?? DEFAULT_MODEL;
}

/**
 * Reads the persistently stored default thinking level.
 * Returns DEFAULT_THINKING_LEVEL when no or a broken config.json exists.
 */
export function getSavedThinkingLevel() {
  return readConfig().thinkingLevel ?? DEFAULT_THINKING_LEVEL;
}

/**
 * Reads the stored backup model as a unit: a model and the thinking level
 * assigned to it belong together and are therefore read together, rather than
 * through two getters like the default values.
 *
 * Three states that have to be kept apart:
 * - `model` set: a fallback takes place
 * - `disabled`: explicitly switched off via false
 * - both empty: never configured
 *
 * The difference between the last two changes nothing about the behaviour and
 * exists solely for the output of "gemini-grounding config": "not set" and
 * "disabled" are two different statements to the user.
 *
 * Both are validated because the file can be edited by hand. A model has to be
 * a non-empty string, a level one of the known ones - otherwise an unusable
 * value would go to the API first and come back as a 400, on the very path that
 * is meant to catch an error.
 */
export function getSavedBackup() {
  const { backupModel, backupThinkingLevel } = readConfig();
  return {
    model: typeof backupModel === "string" && backupModel !== "" ? backupModel : undefined,
    thinkingLevel: THINKING_LEVELS.includes(backupThinkingLevel)
      ? backupThinkingLevel
      : undefined,
    disabled: backupModel === false,
  };
}

/**
 * Resolves which model and thinking level a single call actually runs with -
 * and whether it gets a backup. Shared ground for the MCP handler and the CLI
 * so both give the same answer.
 *
 * Resolution happens anew on EVERY call. A value resolved once would be wrong
 * from the next gemini-set-model on, without anyone noticing.
 *
 * Full derivation: docs/specs.md, "Resolving the defaults per call".
 */
export function resolveCallConfig({ model, thinkingLevel } = {}) {
  // A model named on the call gets NO backup. Whoever names one wants that one -
  // frequently in order to check whether it is reachable at all. An answer from
  // a different model does not answer that question, it hides it.
  //
  // The rule is syntactic and applies even when the named model happens to equal
  // the stored default: what counts is the explicit naming, not the value. An
  // explicit thinkingLevel does not affect the fallback - the model then still
  // is the stored default.
  const backup = model === undefined ? getSavedBackup() : {};

  return {
    model: model ?? getSavedModel(),
    thinkingLevel: thinkingLevel ?? getSavedThinkingLevel(),
    backupModel: backup.model,
    backupThinkingLevel: backup.thinkingLevel,
  };
}

/**
 * Whether a write would put default and backup on the same model - as a plain
 * text reason, or undefined when everything is in order.
 *
 * Were both equal, no fallback would take place at all: runSearch then refuses
 * it with "it is the same model as the default". That is a safety net and no
 * substitute for this check - it only fires on the next failing call, and until
 * then the backup is silently dead.
 *
 * Checked is the STATE AFTER the write, not the call: only that way does the
 * case show up in which a single call sets both values at once. A call without
 * any model is let through even when the stored values already collide -
 * "set-thinking low" did not cause that state and should not fail on it.
 *
 * Here and not in cli.js, because it would otherwise apply to the CLI alone:
 * gemini-set-model writes the same file and can set both values in one go.
 */
export function findModelCollision({ model, backupModel } = {}) {
  if (model === undefined && backupModel === undefined) return undefined;

  const resultingModel = model ?? getSavedModel();
  // false (switched off) and undefined (never configured) are both harmless and
  // drop out through the truthiness check below.
  const resultingBackup = backupModel === undefined ? getSavedBackup().model : backupModel;
  if (!resultingBackup || resultingModel !== resultingBackup) return undefined;

  // Which side the call touches decides the advice: whoever sets the default
  // model has to change something about the backup, and the other way round.
  if (model !== undefined && backupModel !== undefined) {
    return `"${resultingModel}" cannot be both the default and the backup model - a backup only helps if it is a different one.`;
  }
  if (model !== undefined) {
    return `"${resultingModel}" is currently the backup model - set a different backup first, or switch the backup off.`;
  }
  return `"${resultingBackup}" is already the default model - a backup only helps if it is a different one.`;
}

/**
 * Whether a write would leave behind a backup thinking level without its model
 * - as a plain text reason, or undefined.
 *
 * A level belongs to exactly one model (see the unit rule in setSavedConfig).
 * Without that model it has nothing to refer to: it sits in the file, takes
 * effect nowhere, and the confirmation reports a value that the state block two
 * lines below revokes as "not set" or "disabled".
 *
 * As in findModelCollision, checked on the STATE AFTER THE WRITE and not on the
 * single argument, because only gemini-set-model can set model and level in ONE
 * call - at the time of the check neither of them is stored yet.
 */
export function findBackupLevelProblem({ backupModel, backupThinkingLevel } = {}) {
  // null deletes the level and needs no model: the way back to "inherits from
  // the call" must stay open even when no backup is left at all.
  if (backupThinkingLevel === undefined || backupThinkingLevel === null) return undefined;

  const saved = getSavedBackup();
  // Model ID, false (switched off) or undefined (never configured). ?? and not
  // ||, so that a false passed in is preserved.
  const resulting = backupModel ?? (saved.disabled ? false : saved.model);
  if (resulting) return undefined;

  // No CLI command name in the message: the same function answers both
  // interfaces, and "set-backup ..." would be advice into the void inside an MCP
  // response.
  //
  // The first message names the rule and not the state ("a backup that is
  // switched off" instead of "the backup is switched off"): it also appears
  // where the call brings the switching off about in the first place and a
  // backup is still running.
  return resulting === false
    ? "a backup that is switched off has no thinking level - switch a backup model on first, or leave the level out."
    : "no backup model is set - a thinking level on its own has nothing to belong to. Name the backup model together with the level.";
}

/**
 * Stores model, thinking level and backup persistently without overwriting the
 * respective other stored values (undefined fields stay untouched). Contains
 * these values only, never the API key or other sensitive data.
 *
 * null deletes the key. Today only backupThinkingLevel needs that, to fall back
 * to "inherits from the primary call" - the rule applies to all four all the
 * same, because a special rule for exactly one field is not explainable later.
 *
 * THE ONE EXCEPTION TO THE MERGE RULE: the backup is written as a UNIT. A
 * backupModel arriving without a backupThinkingLevel of its own expires a
 * previously stored level instead of leaving it in place. The level belongs to
 * that one model - carried across a change of backup, it would silently apply to
 * a model it was never chosen for.
 *
 * Returns what was actually written - including the null derived here. Only then
 * can the confirmation at the caller name the level that fell away instead of
 * concealing it.
 */
export function setSavedConfig({ model, thinkingLevel, backupModel, backupThinkingLevel }) {
  if (backupModel !== undefined && backupThinkingLevel === undefined) {
    backupThinkingLevel = null;
  }

  const config = readConfig();
  const apply = (key, value) => {
    if (value === undefined) return;
    if (value === null) delete config[key];
    else config[key] = value;
  };
  apply("model", model);
  apply("thinkingLevel", thinkingLevel);
  apply("backupModel", backupModel);
  apply("backupThinkingLevel", backupThinkingLevel);
  // Created on the write path only, so the package creates nothing unasked: as
  // long as nobody sets the model, neither directory nor file comes into
  // existence - readConfig() already handles the missing file.
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));

  return { model, thinkingLevel, backupModel, backupThinkingLevel };
}

/**
 * Confirms every written value individually. Intended for the result of
 * setSavedConfig(), so that the derived null appears there as well.
 *
 * What was stored without standing there is indistinguishable from a discarded
 * parameter - hence every value stands there on its own rather than a bare
 * "saved".
 *
 * Shared by the CLI and the MCP handler, which differ only in their prefix. Two
 * separate copies would drift apart sooner or later.
 *
 * Full derivation: docs/specs.md, "Reporting what was saved".
 */
export function formatSavedValues({ model, thinkingLevel, backupModel, backupThinkingLevel }) {
  const parts = [];
  if (model !== undefined) parts.push(`Model: ${model}`);
  if (thinkingLevel !== undefined) parts.push(`Thinking level: ${thinkingLevel}`);
  if (backupModel !== undefined) {
    parts.push(backupModel === false ? "Backup: off" : `Backup: ${backupModel}`);
  }
  // null means "deleted" and with it: inherits from the call again. That belongs
  // in the output because a previously set level disappears in the process -
  // except on a switched-off backup, where a level means nothing any more.
  if (backupThinkingLevel !== undefined && backupModel !== false) {
    parts.push(
      backupThinkingLevel === null
        ? "Backup thinking level: inherited from the call"
        : `Backup thinking level: ${backupThinkingLevel}`,
    );
  }
  return parts.join(", ");
}

/**
 * The complete stored state in two lines - what applies from now on, not what
 * was just written.
 *
 * Printed after EVERY write and in "config", in the CLI as in the MCP handler.
 * The confirmation above says what changed; only these two lines say what the
 * next query runs with - and that gap is exactly where somebody ends up working
 * with a model they did not mean.
 *
 * On the inherited level the value is printed rather than a bare "inherited":
 * what the backup would run with if it stepped in right now is the information
 * being asked for. The suffix says the value is not its own but travels along -
 * a call passing its own thinkingLevel is what the backup inherits then.
 *
 * The middle dot separates as in formatSearchQueries (gemini.js): model names
 * contain hyphens and digits of their own, between which another hyphen would
 * disappear.
 */
export function formatConfigState() {
  const thinkingLevel = getSavedThinkingLevel();
  const backup = getSavedBackup();

  const backupLine = backup.model
    ? `${backup.model} · ${backup.thinkingLevel ?? `${thinkingLevel} (inherited)`}`
    : backup.disabled
      ? "disabled"
      : "not set";

  return `Primary: ${getSavedModel()} · ${thinkingLevel}\nBackup:  ${backupLine}`;
}
