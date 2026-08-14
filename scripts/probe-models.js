#!/usr/bin/env node
/**
 * Maintenance probe for the negative list of models (issue #15, absorbing #11).
 *
 * Sends every model that passes isUsableModel() the same request runSearch()
 * sends - all of SEARCH_TOOLS plus a thinking level - and reports whether it
 * answers, plus the entries of the list no model matches any more. Both
 * directions in one run: what to add, and what to remove. Run by hand when the
 * negative list is set up or reviewed. NOT part of
 * the server: it is excluded from the published package by the "files" list in
 * package.json, and no runtime code imports it. A per-call availability check
 * would turn an informational tool into a source of load and cost.
 *
 * INVARIANT I4 (see CLAUDE.md and docs/specs.md, "Terms compliance"): the probe
 * records model id, verdict, status code, duration and whether grounding
 * metadata came back - never the answer text, never the sources. The output is
 * meant to be redirected into a file, which makes this the one place in the
 * project where writing a Grounded Result to disk would be one line away.
 *
 * Usage:
 *   node scripts/probe-models.js [options]
 *
 *   --model <id>       probe only this model (repeatable, skips models.list
 *                      filtering, so already-excluded ids can be rechecked)
 *   --all              probe every model, not just those isUsableModel() passes
 *   --deadline <s>     X-Server-Timeout per attempt (default 180)
 *   --attempts <n>     attempts per model on a transient error (default 3)
 *   --pause <s>        pause between models (default 2)
 *   --thinking <level> thinking level to send (default low)
 */
import { parseArgs } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import { GoogleGenAI } from "@google/genai";
import {
  RETRY_OPTIONS,
  SEARCH_TOOLS,
  describeError,
  isUsableModel,
  readErrorBody,
} from "../gemini.js";
import { EXCLUDED_MODELS } from "../models-excluded.js";

/**
 * Needs a real search to be answerable, so a model that ignores the tool shows
 * up as answered-but-not-grounded instead of passing silently. Short answer, to
 * keep output tokens near the floor: the text is discarded either way.
 */
const PROBE_QUERY =
  "What is the current stable version of Node.js? Answer in a single sentence.";

/**
 * The default level to probe with, overridable via --thinking. It matters:
 * measured, the image models answer "Thinking level LOW is not supported for
 * this model. Please retry with other thinking level", which is a verdict on the
 * level rather than on the model - unlike the bare "Thinking level is not
 * supported for this model." that Gemma and the TTS model return.
 */
const DEFAULT_THINKING_LEVEL = "low";

/**
 * The verdict per HTTP status. Only "unusable" belongs in the negative list -
 * everything else says something about the key, the quota or the moment, not
 * about the model. Derived from the table in docs/google_errors.md.
 *
 * 400 is missing on purpose and decided in classify(): INVALID_ARGUMENT is the
 * model rejecting the request, FAILED_PRECONDITION and API_KEY_INVALID hang on
 * the account and would mislabel every remaining model.
 *
 * 504 is "slow" rather than transient: on this server it is usually the deadline
 * we set ourselves, the generation ran in full and is billed, so repeating it
 * doubles the cost. A model that hits it needs a human decision, not a retry.
 */
const VERDICT_BY_STATUS = {
  401: "fatal",
  403: "fatal",
  404: "unusable",
  408: "transient",
  429: "transient",
  500: "transient",
  502: "transient",
  503: "transient",
  504: "slow",
};

/** Upper bound for a wait Google asks for itself, so one blocked model cannot stall the run. */
const MAX_RETRY_DELAY_MS = 90_000;

/**
 * How long to wait before the next attempt. A 429 carries the answer with it as
 * RetryInfo in error.details ("retryDelay": "53s"); the SDK ignores that field
 * (see RETRY_OPTIONS in gemini.js), so it is read here. Without it the probe
 * backs off blindly against a quota window it cannot guess.
 */
function retryDelayMs(error, attempt) {
  try {
    const details = JSON.parse(error.message)?.error?.details ?? [];
    const delay = details.find((detail) => detail.retryDelay)?.retryDelay;
    const seconds = Number.parseFloat(delay);
    if (Number.isFinite(seconds) && seconds > 0) {
      return Math.min(seconds * 1000 + 1000, MAX_RETRY_DELAY_MS);
    }
  } catch {
    // Not an ApiError, or a body that is not JSON. Fall through to the fixed backoff.
  }
  return Math.min(5000 * 2 ** (attempt - 1), MAX_RETRY_DELAY_MS);
}

