// Citation markers ([1], [2]) for the answer text, built from the API's
// groundingSupports. What should become visible is less WHICH source backs a
// sentence than WHETHER it is backed at all - measured on a real response, 27 %
// of the text was covered by no support, and nothing about it showed.
//
// No access to the API or the configuration: text and metadata in, text out,
// hence checkable without network or API key (test/citations.test.js).
//
// On a strict reading the terms raise a question here: they forbid
// interspersing "any other content" with the Grounded Results, and that is what
// the markers do. The exemption is the same source this comment cites for the
// byte offsets anyway - Google's own reference implementation in the Gemini CLI
// places the markers the same way. If Google demonstrates the practice itself,
// the clause means foreign content such as advertising. The markers also point
// at the supplied links rather than away from them.
//
// All arithmetic is in BYTES, never characters: startIndex and endIndex are
// documented as "measured in bytes". On a German test response not one of 28
// positions matched character-based and all 28 matched byte-based; by the end,
// text and bytes had drifted 44 places apart. Google made the same mistake in
// the Gemini CLI (PR google-gemini/gemini-cli#5956, noticed on Japanese text).
// Full derivation: docs/specs.md, "Implementation (`citations.js`)".

/**
 * The ranges no marker may be placed in: Markdown code in running text. A
 * marker inside a code example turns `copy.replace(obj, x=1)` into
 * `copy.replace(obj[3], x=1)` - syntactically valid, factually wrong. Code gets
 * written against the answers of this server, so that outweighs a missing
 * marker.
 *
 * Only code the model writes into its own prose. The code execution blocks are
 * separate parts, appended by buildText() after insertion, and cannot appear
 * here.
 *
 * One pass, left to right: the fenced blocks come first in the alternation, so
 * a fence swallows everything inside it, including single backticks that would
 * otherwise read as inline code. No second scan with an overlap check needed.
 *
 * Counting the backticks before the target position and discarding on an odd
 * count was rejected: one unpaired backtick tips that count for the whole
 * remaining text, a block closed with four backticks does the same, and inside
 * a backtick sequence it oscillates meaninglessly.
 *
 * Indented code blocks (four spaces) are not detected - the only known gap,
 * retrofittable as a third rule should it show up in real answers.
 *
 * Returns BYTE ranges, matching the API's offsets.
 */
function findCodeRanges(text) {
  const toByte = (charIndex) => Buffer.byteLength(text.slice(0, charIndex), "utf8");

  return [...text.matchAll(/```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]+`/g)].map((match) => [
    toByte(match.index),
    toByte(match.index + match[0].length),
  ]);
}

/**
 * Places citation markers in the text of ONE part.
 *
 * - text:         the raw text of exactly one text part
 * - supports:     the groundingSupports belonging to THAT part
 * - chunkNumbers: map from the index in groundingChunks to the number in the
 *                 emitted source list (see buildSourceList)
 *
 * Returns the marked text and the number of markers dropped. Dropping is
 * deliberately generous: a missing marker makes a backed statement look
 * unbacked and merely triggers extra caution, while a misplaced one points at a
 * source that does not support the statement, or destroys code. When in doubt,
 * always against the marker.
 */
export function insertCitations({ text, supports, chunkNumbers }) {
  if (!text || supports.length === 0) return { text, dropped: 0 };

  const bytes = Buffer.from(text, "utf8");
  const codeRanges = findCodeRanges(text);
  // Collected per byte position, not per support: two supports may end at the
  // same position, the API then backing the same clause more than once. One
  // entry per support would place two markers side by side, and [1][1] where
  // the sources overlap.
  const numbersByIndex = new Map();
  let dropped = 0;

  for (const support of supports) {
    const segment = support.segment ?? {};
    const end = segment.endIndex;
    if (typeof end !== "number") continue;

    // Protobuf omits default values: startIndex is absent from the JSON when it
    // is 0. Without ?? 0 the check below would be NaN and always fail.
    const start = segment.startIndex ?? 0;

    // The only safeguard against a silent change of the offset semantics: the
    // API ships the expected excerpt in segment.text. If it does not match the
    // computed position, the marker is dropped rather than guessed. A marker can
    // therefore never land in the wrong place - it can only be missing.
    if (segment.text !== undefined && bytes.subarray(start, end).toString("utf8") !== segment.text) {
      dropped++;
      continue;
    }

    if (codeRanges.some(([from, to]) => end > from && end < to)) {
      dropped++;
      continue;
    }

    // groundingChunkIndices points at the API's UNDEDUPLICATED hit list -
    // measured 14 hits for only 4 distinct URLs. A naive index + 1 would write
    // numbers up to [14] into a list of four entries. chunkNumbers translates;
    // hits that did not make the list produce no marker.
    const numbers = (support.groundingChunkIndices ?? [])
      .map((index) => chunkNumbers.get(index))
      .filter((number) => number !== undefined);

    // No dropped++: there was nothing to place here, so nothing was lost.
    if (numbers.length === 0) continue;

    const atIndex = numbersByIndex.get(end) ?? new Set();
    for (const number of numbers) atIndex.add(number);
    numbersByIndex.set(end, atIndex);
  }

  if (numbersByIndex.size === 0) return { text, dropped };

  // One marker per position, the numbers within it ascending, and inserted back
  // to front so that characters already placed do not shift the pending
  // positions.
  const insertions = [...numbersByIndex]
    .map(([index, numbers]) => ({
      index,
      marker: [...numbers]
        .sort((a, b) => a - b)
        .map((n) => `[${n}]`)
        .join(""),
    }))
    .sort((a, b) => b.index - a.index);

  // The byte pieces are collected and joined ONCE instead of building a new
  // buffer per marker (pattern from Google's reference implementation). Buffer
  // rather than TextEncoder/Uint8Array: identical byte semantics but shorter -
  // this server runs on Node only, so the portability Google needs there is not
  // needed here.
  const chunks = [];
  let lastIndex = bytes.length;
  for (const { index, marker } of insertions) {
    // Catches an offset pointing past the end of the text - otherwise the
    // subarray would come out empty and the marker would land in the wrong
    // place.
    const position = Math.min(index, lastIndex);
    chunks.unshift(bytes.subarray(position, lastIndex));
    chunks.unshift(Buffer.from(marker, "utf8"));
    lastIndex = position;
  }
  chunks.unshift(bytes.subarray(0, lastIndex));

  return { text: Buffer.concat(chunks).toString("utf8"), dropped };
}
