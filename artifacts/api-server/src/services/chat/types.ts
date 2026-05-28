export type ChatTab = "dashboard" | "trending" | "sources" | "intelligence";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ChatContext {
  articles?: unknown[];
  trending?: unknown;
  sources?: unknown;
  clusters?: unknown[];
  predictions?: unknown[];
  marketSignals?: unknown[];
  trackRecord?: unknown;
}

export interface ChatRequest {
  tab: ChatTab;
  context: ChatContext;
  history: ChatMessage[];
  message: string;
}

export interface ChatResponse {
  reply: string;
}
