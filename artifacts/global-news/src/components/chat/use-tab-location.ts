import { useSyncExternalStore } from "react";
import type { ChatTab } from "./types";

// Lives outside the wouter router. We watch window.location.pathname by
// patching history.pushState / history.replaceState (one-time, singleton) plus
// the native popstate event. Wouter uses these under the hood, so navigation
// from the sidebar is picked up without any coupling to the router.

const listeners = new Set<() => void>();
let patched = false;

function notify() {
  listeners.forEach((l) => l());
}

function ensurePatched() {
  if (patched || typeof window === "undefined") return;
  patched = true;
  const origPush = window.history.pushState;
  const origReplace = window.history.replaceState;
  window.history.pushState = function patchedPush(...args: Parameters<typeof origPush>) {
    const r = origPush.apply(this, args);
    notify();
    return r;
  };
  window.history.replaceState = function patchedReplace(...args: Parameters<typeof origReplace>) {
    const r = origReplace.apply(this, args);
    notify();
    return r;
  };
  window.addEventListener("popstate", notify);
  window.addEventListener("hashchange", notify);
}

function subscribe(cb: () => void): () => void {
  ensurePatched();
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function getSnapshot(): string {
  if (typeof window === "undefined") return "/";
  return window.location.pathname;
}

function getServerSnapshot(): string {
  return "/";
}

function pathToTab(pathname: string): ChatTab {
  const base = (import.meta.env.BASE_URL ?? "/").replace(/\/$/, "");
  let p = pathname;
  if (base && p.startsWith(base)) p = p.slice(base.length);
  if (!p.startsWith("/")) p = "/" + p;
  if (p.startsWith("/trending")) return "trending";
  if (p.startsWith("/sources")) return "sources";
  if (p.startsWith("/intelligence")) return "intelligence";
  return "dashboard";
}

export function useCurrentTab(): ChatTab {
  const pathname = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return pathToTab(pathname);
}
