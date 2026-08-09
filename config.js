import fs from "fs";
import os from "os";
import path from "path";

// Plattformueblicher Ort fuer Nutzer-State, NICHT "./config.json" - das
// Arbeitsverzeichnis eines per stdio gestarteten MCP-Servers ist nicht
// garantiert der Projektordner. Auch nicht scriptrelativ: bei "npm install -g"
// liegt das Script in einem Verzeichnis, das der Paketmanager verwaltet und
// beim Update neu schreibt, bei "npx" in einem Cache, dessen Hash sich mit
// jeder Version aendert - die Einstellung waere dort praktisch fluechtig.
//
// Reihenfolge: XDG_CONFIG_HOME gewinnt, wenn gesetzt (Linux-Konvention und
// zugleich das Ventil fuer alle, die den Standardort nicht wollen). Sonst
// unter Windows %APPDATA%, wo Nutzer-State hingehoert - nicht ~/.config.
// macOS wird bewusst wie Linux behandelt: Der Apple-Standard waere
// ~/Library/Application Support/, aber dies ist ein Terminal-Werkzeug, und im
// Terminal sucht niemand in einem im Finder ausgeblendeten Ordner.
const CONFIG_DIR = path.join(
  process.env.XDG_CONFIG_HOME ??
    (process.platform === "win32"
      ? (process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"))
      : path.join(os.homedir(), ".config")),
  "gemini-grounding-mcp",
);

/**
 * Vollstaendiger Pfad der Konfigurationsdatei. Exportiert, weil
 * Auffindbarkeit ueber die Ausgabe entsteht und nicht ueber den Ort: MCP-Server
 * und CLI nennen den Pfad, damit niemand raten muss, wo die Einstellung liegt.
 */
export const CONFIG_PATH = path.join(CONFIG_DIR, "config.json");

const FALLBACK_MODEL = "gemini-flash-latest";
// Bewusst "medium" und nicht "high": der Fallback greift bei jedem neuen
// Nutzer ohne config.json, und ein hoeheres Level kostet ungefragt mehr
// Thinking-Tokens. Wer mehr will, setzt es per gemini-set-model dauerhaft
// oder pro Aufruf.
const FALLBACK_THINKING_LEVEL = "medium";

/**
 * Die von der Gemini-API akzeptierten Thinking-Level - einzige Quelle fuer
 * MCP-Server und CLI, damit beide dieselben Werte zulassen. index.js macht
 * daraus die Zod-Schemas (z.enum nimmt dieses Array direkt), cli.js prueft
 * damit seine Kommandozeilenargumente.
 */
export const THINKING_LEVELS = ["minimal", "low", "medium", "high"];

// readConfig() laeuft pro Aufruf mehrfach - aus getSavedModel(), aus
// getSavedThinkingLevel() und aus getSavedBackup(). Ohne dieses Flag stuende
// dieselbe Warnung dreimal da und saehe nach drei Fehlern aus.
let warned = false;

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
  } catch (error) {
    // Die fehlende Datei ist der Normalfall und kein Fehler: Vor dem ersten
    // gespeicherten Wert existiert sie nicht, und die Defaults sind dann genau
    // das Gewollte.
    //
    // Alles andere - kaputtes JSON nach einem abgebrochenen Schreibvorgang,
    // fehlende Leserechte - macht eine gespeicherte Einstellung wirkungslos.
    // Ohne Hinweis liefe der Server einfach mit den Defaults weiter, und die
    // Einstellung waere verschwunden, ohne dass es jemandem auffiele.
    //
    // console.error und nicht console.log: Ueber stdout laeuft beim
    // MCP-Server das JSON-RPC-Protokoll: eine Zeile dort zerstoert die
    // Verbindung zum Client. stderr landet im Log des Clients und auf der
    // Kommandozeile direkt vor dem Nutzer.
    if (error.code !== "ENOENT" && !warned) {
      warned = true;
      console.error(
        `Warning: ${CONFIG_PATH} could not be read (${error.message}) - using defaults.`,
      );
    }
    return {};
  }
}

/**
 * Liest das dauerhaft gespeicherte Standardmodell.
 * Liefert FALLBACK_MODEL, falls keine oder eine kaputte config.json existiert.
 */
export function getSavedModel() {
  return readConfig().model ?? FALLBACK_MODEL;
}

/**
 * Liest das dauerhaft gespeicherte Standard-Thinking-Level.
 * Liefert FALLBACK_THINKING_LEVEL, falls keine oder eine kaputte config.json existiert.
 */
export function getSavedThinkingLevel() {
  return readConfig().thinkingLevel ?? FALLBACK_THINKING_LEVEL;
}

