/**
 * Models hidden from the default view of gemini-list-models, on top of the
 * isUsableModel() filter in gemini.js. Every entry is a model the API reports as
 * usable and that this server should not offer, for one of four reasons: the
 * call fails, a different model answers, the answer arrives without any source,
 * or the vendor documents the model as built for something else. The four are
 * ordered by how solid they are, and every reason below says which kind it is.
 *
 * Hand-maintained on purpose, with exact ids and no wildcards. A pattern such as
 * "*-image" would catch successors by itself but bring back the silent failure:
 * a future model that UNDERSTANDS images and carries "image" in its name would
 * disappear unnoticed. The failure mode here is the loud one instead - a new
 * model nobody has entered shows up, which is visible, harmless, and asks to be
 * maintained. Nothing ever falls off the list unseen.
 *
 * Where the API refuses, the reason is Google's own wording, shortened to its
 * first sentence. It is the only part that distinguishes those entries:
 * fifteen of them share the status 400 INVALID_ARGUMENT for four different
 * causes. The deprecated models carry their routing target, the three that
 * answer without grounding the measurement, and the two unsuitable ones the
 * documented purpose, because no error code exists for any of them.
 *
 * Not a user setting and therefore not in config.json, which holds model names
 * and thinking levels and nothing else.
 *
 * Verified with scripts/probe-models.js on 2026-10-26 against a single API key,
 * 33 models probed, 25 excluded. Availability differs per key and changes
 * without notice: an entry that no longer matches any model is dead weight, an
 * unlisted model may have retired since. Rerun the probe before trusting this
 * list for anything but its purpose.
 */
export const EXCLUDED_MODELS = {
  // Image generation. Answers a plain search request without complaint and
  // fails on the third tool - see SEARCH_TOOLS. The 3.1 models and
  // gemini-nano-banana-2.1 reject the level first at low (measured 2026-10-26),
  // so the probe needs --thinking high to reach the reason given here.
  "gemini-3-pro-image": "400 INVALID_ARGUMENT - Code execution is not enabled for this model",
  "gemini-3-pro-image-preview":
    "400 INVALID_ARGUMENT - Code execution is not enabled for this model",
  "gemini-3.1-flash-image": "400 INVALID_ARGUMENT - Code execution is not enabled for this model",
  "gemini-3.1-flash-image-preview":
    "400 INVALID_ARGUMENT - Code execution is not enabled for this model",
  "gemini-3.1-flash-lite-image":
    "400 INVALID_ARGUMENT - Code execution is not enabled for this model",
  "gemini-nano-banana-2.1": "400 INVALID_ARGUMENT - Code execution is not enabled for this model",
  "nano-banana-pro-preview": "400 INVALID_ARGUMENT - Code execution is not enabled for this model",

  // No thinking level at all, at any value. Distinct from the image models,
  // which reject one level and name it in the message.
  "gemma-4-26b-a4b-it": "400 INVALID_ARGUMENT - Thinking level is not supported for this model",
  "gemma-4-31b-it": "400 INVALID_ARGUMENT - Thinking level is not supported for this model",

  // A different API. generateContent, which this server calls, is not their
  // entry point - the Deep Research pipeline runs long and interactively, and
  // the Omni models generate video.
  "deep-research-max-preview-04-2026":
    "400 INVALID_ARGUMENT - This model only supports Interactions API",
  "deep-research-preview-04-2026":
    "400 INVALID_ARGUMENT - This model only supports Interactions API",
  "deep-research-pro-preview-12-2025":
    "400 INVALID_ARGUMENT - This model only supports Interactions API",
  "gemini-omni-1.1-flash": "400 INVALID_ARGUMENT - This model only supports Interactions API",
  "gemini-omni-flash-preview": "400 INVALID_ARGUMENT - This model only supports Interactions API",

  // Demands a tool of its own instead of the three this server sends.
  "gemini-2.5-computer-use-preview-10-2025":
    "400 INVALID_ARGUMENT - This model requires the use of the Computer Use tool",

  // Retired. Still in models.list and still described in full - being listed is
  // no statement about availability, and the API offers no field that says so.
  // These three are the case issue #11 documented for gemini-2.5-flash.
  "gemini-2.5-flash": "404 NOT_FOUND - no longer available to new users",
  "gemini-2.5-flash-lite": "404 NOT_FOUND - no longer available to new users",
  "gemini-2.5-pro": "404 NOT_FOUND - no longer available to new users",

  // Answer, ground, and are not the model that answers. Google routes them
  // server-side to their successor without an error; response.modelVersion
  // names the target, and the footer shows it - see formatFooter. Offering them
  // would put a name in the list that no call ever runs under.
  "gemini-3.5-flash": "deprecated - routed to gemini-3.6-flash since 2026-10-08",
  "gemini-3.7-flash": "deprecated - routed to gemini-3.8-flash since 2026-10-08",

  // Answer without a single source. The only entries here that rest on measured
  // behaviour rather than on a status code or a field, and the worst outcome of
  // the four kinds: a failing model is visible, an unsourced answer looks like a good
  // one. It also leaves the source list empty, which is what this server exists
  // to produce - see CLAUDE.md and docs/specs.md, "Terms compliance".
  //
  // Reproduced twice per model, including with a question no training data can
  // answer. gemini-flash-lite-latest grounds reliably under the same query, so
  // the query is not the cause.
  "gemini-3-flash-preview":
    "no sources - ran 5 search queries and returned 0 grounding chunks",
  "gemini-3.1-flash-lite": "no sources - ran no search at all, twice",
  "gemini-3.1-flash-lite-preview": "no sources - ran no search at all, twice",

  // Work, ground, and are still the wrong tool - excluded on the vendor's own
  // statement rather than on a failure. The weakest kind of entry here, and the
  // one to check first when this list is reviewed: an unsuitable model stays
  // unsuitable only as long as its documentation says so.
  "gemini-3.1-pro-preview-customtools":
    "unsuitable - a separate endpoint of gemini-3.1-pro-preview that prioritises " +
    "developer-defined tools; Google recommends the plain endpoint when no custom " +
    "function declarations are registered, and this server registers none",
  "gemini-robotics-er-2-preview":
    "unsuitable - embodied reasoning for physical agents, 128k input instead of 1M; " +
    "documented as not intended for general text or search",
};
