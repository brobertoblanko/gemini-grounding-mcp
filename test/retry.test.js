// Die Retry-Konfiguration fuer voruebergehende API-Fehler. Geprueft wird nicht,
// OB das SDK wiederholt - das ist Googles Code -, sondern WORAUF es wiederholt.
// Der eine Eintrag, der in der Liste fehlt, ist eine Entscheidung und kein
// Versehen; ohne Test sieht er wie eines aus.

import { test } from "node:test";
import assert from "node:assert/strict";
import { RETRY_OPTIONS } from "../gemini.js";

test("wiederholt nicht bei 429", () => {
  // Der Kern dieser Datei. Googles Default waere
  // [408, 429, 500, 502, 503, 504] - wer die Liste daran angleicht, macht die
  // Konfiguration schlechter, ohne dass es auffiele: Bei 429 nennt die API die
  // Wartezeit selbst (RetryInfo.retryDelay), das SDK ignoriert sie und haette
  // seine Versuche verbraucht, bevor die Sperre ablaeuft. Begruendung in
  // gemini.js ueber RETRY_OPTIONS.
  assert.ok(
    !RETRY_OPTIONS.httpStatusCodes.includes(429),
    "429 gehoert nicht in die Liste - siehe Kommentar zu RETRY_OPTIONS",
  );
});

test("wiederholt bei den Fehlern, zu denen die API keine Wartezeit liefert", () => {
  // 503 ist der einzige Fehler, der in der Praxis beobachtet wurde: dreimal in
  // Folge innerhalb einer Minute, jeweils "high demand ... usually temporary".
  // Die Antwort trug dabei kein details-Feld, es gibt also keine Angabe, an der
  // sich eine Wartezeit ausrichten liesse.
  for (const status of [408, 500, 502, 503, 504]) {
    assert.ok(
      RETRY_OPTIONS.httpStatusCodes.includes(status),
      `${status} sollte wiederholt werden`,
    );
  }
});

test("wiederholt nicht bei Fehlern, die sich von allein nicht beheben", () => {
  // 400 (kaputte Anfrage), 401/403 (Schluessel) und 404 (Modell zurueckgezogen)
  // gehen beim zweiten Mal genauso schief. Googles eigene Empfehlung dazu:
  // "Do not retry on client errors (like 400 or 403)."
  for (const status of [400, 401, 403, 404]) {
    assert.ok(
      !RETRY_OPTIONS.httpStatusCodes.includes(status),
      `${status} darf nicht wiederholt werden`,
    );
  }
});

test("begrenzt die Zahl der Versuche", () => {
  // attempts zaehlt den Erstversuch mit; der SDK-Default waere 5. Die Obergrenze
  // ist hier keine Feinheit, sondern die Wartezeit, die der Client ohne jedes
  // Signal aussitzt: vier Versuche ergeben mit initialDelay 1s und expBase 2
  // rund 7 bis 14 Sekunden, bevor der Fehler ueberhaupt ankommt.
  assert.equal(RETRY_OPTIONS.attempts, 4);
});
