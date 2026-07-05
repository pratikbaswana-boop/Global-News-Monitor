// In-memory "hot context" for the event-driven trade path (R2).
//
// The slow-moving inputs to a trade decision — the AI ensemble direction/confidence,
// the HMM regime, the FlipGuard verdict, and the derived SGX / short-covering signals
// — change at most once per 5-minute ensemble cycle. Previously the hot path re-read
// them from the latest market_snapshots row on every evaluation (a DB hop between the
// signal and the executor). Here they live in a single immutable, versioned object
// that the ensemble cycle swaps atomically (build-new-then-swap-reference), so the hot
// path reads them lock-free with zero I/O.
//
// Session priors (FII/DII, delivery %, participant OI) already live in-memory in
// tier3-fetcher.ts (setSessionPriors/getSessionPriors) and are read from there.

export interface HotAssetContext {
  assetId: string;
  direction: "up" | "down" | "neutral" | "uncertain";
  confidence: "high" | "medium" | "low";
  regime: string; // RISK_ON | RISK_OFF | CRISIS
  crisisProbability: number;
  flipConfirmed: boolean;
  priceScore: number;
  uncertaintyFlag: boolean;
  sgxNiftyChangePct: number | null;
  shortCoveringSignal: "none" | "covering" | "unwinding";
  version: number; // monotonic, increments on each publish
  publishedAt: number; // epoch ms
}

// Immutable snapshot of per-asset context. Replaced wholesale (never mutated in place)
// on each publish, so a reader that captured the reference always sees a consistent set.
let contextByAsset: ReadonlyMap<string, HotAssetContext> = new Map();
let version = 0;

/**
 * Atomically publish (or replace) the context for one asset. Builds a new frozen entry
 * and a new map from the current one, then swaps the module reference in a single
 * assignment — readers never observe a half-updated object.
 */
export function publishAssetContext(
  input: Omit<HotAssetContext, "version" | "publishedAt">
): HotAssetContext {
  const entry: HotAssetContext = Object.freeze({
    ...input,
    version: ++version,
    publishedAt: Date.now(),
  });
  const next = new Map(contextByAsset);
  next.set(entry.assetId, entry);
  contextByAsset = next;
  return entry;
}

/** Lock-free read of the current context for an asset (null before its first publish). */
export function getHotContext(assetId: string): HotAssetContext | null {
  return contextByAsset.get(assetId) ?? null;
}

/** All currently-published asset contexts. */
export function getAllHotContext(): ReadonlyMap<string, HotAssetContext> {
  return contextByAsset;
}

/** Current global publish version (diagnostics). */
export function getContextVersion(): number {
  return version;
}

/** Drop all published context (call at session reset). */
export function resetHotContext(): void {
  contextByAsset = new Map();
}
