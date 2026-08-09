// Womit ein einzelner Aufruf tatsaechlich laeuft. resolveCallConfig() ist die
// gemeinsame Antwort fuer den MCP-Server und die CLI, und die einzige Stelle,
// an der die Regel steht, dass ein namentlich genanntes Modell kein Backup
// bekommt.
//
// Ohne Netzwerk pruefbar, und das ist der Grund fuer die eigene Funktion: Ueber
// die CLI liesse sich diese Regel nur mit einem echten API-Aufruf beobachten.
//
// config.js legt CONFIG_PATH beim Import einmalig fest, deshalb wird
// XDG_CONFIG_HOME vor dem dynamischen Import gesetzt. Der INHALT der Datei
// dagegen wird bei jedem Zugriff neu gelesen - die Faelle unten schreiben sie
// deshalb einfach um.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { configFile, freshConfigHome } from "./helpers.js";

const CONFIG_HOME = freshConfigHome();
process.env.XDG_CONFIG_HOME = CONFIG_HOME;

const {
  resolveCallConfig,
  getSavedBackup,
  setSavedConfig,
  findModelCollision,
  findBackupLevelProblem,
} = await import("../config.js");

function writeConfig(config) {
  const file = configFile(CONFIG_HOME);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(config));
}

const SAVED = {
  model: "gemini-saved",
  thinkingLevel: "medium",
  backupModel: "gemini-backup",
  backupThinkingLevel: "low",
};

test("reicht Standard und Backup durch, wenn der Aufruf nichts vorgibt", () => {
  writeConfig(SAVED);

  assert.deepEqual(resolveCallConfig({}), {
    model: "gemini-saved",
    thinkingLevel: "medium",
    backupModel: "gemini-backup",
    backupThinkingLevel: "low",
  });
});

test("schaltet das Backup ab, sobald der Aufruf ein Modell nennt", () => {
  // Der Kern dieser Datei. Wer ein Modell nennt, will dieses eine - haeufig
  // gerade, um zu pruefen, ob es erreichbar ist. Eine Antwort von einem anderen
  // Modell beantwortet diese Frage nicht, sie verdeckt sie.
  writeConfig(SAVED);

  const resolved = resolveCallConfig({ model: "gemini-explicit" });

  assert.equal(resolved.model, "gemini-explicit");
  assert.equal(resolved.backupModel, undefined, "ein genanntes Modell bekommt kein Backup");
  assert.equal(resolved.backupThinkingLevel, undefined);
});

test("schaltet es auch dann ab, wenn das genannte Modell der Standard ist", () => {
  // Die Regel ist syntaktisch: Was zaehlt, ist die ausdrueckliche Nennung, nicht
  // der Wert. Sonst haette derselbe Aufruf je nach gespeichertem Standard ein
  // anderes Verhalten - und niemand saehe dem Aufruf an, welches.
  writeConfig(SAVED);

  assert.equal(resolveCallConfig({ model: "gemini-saved" }).backupModel, undefined);
});

test("laesst das Backup bei einem ausdruecklichen Thinking-Level aktiv", () => {
  // Nur das Modell entscheidet ueber den Fallback. Beim Level bleibt das
  // Primaermodell der gespeicherte Standard, und der darf ausweichen.
  writeConfig(SAVED);

  const resolved = resolveCallConfig({ thinkingLevel: "high" });

  assert.equal(resolved.thinkingLevel, "high");
  assert.equal(resolved.backupModel, "gemini-backup");
});

test("liefert kein Backup, wenn es ausdruecklich abgeschaltet ist", () => {
  writeConfig({ ...SAVED, backupModel: false });

  assert.equal(resolveCallConfig({}).backupModel, undefined);
  // Fuer das Verhalten ist "abgeschaltet" dasselbe wie "nie eingestellt", fuer
  // die Ausgabe von "config" nicht - deshalb bleibt der Unterschied lesbar.
  assert.deepEqual(getSavedBackup(), {
    model: undefined,
    thinkingLevel: "low",
    disabled: true,
  });
});

test("ignoriert unbrauchbare Werte in einer handgeschriebenen Datei", () => {
  // Ein Level, das die API nicht kennt, ginge sonst ausgerechnet auf dem Pfad
  // hinaus, der einen Fehler auffangen soll, und kaeme als 400 zurueck.
  writeConfig({ ...SAVED, backupModel: "", backupThinkingLevel: "sehr hoch" });

  const resolved = resolveCallConfig({});

  assert.equal(resolved.backupModel, undefined, "ein leerer String ist kein Modell");
  assert.equal(resolved.backupThinkingLevel, undefined);
});

test("laesst das Level verfallen, wenn das Backup-Modell wechselt", () => {
  // Das Backup wird als EINHEIT geschrieben, und die Regel steht in
  // setSavedConfig() statt in cli.js - sonst gaelte sie nur fuer die CLI, und
  // der MCP-Handler, der dieselbe Datei schreibt, hat keinen Anlass,
  // ausdruecklich null mitzuschicken.
  //
  // Ohne sie truege "gemini-neu" hier ein Level, das jemand fuer "gemini-alt"
  // gewaehlt hat, und resolveCallConfig gaebe es an einen Fallback weiter.
  writeConfig({});
  setSavedConfig({ backupModel: "gemini-alt", backupThinkingLevel: "high" });
  assert.equal(resolveCallConfig({}).backupThinkingLevel, "high");

  const saved = setSavedConfig({ backupModel: "gemini-neu" });

  assert.equal(resolveCallConfig({}).backupThinkingLevel, undefined);
  // Der abgeleitete Wert kommt zurueck, damit die Bestaetigung beim Aufrufer
  // den Wegfall nennen kann, statt ihn zu verschweigen.
  assert.equal(saved.backupThinkingLevel, null);
});

