import { MessageCircle, X } from "lucide-react";
import { useChat } from "./chat-context";

export function ChatBubble() {
  const { open, toggle } = useChat();

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={open ? "Close assistant" : "Open assistant"}
      className="fixed bottom-5 right-5 z-[60] h-12 w-12 rounded-full bg-primary text-primary-foreground border border-primary-border shadow-lg flex items-center justify-center transition-transform hover:scale-105 active:scale-95"
    >
      {open ? <X className="h-5 w-5" /> : <MessageCircle className="h-5 w-5" />}
    </button>
  );
}
