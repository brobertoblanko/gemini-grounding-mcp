#!/usr/bin/env node
// The shebang makes the file directly executable as a bin entry - needed so
// that "npx @brobertoblanko/gemini-grounding-mcp" starts the server.

import { createRequire } from "node:module";

import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

import { runSearch, describeError } from "./gemini.js";
import { listModels, checkModelIds } from "./models.js";
import {
  CONFIG_PATH,
  findBackupLevelProblem,
  findModelCollision,
  formatConfigState,
  formatSavedValues,
  MAX_DEADLINE_SECONDS,
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

function createServer() {
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
        "use gemini-set-config only when explicitly asked.\n" +
        '- A search that hits the deadline fails with 504 or "no response within" - report it, ' +
        "never raise the deadline on your own to try again.\n" +
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
        "can be changed anytime via gemini-set-config. " +
        "The response includes a source list and a token-usage footer.",
      inputSchema: z.object({
        // trim().min(1) on every string: an empty query costs a billed request for
        // nothing, and an empty model is saved and sent on every search after it.
        query: z.string().trim().min(1).describe("The search or research query"),
        model: z
          .string()
          .trim()
          .min(1)
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
      }),
      // Claude Code runs read-only calls in parallel with each other, so several
      // searches in one turn are several billed requests at once.
      // Full derivation: docs/specs.md, "Tool annotations".
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    // The defaults are resolved here in the handler, NOT as a Zod .default() in
    // the schema: a schema default is evaluated once when the tool is registered
    // and then frozen, so gemini-set-config would only take effect after a server
    // restart.
    //
    // resolveCallConfig instead of two ?? in this place, because the CLI has to
    // answer the same question and is to arrive at the same answer - including the
    // rule that a named model gets no backup.
    // Full derivation: docs/specs.md, "Resolving the defaults per call".
    async ({ query, model, thinkingLevel }, ctx) => {
      try {
        const text = await runSearch({
          query,
          ...resolveCallConfig({ model, thinkingLevel }),
          signal: ctx.mcpReq.signal,
        });
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
        "limits. By default a hand-picked shortlist of those suited to research here; " +
        "all: true shows every model with a status column. The shortlist decides what " +
        "is shown, not what is allowed - gemini-set-config and gemini-search accept any " +
        "model id. Before proposing a shorter selection to the user, name the models the " +
        "call returned, mark the selection as a suggestion, and say that any other model " +
        "id can be set too.",
      inputSchema: z.object({
        all: z
          .boolean()
          .optional()
          .describe(
            "List every model the API key exposes, with a status column saying why " +
              "each one is off the shortlist. Off by default.",
          ),
      }),
      // Not open-world: models.list reaches Google, but only the closed set of
      // models behind this API key.
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ all }) => {
      try {
        const text = await listModels({ all, allOption: "all: true" });
        return { content: [{ type: "text", text }] };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error in gemini-list-models: ${describeError(error)}` }],
          isError: true,
        };
      }
    },
  );

  // Named for the file it writes rather than for one of its values: up to 1.x it
  // was gemini-set-model, which stopped fitting once it set a deadline as well.
  server.registerTool(
    "gemini-set-config",
    {
      title: "Set default model, thinking level, backup model and deadline",
      description:
        "Persist the default model ID, thinking level, backup model and/or search deadline " +
        "to the user config file. Used by gemini-search from the next call on, unless the " +
        "call specifies otherwise. Check availability with gemini-list-models first. Only " +
        "use when the user explicitly asks for the change. At least one parameter is required.",
      inputSchema: z.object({
        model: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe(
            "Model ID, e.g. gemini-flash-latest or a pinned model like gemini-3.5-flash",
          ),
        thinkingLevel: z.enum(THINKING_LEVELS).optional().describe("Model reasoning depth"),
        backupModel: z
          .union([z.string().trim().min(1), z.literal(false)])
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
        deadlineSeconds: z
          .union([z.number().int().positive().max(MAX_DEADLINE_SECONDS), z.literal(false)])
          .optional()
          .describe(
            `Seconds after which Google aborts a search (504) - 300 unless set, at most ${MAX_DEADLINE_SECONDS}. Pass ` +
              "false to send no deadline, so Google's own limit applies. Never raise it " +
              "on your own after a search hit the deadline: report the error instead.",
          ),
      }),
      // Idempotent because the same arguments always leave the same config.json.
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      // CLAUDE.md allows this tool only on the user's explicit instruction. Claude
      // Code then prompts on every call, regardless of permission mode and allow
      // rules, and denies the call where no person can answer, as in claude -p.
      _meta: { "anthropic/requiresUserInteraction": true },
    },
    async ({ model, thinkingLevel, backupModel, backupThinkingLevel, deadlineSeconds }) => {
      if (
        model === undefined &&
        thinkingLevel === undefined &&
        backupModel === undefined &&
        backupThinkingLevel === undefined &&
        deadlineSeconds === undefined
      ) {
        return {
          content: [
            {
              type: "text",
              text:
                "Error in gemini-set-config: at least one of model, thinkingLevel, " +
                "backupModel, backupThinkingLevel or deadlineSeconds must be provided.",
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
          content: [{ type: "text", text: `Error in gemini-set-config: ${problem}` }],
          isError: true,
        };
      }

      // Write errors are a real possibility here - the target directory is created
      // on saving and can be unwritable depending on permissions or a relocated
      // %APPDATA%, and an unreadable existing file refuses the write. Without catch
      // the error would run out of the handler uncaught; with it, it arrives as a
      // clean isError response. Both messages name the path themselves.
      let saved;
      try {
        // setSavedConfig returns what was actually written, which matters for the
        // backup it writes as a unit: the confirmation below names a level that
        // expired instead of concealing it.
        saved = setSavedConfig({
          model,
          thinkingLevel,
          backupModel,
          backupThinkingLevel,
          deadlineSeconds,
        });
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error in gemini-set-config: could not save - ${error.message}`,
            },
          ],
          isError: true,
        };
      }
      // Two pieces of information, and both are needed: the first line names every
      // written value on its own, because a stored value would otherwise be
      // indistinguishable from a discarded parameter. The lines below it name the
      // complete state, so that after the change it is settled without asking what
      // the next query runs with - exactly the confirmation CLAUDE.md requires
      // after a model change. Same functions as in the CLI, so the two interfaces
      // cannot drift apart.
      // Full derivation: docs/specs.md, "Reporting what was saved".
      //
      // A doubtful model warns after the save instead of refusing it, as in the
      // CLI: the short list decides what is shown, not what is allowed.
      const ids = [model, backupModel].filter((id) => typeof id === "string");
      const warnings = (await checkModelIds(ids)).map((advice) => `\n\nWarning: ${advice}`);
      return {
        content: [
          {
            type: "text",
            text:
              `Saved to ${CONFIG_PATH} - ${formatSavedValues(saved)}\n\n` +
              formatConfigState() +
              warnings.join(""),
          },
        ],
      };
    },
  );

  return server;
}

// serveStdio instead of server.connect(new StdioServerTransport()): connect serves
// 2025-era clients only, while serveStdio reads the era from the opening message
// and builds one server for the connection, so 2026-07-28 clients are served too.
// Full derivation: docs/specs.md, "Serving both protocol revisions".
serveStdio(createServer);
