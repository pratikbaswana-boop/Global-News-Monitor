import { useEffect, useRef } from "react";
import { useLocation } from "wouter";
import { useAuth } from "./use-auth";

interface TrackPayload {
  userId: string;
  event: "app_open" | "page_view" | "page_exit" | "session_end";
  pagePath?: string;
  enteredAt?: number;
  exitedAt?: number;
  durationMs?: number;
  loginMethod?: string;
  userAgent?: string;
  viewportWidth?: number;
  viewportHeight?: number;
}

async function trackEngagement(payload: TrackPayload) {
  try {
    await fetch("/api/engagement/track", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    // Silently fail — tracking should never break UX
  }
}

export function useAppOpenTracking() {
  const { user } = useAuth();
  const tracked = useRef(false);

  useEffect(() => {
    if (!user || tracked.current) return;
    tracked.current = true;

    trackEngagement({
      userId: user.uid,
      event: "app_open",
      userAgent: navigator.userAgent,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    });
  }, [user]);
}

export function usePageViewTracking() {
  const { user } = useAuth();
  const [location] = useLocation();
  const pageStartRef = useRef<number>(Date.now());
  const prevPathRef = useRef<string>(location);

  // Send exit for previous page when location changes
  useEffect(() => {
    if (!user) return;

    const prevPath = prevPathRef.current;
    const now = Date.now();
    const duration = now - pageStartRef.current;

    if (prevPath && prevPath !== location) {
      trackEngagement({
        userId: user.uid,
        event: "page_exit",
        pagePath: prevPath,
        enteredAt: pageStartRef.current,
        exitedAt: now,
        durationMs: duration,
      });
    }

    // Track new page entry
    if (location) {
      trackEngagement({
        userId: user.uid,
        event: "page_view",
        pagePath: location,
      });
    }

    pageStartRef.current = now;
    prevPathRef.current = location;
  }, [location, user]);

  // Send exit on unmount (tab close)
  useEffect(() => {
    if (!user) return;
    const uid = user.uid;

    function handleBeforeUnload() {
      trackEngagement({
        userId: uid,
        event: "page_exit",
        pagePath: prevPathRef.current,
        enteredAt: pageStartRef.current,
        exitedAt: Date.now(),
        durationMs: Date.now() - pageStartRef.current,
      });
    }

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [user]);
}

export function useSessionTracking(loginMethod: string) {
  const { user } = useAuth();
  const sessionStartRef = useRef<number>(Date.now());

  useEffect(() => {
    if (!user) return;
    const uid = user.uid;
    sessionStartRef.current = Date.now();

    function handleBeforeUnload() {
      trackEngagement({
        userId: uid,
        event: "session_end",
        loginMethod,
        enteredAt: sessionStartRef.current,
        exitedAt: Date.now(),
        durationMs: Date.now() - sessionStartRef.current,
      });
    }

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [user, loginMethod]);
}

export function trackLogin(userId: string, loginMethod: string) {
  trackEngagement({ userId, event: "app_open", loginMethod });
}
