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

test("drops a marker when the slice does not match segment.text", () => {
  const text = "Eine Aussage. Noch eine.";
  const result = insertCitations({
    text,
    supports: [support(0, 13, "Etwas ganz anderes.", [0])],
    chunkNumbers: new Map([[0, 1]]),
  });

  assert.equal(result.text, text, "text stays unchanged");
  assert.equal(result.dropped, 1);
});

test("drops a marker whose position falls inside a code span", () => {
  const text = "Nutze `copy.replace(obj, x=1)` dafuer.";
  const end = Buffer.byteLength("Nutze `copy.replace(obj", "utf8");

  const result = insertCitations({
    text,
    supports: [support(0, end, "Nutze `copy.replace(obj", [0])],
    chunkNumbers: new Map([[0, 1]]),
  });

  assert.equal(result.text, text, "code stays untouched");
  assert.equal(result.dropped, 1);
});

test("drops a marker inside a fenced block", () => {
  // The single backtick in the block must not tip the detection: the fence is
  // matched first and swallows everything inside it.
  const text = "Beispiel:\n```python\nx = ` + 1\n```\nFertig.";
  const end = Buffer.byteLength("Beispiel:\n```python\nx =", "utf8");

  const result = insertCitations({
    text,
    supports: [support(0, end, "Beispiel:\n```python\nx =", [0])],
    chunkNumbers: new Map([[0, 1]]),
  });

  assert.equal(result.text, text);
  assert.equal(result.dropped, 1);
});

test("places a marker directly after a code span", () => {
  // The most frequent position, measured: the segment ends at the closing
  // backtick. That position is harmless and must not be dropped along.
  const text = "Nutze `pathlib` dafuer. Sonst nichts.";
  const end = Buffer.byteLength("Nutze `pathlib` dafuer.", "utf8");

  const result = insertCitations({
    text,
    supports: [support(0, end, "Nutze `pathlib` dafuer.", [0])],
    chunkNumbers: new Map([[0, 1]]),
  });

  assert.equal(result.text, "Nutze `pathlib` dafuer.[1] Sonst nichts.");
  assert.equal(result.dropped, 0);
});

test("maps chunk indices onto the numbers of the deduplicated list", () => {
  // groundingChunks [A, B, A, C] yields the list [1] A, [2] B, [3] C. A support
  // on chunk 3 (C) must write [3], not [4].
  const result = insertCitations({
    text: "Eine Aussage.",
    supports: [support(0, 13, "Eine Aussage.", [3])],
    chunkNumbers: new Map([
      [0, 1],
      [1, 2],
      [2, 1],
      [3, 3],
    ]),
  });

  assert.equal(result.text, "Eine Aussage.[3]");
});

test("joins several sources as [1][3] and deduplicates while doing so", () => {
  // Chunks 0 and 2 point at the same source - it may appear only once.
  const result = insertCitations({
    text: "Eine Aussage.",
    supports: [support(0, 13, "Eine Aussage.", [0, 2, 1])],
    chunkNumbers: new Map([
      [0, 1],
      [1, 3],
      [2, 1],
    ]),
  });

  assert.equal(result.text, "Eine Aussage.[1][3]");
});

test("merges two supports at the same position into one marker", () => {
  // The API may back the same sentence more than once, and two supports then
  // end at the same byte position. Deduplication runs per position rather than
  // per support; otherwise this would read [1][1][2].
  const result = insertCitations({
    text: "Eine Aussage.",
    supports: [support(0, 13, "Eine Aussage.", [0]), support(0, 13, "Eine Aussage.", [1, 0])],
    chunkNumbers: new Map([
      [0, 1],
      [1, 2],
    ]),
  });

  assert.equal(result.text, "Eine Aussage.[1][2]");
  assert.equal(result.dropped, 0);
});

test("produces no marker for a chunk without a number", () => {
  // A chunk without a uri never reaches the source list. It must produce no
  // marker and does not count as dropped either - there was nothing.
  const result = insertCitations({
    text: "Eine Aussage.",
    supports: [support(0, 13, "Eine Aussage.", [7])],
    chunkNumbers: new Map([[0, 1]]),
  });

  assert.deepEqual(result, { text: "Eine Aussage.", dropped: 0 });
});

test("places several markers without shifting the following positions", () => {
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
  const text = "Eine Antwort ohne groundingMetadata.";
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
