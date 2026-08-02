import { test } from "node:test";
import assert from "node:assert/strict";
import { formatSearchQueries } from "../gemini.js";

// gemini.js laesst sich ohne API-Key importieren: getClient() wird erst in den
// Funktionen aufgerufen, nicht beim Laden des Moduls.

/** Erzeugt eine Suchanfrage genau der gewuenschten Zeichenlaenge. */
const query = (length, filler = "x") => filler.repeat(length);

test("erzeugt keine Zeile, wenn nicht gesucht wurde", () => {
  assert.equal(formatSearchQueries([]), "");
  // Fehlt das Feld ganz, kommt der Default zum Tragen.
  assert.equal(formatSearchQueries(), "");
});

test("schreibt eine einzelne Anfrage vollstaendig aus", () => {
  assert.equal(
    formatSearchQueries(["Node js releases LTS current version"]),
    "\n🔎 Searched: Node js releases LTS current version",
  );
});

test("verbindet mehrere Anfragen mit dem Mittelpunkt", () => {
  const result = formatSearchQueries(["erste Anfrage", "zweite Anfrage"]);
  assert.equal(result, "\n🔎 Searched: erste Anfrage · zweite Anfrage");
});

test("laesst eine breite, aber uebliche Anfrage vollstaendig durch", () => {
  // Wortlaut aus einem echten Aufruf: sechs Suchanfragen mit 260 Zeichen Text.
  // Das ist die obere Kante des Normalfalls und die Begruendung fuer das Budget
  // von 300 - sie muss ungekuerzt bleiben, sonst ist es zu klein gewaehlt.
  // (Der echte Extremfall liegt hoeher: gemessen 11 Anfragen bei einer bewusst
  // ueberbreiten Frage. Genau den soll die Kappung abfangen.)
  const measured = [
    '"Bun" production ready 2025 2026 status',
    "Node js permission model status stable",
    "Rust async runtimes status 2025 2026 async fn in traits Tokio",
    "Python free threading status 3 13 3 14 GIL PEP 703",
    "WASI Preview 3 WebAssembly status 2025 2026",
    "Deno 2 compatibility Node npm",
  ];

  const result = formatSearchQueries(measured);

  assert.ok(!result.includes("more"), "nichts darf gekappt werden");
  for (const entry of measured) {
    assert.ok(result.includes(entry), `"${entry}" fehlt in der Zeile`);
  }
});

test("kappt oberhalb des Budgets und zaehlt den Rest", () => {
  // 10 Anfragen a 50 Zeichen. Kumuliert mit den Trennern: 50, 103, 156, 209,
  // 262, 315 - die sechste reisst das Budget.
  const many = Array.from({ length: 10 }, (_, i) => query(49, String(i)) + String(i));

  const result = formatSearchQueries(many);

  assert.ok(result.endsWith("(+4 more)"), `unerwartetes Ende: ${result}`);
  assert.equal(result.split(" · ").length, 6, "sechs Anfragen sollten sichtbar sein");
});

test("schreibt die grenzueberschreitende Anfrage noch vollstaendig aus", () => {
  // Die zweite Anfrage reisst das Budget deutlich. Sie darf trotzdem nicht
  // mitten im Wort enden - eine halbe Suchanfrage ist wertlos.
  const long = query(280, "b");
  const result = formatSearchQueries([query(100, "a"), long, query(30, "c")]);

  assert.ok(result.includes(long), "die letzte sichtbare Anfrage ist abgeschnitten");
  assert.ok(result.endsWith("(+1 more)"));
});

test("meldet keinen Rest, wenn das Budget exakt aufgeht", () => {
  // 98 + 3 + 98 + 3 + 98 = 300: Die dritte Anfrage erreicht das Budget genau,
  // danach ist die Liste zu Ende. "(+0 more)" waere hier falsch.
  const result = formatSearchQueries([query(98, "a"), query(98, "b"), query(98, "c")]);

  assert.ok(!result.includes("more"), `unerwarteter Rest-Hinweis: ${result.slice(-20)}`);
  assert.equal(result.split(" · ").length, 3);
});