/**
 * Liest das gespeicherte Backup-Modell als Einheit: Modell und das ihm
 * zugeordnete Thinking-Level gehoeren zusammen und werden deshalb zusammen
 * gelesen, statt ueber zwei Getter wie die Standardwerte.
 *
 * Drei Zustaende, die auseinandergehalten werden muessen:
 * - `model` gesetzt: ein Fallback findet statt
 * - `disabled`: ausdruecklich per false abgeschaltet
 * - beides leer: nie eingestellt
 *
 * Der Unterschied zwischen den letzten beiden aendert am Verhalten nichts und
 * existiert allein fuer die Ausgabe von "gemini-grounding config": "not set"
 * und "disabled" sind fuer den Nutzer zwei verschiedene Auskuenfte.
 *
 * Geprueft wird beides, weil die Datei von Hand bearbeitet werden kann. Ein
 * Modell muss ein nicht-leerer String sein, ein Level eines der bekannten -
 * andernfalls ginge ein unbrauchbarer Wert erst an die API und kaeme als 400
 * zurueck, ausgerechnet auf dem Pfad, der einen Fehler auffangen soll.
 */
export function getSavedBackup() {
  const { backupModel, backupThinkingLevel } = readConfig();
  return {
    model: typeof backupModel === "string" && backupModel !== "" ? backupModel : undefined,
    thinkingLevel: THINKING_LEVELS.includes(backupThinkingLevel)
      ? backupThinkingLevel
      : undefined,
    disabled: backupModel === false,
  };
}

/**
 * Loest auf, mit welchem Modell und Thinking-Level ein einzelner Aufruf
 * tatsaechlich laeuft - und ob er ein Backup bekommt. Gemeinsame Grundlage fuer
 * den MCP-Handler und die CLI, damit beide dieselbe Antwort geben.
 *
 * Die Aufloesung geschieht bei JEDEM Aufruf neu. Ein einmal ermittelter Wert
 * waere ab dem naechsten gemini-set-model falsch, ohne dass es jemandem
 * auffiele.
 */
export function resolveCallConfig({ model, thinkingLevel } = {}) {
  // Ein namentlich genanntes Modell bekommt KEIN Backup. Wer eines nennt, will
  // dieses eine - haeufig gerade, um zu pruefen, ob es erreichbar ist. Eine
  // Antwort von einem anderen Modell beantwortet diese Frage nicht, sie
  // verdeckt sie.
  //
  // Die Regel ist syntaktisch und greift auch dann, wenn das genannte Modell
  // zufaellig dem gespeicherten Standard entspricht: Was zaehlt, ist die
  // ausdrueckliche Nennung, nicht der Wert. Ein ausdrueckliches thinkingLevel
  // beruehrt den Fallback dagegen nicht - das Modell bleibt dabei der Standard.
  const backup = model === undefined ? getSavedBackup() : {};

  return {
    model: model ?? getSavedModel(),
    thinkingLevel: thinkingLevel ?? getSavedThinkingLevel(),
    backupModel: backup.model,
    backupThinkingLevel: backup.thinkingLevel,
  };
}

/**
 * Ob ein Schreibvorgang Standard und Backup auf dasselbe Modell legen wuerde -
 * als Begruendung im Klartext, oder undefined, wenn alles in Ordnung ist.
 *
 * Waeren beide gleich, faende kein Ausweichen mehr statt: runSearch lehnt den
 * Fallback dann mit "it is the same model as the default" ab. Das ist ein
 * Fangnetz und kein Ersatz fuer diese Pruefung - es greift erst beim naechsten
 * fehlgeschlagenen Aufruf, und bis dahin ist das Backup lautlos tot.
 *
 * Geprueft wird der ZUSTAND NACH dem Schreiben, nicht der Aufruf: Nur so faellt
 * auch der Fall auf, in dem ein einziger Aufruf beide Werte zugleich setzt.
 * Ein Aufruf ohne jedes Modell wird durchgelassen, auch wenn die gespeicherten
 * Werte bereits kollidieren - "set-thinking low" hat die Lage nicht
 * verursacht und soll nicht an ihr scheitern.
 *
 * Hier und nicht in cli.js, weil es sonst wieder nur fuer die CLI gaelte:
 * gemini-set-model schreibt dieselbe Datei und kann beide Werte auf einmal
 * setzen.
 */
