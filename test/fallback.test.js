// Das Ausweichen auf ein Backup-Modell. Geprueft wird durchgehend am
// Verhalten: Wie viele Anfragen hat das SDK abgesetzt, an welches Modell ging
// die zweite, und was steht danach im Footer.
//
// Dieselbe Grundlage wie retry.test.js - das globale fetch wird ersetzt, sodass
// die Zahl der Aufrufe die Zahl der Versuche IST. Der Schluessel ist ein
// Platzhalter, keine Anfrage verlaesst den Prozess.
//
// Die meisten Faelle nutzen 404: Er steht nicht in RETRY_OPTIONS, wird also
// nicht wiederholt und kommt sofort zurueck. Ein Fall nutzt 503 - der kostet
// echte Sekunden und ist genau deshalb noetig, siehe dort.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { NO_FALLBACK_STATUS, formatFallbackNote, runSearch } from "../gemini.js";
import { errorResponse, mockFetch, okResponse } from "./helpers.js";

process.env.GEMINI_API_KEY = "test-key-never-sent";

const PRIMARY = "gemini-primary";
const BACKUP = "gemini-backup";

/** Ein Aufruf mit eingerichtetem Backup - der Normalfall dieser Datei. */
const withBackup = (overrides = {}) => ({
  query: "irrelevant",
  model: PRIMARY,
  thinkingLevel: "low",
  backupModel: BACKUP,
  ...overrides,
});

/** Das Modell, an das eine abgefangene Anfrage ging - es steht in der URL. */
const modelOf = (call) => String(call.url).match(/models\/([^:]+):/)?.[1];

/** Das Thinking-Level aus dem Koerper einer abgefangenen Anfrage. */
const thinkingOf = (call) => JSON.parse(call.init.body).generationConfig?.thinkingConfig?.thinkingLevel;

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

test("weicht auf das Backup aus und liefert dessen Antwort", async () => {
  const calls = mockFetch(() => errorResponse(404, "NOT_FOUND"), okResponse);

  const result = await runSearch(withBackup());

  assert.equal(calls.length, 2, "nach dem Fehler haette das Backup drankommen muessen");
  assert.equal(modelOf(calls[0]), PRIMARY);
  assert.equal(modelOf(calls[1]), BACKUP, "der zweite Versuch muss an das Backup gehen");
  assert.match(result, /^answer/);
});

test("nennt den Fallback im Footer, samt Grund", async () => {
  // Ohne diese Zeile saehe die Antwort aus wie jede andere - der Nutzer haette
  // ein anderes Modell bekommt, ohne es zu erfahren. Das 🤖-Feld allein reicht
  // nicht: Es zeigt nur, WAS geantwortet hat, nicht dass etwas schiefging.
  mockFetch(() => errorResponse(404, "NOT_FOUND"), okResponse);

  const result = await runSearch(withBackup());

  assert.match(result, /🔁 gemini-primary does not exist \(404\)/);
  assert.match(result, /Update your default\./);
  assert.match(result, /🤖 gemini-backup/, "der Footer muss das Modell nennen, das geantwortet hat");
});

test("laesst den Footer unveraendert, wenn kein Fallback noetig war", async () => {
  // Der Normalfall darf den Footer nicht verlaengern - gleiche Regel wie bei
  // den verworfenen Markern und der Zeile mit den Suchanfragen.
  mockFetch(okResponse);

  const result = await runSearch(withBackup());

  assert.doesNotMatch(result, /🔁/);
});

