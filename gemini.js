import { GoogleGenAI } from "@google/genai";
import { insertCitations } from "./citations.js";
import { DEFAULT_DEADLINE_SECONDS } from "./config.js";

/**
 * Retries for transient errors. Without httpOptions.retryOptions the SDK repeats
 * NOTHING - apiCall() in dist/index.mjs calls fetch() directly when none is set,
 * and no default exists, although the Gemini docs claim the SDKs retry.
 *
 * TWO codes are missing ON PURPOSE from Google's default
 * [408, 429, 500, 502, 503, 504]. The SDK ignores the retryDelay of a 429
 * ("53s") and spends all four attempts after roughly 15 s
 * (googleapis/python-genai#1875 for the Python SDK). A 504 is usually this
 * server's own deadline, so each repeat would bill the full generation again.
 * attempts counts the initial call: three repeats, 7 to 14 s of extra waiting.
 * Full derivation: docs/specs.md, "Why 429 and 504 are missing from that list".
 */
export const RETRY_OPTIONS = {
  attempts: 4,
  httpStatusCodes: [408, 500, 502, 503],
};

/**
 * How long after the deadline the server stops waiting by itself. Since
 * @google/genai 2.29 nothing else on this side ends a silent connection before
 * the MCP client of Claude Code gives up at 1800 s (measured).
 *
 * Deliberately NOT httpOptions.timeout: it arms a local clock with the SAME
 * value as the header, and when that one wins, "This operation was aborted"
 * arrives instead of Google's reason. The brake covers one generate() call with
 * every continuation hop and retry, so a late hop can be cut off while Google
 * still computes and bills it.
 * Full derivation: docs/specs.md, "The deadline this server does send".
 */
export const LOCAL_BRAKE_MARGIN_SECONDS = 30;

/**
 * Errors that do NOT fall back to the backup model. A negative list on purpose:
 * an unknown future code gets the fallback instead of dropping out silently.
 * 401 and 403 hang on the API key, which the backup shares. A 504 is usually the
 * server's own deadline, already billed, and a fallback would double it.
 *
 * Deliberately NOT the same list as RETRY_OPTIONS: on 429 waiting achieves
 * nothing, while switching does, because quotas count per model.
 * Full derivation: docs/specs.md, "Which errors trigger it".
 */
export const NO_FALLBACK_STATUS = [401, 403, 504];

/**
 * Turns an error into a line that still says something for a network error: Node
 * calls every one of them "fetch failed", and what happened lives solely in
 * error.cause, which the single line of an MCP result would lose. Measured,
 * "bad port" supplies no code, ECONNREFUSED does.
 * Full derivation: docs/specs.md, "What reaches the client when a request fails".
 */
export function describeError(error) {
  const cause = error?.cause;
  if (!cause) return error?.message ?? String(error);
  const code = cause.code ? `${cause.code}: ` : "";
  return `${error.message} (${code}${cause.message ?? cause})`;
}

/**
 * The command line's rendering of a runtime error: an ApiError as
 * "<code> <status> - <Google's text>" instead of its raw JSON body, everything
 * else as describeError() has it.
 *
 * For cli.js only. The MCP handler keeps describeError(): the agent reads the
 * raw body without effort, and nothing in error.details such as a 429's
 * retryDelay can get lost on the way. The errors runSearch() wraps around a
 * backup carry the originals as primary or attempts and are rendered from those,
 * in the same layout as their text.
 */
export function formatRuntimeError(error) {
  if (error?.primary) return `${formatRuntimeError(error.primary)} (${error.refusal})`;
  if (error?.attempts) {
    const [first, backup] = error.attempts;
    return (
      `${first.model}: ${formatRuntimeError(first.error)} | ` +
      `backup ${backup.model}: ${formatRuntimeError(backup.error)}`
    );
  }
  const { statusName, message, retryDelay } = readErrorBody(error);
  if (typeof error?.status !== "number" || typeof message !== "string") {
    return describeError(error);
  }
  // Rounded up: "retry in 0 s" for a "0.4s" would invite a retry that still fails.
  const seconds = Math.ceil(Number.parseFloat(retryDelay));
  const retry = Number.isFinite(seconds) ? ` (retry in ${seconds} s)` : "";
  return `${error.status}${statusName ? ` ${statusName}` : ""} - ${message}${retry}`;
}

/**
 * Exported because cli.js checks the key itself before a search and needs the
 * same wording. The throw below stays as the safety net for every other caller.
 */
export const API_KEY_MISSING_MESSAGE =
  "GEMINI_API_KEY is not set - set the environment variable to your Gemini API " +
  "key and try again.";

