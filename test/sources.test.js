import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildSourceList, formatSourcesBlock, formatFooter } from "../gemini.js";

// Diese Datei haelt die Invarianten fest, unter denen dieser Server Googles
// Bedingungen fuer "Grounding with Google Search" einhaelt (siehe CLAUDE.md und
// docs/specs.md, "Terms compliance"). Sie pruefen kein Verhalten, das jemand
// verbessern koennte, sondern eines, das niemand aendern darf: Jede einzelne
// dieser Eigenschaften sieht im Code wie ein Optimierungskandidat aus.
//
// I3 (kein Redirect wird aufgeloest) und I4 (nichts wird zwischengespeichert)
// sind Abwesenheitsaussagen und stehen deshalb nur als Regel in CLAUDE.md.
//
// gemini.js laesst sich ohne API-Key importieren: getClient() wird erst in den
// Funktionen aufgerufen, nicht beim Laden des Moduls.

const candidate = JSON.parse(
  readFileSync(new URL("./fixtures/grounding-chunks.json", import.meta.url), "utf-8"),
);

const chunks = candidate.groundingMetadata.groundingChunks;
const supports = candidate.groundingMetadata.groundingSupports;
const urlContextEntries = candidate.urlContextMetadata.urlMetadata;

/** Die Chunk-Indizes, auf die ueberhaupt ein Belegmarker zeigen wuerde. */
const referencedIndices = new Set(supports.flatMap((s) => s.groundingChunkIndices));

/**
 * Die URIs, die in der Liste erscheinen muessen - jede genau einmal, in dieser
 * Reihenfolge: erst die Suchtreffer, dann die per URL Context gelesenen Seiten.
 * Beide Herkuenfte sind Links im Sinne der Terms, I1 gilt fuer beide.
 */
const expectedUris = [
  ...new Set([
    ...chunks.map((chunk) => chunk.web?.uri).filter(Boolean),
    ...urlContextEntries.map((entry) => entry.retrievedUrl).filter(Boolean),
  ]),
];

test("nimmt jede Quelle auf, auch die unbelegten (I1)", () => {
  // Vorbedingung an die Fixture: Ohne unbelegte Chunks pruefte dieser Test die
  // interessante Haelfte von I1 nicht - dass auch die Links erscheinen, auf die
  // kein Marker zeigt. Genau die sind der naheliegende Kuerzungskandidat.
  const unreferenced = chunks.filter(
    (chunk, index) => chunk.web?.uri && !referencedIndices.has(index),
  );
  assert.ok(unreferenced.length > 0, "die Fixture braucht Chunks ohne Support");

  const { sources } = buildSourceList(candidate);

  assert.equal(sources.length, expectedUris.length);
  for (const chunk of unreferenced) {
    assert.ok(
      sources.some((source) => source.uri === chunk.web.uri),
      `unbelegte Quelle fehlt in der Liste: ${chunk.web.title}`,
    );
  }
});

test("gibt Titel und URI byteidentisch aus (I2)", () => {
  const { sources } = buildSourceList(candidate);
  const block = formatSourcesBlock(sources);

  // Verglichen wird die ganze Zeile, nicht per includes: Eine am Ende gekuerzte
  // URI - der naheliegendste Eingriff ueberhaupt - kaeme durch ein includes auf
  // den Anfang der URI ungehindert durch.
  const lines = block.split("\n").slice(3);
  assert.equal(lines.length, sources.length);

  lines.forEach((line, index) => {
    const source = sources[index];
    assert.equal(line, `[${index + 1}] ${source.title} - ${source.uri}`);
  });

  // Und dieselbe Pruefung gegen die Fixture statt gegen das Zwischenergebnis:
  // Sonst blieben Kuerzungen unbemerkt, die schon in buildSourceList passieren.
  expectedUris.forEach((uri, index) => {
    assert.equal(lines[index], `[${index + 1}] ${titleOf(uri)} - ${uri}`);
  });
});

