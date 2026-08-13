import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { insertCitations } from "../citations.js";

/** Shorthand for the ever-same support structure. */
const support = (start, end, text, chunks) => ({
  segment: { startIndex: start, endIndex: end, text },
  groundingChunkIndices: chunks,
});

test("places the marker at the byte position, not the character position", () => {
  const text = "Änderungen kamen früh. Der Rest blieb.";
  // This text MUST contain multi-byte UTF-8 characters, and is not a leftover
  // from translation. With pure ASCII, byte and character offsets coincide and
  // this test can no longer fail - a character-based implementation would pass
  // it. 22 characters but 24 bytes here, Ä and ü take two each; character-based
  // the marker landed two places too far right, behind "D".
  const end = Buffer.byteLength("Änderungen kamen früh.", "utf8");

  const result = insertCitations({
    text,
    supports: [support(0, end, "Änderungen kamen früh.", [0])],
    chunkNumbers: new Map([[0, 1]]),
  });

  assert.equal(result.text, "Änderungen kamen früh.[1] Der Rest blieb.");
  assert.equal(result.dropped, 0);
});

test("places the marker after a segment containing a 4-byte character", () => {
  // 🔎 is 4 bytes in UTF-8 but two UTF-16 code units, so an implementation
  // counting code units instead of bytes would be off by one here already.
  const text = "Die Suche 🔎 lief. Der Rest folgt.";
  const end = Buffer.byteLength("Die Suche 🔎 lief.", "utf8");

  const result = insertCitations({
    text,
    supports: [support(0, end, "Die Suche 🔎 lief.", [0])],
    chunkNumbers: new Map([[0, 1]]),
  });

  assert.equal(result.text, "Die Suche 🔎 lief.[1] Der Rest folgt.");
  assert.equal(result.dropped, 0);
});

test("places a marker between two 4-byte characters without breaking the surrogate pair", () => {
  const text = "🔎🔬 folgt.";
  const end = Buffer.byteLength("🔎", "utf8");

  const result = insertCitations({
    text,
    supports: [support(0, end, "🔎", [0])],
    chunkNumbers: new Map([[0, 1]]),
  });

  assert.equal(result.text, "🔎[1]🔬 folgt.");
  assert.equal(result.dropped, 0);
  assert.ok(
    !result.text.includes("�"),
    "an off-by-one in surrogate handling would cut mid-pair and produce a replacement character",
  );
});

test("drops a marker whose offset falls inside a surrogate pair", () => {
  // endIndex 3 lands one byte short of the end of 🔎 (4 bytes). The
  // segment.text check must catch this rather than emit invalid UTF-8.
  const text = "🔎🔬 folgt.";

  const result = insertCitations({
    text,
    supports: [support(0, 3, "🔎", [0])],
    chunkNumbers: new Map([[0, 1]]),
  });

  assert.equal(result.text, text);
  assert.equal(result.dropped, 1);
});

test("does not normalise a combining sequence, so later offsets stay valid", () => {
  // "e" + U+0301 (combining acute accent), not the precomposed "é". Any
  // normalisation would collapse the two code points into one and shift
  // every subsequent byte offset silently.
  const text = "Café ist offen. Mehr nicht.";
  const end = Buffer.byteLength("Café ist offen.", "utf8");

  const result = insertCitations({
    text,
    supports: [support(0, end, "Café ist offen.", [0])],
    chunkNumbers: new Map([[0, 1]]),
  });

  assert.equal(result.text, "Café ist offen.[1] Mehr nicht.");
  assert.equal(result.dropped, 0);
  assert.ok(result.text.includes("́"), "combining mark must survive unmerged");
  assert.notEqual(result.text, result.text.normalize("NFC"), "text must stay unnormalised");
});

test("drops a marker when the slice does not match segment.text", () => {
  const text = "A statement. Another one.";
  const result = insertCitations({
    text,
    supports: [support(0, 12, "Something else entirely.", [0])],
    chunkNumbers: new Map([[0, 1]]),
  });

  assert.equal(result.text, text, "text stays unchanged");
  assert.equal(result.dropped, 1);
});

test("drops a marker whose position falls inside a code span", () => {
  const text = "Use `copy.replace(obj, x=1)` for that.";
  const end = Buffer.byteLength("Use `copy.replace(obj", "utf8");

  const result = insertCitations({
    text,
    supports: [support(0, end, "Use `copy.replace(obj", [0])],
    chunkNumbers: new Map([[0, 1]]),
  });

  assert.equal(result.text, text, "code stays untouched");
  assert.equal(result.dropped, 1);
});

test("drops a marker inside a fenced block", () => {
  // The single backtick in the block must not tip the detection: the fence is
  // matched first and swallows everything inside it.
  const text = "Example:\n```python\nx = ` + 1\n```\nDone.";
  const end = Buffer.byteLength("Example:\n```python\nx =", "utf8");

  const result = insertCitations({
    text,
    supports: [support(0, end, "Example:\n```python\nx =", [0])],
    chunkNumbers: new Map([[0, 1]]),
  });

  assert.equal(result.text, text);
  assert.equal(result.dropped, 1);
});

