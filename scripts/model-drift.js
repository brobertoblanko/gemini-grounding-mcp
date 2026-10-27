#!/usr/bin/env node
/**
 * The weekly check of the key's model list against what this repository knows:
 * exclusion entries whose model Google retired, and models offered here that
 * nobody has probed yet. Run by .github/workflows/weekly-update.yml in two jobs,
 * one per phase, split like scripts/weekly-update.js:
 *
 *   node scripts/model-drift.js check <drift.json>   read-only token, Gemini key
 *   node scripts/model-drift.js report <drift.json>  issues: write, no npm ci
 *
 * "check" loads the SDK and therefore needs npm ci, so it never holds a token
 * that can write. "report" uses Node built-ins and gh only and comments on the
 * open drift issue or opens one; it changes nothing in the repository.
 *
 * Free: models.list is not billed. The full probe that decides what goes on the
 * exclusion list costs about 33 billed requests and stays a manual run of
 * scripts/probe-models.js - this check only says when one is due.
 *
 * "Known" means listed in test/fixtures/models-list.json, the stored response
 * the exclusion list was verified against.
 *
 * Full derivation: docs/specs.md, "Model list drift".
 */
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const TITLE = "Model list drift";
const FIXTURE = new URL("../test/fixtures/models-list.json", import.meta.url);

/** The lines for the log and the issue; empty when nothing drifted. */
function describe({ stale, unprobed }) {
  const lines = [];
  if (unprobed.length > 0) {
    lines.push(
      "Offered here, but not in test/fixtures/models-list.json - probe them with " +
        "scripts/probe-models.js --model <id>, then renew the fixture:",
      ...unprobed.map((id) => `- \`${id}\``),
    );
  }
  if (stale.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(
      "On the exclusion list, but no longer in models.list - remove them from models-excluded.js:",
      ...stale.map((id) => `- \`${id}\``),
    );
  }
  return lines;
}

async function check(output) {
  // Imported here and not at the top: "report" runs without npm ci.
  const { fetchModels, findModelDrift, modelId } = await import("../gemini.js");
  const known = new Set(JSON.parse(readFileSync(FIXTURE, "utf8")).models.map(modelId));
  const drift = findModelDrift(await fetchModels(), known);
  writeFileSync(output, JSON.stringify(drift));
  return drift;
}

/**
 * The drift comes from the job that ran dependency code, so it is checked
 * rather than trusted: model ids only, nothing that could smuggle markup or
 * mentions into the issue.
 */
function isGenuine(drift) {
  const ids = (list) =>
    Array.isArray(list) && list.every((id) => typeof id === "string" && /^[\w.-]{1,100}$/.test(id));
  return ids(drift?.stale) && ids(drift?.unprobed);
}

function gh(args, input) {
  const result = spawnSync("gh", args, { encoding: "utf8", input });
  if (result.status !== 0) {
    throw new Error(`gh ${args[0]} ${args[1]} failed: ${result.error?.message ?? result.stderr.trim()}`);
  }
  return result.stdout;
}

function report(drift) {
  const lines = describe(drift);
  if (lines.length === 0) return;

  const body = [...lines, "", "Written by the weekly update; nothing was changed automatically."].join("\n");
  // An open issue gets the new finding as a comment, so earlier weeks stay
  // readable; a closed one counts as done and is left alone. Listed and
  // filtered here rather than through --search: the search index lags behind,
  // and measured, an issue opened three seconds earlier was not found, so a
  // second one was opened next to it.
  const [open] = JSON.parse(
    gh(["issue", "list", "--state", "open", "--limit", "200", "--json", "number,title"]),
  )
    .filter((issue) => issue.title === TITLE)
    .sort((a, b) => a.number - b.number);
  if (open) gh(["issue", "comment", String(open.number), "--body-file", "-"], body);
  else gh(["issue", "create", "--title", TITLE, "--body-file", "-"], body);
}

const [phase, file] = process.argv.slice(2);
if (!["check", "report"].includes(phase) || !file) {
  console.error("Usage: model-drift.js check <drift.json> | report <drift.json>");
  process.exit(1);
}
const drift = phase === "check" ? await check(file) : JSON.parse(readFileSync(file, "utf8"));
if (phase === "report" && !isGenuine(drift)) {
  console.error("The drift file holds something other than model ids - nothing reported.");
  process.exit(1);
}
const lines = describe(drift);
const summary = lines.length > 0 ? lines.join("\n") : "No drift: every offered model is known, every exclusion still matches.";
console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
if (phase === "report") report(drift);