test("aendert nur das Level, wenn kein Backup-Modell mitkommt", () => {
  // Das Gegenstueck: Ohne backupModel greift die Einheit nicht, sonst liesse
  // sich das Level eines eingerichteten Backups gar nicht mehr aendern.
  writeConfig({});
  setSavedConfig({ backupModel: "gemini-alt", backupThinkingLevel: "high" });
  setSavedConfig({ backupThinkingLevel: "minimal" });

  assert.deepEqual(getSavedBackup(), {
    model: "gemini-alt",
    thinkingLevel: "minimal",
    disabled: false,
  });
});

test("erkennt die Kollision auch, wenn ein Aufruf beide Werte setzt", () => {
  // Der Fall, den nur gemini-set-model erzeugen kann - die CLI hat keinen
  // Befehl, der Standard und Backup zugleich schreibt. Geprueft wird deshalb
  // der Zustand NACH dem Schreiben und nicht der einzelne Wert gegen die Datei.
  writeConfig(SAVED);

  assert.match(
    findModelCollision({ model: "gemini-neu", backupModel: "gemini-neu" }),
    /cannot be both/,
  );
  // Und der Gegenbeweis: Wer beide zugleich auf VERSCHIEDENE Modelle setzt,
  // darf nicht an den alten gespeicherten Werten scheitern.
  assert.equal(findModelCollision({ model: "gemini-backup", backupModel: "gemini-saved" }), undefined);
});

test("laesst einen Aufruf ohne Modell durch, auch bei kollidierender Datei", () => {
  // "set-thinking low" hat die Lage nicht verursacht und soll nicht an ihr
  // scheitern - sonst blockiert eine von Hand gleichgesetzte Datei ausgerechnet
  // die Befehle, die nichts damit zu tun haben.
  writeConfig({ model: "gemini-gleich", backupModel: "gemini-gleich" });

  assert.equal(findModelCollision({ thinkingLevel: "low" }), undefined);
  assert.match(findModelCollision({ model: "gemini-gleich" }), /currently the backup model/);
});

test("laesst ein abgeschaltetes Backup nie kollidieren", () => {
  writeConfig({ model: "gemini-saved", backupModel: false });

  assert.equal(findModelCollision({ model: "gemini-saved" }), undefined);
  assert.equal(findModelCollision({ backupModel: false }), undefined);
});

test("weist ein Backup-Level ohne sein Modell ab", () => {
  // Ein Level gehoert zu genau einem Modell. Ohne dieses Modell stuende es in
  // der Datei, wirkte nirgends, und die Bestaetigung meldete einen Wert, den
  // der Zustandsblock zwei Zeilen weiter als "not set" wieder einkassiert.
  writeConfig({ model: "gemini-saved" });

  assert.match(findBackupLevelProblem({ backupThinkingLevel: "low" }), /no backup model is set/);
  // Und der Gegenbeweis: Mit gespeichertem Backup ist genau das der Weg, sein
  // Level zu aendern, ohne das Modell erneut zu nennen.
  writeConfig(SAVED);
  assert.equal(findBackupLevelProblem({ backupThinkingLevel: "low" }), undefined);
});

test("weist ein Level fuer ein abgeschaltetes Backup ab", () => {
  // Zwei Wege in denselben Zustand, und beide muessen ihn erkennen: das
  // gespeicherte false und das in diesem Aufruf uebergebene. Den zweiten kann
  // nur gemini-set-model erzeugen, das Modell und Level zugleich setzt -
  // dieselbe Ueberlegung wie bei der Kollisionspruefung.
  writeConfig({ backupModel: false });
  assert.match(findBackupLevelProblem({ backupThinkingLevel: "low" }), /switched off/);

  writeConfig(SAVED);
  assert.match(
    findBackupLevelProblem({ backupModel: false, backupThinkingLevel: "low" }),
    /switched off/,
  );
});

test("laesst das Backup als vollstaendige Einheit und das Loeschen durch", () => {
  // Modell und Level zusammen sind der Normalfall und brauchen nichts
  // Gespeichertes. null loescht das Level und braucht ebenfalls kein Modell:
  // Der Weg zurueck auf "erbt vom Aufruf" muss auch dann offenstehen, wenn gar
  // kein Backup mehr da ist - sonst liesse sich ein von Hand hinterlassener
  // Rest nicht mehr aufraeumen.
  writeConfig({});

  assert.equal(
    findBackupLevelProblem({ backupModel: "gemini-neu", backupThinkingLevel: "high" }),
    undefined,
  );
  assert.equal(findBackupLevelProblem({ backupThinkingLevel: null }), undefined);
  assert.equal(findBackupLevelProblem({ model: "gemini-x" }), undefined);
});

test("kommt ohne jede gespeicherte Konfiguration aus", () => {
  writeConfig({});

  assert.deepEqual(resolveCallConfig({}), {
    model: "gemini-flash-latest",
    thinkingLevel: "medium",
    backupModel: undefined,
    backupThinkingLevel: undefined,
  });
});
