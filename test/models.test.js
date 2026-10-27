import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  checkModelIds,
  isExcludedModel,
  isUsableModel,
  listModels,
  modelId,
} from "../gemini.js";
import { EXCLUDED_MODELS } from "../models-excluded.js";
import { mockFetch } from "./helpers.js";

// getClient() reads the key on every call and refuses without one, so the cases
// calling listModels() need it set even though the mocked fetch never lets a
// request out. Same placeholder as retry.test.js; CI sets no key at all.
process.env.GEMINI_API_KEY = "test-key-never-sent";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

const FIXTURE = JSON.parse(
  readFileSync(fileURLToPath(new URL("fixtures/models-list.json", import.meta.url)), "utf8"),
);

/** The stored response, or a subset of it, as the raw body the SDK receives. */
const bodyOf = (models) => () =>
  new Response(JSON.stringify({ models }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const listResponse = bodyOf(FIXTURE.models);

const ids = FIXTURE.models.map(modelId);

/**
 * The fixture is the raw HTTP body, because the mock replaces fetch and the SDK
 * still has to parse it. On the wire the field is supportedGenerationMethods;
 * the SDK renames it to supportedActions, which is what isUsableModel() reads.
 * Cases calling that function directly have to do the same rename.
 */
const asSdkModel = (model) => ({ ...model, supportedActions: model.supportedGenerationMethods });

test("every excluded id matches a model in the stored response", () => {
  // A typo in an id never takes effect and nothing points at it - the same
  // silent failure the exclusion list exists to avoid, one step removed. This
  // also catches an entry Google has retired, which turns it into dead weight.
  const dead = Object.keys(EXCLUDED_MODELS).filter((id) => !ids.includes(id));
  assert.deepEqual(dead, [], "excluded ids matching no model in fixtures/models-list.json");
});

test("no excluded model is one the usability filter already removes", () => {
  // Such an entry would be invisible: isUsableModel() drops it first, so the
  // exclusion never runs and its reason is never read.
  const redundant = FIXTURE.models
    .map(asSdkModel)
    .filter((model) => isExcludedModel(model) && !isUsableModel(model))
    .map(modelId);
  assert.deepEqual(redundant, [], "excluded ids the usability filter already removes");
});

test("every reason names its kind", () => {
  // The four kinds carry different weight, and the header says each entry
  // states which it is. An entry without one cannot be reviewed later.
  for (const [id, reason] of Object.entries(EXCLUDED_MODELS)) {
    assert.match(
      reason,
      /^(\d{3} [A-Z_]+|deprecated|no sources|unsuitable) - /,
      `reason for ${id}`,
    );
  }
});

test("the default list hides the excluded models and says so", async () => {
  mockFetch(listResponse);
  const output = await listModels();

  for (const id of Object.keys(EXCLUDED_MODELS)) {
    assert.ok(!output.includes(`${id} `), `${id} must not appear in the default list`);
  }
  assert.match(output, /8 of 60 models offered, \d+ excluded after testing/);
});

test("the note fits a terminal line", async () => {
  // Wider than 80 columns, the terminal wraps it mid-word.
  for (const all of [false, true]) {
    mockFetch(listResponse);
    const note = (await listModels({ all })).split("\n").at(-1);
    assert.ok(note.length < 80, `note is ${note.length} columns: ${note}`);
  }
});

test("all=true lists the offered models first, under a header", async () => {
  mockFetch(listResponse);
  const [header, ...rest] = (await listModels({ all: true })).split("\n");

  assert.match(header, /^MODEL\s+INPUT\s+OUTPUT\s+STATUS$/);
  const statuses = rest.filter((line) => line !== "").slice(0, -1).map((line) => line.trim());
  const firstOther = statuses.findIndex((line) => !line.endsWith("  offered"));
  assert.equal(firstOther, 8, "the 8 offered models lead the list");
  assert.ok(
    statuses.slice(firstOther).every((line) => !line.endsWith("  offered")),
    "no offered model after the first other one",
  );
});

test("the note names the switch the way the caller's frontend spells it", async () => {
  // The note is the only place the shortlist tells anyone how to get past it,
  // and the two frontends spell that switch differently. A wording that fits
  // both would name neither.
  mockFetch(listResponse);
  assert.match(await listModels({ allOption: "--all" }), /--all lists all models/);

  mockFetch(listResponse);
  assert.match(await listModels({ allOption: "all: true" }), /all: true lists all models/);
});

test("all=true bypasses the exclusion list and names the kind of each entry", async () => {
  mockFetch(listResponse);
  const output = await listModels({ all: true });

  for (const id of ids) assert.ok(output.includes(id), `${id} must appear with all=true`);

  // Each entry carries its own kind rather than one shared word. Without it a
  // retired model and an image model read identically, and the kind is the only
  // part of the reason that reaches the user at all.
  const lineFor = new Map(output.split("\n").map((line) => [line.split(" ")[0], line]));
  for (const [id, reason] of Object.entries(EXCLUDED_MODELS)) {
    const kind = reason.split(" - ")[0];
    assert.ok(lineFor.get(id)?.endsWith(`  ${kind}`), `${id} must be listed as "${kind}"`);
  }
});

test("falls back to the full list when the usability filter matches nothing", async () => {
  // The API dropping one of the evaluated fields must not empty the output.
  mockFetch(bodyOf(FIXTURE.models.map(({ thinking, ...rest }) => rest)));
  const output = await listModels();

  for (const id of ids) assert.ok(output.includes(id), `${id} must appear`);
  assert.match(output, /usability filter matched nothing/);
});

test("falls back to the usable models when the exclusion list covers them all", async () => {
  const models = FIXTURE.models.filter(
    (model) => !isUsableModel(asSdkModel(model)) || isExcludedModel(model),
  );
  mockFetch(bodyOf(models));
  const output = await listModels();

  assert.match(output, /are on the exclusion list/);
  for (const id of Object.keys(EXCLUDED_MODELS)) {
    assert.ok(output.includes(`${id} `), `${id} must be shown when nothing else is left`);
  }
});

test("names why a saved model id is unlikely to work, and stays quiet on a good one", async () => {
  mockFetch(listResponse);

  const advice = await checkModelIds([
    "gemini-flash-latest",
    "gemini-typo",
    "aqa",
    "antigravity-preview-05-2026",
    "gemma-4-31b-it",
  ]);

  assert.deepEqual(advice, [
    '"gemini-typo" is not in the model list of this API key - a search with it will most likely fail.',
    '"aqa" cannot run here: no text (generateAnswer).',
    '"antigravity-preview-05-2026" cannot run here: no thinking.',
    `"gemma-4-31b-it" is on this server's exclusion list: ${EXCLUDED_MODELS["gemma-4-31b-it"]}.`,
  ]);
});

test("gives no advice when the model list cannot be fetched", async () => {
  globalThis.fetch = async () => {
    throw new TypeError("fetch failed");
  };
  assert.deepEqual(await checkModelIds(["gemini-typo"]), []);
});
