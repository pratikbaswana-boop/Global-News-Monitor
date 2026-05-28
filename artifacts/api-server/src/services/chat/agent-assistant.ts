import { chatComplete } from "@workspace/integrations-openai-ai-server";
import { logger } from "../../lib/logger.js";
import { buildSystemPrompt } from "./prompts.js";
import type { ChatRequest } from "./types.js";

const FALLBACK_REPLY =
  "I hit an error reading the data on this view. Please try again in a moment.";

export async function runChatAssistant(req: ChatRequest): Promise<string> {
  const system = buildSystemPrompt(req.tab, req.context);

  const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
    { role: "system", content: system },
    ...req.history.map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: req.message },
  ];

  try {
    const res = await chatComplete({
      messages,
      temperature: 0.3,
      max_tokens: 800,
    });
    const reply = res.choices[0]?.message.content?.trim();
    if (!reply) {
      logger.warn({ tab: req.tab }, "chat: empty reply from LLM");
      return FALLBACK_REPLY;
    }
    return reply;
  } catch (err) {
    logger.error({ err, tab: req.tab }, "chat: LLM call failed");
    return FALLBACK_REPLY;
  }
}
