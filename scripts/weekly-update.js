#!/usr/bin/env node
/**
 * The weekly dependency update: merges the open Dependabot pull requests that
 * pass a real end-to-end test, with a hard cap on billed searches. Run by
 * .github/workflows/weekly-update.yml; needs git, gh and GH_TOKEN, plus
 * GEMINI_API_KEY for the smoke test.
 *
 * Order, and why:
 * 1. GitHub Actions updates - merged without a smoke test. They only change
 *    how CI runs and never reach the server; their own CI run is green.
 * 2. All npm minor, patch and security updates together - one smoke test.
 * 3. npm majors one at a time, oldest first - one smoke test each, so a broken
 *    major is attributable.
 * Stops at MAX_SMOKE_TESTS; the rest waits for next week. If nothing needed
 * testing, main itself is tested once, which catches changes on Google's side
 * such as a retired model.
 *
 * Test before merge: each candidate is merged locally onto the current main
 * and exactly that tree is tested - unit tests, then the smoke test. GitHub's
 * squash merge of a conflict-free pull request produces the same tree. A pull
 * request that conflicts is skipped; Dependabot rebases it on its own and it
 * comes up next week.
 *
 * Merging uses the workflow's GITHUB_TOKEN, and events caused by that token
 * start no further workflow runs. Branch protection therefore must not require
 * branches to be up to date: after the first merge, the next pull request
 * would need a fresh CI run that nothing could start. The test of the merged
 * tree here takes over that role.
 *
 * Node built-ins only: every npm ci replaces node_modules under this script.
 * Full derivation: docs/specs.md, "Weekly dependency update".
 */
import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";

/** The hard cap on billed searches per run - each smoke test costs one. */
const MAX_SMOKE_TESTS = 3;

/** The check branch protection requires, reported by .github/workflows/test.yml. */
const REQUIRED_CHECK = "Tests";

const FAILED_LABEL = "weekly-update-failed";

/**
 * Written into the comment on a failed pull request together with its head
 * commit. A pull request is skipped only while that commit is unchanged, so a
 * new version or a rebase by Dependabot is tried again without anyone having
 * to remove the label - nobody may be watching for weeks.
 */
const FAILED_MARKER = "weekly-update failed at";

/** EXIT_UNAVAILABLE in scripts/smoke-test.js, which cannot be imported: it runs on import. */
const SMOKE_UNAVAILABLE = 75;

const DRY_RUN = process.argv.includes("--dry-run");

// The key reaches the smoke test only. npm ci runs the install scripts of
// every dependency of the pull request under test, and they have no business
// seeing it; test/helpers.js does not need it either.
const { GEMINI_API_KEY: _key, ...ENV_WITHOUT_KEY } = process.env;

const report = [];
let smokeTests = 0;
let verifications = 0;
let failed = false;

function log(line) {
  console.log(line);
  report.push(line);
}

