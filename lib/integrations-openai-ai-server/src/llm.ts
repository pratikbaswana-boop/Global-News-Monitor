import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";

type Provider = "anthropic" | "openai";

const PROVIDER: Provider =
  (process.env.LLM_PROVIDER as Provider | undefined) ?? "anthropic";

if (PROVIDER !== "anthropic" && PROVIDER !== "openai") {
  throw new Error(
    `Invalid LLM_PROVIDER="${PROVIDER}". Must be "anthropic" or "openai".`,
  );
}

const DEFAULT_CHAT_MODEL =
  PROVIDER === "anthropic" ? "claude-sonnet-4-6" : "gpt-4o";

const CHAT_MODEL = process.env.LLM_MODEL_CHAT || DEFAULT_CHAT_MODEL;

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
 * changes. Honors LLM_PROVIDER env var to route to Anthropic or OpenAI.
 */
export async function chatComplete(
  params: ChatCompleteParams,
): Promise<ChatCompleteResponse> {
  if (PROVIDER === "openai") {
    return openaiChat(params);
  }
  return anthropicChat(params);
}

async function openaiChat(
  params: ChatCompleteParams,
): Promise<ChatCompleteResponse> {
  const client = getOpenAIForChat();
  // Always use env-configured model — ignore call-site overrides so a single
  // env flip swaps every call site.
  const res = await client.chat.completions.create({
    model: CHAT_MODEL,
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
    // Always use env-configured Claude model
    model: CHAT_MODEL,
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

export const llmProvider = PROVIDER;
export const llmChatModel = CHAT_MODEL;