export function findModelCollision({ model, backupModel } = {}) {
  if (model === undefined && backupModel === undefined) return undefined;

  const resultingModel = model ?? getSavedModel();
  // false (abgeschaltet) und undefined (nie eingestellt) sind beide unschaedlich
  // und fallen ueber die Wahrheitspruefung unten heraus.
  const resultingBackup = backupModel === undefined ? getSavedBackup().model : backupModel;
  if (!resultingBackup || resultingModel !== resultingBackup) return undefined;

  // Welche Seite der Aufruf anfasst, entscheidet ueber den Rat: Wer das
  // Standardmodell setzt, muss am Backup etwas aendern, und umgekehrt.
  if (model !== undefined && backupModel !== undefined) {
    return `"${resultingModel}" cannot be both the default and the backup model - a backup only helps if it is a different one.`;
  }
  if (model !== undefined) {
    return `"${resultingModel}" is currently the backup model - set a different backup first, or switch the backup off.`;
  }
  return `"${resultingBackup}" is already the default model - a backup only helps if it is a different one.`;
}

/**
 * Ob ein Schreibvorgang ein Backup-Thinking-Level ohne zugehoeriges Modell
 * hinterlassen wuerde - als Begruendung im Klartext, oder undefined.
 *
 * Ein Level gehoert zu genau einem Modell (siehe die Einheits-Regel in
 * setSavedConfig). Ohne dieses Modell hat es keinen Bezug: Es steht in der
 * Datei, wirkt nirgends, und die Bestaetigung meldet einen Wert, den der
 * Zustandsblock zwei Zeilen weiter unten als "not set" oder "disabled" wieder
 * einkassiert.
 *
 * Wie bei findModelCollision geprueft am ZUSTAND NACH DEM SCHREIBEN und nicht
 * am einzelnen Argument, denn nur gemini-set-model kann Modell und Level in
 * EINEM Aufruf setzen - dort ist zum Zeitpunkt der Pruefung noch keiner von
 * beiden gespeichert.
 *
 * Hier und nicht in cli.js, aus demselben Grund: Die CLI hatte diese Pruefung
 * zuerst, der MCP-Handler nicht, und ein Modell auf Zuruf nimmt genau den
 * ungeschuetzten Weg.
 */
export function findBackupLevelProblem({ backupModel, backupThinkingLevel } = {}) {
  // null loescht das Level und braucht kein Modell: Der Weg zurueck auf "erbt
  // vom Aufruf" muss auch dann offenstehen, wenn gar kein Backup mehr da ist.
  if (backupThinkingLevel === undefined || backupThinkingLevel === null) return undefined;

  const saved = getSavedBackup();
  // Modell-ID, false (abgeschaltet) oder undefined (nie eingestellt). ?? und
  // nicht ||, damit ein uebergebenes false erhalten bleibt.
  const resulting = backupModel ?? (saved.disabled ? false : saved.model);
  if (resulting) return undefined;

  // Kein CLI-Befehlsname in der Meldung: Dieselbe Funktion beantwortet beide
  // Schnittstellen, und "set-backup ..." waere in einer MCP-Antwort ein
  // Ratschlag ins Leere.
  //
  // Die erste Meldung benennt die Regel und nicht den Zustand ("a backup that
  // is switched off" statt "the backup is switched off"): Sie erscheint auch
  // dort, wo der Aufruf das Abschalten erst herbeifuehrt und ein Backup gerade
  // noch laeuft.
  return resulting === false
    ? "a backup that is switched off has no thinking level - switch a backup model on first, or leave the level out."
    : "no backup model is set - a thinking level on its own has nothing to belong to. Name the backup model together with the level.";
}

/**
 * Speichert Modell, Thinking-Level und Backup dauerhaft, ohne die jeweils
 * anderen gespeicherten Werte zu ueberschreiben (undefined-Felder bleiben
 * unangetastet). Enthaelt ausschliesslich diese Werte, niemals den API-Key oder
 * andere sensible Daten.
 *
 * null loescht den Schluessel. Das braucht heute nur backupThinkingLevel, um
 * wieder auf "erbt vom Primaeraufruf" zurueckzufallen - die Regel gilt trotzdem
 * fuer alle vier, weil eine Sonderregel fuer genau ein Feld spaeter niemand
 * mehr erklaeren kann.
 *
 * DIE EINE AUSNAHME VON DER MERGE-REGEL: Das Backup wird als EINHEIT
 * geschrieben. Kommt ein backupModel ohne eigenes backupThinkingLevel, verfaellt
 * ein zuvor gespeichertes Level, statt liegen zu bleiben. Das Level gehoert zu
 * diesem einen Modell - ueber einen Wechsel des Backups hinweg gaelte es
 * stillschweigend fuer ein Modell, fuer das es nie gewaehlt wurde.
 *
 * Diese Regel steht HIER und nicht in cli.js, weil sie sonst nur fuer die CLI
 * gilt: Der MCP-Handler schreibt dieselbe Datei, und ein Modell, das dort ein
 * neues Backup setzt, hat keinen Anlass, ausdruecklich null mitzuschicken.
 * Zwei Schnittstellen mit gegenlaeufiger Semantik auf einer Datei kann
 * spaeter niemand mehr erklaeren.
 *
 * Liefert zurueck, was tatsaechlich geschrieben wurde - einschliesslich des
 * hier abgeleiteten null. Nur so kann die Bestaetigung beim Aufrufer den
 * Wegfall des Levels nennen, statt ihn zu verschweigen.
 */
