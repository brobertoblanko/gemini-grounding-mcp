#!/usr/bin/env node
// The shebang makes the file directly executable as a bin entry - needed so
// that "npx @brobertoblanko/gemini-grounding-mcp" starts the server.

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

// The version comes from package.json so it is maintained in one place only - a
// second number kept in step by hand sooner or later reports a release to the
// client that is not the one shipped.
//
// createRequire instead of import ... with { type: "json" }: both run from the
// supported Node version on, but Import Attributes would be a syntax error when
// invoked under an older one - and a syntax error aborts the file while parsing,
// before any version check could take effect. createRequire has always run. The
// package.json sits next to this file, in the clone as in the installed package:
// npm always packs it along, regardless of files.
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
  // The defaults are resolved here in the handler, NOT as a Zod .default() in
  // the schema: a schema default is evaluated once when the tool is registered
  // and then frozen, so gemini-set-model would only take effect after a server
  // restart.
  //
  // resolveCallConfig instead of two ?? in this place, because the CLI has to
  // answer the same question and is to arrive at the same answer - including the
  // rule that a named model gets no backup.
  // Full derivation: docs/specs.md, "Resolving the defaults per call".
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
    // The same two checks as in the CLI, and needed here on top of that because
    // only this handler can set several values in ONE call. A model prompted for
    // it has no reason to read the stored state beforehand.
    const problem =
      findModelCollision({ model, backupModel }) ??
      findBackupLevelProblem({ backupModel, backupThinkingLevel });
    if (problem) {
      return {
        content: [{ type: "text", text: `Error in gemini-set-model: ${problem}` }],
        isError: true,
      };
    }

    // Write errors are a real possibility here - the target directory is created
    // on saving and can be unwritable depending on permissions or a relocated
    // %APPDATA%. Without catch the error would run out of the handler uncaught;
    // with it, it arrives as a clean isError response naming the path.
    let saved;
    try {
      // setSavedConfig returns what was actually written, which matters for the
      // backup it writes as a unit: the confirmation below names a level that
      // expired instead of concealing it.
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
    // Two pieces of information, and both are needed: the first line names every
    // written value on its own, because a stored value would otherwise be
    // indistinguishable from a discarded parameter. The two below it name the
    // complete state, so that after the change it is settled without asking what
    // the next query runs with - exactly the confirmation CLAUDE.md requires
    // after a model change. Same functions as in the CLI, so the two interfaces
    // cannot drift apart.
    // Full derivation: docs/specs.md, "Reporting what was saved".
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
