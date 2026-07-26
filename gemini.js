import { GoogleGenAI } from "@google/genai";

function getClient() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "GEMINI_API_KEY is not set. The API key must be provided via environment " +
        "variable (never hardcoded).",
    );
  }
  return new GoogleGenAI({ apiKey });
}

/**
 * Baut die Quellenliste aus zwei getrennten Metadaten-Quellen der Gemini-API:
 * - groundingChunks: Treffer der Google-Suche
 * - urlContextMetadata: Seiten, die Gemini gezielt per URL Context gelesen hat
 * Beide Listen werden zusammengefuehrt und nach URL entduplifiziert.
 */
function buildSourceList(candidate) {
  const searchChunks = candidate?.groundingMetadata?.groundingChunks ?? [];
  const urlContextEntries = candidate?.urlContextMetadata?.urlMetadata ?? [];

  const seen = new Set();
  const sources = [];

  for (const chunk of searchChunks) {
    const uri = chunk.web?.uri;
    if (!uri || seen.has(uri)) continue;
    seen.add(uri);
    sources.push({ title: chunk.web?.title ?? uri, uri });
  }

  for (const entry of urlContextEntries) {
    const uri = entry.retrievedUrl;
    if (!uri || seen.has(uri)) continue;
    seen.add(uri);
    sources.push({ title: uri, uri });
  }

  return sources;
}

function formatSourcesBlock(sources) {
  if (sources.length === 0) return "";
  const list = sources
    .map((s, i) => `[${i + 1}] ${s.title} — ${s.uri}`)
    .join("\n");
  return `\n\nSources:\n${list}`;
}

function formatFooter({ usageMetadata, model, thinkingLevel, sourceCount }) {
  const inputTokens = usageMetadata?.promptTokenCount ?? 0;
  const outputTokens = usageMetadata?.candidatesTokenCount ?? 0;
  const thinkingTokens = usageMetadata?.thoughtsTokenCount ?? 0;
  return (
    `\n\n---\n🔢 ${inputTokens} input / ${outputTokens} output / ${thinkingTokens} thinking tokens ` +
    `| 🔍 ${sourceCount} sources | 🤖 ${model} (thinking: ${thinkingLevel})`
  );
}

/**
 * Fuehrt eine Gemini-Recherche mit allen drei Built-in-Tools durch
 * (Google Search, URL Context, Code Execution) und haengt Quellenliste
 * sowie Token-Footer an den Antworttext an.
 */
export async function runSearch({ query, model, thinkingLevel }) {
  const ai = getClient();

  const response = await ai.models.generateContent({
    model,
    contents: query,
    config: {
      tools: [{ googleSearch: {} }, { urlContext: {} }, { codeExecution: {} }],
      thinkingConfig: { thinkingLevel },
    },
  });

  const candidate = response.candidates?.[0];
  const sources = buildSourceList(candidate);

  const text = response.text ?? "";
  const sourcesBlock = formatSourcesBlock(sources);
  const footer = formatFooter({
    usageMetadata: response.usageMetadata,
    model,
    thinkingLevel,
    sourceCount: sources.length,
  });

  return text + sourcesBlock + footer;
}

/**
 * Listet alle fuer den aktuellen API-Key verfuegbaren Modelle inkl. Input-Token-Limit.
 */
export async function listModels() {
  const ai = getClient();
  const models = await ai.models.list({ config: { pageSize: 50 } });

  const lines = [];
  for await (const model of models) {
    lines.push(`${model.name} (input limit: ${model.inputTokenLimit} tokens)`);
  }
  return lines.join("\n");
}