function capture(cmd, args, { check = true } = {}) {
  const result = spawnSync(cmd, args, { encoding: "utf8" });
  if (check && result.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed: ${result.stderr.trim()}`);
  }
  return result;
}

/** Runs with output passed through to the log and returns the exit code. */
function stream(cmd, args, env) {
  // npm is a .cmd file on Windows and only runs through a shell. One command
  // string rather than args with shell: true, which Node deprecates (DEP0190);
  // the args here are fixed literals, nothing to escape.
  if (process.platform === "win32" && cmd === "npm") {
    return spawnSync(`npm ${args.join(" ")}`, { stdio: "inherit", env, shell: true }).status;
  }
  return spawnSync(cmd, args, { stdio: "inherit", env }).status;
}

const gh = (args) => capture("gh", args).stdout;
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const title = (pr) => `#${pr.number} ${pr.title}`;

const repo = () => process.env.GITHUB_REPOSITORY ?? gh(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]).trim();

function ciGreen(pr) {
  return (pr.statusCheckRollup ?? []).some(
    (c) => (c.name ?? c.context) === REQUIRED_CHECK && (c.conclusion ?? c.state) === "SUCCESS",
  );
}

function failedAtHead(pr) {
  const bodies = gh(["api", `repos/${repo()}/issues/${pr.number}/comments`, "--paginate", "--jq", ".[].body"]);
  return bodies.includes(`${FAILED_MARKER} ${pr.headRefOid}`);
}

/** A change of the leading number - or of the second one below 1.0, where SemVer allows breaking. */
function isBreaking(from, to) {
  const [a, b] = [from, to].map((version) => version.replace(/^v/, "").split("."));
  return a[0] !== b[0] || (a[0] === "0" && a[1] !== b[1]);
}

/**
 * Read from Dependabot's commit message, the same source and the same fallback
 * dependabot/fetch-metadata uses: the update-type lines where present, and
 * otherwise the versions themselves - security updates carry no update-type
 * at all, only "Bumps x from A to B." or, when grouped, "Updates `x` from A
 * to B". A head commit with neither was pushed by someone else and counts as a
 * major: tested on its own rather than slipped into the batch.
 */
function isMajor(pr) {
  const message = gh(["api", `repos/${repo()}/commits/${pr.headRefOid}`, "--jq", ".commit.message"]);
  const types = [...message.matchAll(/update-type:\s*version-update:semver-(\w+)/g)].map((m) => m[1]);
  const versions = [
    ...message.matchAll(/^Bumps \S+ from (v?\d\S*) to (v?\d\S*?)\.?$/gm),
    ...message.matchAll(/^Updates `\S+` from (v?\d\S*) to (v?\d\S*)$/gm),
  ];
  if (types.length === 0 && versions.length === 0) return true;
  return types.includes("major") || versions.some(([, from, to]) => isBreaking(from, to));
}

function listCandidates() {
  const prs = JSON.parse(
    gh([
      "pr", "list", "--author", "app/dependabot", "--state", "open", "--limit", "100",
      "--json", "number,title,headRefName,headRefOid,statusCheckRollup",
    ]),
  ).sort((a, b) => a.number - b.number);

  const actions = [];
  const batch = [];
  const majors = [];
  for (const pr of prs) {
    if (!ciGreen(pr)) {
      log(`- skipped ${title(pr)}: its own "${REQUIRED_CHECK}" check is not green`);
    } else if (failedAtHead(pr)) {
      log(`- skipped ${title(pr)}: failed here before, unchanged since`);
    } else if (pr.headRefName.startsWith("dependabot/github_actions/")) {
      actions.push(pr);
    } else if (pr.headRefName.startsWith("dependabot/npm_and_yarn/")) {
      (isMajor(pr) ? majors : batch).push(pr);
    }
  }
  return { actions, batch, majors };
}

/** Checks out current main with the given pull requests merged on top. */
function prepare(prs) {
  const refs = prs.map((pr) => `+refs/heads/${pr.headRefName}:refs/remotes/origin/${pr.headRefName}`);
  capture("git", ["fetch", "--quiet", "origin", "+refs/heads/main:refs/remotes/origin/main", ...refs]);
  capture("git", ["checkout", "--quiet", "--force", "--detach", "origin/main"]);
  const included = [];
  for (const pr of prs) {
    const merged = capture(
      "git",
      ["merge", "--no-ff", "--no-edit", "-m", `weekly update: ${title(pr)}`, `origin/${pr.headRefName}`],
      { check: false },
    );
    if (merged.status === 0) {
      included.push(pr);
    } else {
      capture("git", ["merge", "--abort"], { check: false });
      log(`- deferred ${title(pr)}: conflicts with main, Dependabot will rebase it`);
    }
  }
  return included;
}

/** "passed", "broken" or "unavailable" for the tree currently checked out. */
function verify() {
  verifications++;
  // A failing install is far more likely the registry than the update: the
  // pull request's own CI installed the same lockfile successfully.
  if (stream("npm", ["ci", "--no-audit", "--no-fund"], ENV_WITHOUT_KEY) !== 0) return "unavailable";
  if (stream("npm", ["test"], ENV_WITHOUT_KEY) !== 0) return "broken";
  if (DRY_RUN) {
    log("  (dry run: smoke test skipped)");
    return "passed";
  }
  smokeTests++;
  const status = stream(process.execPath, ["scripts/smoke-test.js"], process.env);
  if (status === 0) return "passed";
  return status === SMOKE_UNAVAILABLE ? "unavailable" : "broken";
}

function merge(pr) {
  if (DRY_RUN) {
    log(`- would merge ${title(pr)}`);
    return;
  }
  // GitHub computes mergeability lazily after a push to main, so a merge
  // right after the previous one can be refused for a moment.
  let error = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    const result = capture("gh", ["pr", "merge", String(pr.number), "--squash"], { check: false });
    if (result.status === 0) {
      log(`- merged ${title(pr)}`);
      return;
    }
    error = result.stderr.trim();
    sleep(15_000);
  }
  log(`- tested, but GitHub refused to merge ${title(pr)}: ${error}`);
}

