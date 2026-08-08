// Die Wiederholungen bei voruebergehenden API-Fehlern. Geprueft wird am
// Verhalten und nicht an der Konstante: Ob die Liste einen bestimmten Code
// enthaelt, sagt fuer sich genommen nichts - entscheidend ist, dass sie den
// Client ueberhaupt erreicht. Ohne die httpOptions in getClient() waere die
// Konfiguration wirkungslos und jede Behauptung ueber sie trotzdem wahr.
//
// Dafuer wird das globale fetch ersetzt. Das SDK ruft es in apiCall() direkt
// auf, sodass die Zahl der Aufrufe die Zahl der Versuche IST. Kein Testfall
// erreicht dabei die API - der Schluessel ist ein Platzhalter, und der Ersatz
// faengt jede Anfrage ab, bevor sie das Netz sieht.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { RETRY_OPTIONS, SERVER_DEADLINE_SECONDS, runSearch } from "../gemini.js";

process.env.GEMINI_API_KEY = "test-key-never-sent";

const SEARCH = { query: "irrelevant", model: "gemini-test", thinkingLevel: "low" };

/** Eine Fehlerantwort im Format, das die Gemini-API liefert. */
const errorResponse = (code, status) =>
  new Response(JSON.stringify({ error: { code, message: "test", status } }), {
    status: code,
    headers: { "content-type": "application/json" },
  });

/** Die kleinstmoegliche erfolgreiche Antwort, die runSearch durchlaeuft. */
const okResponse = () =>
  new Response(
    JSON.stringify({
      candidates: [{ content: { parts: [{ text: "answer" }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

const realFetch = globalThis.fetch;
let calls;

/**
 * Ersetzt fetch durch eine Folge vorbereiteter Antworten. Jeder Aufruf nimmt
 * die naechste; ist die Folge erschoepft, wiederholt sich die letzte - so
 * braucht ein Fall, der auf dauerhaftes Scheitern zielt, nicht zu wissen, wie
 * oft es dazu kommt.
 */
function mockFetch(...responses) {
  calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    const next = responses[Math.min(calls.length - 1, responses.length - 1)];
    return next();
  };
}

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

test("wiederholt einen 503 und liefert die Antwort des zweiten Versuchs", async () => {
  // Der eigentliche Test dieser Datei, und der einzige, der die Verdrahtung
  // erfasst: Ohne httpOptions.retryOptions am Client wiederholt das SDK NICHTS
  // (apiCall() beginnt mit "if (!retryOptions) return fetch(...)"), der zweite
  // Aufruf faende nie statt und der 503 schlueg bis zum Nutzer durch. Genau der
  // Zustand vor der Einfuehrung der Konstante.
  //
  // 503 ist der einzige Fehler, der hier je beobachtet wurde: dreimal in Folge
  // innerhalb einer Minute, jeweils "high demand ... usually temporary".
  //
  // Der Fall wartet echte ein bis zwei Sekunden - den ersten Backoff des SDK
  // (initialDelay 1s, Jitter zwischen Faktor 1 und 2). Das ist der Preis dafuer,
  // das Verhalten zu pruefen statt eines Objektliterals.
  mockFetch(() => errorResponse(503, "UNAVAILABLE"), okResponse);

  const result = await runSearch(SEARCH);

  assert.equal(calls.length, 2, "der 503 haette wiederholt werden muessen");
  assert.match(result, /^answer/);
});

test("wiederholt einen 429 nicht, sondern meldet ihn sofort", async () => {
  // Googles Default waere [408, 429, 500, 502, 503, 504] - wer die Liste daran
  // angleicht, macht die Konfiguration schlechter, ohne dass es auffiele: Bei
  // 429 nennt die API die Wartezeit selbst (RetryInfo.retryDelay), das SDK liest
  // sie nicht aus und haette seine vier Versuche verbraucht, bevor die Sperre
  // ablaeuft. Ausfuehrlich in gemini.js ueber RETRY_OPTIONS.
  mockFetch(() => errorResponse(429, "RESOURCE_EXHAUSTED"));

  await assert.rejects(() => runSearch(SEARCH));

  assert.equal(calls.length, 1, "429 darf nicht wiederholt werden");
});

test("wiederholt einen 504 nicht, weil das die eigene Frist ist", async () => {
  // Der zweite Code, der aus Googles Standardliste fehlt. Seit dieser Server
  // eine Frist mitschickt, ist ein 504 im Regelfall genau diese Frist - und
  // dann bedeutet jede Wiederholung eine weitere volle Generierung, die
  // abgerechnet wird, ohne je anzukommen. Begruendung in gemini.js ueber
  // RETRY_OPTIONS.
  mockFetch(() => errorResponse(504, "DEADLINE_EXCEEDED"));

  await assert.rejects(() => runSearch(SEARCH));

  assert.equal(calls.length, 1, "504 darf nicht wiederholt werden");
});

test("schickt die Frist mit, ohne die Standard-Header zu verlieren", async () => {
  // Zwei Dinge in einem Fall, weil sie zusammengehoeren: Die Frist muss
  // ankommen, und sie darf die Header des SDK nicht ersetzen. httpOptions
  // werden per Object.assign gemischt - stimmte das nicht, fehlten hier
  // Content-Type und User-Agent, und die Anfrage schluege beim Server fehl,
  // ohne dass ein Test es merkte.
  mockFetch(okResponse);

  await runSearch(SEARCH);

  const headers = new Headers(calls[0].init.headers);
  assert.equal(headers.get("x-server-timeout"), String(SERVER_DEADLINE_SECONDS));
  assert.equal(headers.get("content-type"), "application/json");
  assert.ok(headers.get("user-agent"), "der User-Agent des SDK muss erhalten bleiben");
});

test("wiederholt nicht, was sich von allein nicht behebt", async () => {
  // 400 (kaputte Anfrage), 403 (Schluessel) und 404 (Modell zurueckgezogen)
  // gehen beim zweiten Mal genauso schief. Googles eigene Empfehlung dazu:
  // "Do not retry on client errors (like 400 or 403)."
  for (const [code, status] of [
    [400, "INVALID_ARGUMENT"],
    [403, "PERMISSION_DENIED"],
    [404, "NOT_FOUND"],
  ]) {
    mockFetch(() => errorResponse(code, status));

    await assert.rejects(() => runSearch(SEARCH));

    assert.equal(calls.length, 1, `${code} darf nicht wiederholt werden`);
  }
});

test("begrenzt die Zahl der Versuche", async () => {
  // Der einzige Wert, der hier an der Konstante geprueft wird statt am
  // Verhalten: Vier Versuche abzuwarten dauert mit den SDK-Backoffs 7 bis 14
  // Sekunden, und diese Zeit ist eine Zusicherung ueber Googles Timer, nicht
  // ueber diesen Server.
  //
  // Die Obergrenze ist keine Feinheit, sondern die Wartezeit, die der Client
  // ohne jedes Signal aussitzt: attempts zaehlt den Erstversuch mit, der
  // SDK-Default waere 5.
  assert.equal(RETRY_OPTIONS.attempts, 4);
});
