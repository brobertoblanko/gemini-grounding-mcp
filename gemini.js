import { GoogleGenAI } from "@google/genai";
import { insertCitations } from "./citations.js";
import { EXCLUDED_MODELS } from "./models-excluded.js";

/**
 * Retries for transient errors. Without httpOptions.retryOptions the SDK repeats
 * NOTHING - apiCall() in dist/index.mjs begins with
 * "if (!retryOptions) { return fetch(url, requestInit); }", and no default is
 * set anywhere. The Gemini docs claim the official SDKs retry out of the box;
 * that is demonstrated for the Python SDK only.
 *
 * TWO codes are missing ON PURPOSE. Google's default would be
 * [408, 429, 500, 502, 503, 504]; without this note the list reads like an
 * incomplete copy.
 *
 * 429: the API supplies the waiting time itself, as RetryInfo in error.details
 * ("retryDelay": "53s"). The SDK does not read it - the string "RetryInfo" does
 * not occur anywhere in the bundle - and backs off blindly instead, so against
 * a demanded 53 seconds all four attempts are spent after roughly 15, long
 * before the block expires. The same behaviour in the Python SDK is tracked as
 * googleapis/python-genai#1875. A 429 therefore reaches the client unchanged and
 * immediately.
 *
 * 504: since this server sends a deadline of its own (see
 * SERVER_DEADLINE_SECONDS), a 504 is usually that deadline rather than Google's
 * overloaded gateway. Repeating it runs the same generation to the deadline
 * three more times and pays for each, because an aborted generation is billed
 * all the same. The two causes cannot be told apart here: the retry decision is
 * made on the status code, long before anyone gets to see the DEADLINE_EXCEEDED
 * in the body - and of the two, the expensive one is the more likely.
 *
 * For 500, 502, 503 and 408 no server-supplied hint exists, so blind backoff is
 * the only option. 408 is in the list for completeness: an expired deadline
 * comes back as 504, and a request that runs into nothing is aborted by Node
 * without any HTTP status (measured after 306.8 seconds). A genuine 408 would
 * have to come from an intermediary.
 *
 * attempts counts the initial call, so four attempts mean three repeats and,
 * with the SDK defaults (initialDelay 1s, expBase 2, jitter), 7 to 14 seconds of
 * extra waiting before the error surfaces.
 *
 * Full derivation: docs/specs.md, "Why 429 and 504 are missing from that list".
 */
export const RETRY_OPTIONS = {
  attempts: 4,
  httpStatusCodes: [408, 500, 502, 503],
};

/**
 * The deadline Google's gateway is told about: after this time it should abort
 * the generation instead of computing on. The SDK sends it as the header
 * X-Server-Timeout in whole seconds.
 *
 * The value derives from the shortest link in the chain, and all three numbers
 * are measured, not estimated:
 * - Node severs a silent connection after 306.8 s (undici's headersTimeout of
 *   300 s plus connection setup)
 * - the MCP client of Claude Code waits 1800 s, six times longer
 * - Google itself knows no deadline at all without this header
 *
 * Node therefore cuts first. Everything Google generates beyond that point can
 * no longer be received by anyone - billed it is all the same: input tokens in
 * full, output tokens up to the actual end of the run. Only rejections before
 * execution (400, 401, 403, 429) are free. 290 seconds sits just below Node's
 * limit, so Google stops before the line is cut - and the failure arrives as a
 * 504 with a reason instead of a bare connection abort.
 *
 * Deliberately NOT set via httpOptions.timeout, although the SDK builds the same
 * header from it: that option also produced a client-side AbortController, a
 * second clock racing Google's answer. Which one wins is chance, and when the
 * local one wins, "This operation was aborted" arrives instead of the reason.
 *
 * The SDK's own headers stay untouched: patchHttpOptions() merges both objects
 * with Object.assign, so User-Agent and Content-Type are not lost.
 * Full derivation: docs/specs.md, "The deadline this server does send".
 */
export const SERVER_DEADLINE_SECONDS = 290;