function markFailed(pr) {
  log(`- FAILED ${title(pr)}: left open`);
  if (DRY_RUN) return;
  const run = `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`;
  capture("gh", ["label", "create", FAILED_LABEL, "--color", "B60205", "--force",
    "--description", "The weekly update tested this pull request and it failed"]);
  capture("gh", ["pr", "edit", String(pr.number), "--add-label", FAILED_LABEL]);
  capture("gh", ["pr", "comment", String(pr.number), "--body",
    `The weekly update merged this onto main and the tests failed, so it was not merged: ${run}\n\n` +
      "It is tried again as soon as Dependabot pushes a new commit here.\n\n" +
      `<!-- ${FAILED_MARKER} ${pr.headRefOid} -->`]);
}

/** Tests the tree prepared for prs and acts on the verdict; false stops the run. */
function testAndMerge(prs) {
  const verdict = verify();
  if (verdict === "passed") {
    prs.forEach(merge);
    return true;
  }
  if (verdict === "unavailable") {
    log("- stopped: the API or the registry was unavailable, nothing marked - next week tries again");
    return false;
  }
  failed = true;
  prs.forEach(markFailed);
  return false;
}

function run() {
  if (capture("git", ["status", "--porcelain"]).stdout.trim()) {
    throw new Error("The working tree has uncommitted changes; this script checks out other commits.");
  }
  const { actions, batch, majors } = listCandidates();

  actions.forEach(merge);

  if (batch.length > 0) {
    log(`Minor, patch and security updates: ${batch.map((pr) => `#${pr.number}`).join(", ")}`);
    const included = prepare(batch);
    if (included.length > 0 && !testAndMerge(included)) return;
  }

  for (const [index, pr] of majors.entries()) {
    if (!DRY_RUN && smokeTests >= MAX_SMOKE_TESTS) {
      log(`Limit of ${MAX_SMOKE_TESTS} smoke tests reached, waiting for next week: ` +
        majors.slice(index).map((p) => `#${p.number}`).join(", "));
      return;
    }
    log(`Major update: ${title(pr)}`);
    if (prepare([pr]).length > 0 && !testAndMerge([pr])) return;
  }

  if (verifications === 0) {
    log("Nothing to merge - testing main against the live API");
    prepare([]);
    const verdict = verify();
    if (verdict === "broken") {
      failed = true;
      log("- FAILED: main itself no longer works against the live API");
    } else {
      log(verdict === "passed" ? "- main works" : "- the API or the registry was unavailable");
    }
  }
}

try {
  log(DRY_RUN ? "Weekly update (dry run)" : "Weekly update");
  run();
} catch (error) {
  failed = true;
  log(`- ERROR: ${error.message}`);
}
log(`Smoke tests used: ${smokeTests} of ${MAX_SMOKE_TESTS}`);
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report.join("\n")}\n`);
}
process.exitCode = failed ? 1 : 0;