/**
 * deadlineSeconds false sends no header, and Google then runs to its own limit
 * of 10 minutes for a unary request. The SDK's own headers stay untouched:
 * patchHttpOptions() merges both objects with Object.assign, so User-Agent and
 * Content-Type are not lost.
 */
export function getClient({ deadlineSeconds = false } = {}) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(API_KEY_MISSING_MESSAGE);
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      retryOptions: RETRY_OPTIONS,
      headers: deadlineSeconds === false ? {} : { "X-Server-Timeout": String(deadlineSeconds) },
    },
  });
}

/**
 * Builds the source list from the search hits (groundingChunks) and the pages
 * read via URL Context, deduplicated by URL. chunkNumbers maps the index in
 * groundingChunks to the number in the EMITTED list: measured 17 hits for 14
 * distinct URLs, so the markers would otherwise point past the list.
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
 * Assembles the answer text from the parts instead of `response.text`, whose
 * getter drops the executed code and its result and warns on stderr every call.
 * Code and result go to the END as evidence, like the source list; the API
 * returns them first, in execution order.
 *
 * The citation markers are set here because the API's offsets count from the
 * beginning of EACH part: after the join("\n\n") they would be off by two bytes
 * from the second part onwards.
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

// Character budget for the search queries line. Measured: usually 73 to 270
// characters, but over 500 for a deliberately overbroad question, which would
// pull the footer over several lines. The API documents no upper bound.
const SEARCH_QUERY_BUDGET = 300;

/**
 * The footer line with the queries Gemini actually sent to the Google search
 * (groundingMetadata.webSearchQueries). It is the only place that shows WHETHER
 * the search covered the question at all; source list and markers cannot. Its
 * own line, because appended to the metrics it ran to 385 characters. No
 * queries, no line: the normal case must not lengthen the footer.
 * Full derivation: docs/specs.md, "The search queries line".
 */
