import { Router } from "express";
import { db, userSessionsTable, pageViewsTable, appOpensTable } from "@workspace/db";
import { eq, and, isNull } from "drizzle-orm";
import { logger } from "../lib/logger";
import { randomUUID } from "crypto";

const router = Router();

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

router.post("/api/engagement/track", async (req, res) => {
  try {
    const payload = req.body as TrackPayload;
    const { userId, event } = payload;

    if (!userId || !event) {
      res.status(400).json({ error: "userId and event are required" });
      return;
    }

    switch (event) {
      case "app_open": {
        await db.insert(appOpensTable).values({
          id: randomUUID(),
          userId,
          userAgent: payload.userAgent || null,
          viewportWidth: payload.viewportWidth?.toString() || null,
          viewportHeight: payload.viewportHeight?.toString() || null,
        });
        break;
      }

      case "page_view": {
        await db.insert(pageViewsTable).values({
          id: randomUUID(),
          userId,
          pagePath: payload.pagePath || "/",
          enteredAt: payload.enteredAt ? new Date(payload.enteredAt) : new Date(),
          referrer: req.headers.referer || null,
        });
        break;
      }

      case "page_exit": {
        // Update the most recent page view for this user and path
        if (payload.pagePath && payload.exitedAt) {
          await db
            .update(pageViewsTable)
            .set({
              exitedAt: new Date(payload.exitedAt),
              durationMs: payload.durationMs || null,
            })
            .where(
              and(
                eq(pageViewsTable.userId, userId),
                eq(pageViewsTable.pagePath, payload.pagePath!),
                isNull(pageViewsTable.exitedAt)
              )
            );
        }
        break;
      }

      case "session_end": {
        await db.insert(userSessionsTable).values({
          id: randomUUID(),
          userId,
          startedAt: payload.enteredAt ? new Date(payload.enteredAt) : new Date(),
          endedAt: payload.exitedAt ? new Date(payload.exitedAt) : new Date(),
          durationMs: payload.durationMs || null,
          loginMethod: payload.loginMethod || "unknown",
          ipAddress: req.ip || null,
          userAgent: req.headers["user-agent"] || null,
        });
        break;
      }

      default:
        res.status(400).json({ error: "Unknown event type" });
        return;
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    logger.warn({ err }, "engagement track failed");
    res.status(200).json({ ok: false }); // silently fail
  }
});

export default router;
