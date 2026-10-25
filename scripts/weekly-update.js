#!/usr/bin/env node
/**
 * The weekly dependency update: merges the open Dependabot pull requests that
 * pass a real end-to-end test, with a hard cap on billed searches. Run by
 * .github/workflows/weekly-update.yml in two jobs, one per phase:
 *
 *   node scripts/weekly-update.js test [--dry-run]   read-only token
 *   node scripts/weekly-update.js merge <plan.json>  write token
 *
 * The split is the security boundary. "test" executes the code of the updates
 * under test - npm ci, npm test and the smoke test all run it - so it must
 * never hold a token that can write to the repository. Stripping the token
 * from a child's environment would not be enough: on Linux a child can read
 * its parent's environment from /proc. "merge" holds the write token and runs
 * no dependency code at all - Node built-ins only, no npm ci.
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
 * Test before merge: the "test" phase stacks the candidates locally onto main
 * in exactly the order "merge" applies them, and tests each step. GitHub's
 * squash merge of a conflict-free pull request produces the same tree, and
 * --match-head-commit refuses a pull request whose head moved since. A pull
 * request that conflicts is skipped; Dependabot rebases it on its own and it
 * comes up next week.
 *
 * Merging uses the workflow's GITHUB_TOKEN, and events caused by that token
 * start no further workflow runs. Branch protection therefore must not require
 * branches to be up to date: after the first merge, the next pull request
 * would need a fresh CI run that nothing could start. The test of the stacked
 * tree takes over that role.
 *
 * Full derivation: docs/specs.md, "Weekly dependency update".
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

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

const report = [];

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
const planEntry = ({ number, title, headRefOid }) => ({ number, title, headRefOid });
const numbers = (prs) => prs.map((pr) => `#${pr.number}`).join(", ");

const repo = () =>
  process.env.GITHUB_REPOSITORY ??
  gh(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]).trim();

// --- Phase "test" ------------------------------------------------------------

/**
 * The environment for the code under test. Every token goes, read-only or not
 * - least privilege costs nothing here. The Gemini key goes to the smoke test
 * alone, which cannot work without it; npm ci and npm test never see it.
 */
const isCredential = (name) => /TOKEN|SECRET|PASSWORD|_KEY$/i.test(name);
const ENV_UNTRUSTED = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !isCredential(name)),
);
const ENV_SMOKE = { ...ENV_UNTRUSTED, GEMINI_API_KEY: process.env.GEMINI_API_KEY ?? "" };

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

/**
 * Merges the given pull requests onto the tree checked out right now - which is
 * main plus everything accepted so far, the same stack "merge" builds on GitHub.
 */
