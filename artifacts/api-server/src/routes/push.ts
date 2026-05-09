import { Router } from "express";
import webpush from "web-push";
import { db, pushSubscriptionsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

const router = Router();

// ─── VAPID key management ──────────────────────────────────────────────────────

interface VapidKeys { publicKey: string; privateKey: string }

const VAPID_FILE = join(import.meta.dirname, "../.vapid-keys.json");

function loadOrGenerateVapidKeys(): VapidKeys {
  if (process.env["VAPID_PUBLIC_KEY"] && process.env["VAPID_PRIVATE_KEY"]) {
    return { publicKey: process.env["VAPID_PUBLIC_KEY"], privateKey: process.env["VAPID_PRIVATE_KEY"] };
  }
  if (existsSync(VAPID_FILE)) {
    try {
      return JSON.parse(readFileSync(VAPID_FILE, "utf8")) as VapidKeys;
    } catch { /* regenerate */ }
  }
  const keys = webpush.generateVAPIDKeys();
  try { writeFileSync(VAPID_FILE, JSON.stringify(keys, null, 2)); } catch { /* non-fatal */ }
  return keys;
}

const vapidKeys = loadOrGenerateVapidKeys();

webpush.setVapidDetails(
  "mailto:intel@globalintel.app",
  vapidKeys.publicKey,
  vapidKeys.privateKey
);

export function getVapidPublicKey(): string {
  return vapidKeys.publicKey;
}

// ─── Send push to all subscribers ─────────────────────────────────────────────

export interface PushPayload {
  title: string;
  body: string;
  tag?: string;
  url?: string;
  assetId?: string;
}

export async function sendPushToAll(payload: PushPayload): Promise<void> {
  let subs: (typeof pushSubscriptionsTable.$inferSelect)[] = [];
  try {
    subs = await db.select().from(pushSubscriptionsTable);
  } catch { return; }

  if (subs.length === 0) return;

  for (const sub of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        JSON.stringify(payload)
      );
    } catch {
      // Remove expired / invalid subscriptions
      try {
        await db.delete(pushSubscriptionsTable).where(eq(pushSubscriptionsTable.endpoint, sub.endpoint));
      } catch { /* non-fatal */ }
    }
  }
}

// ─── Routes ───────────────────────────────────────────────────────────────────

router.get("/push/vapid-key", (_req, res) => {
  res.json({ publicKey: vapidKeys.publicKey });
});

router.post("/push/subscribe", async (req, res) => {
  const body = req.body as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
  if (!body.endpoint || !body.keys?.p256dh || !body.keys?.auth) {
    res.status(400).json({ error: "Invalid subscription payload" });
    return;
  }

  const id = Buffer.from(body.endpoint).toString("base64url").slice(0, 64);
  try {
    await db
      .insert(pushSubscriptionsTable)
      .values({ id, endpoint: body.endpoint, p256dh: body.keys.p256dh, auth: body.keys.auth })
      .onConflictDoNothing();
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Failed to store subscription" });
  }
});

router.delete("/push/unsubscribe", async (req, res) => {
  const body = req.body as { endpoint?: string };
  if (!body.endpoint) { res.status(400).json({ error: "endpoint required" }); return; }
  try {
    await db.delete(pushSubscriptionsTable).where(eq(pushSubscriptionsTable.endpoint, body.endpoint));
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Failed to remove subscription" });
  }
});

export default router;
