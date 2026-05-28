import React from "react";
import { ChatStateProvider } from "./chat-context";
import { ChatBubble } from "./chat-bubble";
import { ChatPanel } from "./chat-panel";

/**
 * Top-level isolated chat module. Wrap the app with this in main.tsx:
 *
 *   <ChatModule>
 *     <App />
 *   </ChatModule>
 *
 * The module mounts its own bubble + slide-in panel as overlays. It owns its
 * own state, makes its own /api/chat requests, and detects the active tab
 * from window.location.pathname — so it has zero coupling to App, the router,
 * the QueryClient, or any existing page component.
 */
export function ChatModule({ children }: { children: React.ReactNode }) {
  return (
    <ChatStateProvider>
      {children}
      <ChatBubble />
      <ChatPanel />
    </ChatStateProvider>
  );
}
