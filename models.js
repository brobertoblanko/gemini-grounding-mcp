import { getClient } from "./gemini.js";
import { EXCLUDED_MODELS } from "./models-excluded.js";

/** Abbreviates a token count readably: 1048576 -> 1M, 65536 -> 64k. */
function formatTokenLimit(limit) {
  if (typeof limit !== "number") return "?";
  if (limit >= 1024 * 1024) return `${Math.round(limit / (1024 * 1024))}M`;
  if (limit >= 1024) return `${Math.round(limit / 1024)}k`;
  return String(limit);
}

/**
 * Whether a model CAN run here at all. Two conditions, both taken from what the
 * API reports itself rather than from the model name or from displayName and
 * description, although those two do carry information: "nano-banana-pro-preview"
 * is described as "Gemini 3 Pro Image Preview". Reading them would be the same
 * name pattern one field further right, and it would go stale just as silently
 * once a future text model carries one of the keywords.
 * - generateContent: produces text at all (excludes embeddings, Imagen, Veo and
 *   the Live/Audio models)
 * - thinking: accepts a thinking level. runSearch always sends one, otherwise
 *   the API answers 400 "Thinking level is not supported for this model."
 *
 * What the conditions cannot decide is whether a model SHOULD run here - a TTS
 * model with 8k input passes both. That is what EXCLUDED_MODELS is for.
 * Full derivation: docs/specs.md, "gemini-list-models".
 */
export function isUsableModel(model) {
  return (model.supportedActions ?? []).includes("generateContent") && model.thinking === true;
}

