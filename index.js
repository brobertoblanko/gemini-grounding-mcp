import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { runSearch, listModels } from "./gemini.js";
import { getSavedModel, getSavedThinkingLevel, setSavedConfig } from "./config.js";

const server = new McpServer(
  {
    name: "gemini-grounding",
    title: "Gemini Web Search",
    version: "1.0.0",
    description:
      "Web search and research via Google's Gemini API with grounding — " +
      "current, cited information for library APIs, software behavior, and recent events.",
  },
  {
    instructions:
      "Search and research the web through Google's Gemini API with grounding. " +
      "Use this server to retrieve current, cited information — library APIs, " +
      "software behavior, recent events, or any fact that may be newer than a " +
      "model's training data.\n" +
      "- gemini-search: the model and thinking level actually used are always shown in the " +
      "response footer, so the user can see them without guessing.\n" +
      "- On errors, report them clearly — never silently fall back to another model.\n" +
      "- Before changing the default model, list what's available with gemini-list-models; " +
      "use gemini-set-model only when explicitly asked.\n" +
      "- Every answer has a source list and a token-usage footer appended — keep them intact.",
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
      "explicitly requests a different one for this call — the default " +
      "can be changed anytime via gemini-set-model. " +
      "The response includes a source list and a token-usage footer.",
    inputSchema: {
      query: z.string().describe("The search or research query"),
      model: z
        .string()
        .optional()
        .describe(
          "Gemini model, e.g. gemini-flash-latest. Omit to use the saved " +
            "default; only set when the user explicitly asks for a specific model.",
        ),
      thinkingLevel: z
        .enum(["minimal", "low", "medium", "high"])
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
  async ({ query, model, thinkingLevel }) => {
    try {
      const text = await runSearch({
        query,
        model: model ?? getSavedModel(),
        thinkingLevel: thinkingLevel ?? getSavedThinkingLevel(),
      });
      return { content: [{ type: "text", text }] };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error in gemini-search: ${error.message}` }],
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
      "limits. By default only models usable with this server — they generate text " +
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
        content: [{ type: "text", text: `Error in gemini-list-models: ${error.message}` }],
        isError: true,
      };
    }
  },
);

server.registerTool(
  "gemini-set-model",
  {
    title: "Set default model and/or thinking level",
    description:
      "Persist the default model ID and/or thinking level to config.json. Used by " +
      "gemini-search as the default from the next call on, unless the call specifies " +
      "otherwise. Check availability with gemini-list-models first. At least one of " +
      "the two parameters is required.",
    inputSchema: {
      model: z
        .string()
        .optional()
        .describe(
          "Model ID, e.g. gemini-flash-latest or a pinned model like gemini-3.5-flash",
        ),
      thinkingLevel: z
        .enum(["minimal", "low", "medium", "high"])
        .optional()
        .describe("Model reasoning depth"),
    },
  },
  async ({ model, thinkingLevel }) => {
    if (model === undefined && thinkingLevel === undefined) {
      return {
        content: [
          {
            type: "text",
            text: "Error in gemini-set-model: model or thinkingLevel must be provided.",
          },
        ],
        isError: true,
      };
    }
    setSavedConfig({ model, thinkingLevel });
    const parts = [];
    if (model !== undefined) parts.push(`Model: ${model}`);
    if (thinkingLevel !== undefined) parts.push(`Thinking level: ${thinkingLevel}`);
    return {
      content: [{ type: "text", text: `Saved — ${parts.join(", ")}` }],
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