test("places a marker directly after a code span", () => {
  // The most frequent position, measured: the segment ends at the closing
  // backtick. That position is harmless and must not be dropped along.
  const text = "Use `pathlib` for that. Nothing else.";
  const end = Buffer.byteLength("Use `pathlib` for that.", "utf8");

  const result = insertCitations({
    text,
    supports: [support(0, end, "Use `pathlib` for that.", [0])],
    chunkNumbers: new Map([[0, 1]]),
  });

  assert.equal(result.text, "Use `pathlib` for that.[1] Nothing else.");
  assert.equal(result.dropped, 0);
});

test("maps chunk indices onto the numbers of the deduplicated list", () => {
  // groundingChunks [A, B, A, C] yields the list [1] A, [2] B, [3] C. A support
  // on chunk 3 (C) must write [3], not [4].
  const result = insertCitations({
    text: "A statement.",
    supports: [support(0, 12, "A statement.", [3])],
    chunkNumbers: new Map([
      [0, 1],
      [1, 2],
      [2, 1],
      [3, 3],
    ]),
  });

  assert.equal(result.text, "A statement.[3]");
});

test("joins several sources as [1][3] and deduplicates while doing so", () => {
  // Chunks 0 and 2 point at the same source - it may appear only once.
  const result = insertCitations({
    text: "A statement.",
    supports: [support(0, 12, "A statement.", [0, 2, 1])],
    chunkNumbers: new Map([
      [0, 1],
      [1, 3],
      [2, 1],
    ]),
  });

  assert.equal(result.text, "A statement.[1][3]");
});

test("merges two supports at the same position into one marker", () => {
  // The API may back the same sentence more than once, and two supports then
  // end at the same byte position. Deduplication runs per position rather than
  // per support; otherwise this would read [1][1][2].
  const result = insertCitations({
    text: "A statement.",
    supports: [support(0, 12, "A statement.", [0]), support(0, 12, "A statement.", [1, 0])],
    chunkNumbers: new Map([
      [0, 1],
      [1, 2],
    ]),
  });

  assert.equal(result.text, "A statement.[1][2]");
  assert.equal(result.dropped, 0);
});

test("produces no marker for a chunk without a number", () => {
  // A chunk without a uri never reaches the source list. It must produce no
  // marker and does not count as dropped either - there was nothing.
  const result = insertCitations({
    text: "A statement.",
    supports: [support(0, 12, "A statement.", [7])],
    chunkNumbers: new Map([[0, 1]]),
  });

  assert.deepEqual(result, { text: "A statement.", dropped: 0 });
});

test("places several markers without shifting the following positions", () => {
  // Multi-byte characters here for the same reason as in the first test: they
  // are what makes the second marker's position tell a byte-based
  // implementation from a character-based one. Pure ASCII would still catch a
  // missing shift compensation, but no longer the unit the shift is counted in.
  const text = "Ein Satz über X. Ein Satz über Y.";
  const first = Buffer.byteLength("Ein Satz über X.", "utf8");
  const second = Buffer.byteLength(text, "utf8");

  const result = insertCitations({
    text,
    // Passed in ascending order on purpose: sorting is the function's job.
    supports: [
      support(0, first, "Ein Satz über X.", [0]),
      support(first + 1, second, "Ein Satz über Y.", [1]),
    ],
    chunkNumbers: new Map([
      [0, 1],
      [1, 2],
    ]),
  });

  assert.equal(result.text, "Ein Satz über X.[1] Ein Satz über Y.[2]");
  assert.equal(result.dropped, 0);
});

test("leaves the text unchanged when there are no supports", () => {
  const text = "A response without groundingMetadata.";
  assert.deepEqual(insertCitations({ text, supports: [], chunkNumbers: new Map() }), {
    text,
    dropped: 0,
  });
});

test("processes a real API response without losses", () => {
  // The fixture is a recorded response and stays verbatim, non-ASCII text
  // included: its startIndex/endIndex values refer to exactly this text byte by
  // byte, and without multi-byte characters the check below cannot fail.
  const fixture = JSON.parse(
    readFileSync(new URL("./fixtures/grounded-response.json", import.meta.url), "utf-8"),
  );

  const result = insertCitations({
    text: fixture.text,
    supports: fixture.supports,
    chunkNumbers: new Map(fixture.chunkNumbers),
  });

  assert.equal(result.dropped, 0, "no support may fail verification");
  assert.match(result.text, /\[\d+\]/, "at least one marker was placed");
  // No marker number may exceed the length of the source list - that is exactly
  // the error a naive index + 1 produces.
  for (const match of result.text.matchAll(/\[(\d+)\]/g)) {
    assert.ok(Number(match[1]) <= fixture.sourceCount, `marker [${match[1]}] points nowhere`);
  }
});