/**
 * Errors that do NOT fall back to the backup model. Everything else triggers the
 * fallback, provided a backup is configured.
 *
 * A negative list, and that is the actual decision: an unknown future error code
 * gets the fallback automatically, instead of dropping silently through a
 * positive list. Deliberately NOT the same list as RETRY_OPTIONS - the two
 * answer different questions, the retry "does waiting help?", the fallback "can
 * a different model be the difference?". On 429 the answers diverge: waiting
 * achieves nothing, because the SDK ignores Google's retryDelay, while switching
 * achieves something at once, because quotas count per model.
 *
 * The three exceptions come from two different reasons. 401 and 403 are
 * hopeless: both hang on the API key, and the second call uses the same one, so
 * the model cannot possibly be the cause. 504 is too expensive: on this server
 * it is usually the server's own deadline (see SERVER_DEADLINE_SECONDS), hence a
 * generation that ran in full and is billed, and a fallback would double it and
 * add up to another 290 seconds of waiting.
 *
 * A network error is not in the list and does not need to be: it carries no
 * status at all and drops out by itself.
 * Full derivation: docs/specs.md, "Which errors trigger it".
 */
export const NO_FALLBACK_STATUS = [401, 403, 504];

/**
 * Turns an error into a line that still says something when it comes from the
 * network rather than from the API.
 *
 * An ApiError carries the reason in plain text (message is the raw JSON body of
 * the error response) and needs nothing further. A network error in Node is
 * ALWAYS called "fetch failed" - refused connection, unknown host, timeout, all
 * the same two words - and what actually happened lives solely in error.cause,
 * which the client loses, because an MCP tool can return a single line of text.
 *
 * The code is optional: measured, "bad port" supplies none, ECONNREFUSED does.
 * Without this line a severed connection reaches the calling agent as bare
 * "fetch failed", which explains nothing beyond "it did not work".
 * Full derivation: docs/specs.md, "What reaches the client when a request fails".
 */
export function describeError(error) {
  const cause = error?.cause;
  if (!cause) return error?.message ?? String(error);
  const code = cause.code ? `${cause.code}: ` : "";
  return `${error.message} (${code}${cause.message ?? cause})`;
}

/**
 * Exported because cli.js checks the key itself before a search and needs the
 * same wording. The throw below stays as the safety net for every other caller.
 */
export const API_KEY_MISSING_MESSAGE =
  "GEMINI_API_KEY is not set. The API key must be provided via environment " +
  "variable (never hardcoded).";

function getClient() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(API_KEY_MISSING_MESSAGE);
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      retryOptions: RETRY_OPTIONS,
      headers: { "X-Server-Timeout": String(SERVER_DEADLINE_SECONDS) },
    },
  });
}

/**
 * Builds the source list from two separate metadata sources of the Gemini API:
 * - groundingChunks: hits from the Google search
 * - urlContextMetadata: pages Gemini read on purpose via URL Context
 * Both lists are merged and deduplicated by URL.
 *
 * Returns chunkNumbers as well: the mapping from the index in groundingChunks to
 * the number in the EMITTED list. The two counts diverge, because
 * groundingChunks represents search hits rather than sources - measured 17 hits
 * for 14 distinct URLs. Without this mapping the markers in the text would point
 * at numbers the list does not have.
 *
 * INVARIANT I1 (see CLAUDE.md and docs/specs.md, "Terms compliance"): EVERY
 * chunk with a URI goes into the list, even when not a single support points at
 * it. That nothing here is filtered, capped or deduplicated by domain is not
 * carelessness but the condition for using Grounding with Google Search.
 * Deduplicating by identical URI is allowed, because no destination is lost in
 * the process - by domain it is not. Pinned by test/sources.test.js.
 */