/** The bare model id: the API prefixes every name with "models/". */
export function modelId(model) {
  return (model.name ?? "?").replace(/^models\//, "");
}

/**
 * Whether a model is on the maintained exclusion list. Separate from
 * isUsableModel() because the two answer different questions: that one reads
 * what the API reports, this one what trying it out showed.
 * Full derivation: docs/specs.md, "The exclusion list".
 */
export function isExcludedModel(model) {
  return Object.hasOwn(EXCLUDED_MODELS, modelId(model));
}

/** Whether a model is in the default list: usable and not excluded. */
function isOfferedModel(model) {
  return isUsableModel(model) && !isExcludedModel(model);
}

/**
 * Entries of the exclusion list that no model in models.list matches any more,
 * because Google retired it. Harmless at runtime - nothing ever looks an entry
 * up unless the API named the model first - but the reason is dead weight, and a
 * reused id would attach it to something else.
 *
 * Reported by scripts/probe-models.js and scripts/model-drift.js because nothing
 * else can: the test in test/models.test.js reads the stored response, which
 * keeps a retired model until somebody renews the file, and a test may not call
 * the live API. Needs the full models.list: without liveIds it reports nothing
 * rather than guessing from a partial list.
 */
export function staleEntries(liveIds) {
  if (!liveIds) return [];
  return Object.keys(EXCLUDED_MODELS).filter((id) => !liveIds.has(id));
}

/**
 * What changed in the key's model list since knownIds was recorded, for the
 * weekly check in scripts/model-drift.js:
 * - stale: exclusion entries whose model is gone (see staleEntries)
 * - unprobed: models offered here that knownIds does not contain - a new model
 *   passes isUsableModel() and is offered at once, untried, which is how two
 *   models that fail with 400 reached the short list in August 2026
 */
export function findModelDrift(models, knownIds) {
  const liveIds = new Set(models.map(modelId));
  return {
    stale: staleEntries(liveIds),
    unprobed: models
      .filter(isOfferedModel)
      .map(modelId)
      .filter((id) => !knownIds.has(id))
      .sort((a, b) => a.localeCompare(b)),
  };
}

/**
 * Why a model is not in the default list - for the --all view only. An excluded
 * model shows the kind of its exclusion, everything before the first dash of its
 * reason: the reason itself runs to three lines for the "unsuitable" entries,
 * and the kind is what says how much the entry is worth.
 *
 * A model without generateContent names what it does instead, skipping the
 * count* actions: the native audio models list countTokens first, which says
 * nothing about them.
 */
function modelStatus(model) {
  const actions = model.supportedActions ?? [];
  if (!actions.includes("generateContent")) {
    const action = actions.find((name) => !name.startsWith("count")) ?? actions[0];
    return action ? `no text (${action})` : "no text";
  }
  if (model.thinking !== true) return "no thinking";
  if (!isExcludedModel(model)) return "offered";
  return EXCLUDED_MODELS[modelId(model)].split(" - ")[0];
}

/** Every model the current API key exposes, across all pages. models.list is free. */
export async function fetchModels() {
  const ai = getClient();
  const pager = await ai.models.list({ config: { pageSize: 50 } });
  const models = [];
  for await (const model of pager) models.push(model);
  return models;
}

/**
 * Why each of the given model ids is unlikely to work here, as plain text - an
 * empty list when all of them look fine. Advice after a save, never a refusal:
 * the short list decides what is shown, not what is allowed, and an id the key
 * does not list today may be listed tomorrow.
 *
 * A failed models.list (offline, no key) yields no advice rather than an error,
 * so a save never fails on it. Pass models when they are already fetched.
 * No command name in the text: the CLI and gemini-set-config share it.
 */
export async function checkModelIds(ids, models) {
  if (!models) {
    try {
      models = await fetchModels();
    } catch {
      return [];
    }
  }
  const advice = [];
  for (const id of ids) {
    const model = models.find((candidate) => modelId(candidate) === id);
    if (!model) {
      advice.push(`"${id}" is not in the model list of this API key - a search with it will most likely fail.`);
    } else if (!isUsableModel(model)) {
      advice.push(`"${id}" cannot run here: ${modelStatus(model)}.`);
    } else if (isExcludedModel(model)) {
      advice.push(`"${id}" is on this server's exclusion list: ${EXCLUDED_MODELS[id]}.`);
    }
  }
  return advice;
}

/**
 * Lists the models available to the current API key, with token limits. By
 * default only those this server offers - usable and not excluded; with
 * all=true the complete list including a status column.
 *
 * Two filters run in the default view, and the closing note counts both: leaving
 * EXCLUDED_MODELS unmentioned would make it as invisible to the user as the
 * shortened choice that issue #15 started from. The note stays a single line
 * under 80 columns, so a terminal does not wrap it mid-word, and takes every
 * number from the response, so no wording needs revising when models come and
 * go. Full derivation: docs/specs.md, "The notice names the list".
 *
 * allOption is how the caller's own frontend spells that switch, because the
 * note names it and the two spell it differently: "--all" on the command line,
 * "all: true" over MCP. Both pass it explicitly; the default only keeps the
 * note readable for a caller that does not.
 *
 * Being listed says nothing about availability: deprecated models stay in the
 * response and answer with 404. A field indicating that does not exist.
 */
export async function listModels({ all = false, allOption = "--all" } = {}) {
  const models = await fetchModels();
  if (models.length === 0) return "No models available for this API key.";

  const usable = models.filter(isUsableModel);
  const offered = usable.filter(isOfferedModel);

  // Guard against an empty result, whichever filter empties it: the API might
  // stop supplying the evaluated fields, or the exclusion list might one day
  // cover everything the key still has. Better the wider list than none at all.
  const filterFailed = usable.length === 0;
  const exclusionFailed = !filterFailed && offered.length === 0;
  const showAll = all || filterFailed;
  const shown = [...(showAll ? models : exclusionFailed ? usable : offered)];

  // In the full view the offered models come first: they are what somebody
  // picking a model is looking for, and alphabetically they scatter among 50
  // others.
  const name = modelId;
  const rank = (model) => (showAll && !isOfferedModel(model) ? 1 : 0);
  shown.sort((a, b) => rank(a) - rank(b) || name(a).localeCompare(name(b)));
  const width = Math.max("MODEL".length, ...shown.map((model) => name(model).length));

  const row = (id, input, output, status) =>
    `${id.padEnd(width)}  ${input.padStart(5)}  ${output.padStart(6)}` +
    (showAll ? `  ${status}` : "");
  const lines = [
    row("MODEL", "INPUT", "OUTPUT", "STATUS"),
    ...shown.map((model) =>
      row(
        name(model),
        formatTokenLimit(model.inputTokenLimit),
        formatTokenLimit(model.outputTokenLimit),
        modelStatus(model),
      ),
    ),
  ];

  const hidden = usable.length - offered.length;

  let note;
  if (filterFailed) {
    note =
      `All ${models.length} models - the usability filter matched nothing. Check whether the ` +
      "API still reports supportedActions and thinking.";
  } else if (exclusionFailed) {
    note =
      `All ${usable.length} usable models are on the exclusion list, so it is skipped here. ` +
      "Check models-excluded.js against this API key.";
  } else if (all) {
    note =
      `All ${models.length} models; "offered" marks the default list. ` +
      "Not every model answers.";
  } else {
    note =
      `${offered.length} of ${models.length} models offered, ${hidden} excluded after testing. ` +
      `${allOption} lists all models.`;
  }

  return `${lines.join("\n")}\n\n${note}`;
}
