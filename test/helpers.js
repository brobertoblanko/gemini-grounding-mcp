// Gemeinsame Werkzeuge fuer die Tests, die die CLI als eigenen Prozess
// starten. Die Datei enthaelt selbst keine Testfaelle; das Testskript laedt
// deshalb ausdruecklich nur "test/*.test.js" - der Vorgabewert von
// "node --test" nimmt alles unterhalb von test/ und meldete diese Datei sonst
// wie einen Testfall.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../cli.js", import.meta.url));

/** Eine Fehlerantwort im Format, das die Gemini-API liefert. */
export const errorResponse = (code, status) =>
  new Response(JSON.stringify({ error: { code, message: "test", status } }), {
    status: code,
    headers: { "content-type": "application/json" },
  });

/** Die kleinstmoegliche erfolgreiche Antwort, die runSearch durchlaeuft. */
export const okResponse = () =>
  new Response(
    JSON.stringify({
      candidates: [{ content: { parts: [{ text: "answer" }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

/**
 * Ersetzt das globale fetch durch eine Folge vorbereiteter Antworten und
 * liefert die Liste der Aufrufe, die dabei entstehen. Das SDK ruft fetch in
 * apiCall() direkt auf, sodass die Zahl der Aufrufe die Zahl der Versuche IST -
 * damit laesst sich am Verhalten pruefen, was sonst nur behauptet waere.
 *
 * Jeder Aufruf nimmt die naechste Antwort; ist die Folge erschoepft, wiederholt
 * sich die letzte. So braucht ein Fall, der auf dauerhaftes Scheitern zielt,
 * nicht zu wissen, wie oft es dazu kommt.
 *
 * Kein Testfall erreicht dabei die API: Der Schluessel ist ein Platzhalter, und
 * der Ersatz faengt jede Anfrage ab, bevor sie das Netz sieht.
 */
export function mockFetch(...responses) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return responses[Math.min(calls.length - 1, responses.length - 1)]();
  };
  return calls;
}

/** Ein frisches, leeres Verzeichnis als XDG_CONFIG_HOME fuer einen Testfall. */
export function freshConfigHome() {
  return mkdtempSync(path.join(tmpdir(), "gemini-grounding-test-"));
}

/** Wo config.js seine Datei unterhalb eines XDG_CONFIG_HOME anlegt. */
export function configFile(configHome) {
  return path.join(configHome, "gemini-grounding-mcp", "config.json");
}

/**
 * Startet die CLI als eigenen Prozess und liefert Exit-Code, stdout und stderr.
 *
 * Der eigene Prozess ist keine Bequemlichkeit, sondern noetig: config.js legt
 * seinen Pfad beim Import einmalig fest, und dasselbe gilt fuer das Flag, das
 * die Warnung vor einer unlesbaren Datei auf einmal begrenzt. Jeder Fall
 * braucht deshalb einen frischen Prozess.
 *
 * XDG_CONFIG_HOME zeigt auf ein Temp-Verzeichnis - ohne diese Isolierung
 * schriebe jeder set-Testfall in die echte Konfiguration dieses Rechners.
 * Der API-Key wird bewusst durch einen Platzhalter ersetzt: Kein Testfall darf
 * die API erreichen, und mit einem ueberschriebenen Key kann keiner es
 * versehentlich doch.
 */
export function runCli(args, { configHome = freshConfigHome() } = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      XDG_CONFIG_HOME: configHome,
      GEMINI_API_KEY: "test-key-never-sent",
    },
  });

  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    configHome,
    /** Die gespeicherte Konfiguration, oder {} wenn keine angelegt wurde. */
    savedConfig() {
      try {
        return JSON.parse(readFileSync(configFile(configHome), "utf8"));
      } catch {
        return {};
      }
    },
  };
}
