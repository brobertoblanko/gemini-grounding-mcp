import { test } from "node:test";
import assert from "node:assert/strict";
import { formatSearchQueries } from "../gemini.js";

// gemini.js can be imported without an API key: getClient() is called inside the
// functions, not while the module loads.

/** Builds a search query of exactly the requested character length. */
const query = (length, filler = "x") => filler.repeat(length);

test("produces no line when nothing was searched", () => {
  assert.equal(formatSearchQueries([]), "");
  // When the field is missing entirely, the default takes effect.
  assert.equal(formatSearchQueries(), "");
});

test("writes out a single query in full", () => {
  assert.equal(
    formatSearchQueries(["Node js releases LTS current version"]),
    "\n🔎 Searched: Node js releases LTS current version",
  );
});

test("joins several queries with the middle dot", () => {
  const result = formatSearchQueries(["erste Anfrage", "zweite Anfrage"]);
  assert.equal(result, "\n🔎 Searched: erste Anfrage · zweite Anfrage");
});

test("lets a broad but ordinary request pass in full", () => {
  // Wording from a real call: six search queries with 260 characters of text.
  // That is the upper edge of the normal case and the reason for the budget of
  // 300 - it must stay uncut, otherwise the budget is chosen too small. The real
  // extreme lies higher: 11 queries measured on a deliberately overbroad
  // question, which is what the capping is there for.
  const measured = [
    '"Bun" production ready 2025 2026 status',
    "Node js permission model status stable",
    "Rust async runtimes status 2025 2026 async fn in traits Tokio",
    "Python free threading status 3 13 3 14 GIL PEP 703",
    "WASI Preview 3 WebAssembly status 2025 2026",
    "Deno 2 compatibility Node npm",
  ];

  const result = formatSearchQueries(measured);

  assert.ok(!result.includes("more"), "nothing may be capped");
  for (const entry of measured) {
    assert.ok(result.includes(entry), `"${entry}" is missing from the line`);
  }
});

test("caps above the budget and counts the remainder", () => {
  // 10 queries of 50 characters each. Cumulative with the separators: 50, 103,
  // 156, 209, 262, 315 - the sixth breaks the budget.
  const many = Array.from({ length: 10 }, (_, i) => query(49, String(i)) + String(i));

  const result = formatSearchQueries(many);

  assert.ok(result.endsWith("(+4 more)"), `unexpected ending: ${result}`);
  assert.equal(result.split(" · ").length, 6, "six queries should be visible");
});

test("still writes out the query that crosses the limit in full", () => {
  // The second query breaks the budget by a wide margin. It must not end
  // mid-word all the same, because half a search query is worthless.
  const long = query(280, "b");
  const result = formatSearchQueries([query(100, "a"), long, query(30, "c")]);

  assert.ok(result.includes(long), "the last visible query is truncated");
  assert.ok(result.endsWith("(+1 more)"));
});

test("reports no remainder when the budget works out exactly", () => {
  // 98 + 3 + 98 + 3 + 98 = 300: the third query hits the budget exactly, and
  // after it the list ends. "(+0 more)" would be wrong here.
  const result = formatSearchQueries([query(98, "a"), query(98, "b"), query(98, "c")]);

  assert.ok(!result.includes("more"), `unexpected remainder note: ${result.slice(-20)}`);
  assert.equal(result.split(" · ").length, 3);
});