export function buildSourceList(candidate) {
  const searchChunks = candidate?.groundingMetadata?.groundingChunks ?? [];
  const urlContextEntries = candidate?.urlContextMetadata?.urlMetadata ?? [];

  const numberByUri = new Map();
  const chunkNumbers = new Map();
  const sources = [];
  let skipped = 0;

  const addSource = (title, uri) => {
    if (!numberByUri.has(uri)) {
      sources.push({ title, uri });
      numberByUri.set(uri, sources.length);
    }
    return numberByUri.get(uri);
  };

  searchChunks.forEach((chunk, index) => {
    const uri = chunk.web?.uri;
    // The one path on which a link can be lost here. So far the API delivers web
    // chunks only, measured; were a second type added, its links would silently
    // drop out of the list and I1 would be broken unseen. Counting is all that
    // can be done without knowing the unfamiliar type - the footer at least
    // turns it into a visible loss.
    if (!uri) {
      skipped++;
      return;
    }
    // chunk.web.title ?? uri replaces NO existing title, it labels an entry the
    // API supplied none for. The title is part of the link under the terms (I2),
    // so an existing one stays untouched.
    chunkNumbers.set(index, addSource(chunk.web?.title ?? uri, uri));
  });

  // URL Context sources come after the search hits and therefore do not affect
  // the numbering of the markers.
  //
  // Measured on a request naming a concrete URL: the page read was additionally
  // present as a groundingChunk - with a real page title, a direct URL and
  // supports of its own. It never got past the deduplication here and received
  // markers all the same. Only a page that is NOT also a chunk lands here, and
  // it then stays without markers, because there are no supports for it.
  for (const entry of urlContextEntries) {
    if (entry.retrievedUrl) addSource(entry.retrievedUrl, entry.retrievedUrl);
  }

  return { sources, chunkNumbers, skipped };
}

/**
 * INVARIANT I2: `s.title` and `s.uri` go out unchanged. The redirect URLs are
 * long and look like candidates for shortening - they may be neither shortened
 * nor reduced to the domain nor resolved (I3), and the title explicitly counts
 * as part of the link. Four lines that look harmless, and that do not show the
 * title as a protected component: see CLAUDE.md and docs/specs.md, "Terms compliance".
 * Pinned by test/sources.test.js.
 */
export function formatSourcesBlock(sources) {
  if (sources.length === 0) return "";
  const list = sources
    .map((s, i) => `[${i + 1}] ${s.title} - ${s.uri}`)
    .join("\n");
  return `\n\nSources:\n${list}`;
}

/**
 * Assembles the answer text from the parts of the response instead of using
 * `response.text`. The SDK's `.text` getter discards everything that is not a
 * text part - with Code Execution enabled, precisely the executed code and its
 * result - and writes a warning to stderr on every call. Both go into the answer
 * as code blocks here, so it stays traceable how a computed number came about.
 *
 * Code and result come at the END, after the answer text. The API returns the
 * parts in execution order, so the answer would otherwise begin with a code
 * block and the actual information would follow underneath. The computation is
 * evidence and belongs where the source list is: after the answer, not before.
 *
 * The citation markers are set here as well (see citations.js), deliberately at
 * this point, because the parts are only individually available here: the API's
 * offsets count from the beginning of EACH part, and after the join("\n\n") they
 * would be off by two bytes from the second part onwards.
 * Full derivation: docs/specs.md, "Answer text: assembled by hand instead of `response.text`".
 */
function buildText(candidate, { supports, chunkNumbers }) {
  const textBlocks = [];
  const codeBlocks = [];
  let dropped = 0;

  // forEach rather than for...of: the loop index IS the partIndex that
  // segment.partIndex refers to. Thought parts are skipped but still counted -
  // partIndex counts over ALL parts of the candidate.
  (candidate?.content?.parts ?? []).forEach((part, partIndex) => {
    // Thought parts do not belong in the output - their volume is already in the
    // footer as thinking tokens.
    if (part.thought) return;

    if (part.text) {
      // partIndex is absent from the JSON when it is 0 (protobuf default).
      const result = insertCitations({
        text: part.text,
        supports: supports.filter((s) => (s.segment?.partIndex ?? 0) === partIndex),
        chunkNumbers,
      });
      textBlocks.push(result.text);
      dropped += result.dropped;
    } else if (part.executableCode?.code) {
      // language is the Language enum ("PYTHON"); LANGUAGE_UNSPECIFIED yields no
      // usable language tag for the code block.
      const language = (part.executableCode.language ?? "").toLowerCase();
      const fence = language.includes("unspecified") ? "" : language;
      // trimEnd, because code and output end with a newline - otherwise a blank
      // line sits before the closing fence.
      codeBlocks.push(`\`\`\`${fence}\n${part.executableCode.code.trimEnd()}\n\`\`\``);
    } else if (part.codeExecutionResult) {
      // outcome is "OUTCOME_OK", "OUTCOME_FAILED", ... - the prefix carries no
      // information.
      const outcome =
        (part.codeExecutionResult.outcome ?? "").replace(/^OUTCOME_/, "") || "UNKNOWN";
      const output = (part.codeExecutionResult.output ?? "").trimEnd();
      codeBlocks.push(`Result (${outcome}):\n\`\`\`\n${output}\n\`\`\``);
    }
  });

  // A heading as with the source list, so the appended computation is not read
  // as a continuation of the answer text.
  if (codeBlocks.length > 0) codeBlocks.unshift("Code execution:");

  return { text: [...textBlocks, ...codeBlocks].join("\n\n"), dropped };
}