test("weicht erst aus, wenn alle Wiederholungen verbraucht sind", async () => {
  // Der Fall, um den es bei diesem Feature eigentlich geht: 503 ist der einzige
  // Fehler, der hier je beobachtet wurde. Er steht in RETRY_OPTIONS, also
  // muessen erst alle vier Versuche scheitern, bevor das Backup drankommt -
  // sonst uebersprungen der Fallback eine Wiederholung, die geholfen haette.
  //
  // Dieser Fall wartet echte 7 bis 14 Sekunden (die drei SDK-Backoffs). Das ist
  // der Preis dafuer, die Reihenfolge am Verhalten zu pruefen statt an einer
  // Konstante; alle anderen Faelle hier nutzen deshalb 404.
  const calls = mockFetch(
    () => errorResponse(503, "UNAVAILABLE"),
    () => errorResponse(503, "UNAVAILABLE"),
    () => errorResponse(503, "UNAVAILABLE"),
    () => errorResponse(503, "UNAVAILABLE"),
    okResponse,
  );

  const result = await runSearch(withBackup());

  assert.equal(calls.length, 5, "vier Versuche am Primaermodell, dann das Backup");
  assert.equal(modelOf(calls[3]), PRIMARY, "der vierte Versuch gehoert noch dem Primaermodell");
  assert.equal(modelOf(calls[4]), BACKUP);
  assert.match(result, /🔁 gemini-primary failed \(503 UNAVAILABLE\)/);
});

test("weicht ohne eingerichtetes Backup nicht aus", async () => {
  // Das Feature ist Opt-in. Ohne backupModel muss sich gegenueber dem Zustand
  // davor nichts aendern - auch nicht die Fehlermeldung.
  const calls = mockFetch(() => errorResponse(404, "NOT_FOUND"));

  await assert.rejects(
    () => runSearch(withBackup({ backupModel: undefined })),
    (error) => {
      assert.doesNotMatch(error.message, /backup/i, "ohne Backup gibt es dazu nichts zu sagen");
      return true;
    },
  );

  assert.equal(calls.length, 1);
});

test("weicht bei 401, 403 und 504 nicht aus und sagt warum", async () => {
  // Die drei Ausnahmen aus NO_FALLBACK_STATUS, aus zwei verschiedenen Gruenden:
  // 401 und 403 haengen am Schluessel, den auch das Backup nutzt - aussichtslos.
  // 504 ist die eigene Frist, also eine abgerechnete Generierung, die ein
  // zweiter Versuch verdoppeln wuerde.
  //
  // Der Grund muss beim Nutzer ankommen, sonst bleibt die Frage "warum hat mein
  // Backup nicht gegriffen?" unbeantwortbar.
  for (const [code, status] of [
    [401, "UNAUTHENTICATED"],
    [403, "PERMISSION_DENIED"],
    [504, "DEADLINE_EXCEEDED"],
  ]) {
    const calls = mockFetch(() => errorResponse(code, status));

    await assert.rejects(
      () => runSearch(withBackup()),
      (error) => {
        assert.match(error.message, /backup not tried/, `${code} muss den Grund nennen`);
        return true;
      },
    );

    assert.equal(calls.length, 1, `${code} darf kein Backup ausloesen`);
  }
});

test("haelt die Ausnahmen von der Retry-Liste getrennt", async () => {
  // Die beiden Listen sehen aehnlich aus und beantworten doch verschiedene
  // Fragen: der Retry "hilft Warten?", der Fallback "kann ein anderes Modell
  // der Unterschied sein?". Bei 429 gehen sie auseinander - nicht wiederholen,
  // aber ausweichen. Wer die Listen spaeter angleicht, verliert genau das.
  assert.ok(!NO_FALLBACK_STATUS.includes(429), "429 muss ausweichen duerfen");

  const calls = mockFetch(() => errorResponse(429, "RESOURCE_EXHAUSTED"), okResponse);

  const result = await runSearch(withBackup());

  assert.equal(calls.length, 2, "der 429 darf nicht wiederholt, aber ersetzt werden");
  assert.match(result, /🔁 gemini-primary hit its quota \(429\)/);
});

