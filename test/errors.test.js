// Was beim aufrufenden Agenten ankommt, wenn eine Anfrage scheitert. Ein
// MCP-Tool kann nur eine Zeile Text zurueckgeben; steht darin nichts als
// "fetch failed", kann der Agent dem Nutzer nichts erklaeren.

import { test } from "node:test";
import assert from "node:assert/strict";
import { describeError } from "../gemini.js";

test("haengt die Ursache eines echten Netzwerkfehlers an", async () => {
  // Ein ECHTER Fehler von Nodes fetch statt eines nachgebauten: Die Form von
  // error.cause ist eine Annahme ueber die Laufzeitumgebung, und die prueft man
  // besser an ihr selbst. Ziel ist 127.0.0.1 mit einem unzulaessigen Port -
  // Node lehnt das ab, bevor ein Socket entsteht, es geht also nichts hinaus.
  const error = await fetch("http://127.0.0.1:1/x").catch((e) => e);

  // Der Grund, warum es diese Funktion gibt: message allein ist wertlos.
  assert.equal(error.message, "fetch failed");

  const described = describeError(error);
  assert.match(described, /^fetch failed \(/);
  assert.ok(
    described.length > error.message.length,
    "die Ursache muss in der Zeile stehen, nicht nur der Oberbegriff",
  );
});

test("stellt den Fehlercode voran, wenn es einen gibt", () => {
  // Gemessen liefert nicht jede Ursache einen code ("bad port" etwa nicht),
  // ECONNREFUSED und die Timeouts dagegen schon. Deshalb ist er optional und
  // erzeugt ohne ihn keine leere Klammer.
  //
  // Der Wortlaut hier ist nicht erfunden, sondern der Fall, der diesen Server
  // tatsaechlich treffen kann: eine Antwort, die zu lange auf sich warten
  // laesst. Gemessen gegen einen lokalen Server, der die Anfrage annimmt und
  // dann schweigt - Node 24.15.0 bricht nach 306,8 s ab und liefert genau
  // diese beiden Zeichenketten.
  const error = new TypeError("fetch failed", {
    cause: Object.assign(new Error("Headers Timeout Error"), {
      code: "UND_ERR_HEADERS_TIMEOUT",
    }),
  });

  assert.equal(
    describeError(error),
    "fetch failed (UND_ERR_HEADERS_TIMEOUT: Headers Timeout Error)",
  );
});

test("laesst einen API-Fehler unveraendert", () => {
  // Ein ApiError traegt den rohen JSON-Body der Fehlerantwort als message und
  // damit bereits Code, Status und Klartext der API. Anzuhaengen gibt es da
  // nichts - und umschreiben soll die Funktion nichts.
  const message =
    '{"error":{"code":503,"message":"This model is currently experiencing high demand.",' +
    '"status":"UNAVAILABLE"}}';

  assert.equal(describeError(new Error(message)), message);
});