/**
 * Flags a response that did not finish normally. Without this note a blocked or
 * truncated response would look like a success: the text is missing or breaks
 * off mid-sentence, and the source list and footer sit unchanged underneath.
 */
function formatNotice({ text, candidate, promptFeedback }) {
  const blockReason = promptFeedback?.blockReason;
  if (blockReason) {
    return `\n\n⚠️ Request blocked by the API - blockReason: ${blockReason}`;
  }

  const finishReason = candidate?.finishReason;
  if (text === "") {
    return `\n\n⚠️ The response contained no text - finishReason: ${finishReason ?? "unknown"}`;
  }
  // STOP is the regular completion. Everything else - above all MAX_TOKENS -
  // means a truncated response that would otherwise look complete.
  if (finishReason && finishReason !== "STOP") {
    return `\n\n⚠️ The response is incomplete - finishReason: ${finishReason}`;
  }
  return "";
}

// Character budget for the line with the search queries sent. Measured: usually
// 2 to 6 queries totalling 73 to 270 characters, a single query 29 to 84 - but
// 11 queries with over 500 characters for a deliberately overbroad question. The
// API documents no upper bound, hence the cap: 300 lets the normal case through
// untouched and catches the outlier that would otherwise pull the footer over
// several lines.
const SEARCH_QUERY_BUDGET = 300;

/**
 * Builds the footer line with the queries Gemini actually sent to the Google
 * search (groundingMetadata.webSearchQueries).
 *
 * It sits in the footer because it exposes a gap that neither the source list
 * nor the citation markers show: WHETHER the search covered the question at all.
 * Measured on a request about six web frameworks, Gemini searched six times for
 * "<framework> current version" only - bundle size and rendering strategy, also
 * asked for, came unresearched from model knowledge, and the answer did not show
 * it.
 *
 * Its own line rather than appended to the metrics: together they would run to
 * 385 characters in the measured extreme case and wrap over four terminal lines
 * - in exactly the long answers where the footer is supposed to give
 * orientation.
 *
 * An empty array yields an empty string and therefore no line. That is the rule
 * for every optional part of the footer: the normal case must not lengthen it.
 * Full derivation: docs/specs.md, "The search queries line".
 */
export function formatSearchQueries(queries = []) {
  if (queries.length === 0) return "";

  // The query that breaks the budget is still written IN FULL - a search query
  // truncated mid-word is worthless. The overshoot is bounded by the length of a
  // single query.
  const shown = [];
  let length = 0;
  for (const query of queries) {
    shown.push(query);
    // The separator counts from the second entry onwards, so the budget means
    // the actual line length rather than the sum of the queries.
    length += query.length + (shown.length > 1 ? 3 : 0);
    if (length >= SEARCH_QUERY_BUDGET) break;
  }

  const rest = queries.length - shown.length;
  // " · " rather than ", ": the queries contain quotation marks and digit
  // sequences of their own, between which a comma disappears as a separator.
  return `\n🔎 Searched: ${shown.join(" · ")}${rest > 0 ? ` (+${rest} more)` : ""}`;
}

/**
 * The line about a successful fallback to the backup model. Without a fallback
 * an empty string and therefore no line.
 *
 * 🔁 and not ⚠️: a successful fallback is not a degraded answer. The warning
 * sign stays reserved for the cases where something is wrong with the answer
 * itself (dropped markers, omitted sources, finishReason, blockReason).
 *
 * Three codes get a suffix, because with them there is something TO DO; for all
 * the others - 503, 500, 502, 408 and anything future - the disturbance is
 * transient and the bare code says enough. The 400 is the only one where the
 * line performs real diagnosis: that the backup accepts the same request proves
 * the request was not the problem, the model was.
 * Full derivation: docs/specs.md, "What the footer says".
 */
