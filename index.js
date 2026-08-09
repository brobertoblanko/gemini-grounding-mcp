#!/usr/bin/env node
// Der Shebang macht die Datei als bin-Eintrag direkt ausfuehrbar - noetig,
// damit "npx @brobertoblanko/gemini-grounding-mcp" den Server startet.

import { createRequire } from "node:module";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { runSearch, listModels, describeError } from "./gemini.js";
import {
  CONFIG_PATH,
  findBackupLevelProblem,
  findModelCollision,
  formatConfigState,
  formatSavedValues,
  resolveCallConfig,
  setSavedConfig,
  THINKING_LEVELS,
} from "./config.js";

// Die Version kommt aus der package.json, damit sie nur an einer Stelle
// gepflegt wird - eine zweite, von Hand nachgezogene Zahl meldet dem Client
// frueher oder spaeter eine Fassung, die nicht der ausgelieferten entspricht.
// createRequire statt import ... with { type: "json" }: Beides laeuft ab der
// unterstuetzten Node-Version, aber Import Attributes waeren bei einem Aufruf
// unter einer aelteren Fassung ein Syntaxfehler - und ein Syntaxfehler bricht
// die Datei beim Parsen ab, bevor irgendeine Versionspruefung greifen koennte.
// createRequire laeuft seit jeher. Die package.json liegt neben dieser Datei,
// im Klon wie im installierten Paket: npm packt sie immer mit, unabhaengig
// von files.
const { version } = createRequire(import.meta.url)("./package.json");

const server = new McpServer(
  {
    name: "gemini-grounding",
    title: "Gemini Web Search",
    version,
    description:
      "Web search and research via Google's Gemini API with grounding - " +
      "current, cited information for library APIs, software behavior, and recent events.",
  },
  {
    instructions:
      "Search and research the web through Google's Gemini API with grounding. " +
      "Use this server to retrieve current, cited information - library APIs, " +
      "software behavior, recent events, or any fact that may be newer than a " +
      "model's training data.\n" +
      "- gemini-search: the model and thinking level actually used are always shown in the " +
      "response footer, so the user can see them without guessing.\n" +
      "- On errors, report them clearly - never fall back to a model of your own choosing. " +
      "The only permitted fallback is the backup model the user configured, it happens " +
      "inside the server, and the footer always names it.\n" +
      "- Before changing the default model, list what's available with gemini-list-models; " +
      "use gemini-set-model only when explicitly asked.\n" +
      "- Every answer has a source list and a token-usage footer appended - keep them intact.",
  },
);

server.registerTool(
  "gemini-search",
  {
    title: "Gemini web search with grounding",
    description:
      "Run a web search / research query through the Gemini API. Combines " +
      "Google Search, URL context, and code execution in a single call. " +
      "Uses the saved default model and thinking level unless the user " +
      "explicitly requests a different one for this call - the default " +
      "can be changed anytime via gemini-set-model. " +
      "The response includes a source list and a token-usage footer.",
    inputSchema: {
      query: z.string().describe("The search or research query"),
      model: z
        .string()
        .optional()
        .describe(
          "Gemini model, e.g. gemini-flash-latest. Omit to use the saved " +
            "default; only set when the user explicitly asks for a specific model. " +
            "Naming a model here also disables the configured backup model for this " +
            "call - the request either reaches this model or fails.",
        ),
      thinkingLevel: z
        .enum(THINKING_LEVELS)
        .optional()
        .describe(
          "Model reasoning depth. Omit to use the saved default; only set " +
            "when the user explicitly asks for a specific thinking level.",
        ),
    },
  },
  // Die Defaults werden hier im Handler aufgeloest, NICHT als Zod-.default() im
  // Schema: ein Schema-Default wird einmal beim Registrieren ausgewertet und
  // eingefroren, sodass gemini-set-model erst nach einem Serverneustart wirken
  // wuerde. Der Footer zeigt dadurch immer die tatsaechlich genutzten Werte.
  //
  // resolveCallConfig statt zweier ?? an dieser Stelle, weil die CLI dieselbe
  // Frage beantworten muss und dabei zu derselben Antwort kommen soll - inkl.
  // der Regel, dass ein genanntes Modell kein Backup bekommt.
  async ({ query, model, thinkingLevel }) => {
    try {
      const text = await runSearch({ query, ...resolveCallConfig({ model, thinkingLevel }) });
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error in gemini-search: ${describeError(error)}` }],
        isError: true,
      };
    }
  },
);

server.registerTool(
  "gemini-list-models",
  {
    title: "List available Gemini models",
    description:
      "List the Gemini models available for the current API key with their token " +
      "limits. By default only models usable with this server - they generate text " +
      "and accept a thinking level, which gemini-search always sends. Being listed " +
      "is no guarantee a model still answers: retired models remain in the list and " +
      "return 404 on use.",
    inputSchema: {
      all: z
        .boolean()
        .optional()
        .describe(
          "List every model the API key exposes, including those that cannot be " +
            "used here (embedding, image, video, audio models). Off by default.",
        ),
    },
  },
  async ({ all }) => {
    try {
      const text = await listModels({ all });
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error in gemini-list-models: ${describeError(error)}` }],
        isError: true,
      };
    }
  },
);

