import { db, marketSnapshotsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

// Fix all NIFTY entries with incorrect scoring
const rows = await db
  .select()
  .from(marketSnapshotsTable)
  .where(eq(marketSnapshotsTable.assetId, "nifty50"));

console.log(`Found ${rows.length} NIFTY rows to fix`);

for (const r of rows) {
  if (r.resolvedAt === null) {
    console.log(`  SKIP (pending): ${r.id} ${r.snapshotAt}`);
    continue;
  }

  const snapPrice = r.realPriceAtSnapshot ? parseFloat(r.realPriceAtSnapshot) : null;
  const resPrice = r.realPriceAtResolution ? parseFloat(r.realPriceAtResolution) : null;

  if (snapPrice === null || resPrice === null) {
    console.log(`  SKIP (no price data): ${r.id}`);
    continue;
  }

  const pctChange = ((resPrice - snapPrice) / Math.max(snapPrice, 0.01)) * 100;

  let actualDirection = "neutral";
  if (pctChange > 0.1) actualDirection = "up";
  else if (pctChange < -0.1) actualDirection = "down";
  else actualDirection = "neutral";

  const isCorrect = r.predictedDirection === actualDirection;

  const notes = isCorrect
    ? `Prediction CORRECT. Predicted ${r.predictedDirection.toUpperCase()} and market moved ${actualDirection.toUpperCase()} (${pctChange.toFixed(2)}%). Price: ${snapPrice} → ${resPrice.toFixed(2)}.`
    : `Prediction INCORRECT. Predicted ${r.predictedDirection.toUpperCase()} but market moved ${actualDirection.toUpperCase()} (${pctChange.toFixed(2)}%). Price: ${snapPrice} → ${resPrice.toFixed(2)}.`;

  await db
    .update(marketSnapshotsTable)
    .set({
      resolutionDirection: actualDirection,
      isCorrect,
      resolutionNotes: notes,
      priceChangePct: pctChange.toFixed(2),
    })
    .where(eq(marketSnapshotsTable.id, r.id));

  console.log(`  FIXED: ${r.id} ${r.snapshotAt} | predicted=${r.predictedDirection} actual=${actualDirection} | correct=${isCorrect} | ${pctChange.toFixed(2)}%`);
}

console.log("Done fixing track record");