/**
 * The API's own sentence about what went wrong. readErrorBody() deliberately
 * reads only the machine-readable fields; here the prose is what carries the
 * information, because the status is the same 400 INVALID_ARGUMENT for
 * "Code execution is not enabled for this model" and "Thinking level is not
 * supported for this model." - two entirely different exclusions.
 */
function apiMessage(error) {
  try {
    return JSON.parse(error.message)?.error?.message;
  } catch {
    return undefined;
  }
}

/** Turns a failed attempt into a verdict plus the fields that go into the report. */
function classify(error) {
  const status = typeof error?.status === "number" ? error.status : undefined;
  const { statusName, reason } = readErrorBody(error);

  // No status at all means the request never reached the API - a broken line
  // says nothing about the model.
  if (status === undefined) {
    return { verdict: "transient", status: "-", statusName: "network", reason };
  }

  if (status === 400) {
    const accountLevel = reason === "API_KEY_INVALID" || statusName === "FAILED_PRECONDITION";
    return { verdict: accountLevel ? "fatal" : "unusable", status, statusName, reason };
  }

  return {
    verdict: VERDICT_BY_STATUS[status] ?? "unusable",
    status,
    statusName,
    reason,
  };
}

/**
 * One model, up to `attempts` times. Returns the record for the report and
 * nothing that came out of the model itself, except whether grounding metadata
 * was present at all - a model can answer and still ignore the search tool,
 * which makes it useless here for a reason no status code reports.
 */
async function probe(ai, id, { attempts, thinkingLevel }) {
  for (let attempt = 1; ; attempt++) {
    const startedAt = Date.now();
    try {
      const response = await ai.models.generateContent({
        model: id,
        contents: PROBE_QUERY,
        config: {
          tools: SEARCH_TOOLS,
          thinkingConfig: { thinkingLevel },
        },
      });
      const metadata = response.candidates?.[0]?.groundingMetadata;
      return {
        id,
        verdict: "ok",
        status: "-",
        statusName: "",
        grounded: (metadata?.groundingChunks?.length ?? 0) > 0,
        ms: Date.now() - startedAt,
        attempts: attempt,
      };
    } catch (error) {
      const { verdict, status, statusName, reason } = classify(error);
      const record = {
        id,
        verdict,
        status,
        statusName: statusName ?? "",
        reason,
        apiMessage: apiMessage(error),
        grounded: false,
        ms: Date.now() - startedAt,
        attempts: attempt,
        message: describeError(error),
      };

      if (verdict === "fatal") throw Object.assign(new Error(record.message), { record });
      if (verdict !== "transient" || attempt >= attempts) {
        // A transient error that never cleared is not a verdict on the model.
        if (verdict === "transient") record.verdict = "inconclusive";
        return record;
      }

      const wait = retryDelayMs(error, attempt);
      console.error(
        `  ${id}: ${status} ${statusName ?? ""} - retrying in ${Math.round(wait / 1000)}s ` +
          `(attempt ${attempt + 1}/${attempts})`,
      );
      await sleep(wait);
    }
  }
}

function pad(value, width) {
  return String(value).padEnd(width);
}

/**
 * Entries of the negative list that no model in models.list matches any more,
 * because Google retired it. Harmless at runtime - nothing ever looks an entry
 * up unless the API named the model first - but the reason is dead weight, and a
 * reused id would attach it to something else.
 *
 * Reported here because nothing else can: the test in test/models.test.js reads
 * the stored response, which keeps a retired model until somebody renews the
 * file, and a test may not call the live API. Needs the full models.list, so a
 * run narrowed to --model skips the check rather than guessing from ids the
 * command line supplied.
 */
function staleEntries(liveIds) {
  if (!liveIds) return [];
  return Object.keys(EXCLUDED_MODELS).filter((id) => !liveIds.has(id));
}

