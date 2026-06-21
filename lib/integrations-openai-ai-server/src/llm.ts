import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import {
  BedrockRuntimeClient,
  ConverseCommand,
} from "@aws-sdk/client-bedrock-runtime";

type Provider = "anthropic" | "openai" | "bedrock";

const PROVIDER: Provider =
  (process.env.LLM_PROVIDER as Provider | undefined) ?? "anthropic";

if (PROVIDER !== "anthropic" && PROVIDER !== "openai" && PROVIDER !== "bedrock") {
  throw new Error(
    `Invalid LLM_PROVIDER="${PROVIDER}". Must be "anthropic", "openai", or "bedrock".`,
  );
}

const DEFAULT_CHAT_MODEL =
  PROVIDER === "anthropic" ? "claude-sonnet-4-6" :
  PROVIDER === "bedrock" ? "us.anthropic.claude-sonnet-4-20250514-v1:0" :
  "gpt-4o";

const CHAT_MODEL = process.env.LLM_MODEL_CHAT || DEFAULT_CHAT_MODEL;
const FAST_CHAT_MODEL = process.env.LLM_MODEL_FAST || CHAT_MODEL;

let _anthropic: Anthropic | null = null;
function getAnthropic(): Anthropic {
  if (_anthropic) return _anthropic;
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    throw new Error(
      "ANTHROPIC_API_KEY must be set when LLM_PROVIDER=anthropic.",
    );
  }
  _anthropic = new Anthropic({ apiKey: key });
  return _anthropic;
}