function stack(prs) {
  const included = [];
  for (const pr of prs) {
    capture("git", ["fetch", "--quiet", "origin", `+refs/heads/${pr.headRefName}:refs/remotes/origin/${pr.headRefName}`]);
    const merged = capture(
      "git",
      ["merge", "--no-ff", "--no-edit", "-m", `weekly update: ${title(pr)}`, pr.headRefOid],
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

function testPhase(dryRun) {
  if (capture("git", ["status", "--porcelain"]).stdout.trim()) {
    throw new Error("The working tree has uncommitted changes; this script checks out other commits.");
  }
  capture("git", ["fetch", "--quiet", "origin", "+refs/heads/main:refs/remotes/origin/main"]);
  capture("git", ["checkout", "--quiet", "--force", "--detach", "origin/main"]);

  const plan = { merge: [], failed: [] };
  let smokeTests = 0;
  let verifications = 0;

  /** "passed", "broken" or "unavailable" for the tree checked out right now. */
  function verify() {
    verifications++;
    // --ignore-scripts: no dependency needs its install script at runtime -
    // protobufjs's postinstall only checks its own CLI tooling - and none
    // should run code before the tests even start. A failing install is far
    // more likely the registry than the update: the pull request's own CI
    // installed the same lockfile successfully.
    if (stream("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], ENV_UNTRUSTED) !== 0) {
      return "unavailable";
    }
    if (stream("npm", ["test"], ENV_UNTRUSTED) !== 0) return "broken";
    if (dryRun) {
      log("  (dry run: smoke test skipped)");
      return "passed";
    }
    smokeTests++;
    const status = stream(process.execPath, ["scripts/smoke-test.js"], ENV_SMOKE);
    if (status === 0) return "passed";
    return status === SMOKE_UNAVAILABLE ? "unavailable" : "broken";
  }

  /** Records the verdict; false stops the phase - later steps would build on a broken one. */
  function accept(prs, verdict) {
    if (verdict === "passed") {
      prs.forEach((pr) => log(`- passed ${title(pr)}`));
      plan.merge.push(...prs.map(planEntry));
      return true;
    }
    if (verdict === "unavailable") {
      log("- stopped: the API or the registry was unavailable, nothing marked - next week tries again");
    } else {
      prs.forEach((pr) => log(`- FAILED ${title(pr)}`));
      plan.failed.push(...prs.map(planEntry));
    }
    return false;
  }

  const { actions, batch, majors } = listCandidates();

  // Stacked first, so the npm tests below run on top of them as well.
  for (const pr of stack(actions)) {
    log(`- accepted without smoke test (GitHub Actions only) ${title(pr)}`);
    plan.merge.push(planEntry(pr));
  }

  let stopped = false;
  if (batch.length > 0) {
    log(`Minor, patch and security updates: ${numbers(batch)}`);
    const included = stack(batch);
    if (included.length > 0) stopped = !accept(included, verify());
  }

  for (const [index, pr] of majors.entries()) {
    if (stopped) break;
    if (!dryRun && smokeTests >= MAX_SMOKE_TESTS) {
      log(`Limit of ${MAX_SMOKE_TESTS} smoke tests reached, waiting for next week: ${numbers(majors.slice(index))}`);
      break;
    }
    log(`Major update: ${title(pr)}`);
    if (stack([pr]).length > 0) stopped = !accept([pr], verify());
  }

  if (verifications === 0) {
    log("Nothing to test - testing main against the live API");
    capture("git", ["checkout", "--quiet", "--force", "--detach", "origin/main"]);
    const verdict = verify();
    if (verdict === "broken") plan.mainBroken = true;
    log({ passed: "- main works", broken: "- FAILED: main itself no longer works against the live API" }[verdict] ??
      "- the API or the registry was unavailable");
  }

  log(`Smoke tests used: ${smokeTests} of ${MAX_SMOKE_TESTS}`);
  return plan;
}

// --- Phase "merge" -----------------------------------------------------------

function merge(pr) {
  // GitHub computes mergeability lazily after a push to main, so a merge
  // right after the previous one can be refused for a moment.
  let error = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    const result = capture(
      "gh",
      ["pr", "merge", String(pr.number), "--squash", "--match-head-commit", pr.headRefOid],
      { check: false },
    );
    if (result.status === 0) {
      log(`- merged ${title(pr)}`);
      return true;
    }
    error = result.stderr.trim();
    sleep(15_000);
  }
  log(`- GitHub refused to merge ${title(pr)}, stopping: ${error}`);
  return false;
}

function markFailed(pr) {
  const run = `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`;
  capture("gh", ["label", "create", FAILED_LABEL, "--color", "B60205", "--force",
    "--description", "The weekly update tested this pull request and it failed"]);
  capture("gh", ["pr", "edit", String(pr.number), "--add-label", FAILED_LABEL]);
  capture("gh", ["pr", "comment", String(pr.number), "--body",
    `The weekly update tested this on top of main and it failed, so it was not merged: ${run}\n\n` +
      "It is tried again as soon as Dependabot pushes a new commit here.\n\n" +
      `<!-- ${FAILED_MARKER} ${pr.headRefOid} -->`]);
  log(`- marked ${title(pr)} as failed, left open`);
}

/**
 * The plan comes from the job that ran the code under test, so it is checked
 * rather than trusted: whatever wrote it could have written anything. Only an
 * open Dependabot pull request whose head is still the tested commit passes -
 * at worst a tampered plan merges a genuine Dependabot update untested, and
 * branch protection still demands its own green "Tests" check.
 */
function isGenuine(pr) {
  if (!Number.isInteger(pr.number) || !/^[0-9a-f]{40}$/.test(pr.headRefOid)) return false;
  const live = JSON.parse(gh(["pr", "view", String(pr.number), "--json", "state,author,headRefOid"]));
  return live.state === "OPEN" && live.author?.login === "app/dependabot" && live.headRefOid === pr.headRefOid;
}

/** Returns whether the run counts as failed. */
function mergePhase(plan) {
  // In the tested order: every step was tested on top of the ones before it,
  // so after a refused merge the rest no longer matches what was tested.
  for (const pr of plan.merge) {
    if (!isGenuine(pr)) {
      log(`- #${pr.number} is not the tested Dependabot pull request any more, stopping`);
      return true;
    }
    if (!merge(pr)) return true;
  }
  plan.failed.filter(isGenuine).forEach(markFailed);
  return plan.failed.length > 0 || Boolean(plan.mainBroken);
}

// --- Entry point -------------------------------------------------------------

const [phase, argument] = process.argv.slice(2);
let failed = false;
try {
  if (phase === "test") {
    const dryRun = argument === "--dry-run";
    log(dryRun ? "Weekly update - test (dry run)" : "Weekly update - test");
    const plan = testPhase(dryRun);
    writeFileSync("weekly-update-plan.json", JSON.stringify(plan));
    // A dry run has no merge phase to turn failures into a red run.
    failed = dryRun && (plan.failed.length > 0 || Boolean(plan.mainBroken));
  } else if (phase === "merge") {
    log("Weekly update - merge");
    failed = mergePhase(JSON.parse(readFileSync(argument, "utf8")));
  } else {
    throw new Error('Usage: weekly-update.js test [--dry-run] | merge <plan.json>');
  }
} catch (error) {
  failed = true;
  log(`- ERROR: ${error.message}`);
}
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report.join("\n")}\n`);
}
process.exitCode = failed ? 1 : 0;