test("weicht bei einem unbrauchbaren API-Schluessel nicht aus", async () => {
  // Gemessen an der echten API: Ein ungueltiger Schluessel kommt als 400
  // INVALID_ARGUMENT zurueck, nicht als 401 oder 403 - der Statuscode allein
  // erkennt diesen Fall also nicht, und ein 400 loest sonst zu Recht einen
  // Fallback aus. Erkannt wird er am reason in error.details.
  //
  // Ohne diese Ausnahme schickt ausgerechnet der haeufigste Einrichtungsfehler
  // eine zweite, garantiert aussichtslose Anfrage und antwortet mit derselben
  // Meldung zweimal.
  const body = JSON.stringify({
    error: {
      code: 400,
      message: "API key not valid. Please pass a valid API key.",
      status: "INVALID_ARGUMENT",
      details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "API_KEY_INVALID" }],
    },
  });
  const calls = mockFetch(
    () => new Response(body, { status: 400, headers: { "content-type": "application/json" } }),
  );

  await assert.rejects(
    () => runSearch(withBackup()),
    (error) => {
      assert.match(error.message, /backup not tried: the API key is not valid/);
      return true;
    },
  );

  assert.equal(calls.length, 1);
});

test("weicht nicht auf dasselbe Modell aus", async () => {
  const calls = mockFetch(() => errorResponse(404, "NOT_FOUND"));

  await assert.rejects(
    () => runSearch(withBackup({ backupModel: PRIMARY })),
    (error) => {
      assert.match(error.message, /same model as the default/);
      return true;
    },
  );

  assert.equal(calls.length, 1);
});

test("nennt beide Fehler, wenn auch das Backup scheitert", async () => {
  // Stuende hier nur der zweite Fehler, suchte man am falschen Modell.
  const calls = mockFetch(
    () => errorResponse(404, "NOT_FOUND"),
    () => errorResponse(400, "INVALID_ARGUMENT"),
  );

  await assert.rejects(
    () => runSearch(withBackup()),
    (error) => {
      assert.match(error.message, /gemini-primary: .*404/s);
      assert.match(error.message, /backup gemini-backup: .*400/s);
      return true;
    },
  );

  assert.equal(calls.length, 2);
});

test("erbt das Thinking-Level des Aufrufs, wenn das Backup keines hat", async () => {
  // Geerbt wird das fuer DIESEN Aufruf genutzte Level, nicht der gespeicherte
  // Standard: Wer "high" uebergeben hat, will es auch beim Ausweichmodell.
  const calls = mockFetch(() => errorResponse(404, "NOT_FOUND"), okResponse);

  await runSearch(withBackup({ thinkingLevel: "high" }));

  assert.equal(thinkingOf(calls[1]), "high");
});

test("nutzt das eigene Thinking-Level des Backups, wenn eines gesetzt ist", async () => {
  const calls = mockFetch(() => errorResponse(404, "NOT_FOUND"), okResponse);

  const result = await runSearch(
    withBackup({ thinkingLevel: "high", backupThinkingLevel: "minimal" }),
  );

  assert.equal(thinkingOf(calls[0]), "high", "das Primaermodell behaelt seines");
  assert.equal(thinkingOf(calls[1]), "minimal");
  // Der Footer muss das tatsaechlich genutzte Level zeigen, nicht das des
  // ersten Versuchs - sonst stuende dort eine Angabe, die nie gegolten hat.
  assert.match(result, /🤖 gemini-backup \(thinking: minimal\)/);
});

test("formatiert die Fallback-Zeile pro Fehlerklasse verschieden", () => {
  // Ein Zusatz nur dort, wo etwas ZU TUN ist. Ohne diese Unterscheidung liest
  // sich ein dauerhafter 404 wie eine voruebergehende Stoerung, und niemand
  // korrigiert je das kaputte Standardmodell.
  const note = (status, statusName) => formatFallbackNote({ model: "m", status, statusName });

  assert.match(note(404), /does not exist.*Update your default/);
  assert.match(note(429), /hit its quota/);
  assert.match(note(400), /Check the thinking level/);
  assert.match(note(503, "UNAVAILABLE"), /failed \(503 UNAVAILABLE\)/);
  // Ohne Statusnamen bleibt die blosse Zahl - keine leere Klammer.
  assert.match(note(502), /failed \(502\)/);
  assert.equal(formatFallbackNote(undefined), "", "ohne Fallback keine Zeile");
});