export function formatFallbackNote(fallback) {
  if (!fallback) return "";

  const { model, status, statusName } = fallback;
  const answered = "answered by backup";

  switch (status) {
    case 404:
      return `\n🔁 ${model} does not exist (404) - ${answered}. Update your default.`;
    case 429:
      return `\n🔁 ${model} hit its quota (429) - ${answered}.`;
    case 400:
      return (
        `\n🔁 ${model} rejected the request (400) - ${answered}. ` +
        "Check the thinking level of your default model."
      );
    default:
      return `\n🔁 ${model} failed (${statusName ? `${status} ${statusName}` : status}) - ${answered}.`;
  }
}

export function formatFooter({
  usageMetadata,
  model,
  thinkingLevel,
  sourceCount,
  dropped,
  skipped,
  searchQueries,
  fallback,
}) {
  const inputTokens = usageMetadata?.promptTokenCount ?? 0;
  const outputTokens = usageMetadata?.candidatesTokenCount ?? 0;
  const thinkingTokens = usageMetadata?.thoughtsTokenCount ?? 0;

  // Dropped markers belong in the footer because they change how much the
  // response can be relied on: if a marker is missing, the passage may be
  // ungrounded - or the verification discarded it.
  const droppedNote = dropped > 0 ? ` | ⚠️ ${dropped} markers dropped` : "";

  // Omitted chunks likewise. Unlike dropped markers this affects not the
  // reliability of the answer but the completeness of the source list - a loss
  // nobody would notice without this line (I1, see buildSourceList).
  const skippedNote =
    skipped > 0 ? ` | ⚠️ ${skipped} sources omitted (unknown chunk type)` : "";

  return (
    `\n\n---\n🔢 ${inputTokens} input / ${outputTokens} output / ${thinkingTokens} thinking tokens ` +
    `| 🔍 ${sourceCount} sources | 🤖 ${model} (thinking: ${thinkingLevel})${droppedNote}${skippedNote}` +
    formatSearchQueries(searchQueries) +
    formatFallbackNote(fallback)
  );
}

/**
 * The API's error body as an object: status ("UNAVAILABLE", "NOT_FOUND", ...)
 * and, where present, the machine-readable reason from error.details.
 *
 * The message of an ApiError IS the JSON body of the error response, even for a
 * response without JSON - the SDK then builds one itself. In a try all the same:
 * both are incidental, and no call that would otherwise have gone through may
 * fail on them.
 */
export function readErrorBody(error) {
  try {
    const body = JSON.parse(error.message)?.error;
    return {
      statusName: body?.status,
      reason: body?.details?.find((detail) => detail.reason)?.reason,
    };
  } catch {
    return {};
  }
}

/**
 * Why no fallback happens although a backup IS configured - or undefined when
 * the fallback does take place.
 *
 * Each of these reasons goes to the user as text, because it would otherwise
 * leave the unanswerable question "why did my backup not kick in?". A backup
 * that is not configured never gets here: then there is nothing to explain.
 */
function fallbackRefusal({ error, model, backupModel, reason }) {
  if (backupModel === model) {
    return "backup not tried: it is the same model as the default";
  }
  // Measured: an unusable key does NOT arrive as 401 or 403 but as a
  // 400 INVALID_ARGUMENT with "API key not valid", so the status code alone is
  // not enough here. A 400 otherwise does justify a fallback, because behind it
  // can be a model that does not know the thinking level. The key, however,
  // applies to both models: hopeless.
  if (reason === "API_KEY_INVALID") {
    return "backup not tried: the API key is not valid, and the backup would use the same one";
  }
  const status = error?.status;
  if (typeof status !== "number") {
    // No HTTP status means the request never reached the API or the connection
    // broke. With the second model it would run over the same line to the same
    // host.
    return "backup not tried: the request never reached the API";
  }
  if (NO_FALLBACK_STATUS.includes(status)) {
    return status === 504
      ? "backup not tried: the generation ran to the deadline and is billed - a retry would double it"
      : `backup not tried: ${status} applies to the API key, not to the model`;
  }
  return undefined;
}

