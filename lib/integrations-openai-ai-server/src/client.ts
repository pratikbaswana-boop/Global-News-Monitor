import OpenAI from "openai";

const apiKey =
  process.env.OPENAI_API_KEY || process.env.AI_INTEGRATIONS_OPENAI_API_KEY;

if (!apiKey) {
  throw new Error(
    "OPENAI_API_KEY (or AI_INTEGRATIONS_OPENAI_API_KEY) must be set. " +
      "It is required for embeddings even when LLM_PROVIDER=anthropic.",
  );
}

export const openai = new OpenAI({
  apiKey,
  baseURL:
    process.env.AI_INTEGRATIONS_OPENAI_BASE_URL || "https://api.openai.com/v1",
});