let _openai: OpenAI | null = null;
function getOpenAIForChat(): OpenAI {
  if (_openai) return _openai;
  const key =
    process.env.OPENAI_API_KEY ||
    process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
  if (!key) {
    throw new Error(
      "OPENAI_API_KEY (or AI_INTEGRATIONS_OPENAI_API_KEY) must be set when LLM_PROVIDER=openai.",
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
function getBedrock(): BedrockRuntimeClient {
  if (_bedrock) return _bedrock;
  const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";
  _bedrock = new BedrockRuntimeClient({
    region,
    // Bedrock new-account quotas are tight (2-4 RPM). Crank SDK retries far above default 3
    // so bursts of parallel calls (ensemble fires 3 windows × N assets) ride out throttling.
    maxAttempts: 10,
    credentials: process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
      ? {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
          sessionToken: process.env.AWS_SESSION_TOKEN,
        }
      : undefined, // falls back to EC2 IAM role / instance profile
  });
  return _bedrock;
}

// Manual exponential-backoff retry on top of SDK retries. SDK's adaptive
// backoff caps at ~20s total; for our burst pattern we need longer ceilings.
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
      // Backoff: 1s, 2s, 4s, 8s, 16s, 32s + jitter
      const delayMs = Math.min(32000, 1000 * 2 ** attempt) + Math.random() * 500;
      console.warn(`[${label}] throttled, retry ${attempt + 1}/${maxRetries} in ${Math.round(delayMs)}ms`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatCompleteParams {
  model?: string;
  temperature?: number;
  max_tokens?: number;
  messages: ChatMessage[];
  response_format?: { type: "json_object" } | { type: "text" };
}

export interface ChatCompleteResponse {
  choices: Array<{
    message: { role: "assistant"; content: string };
    finish_reason: string;
  }>;
  model: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/**
 * Provider-agnostic chat completion. Mirrors the shape of
 * openai.chat.completions.create() so call sites can drop in with no other
 * changes. Honors LLM_PROVIDER env var to route to Anthropic, OpenAI, or Bedrock.
 */
export async function chatComplete(
  params: ChatCompleteParams,
): Promise<ChatCompleteResponse> {
  if (PROVIDER === "openai") {
    return openaiChat(params);
  }
  if (PROVIDER === "bedrock") {
    return bedrockChat(params);
  }
  return anthropicChat(params);
}

async function openaiChat(
  params: ChatCompleteParams,
  modelOverride?: string,
): Promise<ChatCompleteResponse> {
  const client = getOpenAIForChat();
  const res = await client.chat.completions.create({
    model: modelOverride || CHAT_MODEL,
    temperature: params.temperature,
    max_tokens: params.max_tokens,
    messages: params.messages,
    response_format: params.response_format,
  });
  return {
    choices: res.choices.map((c) => ({
      message: {
        role: "assistant" as const,
        content: c.message.content ?? "",
      },
      finish_reason: c.finish_reason ?? "stop",
    })),
    model: res.model,
    usage: res.usage
      ? {
          prompt_tokens: res.usage.prompt_tokens,
          completion_tokens: res.usage.completion_tokens,
          total_tokens: res.usage.total_tokens,
        }
      : undefined,
  };
}

async function anthropicChat(
  params: ChatCompleteParams,
  modelOverride?: string,
): Promise<ChatCompleteResponse> {
  const client = getAnthropic();

  const systemMessages = params.messages.filter((m) => m.role === "system");
  const turnMessages = params.messages.filter((m) => m.role !== "system");

  let system = systemMessages.map((m) => m.content).join("\n\n");

  // Anthropic has no native JSON mode — instruct the model.
  if (params.response_format?.type === "json_object") {
    system = `${system}\n\nIMPORTANT: Respond with ONLY valid JSON. No markdown fences, no commentary, no prose — just the JSON object.`;
  }

  const res = await client.messages.create({
    model: modelOverride || CHAT_MODEL,
    max_tokens: params.max_tokens ?? 4096,
    temperature: params.temperature,
    system: system || undefined,
    messages: turnMessages.map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    })),
  });

  const text = res.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");

  // Strip markdown fences if model wrapped JSON anyway.
  const cleaned =
    params.response_format?.type === "json_object"
      ? text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim()
      : text;

  return {
    choices: [
      {
        message: { role: "assistant", content: cleaned },
        finish_reason: res.stop_reason ?? "stop",
      },
    ],
    model: res.model,
    usage: {
      prompt_tokens: res.usage.input_tokens,
      completion_tokens: res.usage.output_tokens,
      total_tokens: res.usage.input_tokens + res.usage.output_tokens,
    },
  };
}

async function bedrockChat(
  params: ChatCompleteParams,
  modelOverride?: string,
): Promise<ChatCompleteResponse> {
  const client = getBedrock();
  const model = modelOverride || CHAT_MODEL;

  // Separate system messages from turn messages
  const systemMessages = params.messages.filter((m) => m.role === "system");
  const turnMessages = params.messages.filter((m) => m.role !== "system");

  let systemText = systemMessages.map((m) => m.content).join("\n\n");

  // Bedrock/Claude has no native JSON mode — instruct the model.
  if (params.response_format?.type === "json_object") {
    systemText = `${systemText}\n\nIMPORTANT: Respond with ONLY valid JSON. No markdown fences, no commentary, no prose — just the JSON object.`;
  }

  const system = systemText
    ? [{ text: systemText }]
    : undefined;

  // Map messages to Bedrock Converse format
  const messages = turnMessages.map((m) => ({
    role: m.role as "user" | "assistant",
    content: [{ text: m.content }],
  }));

  const command = new ConverseCommand({
    modelId: model,
    system,
    messages,
    inferenceConfig: {
      maxTokens: params.max_tokens ?? 4096,
      temperature: params.temperature,
    },
  });

  const res = await withBackoff(() => client.send(command), `bedrock:${model}`);

  const textContent = res.output?.message?.content
    ?.filter((c: { text?: string }): c is { text: string } => "text" in c && typeof c.text === "string")
    ?.map((c: { text: string }) => c.text)
    ?.join("") ?? "";

  // Strip markdown fences if model wrapped JSON anyway.
  const cleaned =
    params.response_format?.type === "json_object"
      ? textContent.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim()
      : textContent;

  const usage = res.usage;

  return {
    choices: [
      {
        message: { role: "assistant", content: cleaned },
        finish_reason: res.stopReason ?? "stop",
      },
    ],
    model: modelOverride || CHAT_MODEL,
    usage: usage
      ? {
          prompt_tokens: usage.inputTokens ?? 0,
          completion_tokens: usage.outputTokens ?? 0,
          total_tokens: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
        }
      : undefined,
  };
}

export const llmProvider = PROVIDER;
export const llmChatModel = CHAT_MODEL;
export const llmFastModel = FAST_CHAT_MODEL;

/**
 * Fast model variant for lightweight tasks (event extraction, summarisation).
 * Uses LLM_MODEL_FAST env var; falls back to the main chat model if not set.
 */
export async function chatCompleteFast(
  params: ChatCompleteParams,
): Promise<ChatCompleteResponse> {
  if (PROVIDER === "openai") {
    return openaiChat(params, FAST_CHAT_MODEL);
  }
  if (PROVIDER === "bedrock") {
    return bedrockChat(params, FAST_CHAT_MODEL);
  }
  return anthropicChat(params, FAST_CHAT_MODEL);
}
