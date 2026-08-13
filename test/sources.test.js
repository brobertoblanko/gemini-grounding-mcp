import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildSourceList, formatSourcesBlock, formatFooter } from "../gemini.js";

// This file pins the invariants under which this server keeps to Google's terms
// for "Grounding with Google Search" - see CLAUDE.md and docs/specs.md, "Terms compliance".
// They cover no behaviour anyone could improve, but behaviour nobody may
// change: every single one of these properties looks like a candidate for
// optimization in the code.
//
// I3 (no redirect is resolved) and I4 (nothing is cached) are statements of
// absence and therefore stand only as a rule in CLAUDE.md.
//
// gemini.js imports without an API key: getClient() runs inside the functions,
// not when the module loads.

const candidate = JSON.parse(
  readFileSync(new URL("./fixtures/grounding-chunks.json", import.meta.url), "utf-8"),
);

const chunks = candidate.groundingMetadata.groundingChunks;
const supports = candidate.groundingMetadata.groundingSupports;
const urlContextEntries = candidate.urlContextMetadata.urlMetadata;

/** The chunk indices that any citation marker points at. */
const referencedIndices = new Set(supports.flatMap((s) => s.groundingChunkIndices));

/**
 * The URIs that must appear in the list - each exactly once, in this order:
 * search hits first, then the pages read via URL Context. Both origins are
 * links under the terms, I1 applies to both.
 */
const expectedUris = [
  ...new Set([
    ...chunks.map((chunk) => chunk.web?.uri).filter(Boolean),
    ...urlContextEntries.map((entry) => entry.retrievedUrl).filter(Boolean),
  ]),
];

test("includes every source, the unsupported ones too (I1)", () => {
  // Precondition on the fixture: without unsupported chunks this test would
  // miss the interesting half of I1 - that the links no marker points at appear
  // as well. Those are the obvious candidates for trimming.
  const unreferenced = chunks.filter(
    (chunk, index) => chunk.web?.uri && !referencedIndices.has(index),
  );
  assert.ok(unreferenced.length > 0, "the fixture needs chunks without a support");

  const { sources } = buildSourceList(candidate);

  assert.equal(sources.length, expectedUris.length);
  for (const chunk of unreferenced) {
    assert.ok(
      sources.some((source) => source.uri === chunk.web.uri),
      `unsupported source missing from the list: ${chunk.web.title}`,
    );
  }
});

test("emits title and URI byte for byte (I2)", () => {
  const { sources } = buildSourceList(candidate);
  const block = formatSourcesBlock(sources);

  // The whole line is compared, not via includes: a URI truncated at the end -
  // the most obvious intervention of all - would pass an includes on the start
  // of the URI unhindered.
  const lines = block.split("\n").slice(3);
  assert.equal(lines.length, sources.length);

  lines.forEach((line, index) => {
    const source = sources[index];
    assert.equal(line, `[${index + 1}] ${source.title} - ${source.uri}`);
  });

  // And the same check against the fixture instead of the intermediate result:
  // otherwise truncations already happening in buildSourceList go unnoticed.
  expectedUris.forEach((uri, index) => {
    assert.equal(lines[index], `[${index + 1}] ${titleOf(uri)} - ${uri}`);
  });
});

/**
 * The title the API supplied for this URI. For URL Context pages it supplies
 * none, and there the URL is the label as well.
 */
function titleOf(uri) {
  return chunks.find((chunk) => chunk.web?.uri === uri)?.web.title ?? uri;
}

test("reports skipped chunks in the footer instead of hiding them", () => {
  const withoutUri = chunks.filter((chunk) => !chunk.web?.uri);
  assert.ok(withoutUri.length > 0, "the fixture needs chunks without web.uri");

  const { skipped } = buildSourceList(candidate);
  assert.equal(skipped, withoutUri.length);

  const footer = formatFooter({
    usageMetadata: {},
    model: "gemini-flash-latest",
    thinkingLevel: "medium",
    sourceCount: expectedUris.length,
    dropped: 0,
    skipped,
    searchQueries: [],
  });
  assert.match(footer, new RegExp(`⚠️ ${skipped} sources omitted`));

  // The normal case must not lengthen the footer, see formatSearchQueries.
  const clean = formatFooter({
    usageMetadata: {},
    model: "gemini-flash-latest",
    thinkingLevel: "medium",
    sourceCount: expectedUris.length,
    dropped: 0,
    skipped: 0,
    searchQueries: [],
  });
  assert.ok(!clean.includes("omitted"), `unexpected notice: ${clean}`);
});

test("includes the pages read via URL Context too (I1)", () => {
  // The second branch of buildSourceList. It draws no attention because these
  // entries have no supports, so no marker points nowhere when they are missing
  // - they disappear silently.
  const { sources, chunkNumbers } = buildSourceList(candidate);
  const listed = sources.map((source) => source.uri);

  for (const entry of urlContextEntries) {
    assert.ok(listed.includes(entry.retrievedUrl), `page read is missing: ${entry.retrievedUrl}`);
  }

  // The measured case: the page read also arrived as a groundingChunk, with a
  // direct URL instead of a redirect. That must not put it in the list twice.
  const alsoAChunk = urlContextEntries.find((entry) =>
    chunks.some((chunk) => chunk.web?.uri === entry.retrievedUrl),
  );
  assert.ok(alsoAChunk, "the fixture needs a page that is a chunk as well");
  assert.equal(listed.filter((uri) => uri === alsoAChunk.retrievedUrl).length, 1);

  // URL Context pages come after the search hits so that they do not shift the
  // numbering of the markers.
  const highestChunkNumber = Math.max(...chunkNumbers.values());
  const onlyUrlContext = urlContextEntries
    .map((entry) => entry.retrievedUrl)
    .filter((uri) => !chunks.some((chunk) => chunk.web?.uri === uri));
  for (const uri of onlyUrlContext) {
    assert.ok(listed.indexOf(uri) + 1 > highestChunkNumber, `${uri} shifts the markers`);
  }
});

test("merges identical URIs into a single entry", () => {
  // Deduplicating by identical URI is allowed, because no destination is lost
  // in the process. Deduplicating by domain would break I1.
  const duplicated = expectedUris.find(
    (uri) => chunks.filter((chunk) => chunk.web?.uri === uri).length > 1,
  );
  assert.ok(duplicated, "the fixture needs a URI delivered twice");

  const { sources, chunkNumbers } = buildSourceList(candidate);

  assert.equal(sources.filter((source) => source.uri === duplicated).length, 1);

  const indices = chunks.flatMap((chunk, index) =>
    chunk.web?.uri === duplicated ? [index] : [],
  );
  const numbers = new Set(indices.map((index) => chunkNumbers.get(index)));
  assert.equal(numbers.size, 1, "both indices must point at the same number");
  assert.ok(!numbers.has(undefined), "no index may be left without a number");
});
