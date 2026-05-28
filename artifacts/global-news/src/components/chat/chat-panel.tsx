import React, { useEffect, useRef, useState } from "react";
import { Send, Brain, Trash2 } from "lucide-react";
import { useChat } from "./chat-context";
import type { ChatTab } from "./types";

const TAB_TITLE: Record<ChatTab, string> = {
  dashboard: "Terminal",
  trending: "Trending Vectors",
  sources: "Data Sources",
  intelligence: "Intelligence",
};

export function ChatPanel() {
  const { open, setOpen, tab, messages, pending, sendMessage, clear } = useChat();
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (!scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, pending]);

  useEffect(() => {
    if (open) textareaRef.current?.focus();
  }, [open]);

  const onSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!draft.trim() || pending) return;
    const text = draft;
    setDraft("");
    await sendMessage(text);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSubmit();
    }
  };

  return (
    <div
      className={`fixed top-0 right-0 z-50 h-screen w-[380px] max-w-[92vw] bg-[#0c0e14] border-l border-border/40 shadow-2xl flex flex-col transition-transform duration-200 ease-out ${
        open ? "translate-x-0" : "translate-x-full"
      }`}
      role="dialog"
      aria-label="IntelDash Assistant"
      aria-hidden={!open}
    >
      <header className="flex items-center justify-between px-4 py-3 border-b border-border/40">
        <div className="flex items-center gap-2">
          <div className="h-7 w-7 rounded-md bg-primary/10 flex items-center justify-center">
            <Brain className="h-4 w-4 text-primary" />
          </div>
          <div className="leading-tight">
            <div className="text-sm font-semibold tracking-tight" style={{ fontFamily: "'Space Grotesk', sans-serif" }}>
              IntelDash Assistant
            </div>
            <div className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
              Context: {TAB_TITLE[tab]}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={clear}
            aria-label="Clear conversation"
            className="h-8 w-8 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/40 flex items-center justify-center transition-colors"
            title="Clear conversation"
          >
            <Trash2 className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="Close"
            className="h-8 px-2 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/40 text-xs font-medium transition-colors"
          >
            Close
          </button>
        </div>
      </header>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
        {messages.map((m, i) => (
          <Bubble key={i} role={m.role} content={m.content} />
        ))}
        {pending ? <Typing /> : null}
      </div>

      <form onSubmit={onSubmit} className="border-t border-border/40 p-3 flex flex-col gap-2">
        <textarea
          ref={textareaRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={`Ask about ${TAB_TITLE[tab]}...`}
          rows={2}
          className="w-full resize-none rounded-md border border-input bg-transparent px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
          disabled={pending}
          aria-label="Ask a question"
        />
        <div className="flex items-center justify-between">
          <div className="text-[10px] text-muted-foreground">
            Enter to send · Shift+Enter for newline
          </div>
          <button
            type="submit"
            disabled={pending || !draft.trim()}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary text-primary-foreground border border-primary-border px-3 py-1.5 text-xs font-medium disabled:opacity-50"
          >
            <Send className="h-3.5 w-3.5" />
            Send
          </button>
        </div>
      </form>
    </div>
  );
}

function Bubble({ role, content }: { role: "user" | "assistant"; content: string }) {
  const isUser = role === "user";
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[88%] rounded-lg px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap break-words ${
          isUser
            ? "bg-primary/15 border border-primary/30 text-foreground"
            : "bg-muted/30 border border-border/40 text-foreground"
        }`}
      >
        {content}
      </div>
    </div>
  );
}

function Typing() {
  return (
    <div className="flex justify-start">
      <div className="rounded-lg px-3 py-2 bg-muted/30 border border-border/40">
        <div className="flex gap-1">
          <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground animate-pulse [animation-delay:0ms]" />
          <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground animate-pulse [animation-delay:150ms]" />
          <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground animate-pulse [animation-delay:300ms]" />
        </div>
      </div>
    </div>
  );
}