/**
 * Der Titel, den die API zu dieser URI mitgeliefert hat. Zu URL-Context-Seiten
 * liefert sie keinen, dort ist die URL zugleich die Beschriftung.
 */
function titleOf(uri) {
  return chunks.find((chunk) => chunk.web?.uri === uri)?.web.title ?? uri;
}

test("meldet uebersprungene Chunks im Footer, statt sie zu verschweigen", () => {
  const withoutUri = chunks.filter((chunk) => !chunk.web?.uri);
  assert.ok(withoutUri.length > 0, "die Fixture braucht Chunks ohne web.uri");

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

  // Der Normalfall darf den Footer nicht verlaengern - gleiche Regel wie bei
  // den verworfenen Markern und der Zeile mit den Suchanfragen.
  const clean = formatFooter({
    usageMetadata: {},
    model: "gemini-flash-latest",
    thinkingLevel: "medium",
    sourceCount: expectedUris.length,
    dropped: 0,
    skipped: 0,
    searchQueries: [],
  });
  assert.ok(!clean.includes("omitted"), `unerwarteter Hinweis: ${clean}`);
});

test("nimmt auch die per URL Context gelesenen Seiten auf (I1)", () => {
  // Der zweite Zweig von buildSourceList. Er faellt nicht auf, weil zu diesen
  // Eintraegen keine Supports gehoeren und damit auch kein Marker ins Leere
  // zeigt, wenn sie fehlen - sie verschwaenden lautlos.
  const { sources, chunkNumbers } = buildSourceList(candidate);
  const listed = sources.map((source) => source.uri);

  for (const entry of urlContextEntries) {
    assert.ok(listed.includes(entry.retrievedUrl), `gelesene Seite fehlt: ${entry.retrievedUrl}`);
  }

  // Der gemessene Fall: Die gelesene Seite kam zusaetzlich als groundingChunk
  // an, mit direkter URL statt Weiterleitung. Sie darf dadurch nicht doppelt
  // in der Liste stehen.
  const alsoAChunk = urlContextEntries.find((entry) =>
    chunks.some((chunk) => chunk.web?.uri === entry.retrievedUrl),
  );
  assert.ok(alsoAChunk, "die Fixture braucht eine Seite, die zugleich Chunk ist");
  assert.equal(listed.filter((uri) => uri === alsoAChunk.retrievedUrl).length, 1);

  // URL-Context-Seiten stehen hinter den Suchtreffern, damit sie die
  // Nummerierung der Marker nicht verschieben.
  const highestChunkNumber = Math.max(...chunkNumbers.values());
  const onlyUrlContext = urlContextEntries
    .map((entry) => entry.retrievedUrl)
    .filter((uri) => !chunks.some((chunk) => chunk.web?.uri === uri));
  for (const uri of onlyUrlContext) {
    assert.ok(listed.indexOf(uri) + 1 > highestChunkNumber, `${uri} verschiebt die Marker`);
  }
});

test("fasst identische URIs zu einem Eintrag zusammen", () => {
  // Nach identischer URI zu deduplizieren ist erlaubt, weil dabei kein Ziel
  // verlorengeht. Nach Domain zu deduplizieren waere ein Verstoss gegen I1.
  const duplicated = expectedUris.find(
    (uri) => chunks.filter((chunk) => chunk.web?.uri === uri).length > 1,
  );
  assert.ok(duplicated, "die Fixture braucht eine doppelt gelieferte URI");

  const { sources, chunkNumbers } = buildSourceList(candidate);

  assert.equal(sources.filter((source) => source.uri === duplicated).length, 1);

  const indices = chunks.flatMap((chunk, index) =>
    chunk.web?.uri === duplicated ? [index] : [],
  );
  const numbers = new Set(indices.map((index) => chunkNumbers.get(index)));
  assert.equal(numbers.size, 1, "beide Indizes muessen auf dieselbe Nummer zeigen");
  assert.ok(!numbers.has(undefined), "kein Index darf ohne Nummer bleiben");
});
