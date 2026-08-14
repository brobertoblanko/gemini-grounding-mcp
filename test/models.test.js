import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { isExcludedModel, isUsableModel, listModels, modelId } from "../gemini.js";
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
  // The three kinds carry different weight, and the header says each entry
  // states which it is. An entry without one cannot be reviewed later.
  for (const [id, reason] of Object.entries(EXCLUDED_MODELS)) {
    assert.match(reason, /^(\d{3} [A-Z_]+|no sources|unsuitable) - /, `reason for ${id}`);
  }
});

test("the default list hides the excluded models and says so", async () => {
  mockFetch(listResponse);
  const output = await listModels();

  for (const id of Object.keys(EXCLUDED_MODELS)) {
    assert.ok(!output.includes(`${id} `), `${id} must not appear in the default list`);
  }
  assert.match(output, /models-excluded\.js/);
  assert.match(output, /8 of 53 models offered here, \d+ usable ones excluded/);
});

test("the note names the switch the way the caller's frontend spells it", async () => {
  // The note is the only place the shortlist tells anyone how to get past it,
  // and the two frontends spell that switch differently. A wording that fits
  // both would name neither.
  mockFetch(listResponse);
  assert.match(await listModels({ allOption: "--all" }), /--all lists them all/);

  mockFetch(listResponse);
  assert.match(await listModels({ allOption: "all: true" }), /all: true lists them all/);
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
