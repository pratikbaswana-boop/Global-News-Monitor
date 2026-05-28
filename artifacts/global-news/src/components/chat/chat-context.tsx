import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import { fetchTabContext, postChat } from "./api";
import { useCurrentTab } from "./use-tab-location";
import type { ChatMessage, ChatTab } from "./types";

interface ChatState {
  open: boolean;
  setOpen: (v: boolean) => void;
  toggle: () => void;
  tab: ChatTab;
  messages: ChatMessage[];
  pending: boolean;
  sendMessage: (text: string) => Promise<void>;
  clear: () => void;
}

const Ctx = createContext<ChatState | null>(null);

const TAB_GREETING: Record<ChatTab, string> = {
  dashboard:
    "Hi — ask me anything about the news on this Terminal view.",
  trending:
    "Hi — ask me about the entities and trends on this view.",
  sources:
    "Hi — ask me about the data sources and ingestion metrics on this view.",
  intelligence:
    "Hi — ask me about the clusters, predictions, market signals, or track record on this view.",
};

export function ChatStateProvider({ children }: { children: React.ReactNode }) {
  const tab = useCurrentTab();
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [pending, setPending] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const greeting = TAB_GREETING[tab];

  const sendMessage = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || pending) return;

      const userMsg: ChatMessage = { role: "user", content: trimmed };
      const history = messages;
      setMessages((m) => [...m, userMsg]);
      setPending(true);

      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;

      try {
        const context = await fetchTabContext(tab, ctrl.signal);
        const res = await postChat(
          { tab, context, history, message: trimmed },
          ctrl.signal,
        );
        setMessages((m) => [...m, { role: "assistant", content: res.reply }]);
      } catch {
        setMessages((m) => [
          ...m,
          {
            role: "assistant",
            content:
              "I hit an error reaching the assistant. Please try again in a moment.",
          },
        ]);
      } finally {
        setPending(false);
      }
    },
    [messages, pending, tab],
  );

  const clear = useCallback(() => {
    abortRef.current?.abort();
    setMessages([]);
    setPending(false);
  }, []);

  const value = useMemo<ChatState>(
    () => ({
      open,
      setOpen,
      toggle: () => setOpen((v) => !v),
      tab,
      messages,
      pending,
      sendMessage,
      clear,
    }),
    [open, tab, messages, pending, sendMessage, clear],
  );

  // Inject a tab-aware greeting as a transient assistant intro when the message
  // list is empty. Not stored in `messages` so it never leaves with the user.
  const displayMessages = useMemo<ChatMessage[]>(() => {
    if (messages.length === 0) return [{ role: "assistant", content: greeting }];
    return messages;
  }, [messages, greeting]);

  return <Ctx.Provider value={{ ...value, messages: displayMessages }}>{children}</Ctx.Provider>;
}

export function useChat(): ChatState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useChat must be used inside <ChatStateProvider>");
  return v;
}