export function formatSearchQueries(queries = []) {
  // Identical queries once: the SDK concatenates the lists of all continuation
  // hops. Unlike the source list this line falls under no invariant.
  queries = [...new Set(queries)];
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
 * The footer line about a successful fallback; none without one. 🔁 and not ⚠️,
 * because the answer itself is not degraded. 404, 429 and 400 get a suffix
 * because there is something TO DO; the 400 also proves that the model, not the
 * request, was the problem.
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

/**
 * The footer line about an answer the SDK continued over several requests; none
 * without one. Each hop resends and bills the prompt, so the summed input figure
 * can be a multiple of the question's own. The SDK records no hop count, a grown
 * prompt is the one trace. Not a ⚠️: the answer is complete, it only cost more.
 * Full derivation: docs/specs.md, "Automatic continuation".
 */
export function formatContinuationNote(usageMetadata) {
  const total = usageMetadata?.promptTokenCount;
  const initial = usageMetadata?.initialPromptTokenCount;
  if (typeof total !== "number" || typeof initial !== "number" || total <= initial) return "";
  return `\n↪ Continued in further requests - input tokens summed over all of them (first request: ${initial})`;
}

export function formatFooter({
  usageMetadata,
  model,
  modelVersion,
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

  // The model that answered, where it is not the one requested: aliases resolve,
  // and deprecated ids are routed to a successor without an error.
  // Full derivation: docs/specs.md, "Footer format in the tool result".
  const served = modelVersion && modelVersion !== model ? ` → ${modelVersion}` : "";

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
    `| 🔍 ${sourceCount} sources | 🤖 ${model}${served} (thinking: ${thinkingLevel})` +
    `${droppedNote}${skippedNote}` +
    formatSearchQueries(searchQueries) +
    formatContinuationNote(usageMetadata) +
    formatFallbackNote(fallback)
  );
}

/**
 * The API's error body as an object: status ("UNAVAILABLE", "NOT_FOUND", ...),
 * Google's plain-text message and, where present, the machine-readable reason
 * and a 429's waiting time ("53s") from error.details.
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
      message: body?.message,
      reason: body?.details?.find((detail) => detail.reason)?.reason,
      retryDelay: body?.details?.find((detail) => detail.retryDelay)?.retryDelay,
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
  // Before the status check, which would call it "never reached the API": the
  // request may well have reached it, and nothing says the line is any better
  // for a second model.
  if (error instanceof LocalDeadlineError) {
    return `backup not tried: no response within ${error.limitSeconds} s`;
  }
  // Measured: an invalid key arrives as 400 INVALID_ARGUMENT, not as 401 or 403,
  // and a 400 otherwise does justify a fallback.
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
 * An error that additionally says why no backup was tried. Without a cause, so
 * describeError() passes the text through unchanged - the cause of a network
 * error is already in it. The original error rides along as primary, so
 * formatRuntimeError() can still render it as an ApiError.
 */
function withRefusal(error, refusal) {
  return Object.assign(new Error(`${describeError(error)} (${refusal})`), {
    primary: error,
    refusal,
  });
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

/**
 * The error the local brake turns into. Its own class, so fallbackRefusal() and
 * the tests recognise it without parsing text.
 */
export class LocalDeadlineError extends Error {
  constructor(deadlineSeconds) {
    const limit = deadlineSeconds + LOCAL_BRAKE_MARGIN_SECONDS;
    super(
      `no response within ${limit} s - aborted locally ` +
        `(deadline ${deadlineSeconds} s + ${LOCAL_BRAKE_MARGIN_SECONDS} s margin)`,
    );
    this.limitSeconds = limit;
  }
}

/**
 * One call to the API, continuation hops and retries included. The brake is
 * armed per call, so a backup gets a budget of its own; setTimeout rather than
 * AbortSignal.timeout(), because the tests advance it with mock.timers. signal is
 * the client's cancellation: it ends the request too, but is no deadline.
 */
async function generate(ai, { query, model, thinkingLevel, deadlineSeconds, signal }) {
  const brake = new AbortController();
  const timer =
    deadlineSeconds === false
      ? undefined
      : setTimeout(() => brake.abort(), (deadlineSeconds + LOCAL_BRAKE_MARGIN_SECONDS) * 1000);
  const abort = signal ? AbortSignal.any([brake.signal, signal]) : brake.signal;
  try {
    return await requestContent(ai, { query, model, thinkingLevel, signal: abort });
  } catch (error) {
    // Checked on the signal, not on the error: what fetch throws on an abort
    // differs between runtimes, the signal's state does not.
    if (brake.signal.aborted) throw new LocalDeadlineError(deadlineSeconds);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function requestContent(ai, { query, model, thinkingLevel, signal }) {
  return ai.models.generateContent({
    model,
    contents: query,
    config: {
      abortSignal: signal,
      // Keeps request and response out of Google's API logs, on by default for
      // new paid-tier projects since 2026-10-26. Not INVARIANT I4, which is about
      // this server's disk. Full derivation: docs/specs.md, "Logging at Google: store".
      store: false,
      // The current date and nothing else: without it the model reads "the latest
      // version" against its training cutoff. "en-CA" yields YYYY-MM-DD in LOCAL
      // time; toISOString() is UTC and reports the previous day in Central Europe
      // between 00:00 and 02:00.
      // Full derivation: docs/specs.md, "The current date as the only system instruction".
      systemInstruction: `Today's date is ${new Date().toLocaleDateString("en-CA")}.`,
      tools: SEARCH_TOOLS,
      thinkingConfig: { thinkingLevel },
    },
  });
}

/**
 * Runs a research call with all three built-in tools and appends citation
 * markers, source list and footer. If the model fails and a backup was passed
 * (resolveCallConfig() in config.js decides), the same request runs once more;
 * everything evaluated afterwards knows nothing of the fallback except the footer.
 *
 * signal is the MCP client's cancellation: it stops the request, the SDK's
 * retries and the backup, which would be a second billed request nobody reads.
 * Full derivation: docs/specs.md, "Cancellation by the client".
 */
export async function runSearch({
  query,
  model,
  thinkingLevel,
  backupModel,
  backupThinkingLevel,
  deadlineSeconds = DEFAULT_DEADLINE_SECONDS,
  signal,
}) {
  const ai = getClient({ deadlineSeconds });

  let response;
  // Stays undefined when the first attempt goes through, which drops the footer
  // line entirely.
  let fallback;

  try {
    response = await generate(ai, { query, model, thinkingLevel, deadlineSeconds, signal });
  } catch (error) {
    // Without a configured backup nothing changes: the error goes out unaltered,
    // as it did before this feature.
    if (!backupModel || signal?.aborted) throw error;

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
      response = await generate(ai, { query, model, thinkingLevel, deadlineSeconds, signal });
    } catch (backupError) {
      // Both errors, each with its model in front of it. With only the second
      // one here, you would go looking at the wrong model; describeError() on
      // both, so the cause of a network error is not lost.
      throw Object.assign(
        new Error(
          `${fallback.model}: ${describeError(error)} | ` +
            `backup ${backupModel}: ${describeError(backupError)}`,
        ),
        { attempts: [{ model: fallback.model, error }, { model: backupModel, error: backupError }] },
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
    modelVersion: response.modelVersion,
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
