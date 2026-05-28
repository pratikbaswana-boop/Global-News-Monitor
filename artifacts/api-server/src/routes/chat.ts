import { Router } from "express";
import { runChatAssistant } from "../services/chat/agent-assistant.js";
import type { ChatRequest, ChatResponse, ChatTab, ChatMessage } from "../services/chat/types.js";
import { logger } from "../lib/logger.js";

const router = Router();

const VALID_TABS: ReadonlySet<ChatTab> = new Set([
  "dashboard",
  "trending",
  "sources",
  "intelligence",
]);

function parseRequest(body: unknown): ChatRequest | { error: string } {
  if (!body || typeof body !== "object") return { error: "body must be an object" };
  const b = body as Record<string, unknown>;

  if (typeof b.tab !== "string" || !VALID_TABS.has(b.tab as ChatTab)) {
    return { error: "tab must be one of dashboard|trending|sources|intelligence" };
  }
  if (typeof b.message !== "string" || b.message.trim().length === 0) {
    return { error: "message must be a non-empty string" };
  }
  if (b.message.length > 4000) {
    return { error: "message too long" };
  }
  if (!Array.isArray(b.history)) {
    return { error: "history must be an array" };
  }
  if (b.history.length > 40) {
    return { error: "history too long" };
  }
  const history: ChatMessage[] = [];
  for (const m of b.history) {
    if (!m || typeof m !== "object") return { error: "history entries must be objects" };
    const mm = m as Record<string, unknown>;
    if (mm.role !== "user" && mm.role !== "assistant") {
      return { error: "history.role must be 'user' or 'assistant'" };
    }
    if (typeof mm.content !== "string") return { error: "history.content must be a string" };
    history.push({ role: mm.role, content: mm.content });
  }
  const context = (b.context && typeof b.context === "object") ? (b.context as ChatRequest["context"]) : {};

  return {
    tab: b.tab as ChatTab,
    message: b.message,
    history,
    context,
  };
}

router.post("/chat", async (req, res) => {
  const parsed = parseRequest(req.body);
  if ("error" in parsed) {
    const reply: ChatResponse = {
      reply: "I couldn't parse that request. Please refresh the page and try again.",
    };
    logger.warn({ err: parsed.error }, "chat: bad request");
    res.status(200).json(reply);
    return;
  }

  const reply = await runChatAssistant(parsed);
  const out: ChatResponse = { reply };
  res.status(200).json(out);
});

export default router;