export function setSavedConfig({ model, thinkingLevel, backupModel, backupThinkingLevel }) {
  if (backupModel !== undefined && backupThinkingLevel === undefined) {
    backupThinkingLevel = null;
  }

  const config = readConfig();
  const apply = (key, value) => {
    if (value === undefined) return;
    if (value === null) delete config[key];
    else config[key] = value;
  };
  apply("model", model);
  apply("thinkingLevel", thinkingLevel);
  apply("backupModel", backupModel);
  apply("backupThinkingLevel", backupThinkingLevel);
  // Nur hier im Schreibpfad angelegt, damit das Paket nichts ungefragt
  // erzeugt: Solange niemand das Modell setzt, entsteht weder Verzeichnis noch
  // Datei - readConfig() faengt die fehlende Datei bereits ab.
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));

  return { model, thinkingLevel, backupModel, backupThinkingLevel };
}

/**
 * Bestaetigt jeden geschriebenen Wert einzeln. Gedacht fuer das Ergebnis von
 * setSavedConfig(), damit dort auch das abgeleitete null erscheint.
 *
 * Was gespeichert wurde, ohne dass es dasteht, ist von einem verworfenen
 * Parameter nicht zu unterscheiden - deshalb steht jeder Wert einzeln da und
 * nicht bloss ein "gespeichert".
 *
 * Gemeinsam genutzt von CLI und MCP-Handler, die nur ihr Praefix
 * unterscheiden. Zwei getrennte Fassungen liefen frueher oder spaeter
 * auseinander, und dann sagte dieselbe Aenderung je nach Schnittstelle etwas
 * anderes.
 */
export function formatSavedValues({ model, thinkingLevel, backupModel, backupThinkingLevel }) {
  const parts = [];
  if (model !== undefined) parts.push(`Model: ${model}`);
  if (thinkingLevel !== undefined) parts.push(`Thinking level: ${thinkingLevel}`);
  if (backupModel !== undefined) {
    parts.push(backupModel === false ? "Backup: off" : `Backup: ${backupModel}`);
  }
  // null heisst "geloescht" und damit: erbt wieder vom Aufruf. Das gehoert
  // genannt, weil ein zuvor gesetztes Level dabei verschwindet - ausser bei
  // einem abgeschalteten Backup, wo ein Level nichts mehr bedeutet.
  if (backupThinkingLevel !== undefined && backupModel !== false) {
    parts.push(
      backupThinkingLevel === null
        ? "Backup thinking level: inherited from the call"
        : `Backup thinking level: ${backupThinkingLevel}`,
    );
  }
  return parts.join(", ");
}

/**
 * Der vollstaendige gespeicherte Zustand in zwei Zeilen - was ab jetzt gilt,
 * nicht was gerade geschrieben wurde.
 *
 * Steht nach JEDEM Schreibvorgang und in "config", in CLI wie MCP-Handler.
 * Die Bestaetigung darueber sagt, was sich geaendert hat; erst diese beiden
 * Zeilen sagen, womit die naechste Recherche laeuft. Wer nur eines von beidem
 * sieht, muss den Rest aus dem Gedaechtnis ergaenzen - und das ist genau der
 * Punkt, an dem jemand mit einem Modell arbeitet, das er nicht gemeint hat.
 *
 * Beim geerbten Level steht der Wert und nicht bloss "inherited": Was das
 * Backup bekaeme, wenn es jetzt einspraenge, ist die Auskunft, um die es geht.
 * Der Zusatz sagt dazu, dass der Wert nicht ihm gehoert, sondern mitwandert -
 * uebergibt ein Aufruf ein eigenes thinkingLevel, erbt das Backup dieses.
 *
 * Der Mittelpunkt trennt wie in formatSearchQueries (gemini.js): Modellnamen
 * enthalten selbst Bindestriche und Ziffern, zwischen denen ein weiterer
 * Bindestrich untergeht.
 */
export function formatConfigState() {
  const thinkingLevel = getSavedThinkingLevel();
  const backup = getSavedBackup();

  const backupLine = backup.model
    ? `${backup.model} · ${backup.thinkingLevel ?? `${thinkingLevel} (inherited)`}`
    : backup.disabled
      ? "disabled"
      : "not set";

  return `Primary: ${getSavedModel()} · ${thinkingLevel}\nBackup:  ${backupLine}`;
}
