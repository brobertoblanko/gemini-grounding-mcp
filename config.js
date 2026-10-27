import fs from "fs";
import os from "os";
import path from "path";

// The platform's conventional location for user state, NOT "./config.json" and
// not next to the script: an MCP server's working directory is not guaranteed,
// and npm rewrites the script's directory on update or caches it per version.
// XDG_CONFIG_HOME wins, then %APPDATA% on Windows, otherwise ~/.config - macOS
// included, because in the terminal nobody looks in a folder Finder hides. An
// empty or relative value counts as unset, as the XDG spec demands.
// Full derivation: docs/specs.md, "Configuration file location".
const absolute = (value) => (value && path.isAbsolute(value) ? value : undefined);
const CONFIG_DIR = path.join(
  absolute(process.env.XDG_CONFIG_HOME) ??
    (process.platform === "win32"
      ? (absolute(process.env.APPDATA) ?? path.join(os.homedir(), "AppData", "Roaming"))
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
// gemini-set-config.
const DEFAULT_THINKING_LEVEL = "medium";

/**
 * The deadline Google's gateway is told about, in whole seconds, for a missing
 * or unusable config.json entry. Below Google's own limit of 10 minutes for a
 * unary request (SDK comment on createUndiciNoTimeoutDispatcher, @google/genai
 * 2.31.0), so the header still decides. A round number, because since
 * @google/genai 2.29 no client-side limit is left to stay under.
 * Full derivation: docs/specs.md, "The deadline this server does send".
 */
export const DEFAULT_DEADLINE_SECONDS = 300;

/**
 * Google's own limit for a unary request (see DEFAULT_DEADLINE_SECONDS). A larger
 * deadline would promise a limit that does not exist.
 */
export const MAX_DEADLINE_SECONDS = 600;

/**
 * Google's lower limit for X-Server-Timeout. Measured 2026-10-27, a smaller one
 * fails every request with 400 "Manually set deadline 1s is too short. Minimum
 * allowed deadline is 10s." - and the backup with it, because a 400 falls back.
 */
export const MIN_DEADLINE_SECONDS = 10;

/**
 * Whether a value may be stored as the deadline: a whole number of seconds from
 * MIN_DEADLINE_SECONDS to MAX_DEADLINE_SECONDS, or false for "send none". false
 * and not 0 or null, the same convention as backupModel: false - a switch that
 * is deliberately off, kept apart from "never set".
 */
export function isValidDeadline(value) {
  return (
    value === false ||
    (Number.isInteger(value) && value >= MIN_DEADLINE_SECONDS && value <= MAX_DEADLINE_SECONDS)
  );
}

/**
 * The thinking levels the Gemini API accepts - single source for MCP server and
 * CLI so both allow the same values. index.js turns them into the Zod schemas
 * (z.enum takes this array directly), cli.js validates its command line
 * arguments against them.
 */
export const THINKING_LEVELS = ["minimal", "low", "medium", "high"];

// The MCP server reads config.json on every call; without this memory each
// search would repeat the same warning in the client's log.
const warned = new Map();
let collecting = false;

/**
 * console.error and not console.log: the MCP server speaks JSON-RPC over
 * stdout, where a single line breaks the connection to the client. stderr lands
 * in the client's log and, on the command line, straight in front of the user.
 */
function warnOnce(key, message) {
  if (warned.has(key)) return;
  warned.set(key, message);
  if (!collecting) console.error(`Warning: ${message}`);
}

/**
 * Everything wrong with config.json, through the same loadConfig() every call
 * runs - so "doctor" in cli.js cannot disagree with what a search actually
 * does. Collected instead of printed, and with the path shortened to
 * the file name: the output is meant to be pasted into a bug report.
 */
export function configProblems() {
  collecting = true;
  try {
    loadConfig();
  } finally {
    collecting = false;
  }
  return [...warned.values()].map((message) => message.replaceAll(CONFIG_PATH, "config.json"));
}

/**
 * strict is for the write path: there an unreadable file must stop the write,
 * because writing on top of the defaults would replace every stored value with
 * the one just set.
 */
function readConfig({ strict = false } = {}) {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    // null would crash loadConfig(), and an array swallows the write silently:
    // JSON.stringify drops properties set on it.
    if (typeof config !== "object" || config === null || Array.isArray(config)) {
      throw new Error("not a JSON object");
    }
    return config;
  } catch (error) {
    if (strict && error.code !== "ENOENT") {
      throw new Error(
        `${CONFIG_PATH} could not be read (${error.message}) - fix it, or delete it with "gemini-grounding reset all"; nothing was saved.`,
      );
    }
    // The missing file is the normal case before the first stored value. Anything
    // else renders a stored setting ineffective and must not pass in silence.
    if (error.code !== "ENOENT") {
      warnOnce("file", `${CONFIG_PATH} could not be read (${error.message}) - using defaults.`);
    }
    return {};
  }
}

/**
 * The stored settings as one validated snapshot, read from the file once, so a
 * call cannot mix values from before and after a write. Each value falls back
 * to its default when no or a broken config.json exists.
 */
export function loadConfig() {
  const config = readConfig();
  return {
    model: savedModel(config),
    thinkingLevel: savedThinkingLevel(config),
    backup: savedBackup(config),
    deadlineSeconds: savedDeadline(config),
  };
}

// Validated like the backup, because the file can be edited by hand: an empty
// model would go to the API on every search.
function savedModel({ model }) {
  if (model === undefined) return DEFAULT_MODEL;
  if (typeof model === "string" && model.trim() !== "") return model;
  warnOnce(
    "model",
    `model in ${CONFIG_PATH} must be a non-empty string, not ${JSON.stringify(model)} - ` +
      `using ${DEFAULT_MODEL}.`,
  );
  return DEFAULT_MODEL;
}

// Validated because an unknown level comes back as a 400, which triggers the
// fallback - and the backup inherits the same unusable level.
function savedThinkingLevel({ thinkingLevel }) {
  if (thinkingLevel === undefined) return DEFAULT_THINKING_LEVEL;
  if (THINKING_LEVELS.includes(thinkingLevel)) return thinkingLevel;
  warnOnce(
    "thinkingLevel",
    `thinkingLevel in ${CONFIG_PATH} must be one of ${THINKING_LEVELS.join(", ")}, ` +
      `not ${JSON.stringify(thinkingLevel)} - using ${DEFAULT_THINKING_LEVEL}.`,
  );
  return DEFAULT_THINKING_LEVEL;
}

/**
 * Whole seconds, or false when none is to be sent. An unusable value warns:
 * unlike an unknown model, which the API rejects, a deadline nobody applies
 * would show nowhere.
 */
function savedDeadline({ deadlineSeconds }) {
  if (deadlineSeconds === undefined) return DEFAULT_DEADLINE_SECONDS;
  if (isValidDeadline(deadlineSeconds)) return deadlineSeconds;

  // The cap and not the default: whoever wrote 3600 wanted the longest deadline
  // there is.
  if (Number.isInteger(deadlineSeconds) && deadlineSeconds > MAX_DEADLINE_SECONDS) {
    warnOnce(
      "deadlineSeconds",
      `deadlineSeconds in ${CONFIG_PATH} is ${deadlineSeconds}, but Google ends a request ` +
        `after ${MAX_DEADLINE_SECONDS} s anyway - using ${MAX_DEADLINE_SECONDS}.`,
    );
    return MAX_DEADLINE_SECONDS;
  }
  // The floor for the same reason: whoever wrote 5 wanted the shortest one.
  if (Number.isInteger(deadlineSeconds) && deadlineSeconds > 0 && deadlineSeconds < MIN_DEADLINE_SECONDS) {
    warnOnce(
      "deadlineSeconds",
      `deadlineSeconds in ${CONFIG_PATH} is ${deadlineSeconds}, but Google rejects a deadline ` +
        `below ${MIN_DEADLINE_SECONDS} s - using ${MIN_DEADLINE_SECONDS}.`,
    );
    return MIN_DEADLINE_SECONDS;
  }
  warnOnce(
    "deadlineSeconds",
    `deadlineSeconds in ${CONFIG_PATH} must be a whole number from ${MIN_DEADLINE_SECONDS} to ${MAX_DEADLINE_SECONDS} or false, ` +
      `not ${JSON.stringify(deadlineSeconds)} - using ${DEFAULT_DEADLINE_SECONDS}.`,
  );
  return DEFAULT_DEADLINE_SECONDS;
}

/**
 * The backup as a unit, because a model and its thinking level belong
 * together. disabled (false in the file) behaves like "never configured"
 * and exists for the output of "config" alone: "off" and "not set" are two
 * different statements. Invalid values count as unset, so they never reach the
 * API on the very path that is meant to catch an error - and warn, because
 * "High" for "high" would otherwise leave the backup on the inherited level
 * unseen.
 */
function savedBackup({ backupModel, backupThinkingLevel }) {
  const model = typeof backupModel === "string" && backupModel.trim() !== "" ? backupModel : undefined;
  if (backupModel !== undefined && backupModel !== false && !model) {
    warnOnce(
      "backupModel",
      `backupModel in ${CONFIG_PATH} must be a non-empty string or false, ` +
        `not ${JSON.stringify(backupModel)} - no backup is used.`,
    );
  }
  const thinkingLevel = THINKING_LEVELS.includes(backupThinkingLevel) ? backupThinkingLevel : undefined;
  if (backupThinkingLevel !== undefined && !thinkingLevel) {
    warnOnce(
      "backupThinkingLevel",
      `backupThinkingLevel in ${CONFIG_PATH} must be one of ${THINKING_LEVELS.join(", ")}, ` +
        `not ${JSON.stringify(backupThinkingLevel)} - the backup inherits the level of the call.`,
    );
  }
  return { model, thinkingLevel, disabled: backupModel === false };
}

/**
 * Which model and thinking level a single call runs with, and whether it gets a
 * backup - shared by the MCP handler and the CLI. Resolved anew on EVERY call,
 * because a value resolved once would be wrong after the next gemini-set-config.
 * Full derivation: docs/specs.md, "Resolving the defaults per call".
 */
export function resolveCallConfig({ model, thinkingLevel } = {}) {
  // A model named on the call gets NO backup: whoever names one often wants to
  // know whether that one is reachable. Syntactic - it applies even when the
  // named model equals the stored default.
  const saved = loadConfig();
  const backup = model === undefined ? saved.backup : {};

  return {
    model: model ?? saved.model,
    thinkingLevel: thinkingLevel ?? saved.thinkingLevel,
    backupModel: backup.model,
    backupThinkingLevel: backup.thinkingLevel,
    // No per-call override: the deadline is an operating setting, and a call
    // that could raise it would turn a 504 into an invitation to retry longer.
    deadlineSeconds: saved.deadlineSeconds,
  };
}

/**
 * Whether a write would put default and backup on the same model, as a plain
 * text reason. runSearch refuses such a fallback as well, but only on the next
 * failing call; until then the backup is silently dead.
 *
 * Checked on the STATE AFTER the write, because gemini-set-config can set both
 * in one call. A call without any model passes even when the stored values
 * already collide: it did not cause that state.
 */
export function findModelCollision({ model, backupModel } = {}) {
  if (model === undefined && backupModel === undefined) return undefined;

  const saved = loadConfig();
  // null is a reset and leaves the built-in default, not what is saved now.
  const resultingModel = model === null ? DEFAULT_MODEL : (model ?? saved.model);
  // false (switched off) and undefined (never configured) are both harmless and
  // drop out through the truthiness check below.
  const resultingBackup = backupModel === undefined ? saved.backup.model : backupModel;
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
 * Whether a write would leave a backup thinking level without its model, as a
 * plain text reason. Such a level takes effect nowhere, and the confirmation
 * would name a value that the state block below revokes. Checked on the STATE
 * AFTER THE WRITE, as in findModelCollision.
 */
export function findBackupLevelProblem({ backupModel, backupThinkingLevel } = {}) {
  // null deletes the level and needs no model: the way back to "inherits from
  // the call" must stay open even when no backup is left at all.
  if (backupThinkingLevel === undefined || backupThinkingLevel === null) return undefined;

  const saved = loadConfig().backup;
  // Model ID, false (switched off) or undefined (never configured). ?? and not
  // ||, so that a false passed in is preserved.
  const resulting = backupModel ?? (saved.disabled ? false : saved.model);
  if (resulting) return undefined;

  // No command name: both interfaces share the text. The first message names the
  // rule, not the state, because the same call may be what switches it off.
  return resulting === false
    ? "a backup that is switched off has no thinking level - switch a backup model on first, or leave the level out."
    : "no backup model is set - a thinking level on its own has nothing to belong to. Name the backup model together with the level.";
}

/**
 * Stores model, thinking level, backup and deadline persistently without
 * overwriting the respective other stored values (undefined fields stay
 * untouched). Contains these values only, never the API key, other sensitive
 * data or anything from a response - INVARIANT I4 (see CLAUDE.md and
 * docs/specs.md, "Terms compliance"): Grounded Results never touch the disk.
 *
 * null deletes the key. THE ONE EXCEPTION TO THE MERGE RULE: a backupModel
 * without a backupThinkingLevel of its own expires the stored level, which was
 * chosen for a different model. Returns what was actually written, that null
 * included, so the confirmation can name the level that fell away.
 */
export function setSavedConfig({
  model,
  thinkingLevel,
  backupModel,
  backupThinkingLevel,
  deadlineSeconds,
}) {
  if (backupModel !== undefined && backupThinkingLevel === undefined) {
    backupThinkingLevel = null;
  }

  const config = readConfig({ strict: true });
  const apply = (key, value) => {
    if (value === undefined) return;
    if (value === null) delete config[key];
    else config[key] = value;
  };
  apply("model", model);
  apply("thinkingLevel", thinkingLevel);
  apply("backupModel", backupModel);
  apply("backupThinkingLevel", backupThinkingLevel);
  apply("deadlineSeconds", deadlineSeconds);
  // Created on the write path only, so the package creates nothing unasked.
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  // Written beside it and renamed over it, so an interrupted write leaves the old
  // file instead of half a new one. The pid keeps CLI and server apart.
  const temp = `${CONFIG_PATH}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(config, null, 2));
    fs.renameSync(temp, CONFIG_PATH);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }

  return { model, thinkingLevel, backupModel, backupThinkingLevel, deadlineSeconds };
}

/** Removes the whole file; a missing one is no error. */
export function deleteSavedConfig() {
  fs.rmSync(CONFIG_PATH, { force: true });
}

/** "300 s", or what false means, for the confirmation and the state block. */
function formatDeadline(deadlineSeconds) {
  return deadlineSeconds === false
    ? "none (Google's own limit applies)"
    : `${deadlineSeconds} s`;
}

/**
 * Confirms every written value individually, from the result of setSavedConfig()
 * so the derived null appears too: a value stored without being named is
 * indistinguishable from a discarded parameter. Shared by the CLI and the MCP
 * handler, so the two cannot drift apart.
 * Full derivation: docs/specs.md, "Reporting what was saved".
 */
export function formatSavedValues({
  model,
  thinkingLevel,
  backupModel,
  backupThinkingLevel,
  deadlineSeconds,
}) {
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
  if (deadlineSeconds !== undefined) parts.push(`Deadline: ${formatDeadline(deadlineSeconds)}`);
  return parts.join(", ");
}

/**
 * The complete stored state in three lines - what the next query runs with, not
 * what was just written. Printed after EVERY write and in "config". The
 * inherited level is printed as its value, because that is what the backup
 * would run with right now. The labels are padded to the width of "Deadline: ",
 * and cli.js pads its own lines in "config" to the same column.
 * Full derivation: docs/specs.md, "Reporting what was saved".
 */
export function formatConfigState() {
  const { model, thinkingLevel, backup, deadlineSeconds } = loadConfig();

  const backupLine = backup.model
    ? `${backup.model} · ${backup.thinkingLevel ?? `${thinkingLevel} (inherited)`}`
    : backup.disabled
      ? "off"
      : "not set";

  return (
    `Default:  ${model} · ${thinkingLevel}\n` +
    `Backup:   ${backupLine}\n` +
    `Deadline: ${formatDeadline(deadlineSeconds)}`
  );
}