server.registerTool(
  "gemini-set-model",
  {
    title: "Set default model, thinking level and backup model",
    description:
      "Persist the default model ID, thinking level and/or backup model to the user " +
      "config file. Used by gemini-search as the default from the next call on, unless " +
      "the call specifies otherwise. Check availability with gemini-list-models first. " +
      "At least one parameter is required.",
    inputSchema: {
      model: z
        .string()
        .optional()
        .describe(
          "Model ID, e.g. gemini-flash-latest or a pinned model like gemini-3.5-flash",
        ),
      thinkingLevel: z.enum(THINKING_LEVELS).optional().describe("Model reasoning depth"),
      backupModel: z
        .union([z.string(), z.literal(false)])
        .optional()
        .describe(
          "Model to retry the same request with when the default model fails, e.g. " +
            "because it is overloaded (503). Off unless set. Pass false to switch it " +
            "off again. Not used when a call names a model explicitly.",
        ),
      backupThinkingLevel: z
        .enum(THINKING_LEVELS)
        .nullable()
        .optional()
        .describe(
          "Reasoning depth for the backup model. Omit it while setting backupModel " +
            "and the backup inherits the level of the call it is standing in for, " +
            "which is the default. Set it on its own to change the level of the " +
            "backup already saved, leaving the model as it is.",
        ),
    },
  },
  async ({ model, thinkingLevel, backupModel, backupThinkingLevel }) => {
    if (
      model === undefined &&
      thinkingLevel === undefined &&
      backupModel === undefined &&
      backupThinkingLevel === undefined
    ) {
      return {
        content: [
          {
            type: "text",
            text:
              "Error in gemini-set-model: at least one of model, thinkingLevel, " +
              "backupModel or backupThinkingLevel must be provided.",
          },
        ],
        isError: true,
      };
    }
    // Dieselben beiden Pruefungen wie in der CLI, und hier zusaetzlich noetig,
    // weil nur dieser Handler mehrere Werte in EINEM Aufruf setzen kann.
    //
    // Waeren Standard und Backup dasselbe Modell, faende kein Ausweichen mehr
    // statt - und auffallen wuerde das erst beim naechsten fehlgeschlagenen
    // gemini-search. Ein Backup-Level ohne sein Modell wiederum schriebe einen
    // Wert, den der Zustandsblock unter der Bestaetigung sofort wieder
    // einkassiert; ein Modell auf Zuruf hat keinen Anlass, den gespeicherten
    // Zustand vorher zu lesen.
    const problem =
      findModelCollision({ model, backupModel }) ??
      findBackupLevelProblem({ backupModel, backupThinkingLevel });
    if (problem) {
      return {
        content: [{ type: "text", text: `Error in gemini-set-model: ${problem}` }],
        isError: true,
      };
    }

    // Schreibfehler sind hier real moeglich - das Zielverzeichnis wird beim
    // Speichern erst angelegt und kann je nach Rechten oder verschobenem
    // %APPDATA% unbeschreibbar sein. Ohne catch liefe der Fehler ungefangen aus
    // dem Handler; mit catch kommt er als saubere isError-Antwort samt Pfad an.
    let saved;
    try {
      // setSavedConfig liefert zurueck, was tatsaechlich geschrieben wurde -
      // wichtig beim Backup, das es als Einheit schreibt: Ein backupModel ohne
      // eigenes Level laesst ein zuvor gespeichertes verfallen, und die
      // Bestaetigung unten nennt das, statt es zu verschweigen.
      saved = setSavedConfig({ model, thinkingLevel, backupModel, backupThinkingLevel });
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error in gemini-set-model: could not write ${CONFIG_PATH} - ${error.message}`,
          },
        ],
        isError: true,
      };
    }
    // Zwei Auskuenfte, und beide werden gebraucht: Die erste Zeile nennt jeden
    // geschriebenen Wert einzeln, weil ein gespeicherter Wert sonst von einem
    // verworfenen Parameter nicht zu unterscheiden waere. Die beiden darunter
    // nennen den vollstaendigen Zustand, damit nach der Aenderung ohne
    // Rueckfrage feststeht, womit die naechste Recherche laeuft - genau die
    // Bestaetigung, die CLAUDE.md nach einer Modellaenderung verlangt.
    //
    // Dieselben Funktionen wie in der CLI, damit beide Schnittstellen nicht
    // auseinanderlaufen.
    return {
      content: [
        {
          type: "text",
          text:
            `Saved to ${CONFIG_PATH} - ${formatSavedValues(saved)}\n\n` + formatConfigState(),
        },
      ],
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