/**
 * An error that additionally says why no backup was tried. A plain Error without
 * a cause, so describeError() passes it through unchanged - the cause of a
 * network error is already in the text.
 */
function withRefusal(error, refusal) {
  return new Error(`${describeError(error)} (${refusal})`);
}

/**
 * The three built-in tools every call sends. A constant rather than a literal
 * inside generate(), because a model has to accept ALL THREE to be usable here,
 * and anything measuring that must send the identical set: measured, the image
 * models answer a search request without complaint and fail on
 * "Code execution is not enabled for this model" - the narrower request would
 * report them as working. See scripts/probe-models.js.
 *
 * Frozen because the same objects now go into every request: a write into them
 * would leave the first call untouched and change every one after it.
 */
export const SEARCH_TOOLS = Object.freeze([
  Object.freeze({ googleSearch: {} }),
  Object.freeze({ urlContext: {} }),
  Object.freeze({ codeExecution: {} }),
]);

/** One call to the API. Everything that stays the same per attempt lives here. */
function generate(ai, { query, model, thinkingLevel }) {
  return ai.models.generateContent({
    model,
    contents: query,
    config: {
      // The current date, nothing else. Without it the model reads "the latest
      // version" against its own training cutoff rather than against today -
      // measured, it searched for "2025 2026" in four out of six cases, because
      // it knows the year only approximately. For a server whose purpose is to
      // bypass training knowledge, that is the wrong kind of vagueness.
      //
      // Deliberately NO content-level instructions such as "prefer official
      // documentation": they tint every answer and narrow research into OS
      // behaviour or recent events. A date is a fact, a source preference an
      // opinion.
      //
      // toLocaleDateString("en-CA") yields YYYY-MM-DD in LOCAL time.
      // toISOString() would be UTC and would report the previous day in Central
      // Europe between 00:00 and 02:00 - in the very function meant to guarantee
      // the correct date.
      systemInstruction: `Today's date is ${new Date().toLocaleDateString("en-CA")}.`,
      tools: SEARCH_TOOLS,
      thinkingConfig: { thinkingLevel },
    },
  });
}

/**
 * Runs a Gemini research call with all three built-in tools (Google Search, URL
 * Context, Code Execution), places the citation markers in the answer text and
 * appends the source list and token footer.
 *
 * If the model fails and a backup was passed, the same request runs a second
 * time - with the same retry, because that hangs on the client rather than on
 * the call. Whether a backup IS passed is decided by resolveCallConfig() in
 * config.js: a model named explicitly gets none.
 *
 * Everything evaluated afterwards runs on the response that won and knows
 * nothing of the fallback - except the footer, which has to name it.
 */