/** The table, plus the entries ready to paste into the negative list. */
function report(records, liveIds) {
  const width = Math.max(...records.map((record) => record.id.length), 5);
  const lines = [
    `${pad("model", width)}  ${pad("verdict", 12)} ${pad("code", 5)} ${pad("status", 20)} ` +
      `${pad("ms", 7)} grounded`,
  ];
  for (const record of records) {
    lines.push(
      `${pad(record.id, width)}  ${pad(record.verdict, 12)} ${pad(record.status, 5)} ` +
        `${pad(record.statusName, 20)} ${pad(record.ms, 7)} ` +
        (record.verdict === "ok" ? (record.grounded ? "yes" : "NO") : ""),
    );
  }

  const counts = {};
  for (const record of records) counts[record.verdict] = (counts[record.verdict] ?? 0) + 1;
  lines.push(
    "",
    `${records.length} probed: ` +
      Object.entries(counts)
        .map(([verdict, count]) => `${count} ${verdict}`)
        .join(", "),
  );

  const ungrounded = records.filter((record) => record.verdict === "ok" && !record.grounded);
  if (ungrounded.length > 0) {
    lines.push(
      "",
      "Answered but returned no grounding chunks - decide by hand whether the model",
      "cannot search or the query simply did not need it:",
      ...ungrounded.map((record) => `  ${record.id}`),
    );
  }

  const unusable = records.filter((record) => record.verdict === "unusable");
  if (unusable.length > 0) {
    lines.push("", "Candidates for the negative list:", "");
    for (const record of unusable) {
      const code = [record.status, record.reason ?? record.statusName].filter(Boolean).join(" ");
      // The trailing full stop is Google's on some messages and not on others.
      const why = (record.apiMessage ?? "").replace(/\.$/, "");
      lines.push(`  "${record.id}": "${code}${why ? ` - ${why}` : ""}",`);
    }
  }

  const stale = staleEntries(liveIds);
  if (stale.length > 0) {
    lines.push(
      "",
      "On the list in models-excluded.js and no longer offered by this key - drop",
      "the entry, unless the id is one this key never had:",
      ...stale.map((id) => `  ${id}`),
    );
  }

  const inconclusive = records.filter(
    (record) => record.verdict === "inconclusive" || record.verdict === "slow",
  );
  if (inconclusive.length > 0) {
    lines.push(
      "",
      "No verdict - rerun these, the error was about the moment or the quota:",
      ...inconclusive.map((record) => `  ${record.id}  ${record.status} ${record.statusName}`),
    );
  }

  return lines.join("\n");
}

async function main() {
  const { values } = parseArgs({
    options: {
      model: { type: "string", multiple: true },
      all: { type: "boolean", default: false },
      deadline: { type: "string", default: "180" },
      attempts: { type: "string", default: "3" },
      pause: { type: "string", default: "2" },
      thinking: { type: "string", default: DEFAULT_THINKING_LEVEL },
    },
  });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set.");

  const attempts = Number.parseInt(values.attempts, 10);
  const pauseMs = Number.parseFloat(values.pause) * 1000;
  const ai = new GoogleGenAI({
    apiKey,
    httpOptions: {
      retryOptions: RETRY_OPTIONS,
      // Shorter than SERVER_DEADLINE_SECONDS: this query needs seconds, and the
      // probe runs sequentially over dozens of models. A model that still runs
      // into it is reported as "slow" rather than unusable.
      headers: { "X-Server-Timeout": values.deadline },
    },
  });

  let ids;
  // Everything the key currently offers, for staleEntries(). Stays undefined on
  // a run narrowed to --model, where no complete list was ever fetched.
  let liveIds;
  if (values.model?.length) {
    ids = values.model;
  } else {
    const pager = await ai.models.list({ config: { pageSize: 50 } });
    const models = [];
    for await (const model of pager) models.push(model);
    const nameOf = (model) => (model.name ?? "").replace(/^models\//, "");
    liveIds = new Set(models.map(nameOf).filter(Boolean));
    ids = (values.all ? models : models.filter(isUsableModel))
      .map(nameOf)
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));
  }

  // stderr throughout: progress belongs next to the table, not inside it, so
  // stdout stays a clean artefact when redirected.
  console.error(`Probing ${ids.length} models, ${attempts} attempts each.\n`);

  const records = [];
  for (const [index, id] of ids.entries()) {
    console.error(`[${index + 1}/${ids.length}] ${id}`);
    try {
      records.push(await probe(ai, id, { attempts, thinkingLevel: values.thinking }));
    } catch (error) {
      // Only a fatal verdict gets here: the key or the account is the problem,
      // and every remaining model would fail the same way and be mislabelled.
      console.error(`\nAborted at ${id}: ${error.message}`);
      console.error("This is an account-level error, not a verdict on the model.");
      if (records.length > 0) console.log(report(records, liveIds));
      process.exitCode = 1;
      return;
    }
    if (index < ids.length - 1) await sleep(pauseMs);
  }

  console.error("");
  console.log(report(records, liveIds));
}

await main();
