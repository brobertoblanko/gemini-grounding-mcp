import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { insertCitations } from "../citations.js";

/** Kurzform fuer die immer gleiche Support-Struktur. */
const support = (start, end, text, chunks) => ({
  segment: { startIndex: start, endIndex: end, text },
  groundingChunkIndices: chunks,
});

test("setzt den Marker an der Byte- und nicht an der Zeichenposition", () => {
  const text = "Änderungen kamen früh. Der Rest blieb.";
  // 22 Zeichen, aber 24 Bytes - Ä und ü brauchen je zwei. Zeichenbasiert
  // landete der Marker zwei Stellen zu weit rechts, also hinter "D".
  const end = Buffer.byteLength("Änderungen kamen früh.", "utf8");

  const result = insertCitations({
    text,
    supports: [support(0, end, "Änderungen kamen früh.", [0])],
    chunkNumbers: new Map([[0, 1]]),
  });

  assert.equal(result.text, "Änderungen kamen früh.[1] Der Rest blieb.");
  assert.equal(result.dropped, 0);
});

test("verwirft einen Marker, wenn der Ausschnitt nicht zu segment.text passt", () => {
  const text = "Eine Aussage. Noch eine.";
  const result = insertCitations({
    text,
    supports: [support(0, 13, "Etwas ganz anderes.", [0])],
    chunkNumbers: new Map([[0, 1]]),
  });

  assert.equal(result.text, text, "Text bleibt unveraendert");
  assert.equal(result.dropped, 1);
});

test("verwirft einen Marker, dessen Position in einem Codeabschnitt liegt", () => {
  const text = "Nutze `copy.replace(obj, x=1)` dafuer.";
  const end = Buffer.byteLength("Nutze `copy.replace(obj", "utf8");

  const result = insertCitations({
    text,
    supports: [support(0, end, "Nutze `copy.replace(obj", [0])],
    chunkNumbers: new Map([[0, 1]]),
  });

  assert.equal(result.text, text, "Code bleibt unangetastet");
  assert.equal(result.dropped, 1);
});

test("verwirft einen Marker innerhalb eines umzaeunten Blocks", () => {
  // Der einzelne Backtick im Block darf die Erkennung nicht kippen: Der Zaun
  // wird zuerst gesucht und schluckt alles, was in ihm steht.
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

test("setzt einen Marker direkt hinter einem Codeabschnitt", () => {
  // Gemessen die haeufigste Lage: Das Segment endet am schliessenden Backtick.
  // Diese Position ist unkritisch und darf nicht mit verworfen werden.
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

test("uebersetzt Chunk-Indizes auf die Nummern der deduplizierten Liste", () => {
  // groundingChunks [A, B, A, C] ergibt die Liste [1] A, [2] B, [3] C.
  // Ein Support auf Chunk 3 (C) muss [3] schreiben, nicht [4].
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

test("fasst mehrere Quellen als [1][3] zusammen und dedupliziert dabei", () => {
  // Chunks 0 und 2 zeigen auf dieselbe Quelle - sie darf nur einmal erscheinen.
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

test("fasst zwei Supports auf derselben Position zu einem Marker zusammen", () => {
  // Die API darf denselben Satz mehrfach stuetzen - zwei Supports enden dann
  // auf derselben Byte-Position. Dedupliziert wird pro Position und nicht pro
  // Support, sonst stuende hier [1][1][2].
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

test("erzeugt keinen Marker fuer einen Chunk ohne Nummer", () => {
  // Ein Chunk ohne uri schafft es nicht in die Quellenliste. Er darf keinen
  // Marker erzeugen und zaehlt auch nicht als verworfen - es gab nichts.
  const result = insertCitations({
    text: "Eine Aussage.",
    supports: [support(0, 13, "Eine Aussage.", [7])],
    chunkNumbers: new Map([[0, 1]]),
  });

  assert.deepEqual(result, { text: "Eine Aussage.", dropped: 0 });
});

test("setzt mehrere Marker, ohne die folgenden Positionen zu verschieben", () => {
  const text = "Ein Satz über X. Ein Satz über Y.";
  const first = Buffer.byteLength("Ein Satz über X.", "utf8");
  const second = Buffer.byteLength(text, "utf8");

  const result = insertCitations({
    text,
    // Bewusst aufsteigend uebergeben: Das Sortieren ist Sache der Funktion.
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

test("laesst den Text unveraendert, wenn keine Supports vorliegen", () => {
  const text = "Eine Antwort ohne groundingMetadata.";
  assert.deepEqual(insertCitations({ text, supports: [], chunkNumbers: new Map() }), {
    text,
    dropped: 0,
  });
});

test("verarbeitet eine echte API-Antwort ohne Verluste", () => {
  const fixture = JSON.parse(
    readFileSync(new URL("./fixtures/grounded-response.json", import.meta.url), "utf-8"),
  );

  const result = insertCitations({
    text: fixture.text,
    supports: fixture.supports,
    chunkNumbers: new Map(fixture.chunkNumbers),
  });

  assert.equal(result.dropped, 0, "kein Support darf an der Verifikation scheitern");
  assert.match(result.text, /\[\d+\]/, "mindestens ein Marker wurde gesetzt");
  // Keine Marker-Nummer darf ueber die Laenge der Quellenliste hinausgehen -
  // genau das waere der Fehler, den ein naives index + 1 erzeugt.
  for (const match of result.text.matchAll(/\[(\d+)\]/g)) {
    assert.ok(Number(match[1]) <= fixture.sourceCount, `Marker [${match[1]}] zeigt ins Leere`);
  }
});
