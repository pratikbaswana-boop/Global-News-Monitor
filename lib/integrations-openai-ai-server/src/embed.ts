// Provider-agnostic text embeddings.
//
// Honors LLM_PROVIDER (anthropic|openai|bedrock) the same way as chatComplete.
// Anthropic doesn't ship a first-party embedding API, so when
// LLM_PROVIDER=anthropic we route embeddings to Bedrock by default (Titan v2)
// — that keeps a single AWS credential serving both. Override the route with
// EMBED_PROVIDER=openai|bedrock if you'd rather pin it explicitly.
//
// Default models:
//   openai  → text-embedding-3-small  (1536 dim)
//   bedrock → amazon.titan-embed-text-v2:0  (1024 dim)
//
// Override with LLM_MODEL_EMBED.

import OpenAI from "openai";
import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";

type LlmProvider = "anthropic" | "openai" | "bedrock";
type EmbedProvider = "openai" | "bedrock";

const LLM_PROVIDER: LlmProvider =
  (process.env.LLM_PROVIDER as LlmProvider | undefined) ?? "anthropic";

const EMBED_PROVIDER: EmbedProvider = (() => {
  const explicit = process.env.EMBED_PROVIDER as EmbedProvider | undefined;
  if (explicit === "openai" || explicit === "bedrock") return explicit;
  // Default: follow LLM_PROVIDER, except anthropic (which has no embed API).
  if (LLM_PROVIDER === "openai") return "openai";
  return "bedrock"; // anthropic and bedrock both route here
})();

const DEFAULT_EMBED_MODEL =
  EMBED_PROVIDER === "openai"
    ? "text-embedding-3-small"
    : "amazon.titan-embed-text-v2:0";

const EMBED_MODEL = process.env.LLM_MODEL_EMBED || DEFAULT_EMBED_MODEL;

let _openai: OpenAI | null = null;
function getOpenAIForEmbed(): OpenAI {
  if (_openai) return _openai;
  const key =
    process.env.OPENAI_API_KEY ||
    process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
  if (!key) {
    throw new Error(
      "OPENAI_API_KEY (or AI_INTEGRATIONS_OPENAI_API_KEY) must be set when EMBED_PROVIDER=openai.",
    );
  }
  _openai = new OpenAI({
    apiKey: key,
    baseURL:
      process.env.AI_INTEGRATIONS_OPENAI_BASE_URL ||
      "https://api.openai.com/v1",
  });
  return _openai;
}

let _bedrock: BedrockRuntimeClient | null = null;
function getBedrockForEmbed(): BedrockRuntimeClient {
  if (_bedrock) return _bedrock;
  const region =
    process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";
  _bedrock = new BedrockRuntimeClient({
    region,
    maxAttempts: 10,
    credentials:
      process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
        ? {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID,
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
            sessionToken: process.env.AWS_SESSION_TOKEN,
          }
        : undefined,
  });
  return _bedrock;
}

async function withBackoff<T>(fn: () => Promise<T>, label: string): Promise<T> {
  const maxRetries = 6;
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const name = (err as { name?: string }).name ?? "";
      const message = (err as { message?: string }).message ?? "";
      const throttled =
        name === "ThrottlingException" ||
        name === "TooManyRequestsException" ||
        /throttl|too many requests/i.test(message);
      if (!throttled || attempt === maxRetries - 1) throw err;
      const delayMs =
        Math.min(32000, 1000 * 2 ** attempt) + Math.random() * 500;
      console.warn(
        `[${label}] throttled, retry ${attempt + 1}/${maxRetries} in ${Math.round(
          delayMs,
        )}ms`,
      );
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

const MAX_CHARS = 8192;

async function embedOpenAI(text: string): Promise<number[]> {
  const client = getOpenAIForEmbed();
  const res = await client.embeddings.create({
    model: EMBED_MODEL,
    input: text.slice(0, MAX_CHARS),
  });
  const v = res.data[0]?.embedding;
  if (!v) throw new Error("openai embed: empty response");
  return v;
}

async function embedBedrock(text: string): Promise<number[]> {
  const client = getBedrockForEmbed();
  const isTitan = EMBED_MODEL.startsWith("amazon.titan");
  const isCohere = EMBED_MODEL.startsWith("cohere.");
  let body: string;
  if (isTitan) {
    body = JSON.stringify({ inputText: text.slice(0, MAX_CHARS) });
  } else if (isCohere) {
    body = JSON.stringify({
      texts: [text.slice(0, MAX_CHARS)],
      input_type: "search_document",
    });
  } else {
    throw new Error(
      `Unsupported Bedrock embed model: ${EMBED_MODEL}. Use amazon.titan-embed-* or cohere.embed-*.`,
    );
  }
  const cmd = new InvokeModelCommand({
    modelId: EMBED_MODEL,
    contentType: "application/json",
    accept: "application/json",
    body,
  });
  const res = await withBackoff(
    () => client.send(cmd),
    `bedrock-embed:${EMBED_MODEL}`,
  );
  const decoded = new TextDecoder().decode(res.body);
  const parsed = JSON.parse(decoded) as {
    embedding?: number[];
    embeddings?: number[][];
  };
  const v = parsed.embedding ?? parsed.embeddings?.[0];
  if (!v) throw new Error("bedrock embed: empty response");
  return v;
}

/**
 * Provider-agnostic text embedding. Routes to OpenAI or Bedrock based on
 * EMBED_PROVIDER (defaults to follow LLM_PROVIDER; anthropic→bedrock).
 */
export async function embedText(text: string): Promise<number[]> {
  if (EMBED_PROVIDER === "openai") return embedOpenAI(text);
  return embedBedrock(text);
}

export const embedProvider = EMBED_PROVIDER;
export const embedModel = EMBED_MODEL;
