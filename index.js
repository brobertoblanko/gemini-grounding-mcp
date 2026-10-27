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
  MIN_DEADLINE_SECONDS,
  resolveCallConfig,
  setSavedConfig,
  THINKING_LEVELS,
} from "./config.js";

// The version comes from package.json, so it is maintained in one place only.
// createRequire instead of import ... with { type: "json" }: under an older Node
// the Import Attributes are a syntax error that aborts the file before any
// version check. npm always packs package.json along, regardless of files.
const { version } = createRequire(import.meta.url)("./package.json");

const toolError = (tool, text) => ({
  content: [{ type: "text", text: `Error in ${tool}: ${text}` }],
  isError: true,
});

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
    // The defaults are resolved per call, NOT as a Zod .default(): that is
    // evaluated once at registration, so gemini-set-config would only take effect
    // after a restart. resolveCallConfig, so the CLI arrives at the same answer.
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
        return toolError("gemini-search", describeError(error));
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
        return toolError("gemini-list-models", describeError(error));
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
          .union([
            z.number().int().min(MIN_DEADLINE_SECONDS).max(MAX_DEADLINE_SECONDS),
            z.literal(false),
          ])
          .optional()
          .describe(
            `Seconds after which Google aborts a search (504) - 300 unless set, from ` +
              `${MIN_DEADLINE_SECONDS} to ${MAX_DEADLINE_SECONDS}. Pass ` +
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
    async (args) => {
      // Over the parsed arguments, so a parameter added to the schema counts too.
      if (Object.values(args).every((value) => value === undefined)) {
        return toolError(
          "gemini-set-config",
          "at least one of model, thinkingLevel, backupModel, backupThinkingLevel " +
            "or deadlineSeconds must be provided.",
        );
      }
      const { model, thinkingLevel, backupModel, backupThinkingLevel, deadlineSeconds } = args;
      // The same two checks as in the CLI, and needed here on top of that because
      // only this handler can set several values in ONE call. A model prompted for
      // it has no reason to read the stored state beforehand.
      const problem =
        findModelCollision({ model, backupModel }) ??
        findBackupLevelProblem({ backupModel, backupThinkingLevel });
      if (problem) return toolError("gemini-set-config", problem);

      // Write errors are real here: an unwritable directory or an unreadable file.
      // Without catch they would escape the handler instead of arriving as isError.
      let saved;
      try {
        // What was actually written, so the confirmation names an expired level.
        saved = setSavedConfig({
          model,
          thinkingLevel,
          backupModel,
          backupThinkingLevel,
          deadlineSeconds,
        });
      } catch (error) {
        return toolError("gemini-set-config", `could not save - ${error.message}`);
      }
      // What was written, then the complete state the next query runs with - the
      // confirmation CLAUDE.md requires after a model change.
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
