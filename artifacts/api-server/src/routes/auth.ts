import { Router } from "express";
import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../lib/logger";
import { randomUUID } from "crypto";

const router = Router();

// Upsert user on Firebase login
router.post("/auth/user", async (req, res) => {
  try {
    const { uid, email, displayName, photoURL } = req.body;

    if (!uid || !email) {
      res.status(400).json({ error: "uid and email are required" });
      return;
    }

    // Check if user exists
    const existing = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(eq(usersTable.firebaseUid, uid))
      .limit(1);

    if (existing.length > 0) {
      // Update last seen
      await db
        .update(usersTable)
        .set({ updatedAt: new Date() })
        .where(eq(usersTable.firebaseUid, uid));

      res.status(200).json({ id: existing[0].id, created: false });
      return;
    }

    // Create new user
    const id = randomUUID();
    await db.insert(usersTable).values({
      id,
      firebaseUid: uid,
      email,
      displayName: displayName || null,
      photoUrl: photoURL || null,
    });

    logger.info({ uid, email }, "new user registered");
    res.status(201).json({ id, created: true });
  } catch (err) {
    logger.error({ err }, "auth user upsert failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