export async function runSearch({
  query,
  model,
  thinkingLevel,
  backupModel,
  backupThinkingLevel,
}) {
  const ai = getClient();

  let response;
  // Stays undefined when the first attempt goes through, which drops the footer
  // line entirely.
  let fallback;

  try {
    response = await generate(ai, { query, model, thinkingLevel });
  } catch (error) {
    // Without a configured backup nothing changes: the error goes out unaltered,
    // as it did before this feature.
    if (!backupModel) throw error;

    const { statusName, reason } = readErrorBody(error);
    const refusal = fallbackRefusal({ error, model, backupModel, reason });
    if (refusal) throw withRefusal(error, refusal);

    fallback = { model, status: error.status, statusName };
    model = backupModel;
    // Without a level of its own the backup inherits the one actually used for
    // THIS call, not the stored default: whoever passed thinkingLevel "high"
    // wants it on the evasive model too.
    thinkingLevel = backupThinkingLevel ?? thinkingLevel;

    try {
      response = await generate(ai, { query, model, thinkingLevel });
    } catch (backupError) {
      // Both errors, each with its model in front of it. With only the second
      // one here, you would go looking at the wrong model; describeError() on
      // both, so the cause of a network error is not lost.
      throw new Error(
        `${fallback.model}: ${describeError(error)} | ` +
          `backup ${backupModel}: ${describeError(backupError)}`,
      );
    }
  }

  const candidate = response.candidates?.[0];
  const { sources, chunkNumbers, skipped } = buildSourceList(candidate);

  // The ?? [] guards against a response without groundingMetadata - everything
  // then runs through unchanged, only without markers.
  const { text, dropped } = buildText(candidate, {
    supports: candidate?.groundingMetadata?.groundingSupports ?? [],
    chunkNumbers,
  });

  const notice = formatNotice({
    text,
    candidate,
    promptFeedback: response.promptFeedback,
  });
  const sourcesBlock = formatSourcesBlock(sources);
  const footer = formatFooter({
    usageMetadata: response.usageMetadata,
    model,
    thinkingLevel,
    sourceCount: sources.length,
    dropped,
    skipped,
    // Same guard as for the supports: without search hits the field is absent,
    // and the line disappears.
    searchQueries: candidate?.groundingMetadata?.webSearchQueries ?? [],
    // After a fallback, model and thinkingLevel above already hold the backup,
    // so the footer names what actually answered by itself. This line adds why.
    fallback,
  });

  // The footer stays the last component of the response in every case.
  //
  // The order text - notice - sources - footer has a second reason: nothing the
  // server added sits between the answer and its links. The terms forbid
  // interspersing foreign content with the Grounded Results; here there is
  // nothing in between. See CLAUDE.md and docs/specs.md, "Terms compliance".
  return text + notice + sourcesBlock + footer;
}

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

/**
 * Why a model is not in the default list - for the --all view only. An excluded
 * model shows the kind of its exclusion, everything before the first dash of its
 * reason: the reason itself runs to three lines for the "unsuitable" entries,
 * and the kind is what says how much the entry is worth.
 */
function modelStatus(model) {
  const actions = model.supportedActions ?? [];
  if (!actions.includes("generateContent")) return actions[0] ?? "no generateContent";
  if (model.thinking !== true) return "no thinking";
  if (!isExcludedModel(model)) return "thinking";
  return EXCLUDED_MODELS[modelId(model)].split(" - ")[0];
}

/**
 * Lists the models available to the current API key, with token limits. By
 * default only those this server offers - usable and not excluded; with
 * all=true the complete list including a status column.
 *
 * Two filters run in the default view, and the closing note counts both: leaving
 * EXCLUDED_MODELS unmentioned would make it as invisible to the user as the
 * shortened choice that issue #15 started from. The note stays one line and
 * takes every number from the response, so no wording needs revising when models
 * come and go. Full derivation: docs/specs.md, "The notice names the list".
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
  const ai = getClient();
  const pager = await ai.models.list({ config: { pageSize: 50 } });

  const models = [];
  for await (const model of pager) models.push(model);
  if (models.length === 0) return "No models available for this API key.";

  const usable = models.filter(isUsableModel);
  const offered = usable.filter((model) => !isExcludedModel(model));

  // Guard against an empty result, whichever filter empties it: the API might
  // stop supplying the evaluated fields, or the exclusion list might one day
  // cover everything the key still has. Better the wider list than none at all.
  const filterFailed = usable.length === 0;
  const exclusionFailed = !filterFailed && offered.length === 0;
  const showAll = all || filterFailed;
  const shown = [...(showAll ? models : exclusionFailed ? usable : offered)];

  const name = modelId;
  shown.sort((a, b) => name(a).localeCompare(name(b)));
  const width = Math.max(...shown.map((model) => name(model).length));

  const lines = shown.map((model) => {
    const limits =
      `${formatTokenLimit(model.inputTokenLimit).padStart(4)} in / ` +
      `${formatTokenLimit(model.outputTokenLimit).padStart(4)} out`;
    const status = showAll ? `  ${modelStatus(model)}` : "";
    return `${name(model).padEnd(width)}  ${limits}${status}`;
  });

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
      `All ${models.length} models; the ${offered.length} marked "thinking" are the default ` +
      "list, the rest name the kind of their exclusion. Listed is no guarantee of an answer.";
  } else {
    note =
      `${offered.length} of ${models.length} models offered here, ${hidden} usable ones ` +
      `excluded (models-excluded.js). ${allOption} lists them all with their status.`;
  }

  return `${lines.join("\n")}\n\n${note}`;
}
