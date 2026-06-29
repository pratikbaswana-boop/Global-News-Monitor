// Market scheduler — fetches NSE features, runs HMM regime detection, and triggers
// per-asset GPT-4o ensemble inference on a smart cadence by IST time of day.
//
// Cadence:
//   • Pre-market   (08:45–09:15 IST = 03:15–03:45 UTC): every 15 min  (2 cycles: 08:45 + 09:00)
//   • Open         (09:15–15:30 IST = 03:45–10:00 UTC): every 5 min
//   • Post-close   (15:30–16:30 IST = 10:00–11:00 UTC): every 15 min
//   • Off-hours    (16:30–08:45 IST):                   every 60 min
//
// Each cycle: HMM regime → 3-window ensemble per asset → persist to market_snapshots cache.

import { randomUUID } from "crypto";
import { db, marketRegimesTable, flipGuardsTable, marketSnapshotsTable } from "@workspace/db";
import { desc, gt, eq, and } from "drizzle-orm";
import { logger } from "../../lib/logger.js";
import { fetchRegimeFeatures, fetchNSEPriceData } from "./nse-direct-scraper.js";
import { detectRegime } from "./hmm-regime.js";
import { runMarketAgent } from "./market-agent.js";
import { fetchSessionPriors, setSessionPriors, getSessionPriors, fetchTier3Snapshot } from "./tier3-fetcher.js";
import { recordObservation, computeIntradaySignal, resetSignalState } from "./tier3-signal.js";
import { getRelevantNewsByAsset } from "./stock-news.js";

const ASSET_ID = "nse_market";
const FIRST_RUN_DELAY_MS = 2 * 60 * 1000; // 2 min after startup

// Cadence in ms by window
const CADENCE_OPEN = 5 * 60 * 1000;        // 5 min
const CADENCE_PRE_POST = 15 * 60 * 1000;   // 15 min
const CADENCE_OFF_HOURS = 60 * 60 * 1000;  // 60 min

// Indian assets to forecast every cycle. Mirrors ASSET_TEMPLATES in intelligence.ts.
const FORECAST_ASSETS: Array<{ id: string; name: string; symbol: string }> = [
  { id: "nifty50",    name: "NIFTY 50 (NSE India)",   symbol: "NIFTY" },
  { id: "sensex",     name: "BSE SENSEX",             symbol: "SENSEX" },
  { id: "reliance",   name: "Reliance Industries",    symbol: "RELIANCE" },
  { id: "tcs",        name: "Tata Consultancy Services", symbol: "TCS" },
  { id: "hdfc-bank",  name: "HDFC Bank",              symbol: "HDFCBANK" },
  { id: "gold",       name: "Gold (₹/10g)",           symbol: "GOLD" },
  { id: "silver",     name: "Silver (₹/kg)",          symbol: "SILVER" },
];

type Window = "pre-market" | "open" | "closed";

/**
 * IST market windows:
 *   pre-market : 08:45–09:15  (snapshots warm up before open)
 *   open       : 09:15–15:30  (live 5-min cycles)
 *   closed     : everything else (overnight + weekend + post-close + off-hours)
 *
 * During `closed` we still run HMM regime detection (Yahoo data is fresh 24/7)
 * but we DO NOT generate market-snapshot rows. The UI shows "Markets closed —
 * next session: <date>". Tomorrow's pre-market window generates the next day's
 * first fresh prediction.
 */
function currentWindow(): Window {
  const now = new Date();
  // IST = UTC+5:30
  const istMin = (now.getUTCHours() * 60 + now.getUTCMinutes() + 330) % (24 * 60);
  const istDay = (new Date(now.getTime() + 330 * 60 * 1000)).getUTCDay(); // 0=Sun, 6=Sat
  // Weekends are always closed
  if (istDay === 0 || istDay === 6) return "closed";
  if (istMin >= 525 && istMin < 555) return "pre-market";   // 08:45–09:15
  if (istMin >= 555 && istMin < 930) return "open";          // 09:15–15:30
  return "closed";                                            // post-close + overnight
}

function cadenceForWindow(w: Window): number {
  switch (w) {
    case "open":       return CADENCE_OPEN;
    case "pre-market": return CADENCE_PRE_POST;
    case "closed":     return CADENCE_OFF_HOURS;
  }
}

// Compute the next 09:15 IST trading-day timestamp (skips Sat/Sun).
// 09:15 IST = 03:45 UTC. Set UTC hours directly — no +offset/-offset dance.
export function nextSessionOpenAt(from: Date = new Date()): Date {
  const offsetMs = 330 * 60 * 1000;
  let candidate = new Date(from);
  candidate.setUTCHours(3, 45, 0, 0); // 03:45 UTC = 09:15 IST today
  if (candidate <= from) {
    candidate = new Date(candidate.getTime() + 24 * 60 * 60 * 1000);
  }
  // Skip weekend
  for (let i = 0; i < 7; i++) {
    const istDay = (new Date(candidate.getTime() + offsetMs)).getUTCDay();
    if (istDay !== 0 && istDay !== 6) break;
    candidate = new Date(candidate.getTime() + 24 * 60 * 60 * 1000);
  }
  return candidate;
}

// Compute today's 15:30 IST close timestamp (10:00 UTC).
export function currentSessionClosesAt(from: Date = new Date()): Date {
  const candidate = new Date(from);
  candidate.setUTCHours(10, 0, 0, 0); // 10:00 UTC = 15:30 IST
  return candidate;
}

export function getMarketStatus(now: Date = new Date()): {
  status: "open" | "pre-market" | "closed";
  nextOpen: string;
  currentClose: string;
} {
  const w = currentWindow();
  // Map internal Window to public status
  const status = w === "open" ? "open" as const : w === "pre-market" ? "pre-market" as const : "closed" as const;
  return {
    status,
    nextOpen: nextSessionOpenAt(now).toISOString(),
    currentClose: currentSessionClosesAt(now).toISOString(),
  };
}

async function detectAndStoreRegime(): Promise<boolean> {
  try {
    const features = await fetchRegimeFeatures(30);
    if (features.length < 5) {
      logger.warn({ count: features.length }, "market-scheduler: insufficient features for HMM");
      return false;
    }

    const regime = detectRegime(features);
    const latest = features[features.length - 1]!;

    await db.insert(marketRegimesTable).values({
      id: randomUUID(),
      assetId: ASSET_ID,
      regime: regime.regime,
      riskOnProbability: regime.probabilities.RISK_ON,
      riskOffProbability: regime.probabilities.RISK_OFF,
      crisisProbability: regime.probabilities.CRISIS,
      vixLevel: latest.vixLevel,
      vixChange5d: latest.vixChange5d,
      // The DB column is named fiiNetFlow5d for legacy reasons; we now store
      // pcrIntraday in it (PCR replaced FII 5d in the HMM feature vector).
      fiiNetFlow5d: latest.pcrIntraday,
      niftyRealVol10d: latest.niftyRealVol10d,
      inrUsdChange5d: latest.inrUsdChange5d,
      featuresJson: JSON.stringify(features.slice(-30)),
      sequenceSummary: regime.sequenceSummary,
    });

    if (regime.driftAlert) {
      logger.warn({
        avgLogLikelihood: regime.avgLogLikelihood.toFixed(2),
        recommendation: "Review and recalibrate MU/SIGMA constants in hmm-regime.ts",
      }, "market-scheduler: HMM drift alert — model parameters may no longer describe current market");
    }

    logger.info({
      regime: regime.regime,
      confidence: regime.confidence.toFixed(2),
      sequence: regime.sequenceSummary,
      vix: latest.vixLevel,
      pcr: latest.pcrIntraday.toFixed(2),
      avgLL: regime.avgLogLikelihood.toFixed(2),
      drift: regime.driftAlert,
    }, "market-scheduler: regime stored");
    return true;
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err }, "market-scheduler: regime detection failed");
    return false;
  }
}

async function runEnsembleForAllAssets(window: Window): Promise<void> {
  // Load LATEST stored regime (within last 24h). Without ORDER BY, Postgres
  // returned rows in physical/arbitrary order — the scheduler was picking up
  // an old CRISIS row from initial setup, passing CRISIS into every ensemble
  // call, and confidenceWeightedVote was returning UNCERTAIN on every asset.
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const rows = await db
    .select()
    .from(marketRegimesTable)
    .where(gt(marketRegimesTable.detectedAt, cutoff))
    .orderBy(desc(marketRegimesTable.detectedAt))
    .limit(1)
    .then((r) => r);
  if (rows.length === 0) {
    logger.info("market-scheduler: no recent regime row, skipping ensemble");
    return;
  }

  // Build a RegimeState-shaped object from the stored row for runMarketAgent
  const last = rows[0]!;
  const regimeState = {
    regime: last.regime as "RISK_ON" | "RISK_OFF" | "CRISIS",
    probabilities: {
      RISK_ON: last.riskOnProbability,
      RISK_OFF: last.riskOffProbability,
      CRISIS: last.crisisProbability,
    },
    confidence: Math.max(last.riskOnProbability, last.riskOffProbability, last.crisisProbability),
    sequenceSummary: last.sequenceSummary ?? "stored",
  };

  // Per-asset raw news, filtered to each instrument's market drivers within the
  // last-trading-day window. One DB query, reused across all assets this cycle.
  const newsByAsset = await getRelevantNewsByAsset(
    FORECAST_ASSETS.map(a => ({ id: a.id, name: a.name })),
  );

  let ok = 0;
  let failed = 0;
  for (const asset of FORECAST_ASSETS) {
    try {
      // Fetch real OHLCV from Yahoo Finance for this asset
      let candleSummary = "Historical price data unavailable";
      let marketStats = "";
      let ohlcvCandles: Array<{
        date: string;
        open: number;
        high: number;
        low: number;
        close: number;
        volume: number;
        changePct: number;
      }> = [];

      try {
        const yahooSymbol = asset.symbol === "NIFTY" ? "^NSEI" :
                            asset.symbol === "SENSEX" ? "^BSESN" :
                            asset.symbol === "GOLD" ? "GC=F" :
                            asset.symbol === "SILVER" ? "SI=F" :
                            `${asset.symbol}.NS`;
        const priceData = await fetchNSEPriceData(yahooSymbol, 7);
        if (priceData.length >= 2) {
          const latest = priceData[priceData.length - 1]!;
          const prev = priceData[priceData.length - 2]!;
          const sevenDayChange = ((latest.close - priceData[0]!.close) / priceData[0]!.close) * 100;
          const avgRange = priceData.slice(1).reduce((s, d) => s + Math.abs(d.returnPct), 0) / (priceData.length - 1);
          const trend = latest.close > prev.close ? "up" : "down";

          candleSummary = priceData.map((d, i) => {
            if (i === 0) return `${d.date}: C=${d.close.toFixed(2)}`;
            return `${d.date}: C=${d.close.toFixed(2)} Chg=${d.returnPct > 0 ? "+" : ""}${d.returnPct.toFixed(2)}%`;
          }).join("\n");

          marketStats = `7-day change: ${sevenDayChange > 0 ? "+" : ""}${sevenDayChange.toFixed(2)}% | Trend: ${trend} | Avg daily range: ${avgRange.toFixed(2)}%`;

          // Build OHLCV candles from close data (Yahoo daily close only)
          // Use close as proxy for open/high/low when full OHLCV unavailable
          ohlcvCandles = priceData.map((d, i) => {
            const prevClose = i > 0 ? priceData[i - 1]!.close : d.close;
            const change = ((d.close - prevClose) / prevClose) * 100;
            return {
              date: d.date,
              open: prevClose,
              high: Math.max(d.close, prevClose),
              low: Math.min(d.close, prevClose),
              close: d.close,
              volume: 0, // volume not available from daily close endpoint
              changePct: i === 0 ? 0 : change,
            };
          });
        }
      } catch (err) {
        logger.warn({ asset: asset.id, err: err instanceof Error ? err.message : err }, "market-scheduler: price fetch failed, using fallback");
      }

      const signal = await runMarketAgent(
        asset.id,
        asset.name,
        asset.symbol,
        regimeState as never,
        candleSummary,
        marketStats,
        null,
        { force: true, ohlcvCandles, relevantNews: newsByAsset.get(asset.id) ?? "" },
      );
      ok++;

      // Update latest snapshot with fresh direction/flip/regime/priceScore
      // so the UI never shows stale morning data when AI has changed its mind.
      try {
        const today = todayIstDateKey();
        const todayStart = new Date(`${today}T00:00:00+05:30`);
        const rows = await db
          .select()
          .from(marketSnapshotsTable)
          .where(
            and(
              eq(marketSnapshotsTable.assetId, asset.id),
              gt(marketSnapshotsTable.snapshotAt, todayStart)
            )
          )
          .orderBy(desc(marketSnapshotsTable.snapshotAt))
          .limit(1);

        if (rows.length > 0) {
          const snapshot = rows[0]!;
          const oldDirection = snapshot.predictedDirection;
          const oldFlip = snapshot.flipConfirmed;
          const directionChanged = oldDirection !== signal.direction;
          const flipChanged = oldFlip !== signal.flipConfirmed;
          const oldPriceScore = snapshot.priceScore ?? 0;
          const priceScoreChanged = Math.abs(oldPriceScore - signal.priceScore) > 0.15;
          const confidenceBoosted = (snapshot.predictedConfidence === "low" && (signal.confidence === "medium" || signal.confidence === "high"));
          const isMaterialChange = directionChanged || flipChanged || priceScoreChanged || confidenceBoosted;

          if (isMaterialChange) {
            // Material change — create a NEW snapshot row so the signal executor
            // sees it and historical tracking is preserved.
            const now = new Date();
            let resolveAfter: Date;
            resolveAfter = new Date(now);
            resolveAfter.setUTCHours(10, 0, 0, 0); // 15:30 IST market close
            if (resolveAfter.getTime() <= now.getTime()) {
              resolveAfter = new Date(resolveAfter.getTime() + 24 * 60 * 60 * 1000);
              while (isWeekendForDate(resolveAfter)) {
                resolveAfter = new Date(resolveAfter.getTime() + 24 * 60 * 60 * 1000);
              }
            }
            const latestPrice = ohlcvCandles.length > 0 ? ohlcvCandles[ohlcvCandles.length - 1]!.close : null;

            await db.insert(marketSnapshotsTable).values({
              id: randomUUID(),
              assetId: asset.id,
              assetName: asset.name,
              assetSymbol: asset.symbol,
              predictedDirection: signal.direction === "uncertain" ? "neutral" : signal.direction,
              predictedMagnitude: signal.magnitude,
              predictedConfidence: signal.confidence,
              priceImpactEstimate: signal.priceImpactEstimate,
              timeframe: "intraday",
              bullScore: signal.bullScore.toString(),
              bearScore: signal.bearScore.toString(),
              dominantNarrative: signal.dominantNarrative,
              verdict: signal.verdict,
              triggerNewsSummary: signal.triggerNewsSummary,
              assumptions: signal.assumptions,
              triggerArticleIds: JSON.stringify([]),
              resolveAfter,
              ...(latestPrice !== null ? { realPriceAtSnapshot: latestPrice.toString() } : {}),
              priceScore: signal.priceScore,
              flipConfirmed: signal.flipConfirmed,
              regimeAtSnapshot: signal.regime,
              tier3Evidence: JSON.stringify(signal.tier3Evidence),
              candleTrustScore: signal.candleTrustScore,
              regimeAge: signal.regimeAge,
              ...(signal.candleFlags?.length ? { candleFlags: JSON.stringify(signal.candleFlags) } : {}),
              ...(signal.channelDecaySummary?.length ? { channelDecaySummary: JSON.stringify(signal.channelDecaySummary) } : {}),
              ...(signal.regimeProbabilities ? { regimeProbabilities: JSON.stringify(signal.regimeProbabilities) } : {}),
              ...(signal.activeChannels?.length ? { activeChannels: JSON.stringify(signal.activeChannels) } : {}),
              ...(signal.ensembleVotes?.length ? { ensembleVotes: JSON.stringify(signal.ensembleVotes) } : {}),
              uncertaintyFlag: signal.uncertaintyFlag,
              ...(signal.tier3Evidence?.maxPainStrike != null ? { maxPainStrike: signal.tier3Evidence.maxPainStrike.toString() } : {}),
              ...(signal.tier3Evidence?.maxPainDistancePct != null ? { maxPainDistancePct: signal.tier3Evidence.maxPainDistancePct } : {}),
              ...(signal.tier3Evidence?.sgxNiftyChangePct != null ? { sgxNiftyChangePct: signal.tier3Evidence.sgxNiftyChangePct } : {}),
              ...(signal.tier3Evidence?.shortCoveringSignal != null ? { shortCoveringSignal: signal.tier3Evidence.shortCoveringSignal } : {}),
              ...(directionChanged || flipChanged ? { flipReason: directionChanged ? `Direction flipped to ${signal.direction}` : `Flip confirmed=${signal.flipConfirmed}` } : {}),
            });

            logger.info({
              assetId: asset.id,
              oldDirection,
              newDirection: signal.direction,
              flip: signal.flipConfirmed,
              priceScore: signal.priceScore.toFixed(3),
              regime: signal.regime,
              reason: directionChanged ? "direction" : flipChanged ? "flip" : priceScoreChanged ? "priceScore" : "confidence",
            }, "market-scheduler: snapshot created from ensemble (material change)");
          } else {
            // No material change — update existing row, but refresh snapshotAt
            // so the signal executor still sees it within its 30-minute window.
            await db
              .update(marketSnapshotsTable)
              .set({
                predictedDirection: signal.direction,
                predictedConfidence: signal.confidence,
                flipConfirmed: signal.flipConfirmed,
                priceScore: signal.priceScore,
                regimeAtSnapshot: signal.regime,
                tier3Evidence: JSON.stringify(signal.tier3Evidence),
                timeframe: "intraday",
                snapshotAt: new Date(),
                ...(directionChanged || flipChanged ? { flipReason: directionChanged ? `Direction flipped to ${signal.direction}` : `Flip confirmed=${signal.flipConfirmed}` } : {}),
              })
              .where(eq(marketSnapshotsTable.id, snapshot.id));

            logger.info({
              assetId: asset.id,
              oldDirection,
              newDirection: signal.direction,
              flip: signal.flipConfirmed,
              priceScore: signal.priceScore.toFixed(3),
              regime: signal.regime,
            }, "market-scheduler: snapshot refreshed from ensemble");
          }
        } else {
          // No snapshot for today yet — create one so the UI has fresh data.
          const now = new Date();
          let resolveAfter: Date;
          resolveAfter = new Date(now);
          resolveAfter.setUTCHours(10, 0, 0, 0); // 15:30 IST market close
          if (resolveAfter.getTime() <= now.getTime()) {
            resolveAfter = new Date(resolveAfter.getTime() + 24 * 60 * 60 * 1000);
            while (isWeekendForDate(resolveAfter)) {
              resolveAfter = new Date(resolveAfter.getTime() + 24 * 60 * 60 * 1000);
            }
          }
          const latestPrice = ohlcvCandles.length > 0 ? ohlcvCandles[ohlcvCandles.length - 1]!.close : null;

          await db.insert(marketSnapshotsTable).values({
            id: randomUUID(),
            assetId: asset.id,
            assetName: asset.name,
            assetSymbol: asset.symbol,
            predictedDirection: signal.direction === "uncertain" ? "neutral" : signal.direction,
            predictedMagnitude: signal.magnitude,
            predictedConfidence: signal.confidence,
            priceImpactEstimate: signal.priceImpactEstimate,
            timeframe: "intraday",
            bullScore: signal.bullScore.toString(),
            bearScore: signal.bearScore.toString(),
            dominantNarrative: signal.dominantNarrative,
            verdict: signal.verdict,
            triggerNewsSummary: signal.triggerNewsSummary,
            assumptions: signal.assumptions,
            triggerArticleIds: JSON.stringify([]),
            resolveAfter,
            ...(latestPrice !== null ? { realPriceAtSnapshot: latestPrice.toString() } : {}),
            priceScore: signal.priceScore,
            flipConfirmed: signal.flipConfirmed,
            regimeAtSnapshot: signal.regime,
            tier3Evidence: JSON.stringify(signal.tier3Evidence),
            candleTrustScore: signal.candleTrustScore,
            regimeAge: signal.regimeAge,
            ...(signal.candleFlags?.length ? { candleFlags: JSON.stringify(signal.candleFlags) } : {}),
            ...(signal.channelDecaySummary?.length ? { channelDecaySummary: JSON.stringify(signal.channelDecaySummary) } : {}),
            ...(signal.regimeProbabilities ? { regimeProbabilities: JSON.stringify(signal.regimeProbabilities) } : {}),
            ...(signal.activeChannels?.length ? { activeChannels: JSON.stringify(signal.activeChannels) } : {}),
            ...(signal.ensembleVotes?.length ? { ensembleVotes: JSON.stringify(signal.ensembleVotes) } : {}),
            uncertaintyFlag: signal.uncertaintyFlag,
            ...(signal.tier3Evidence?.maxPainStrike != null ? { maxPainStrike: signal.tier3Evidence.maxPainStrike.toString() } : {}),
            ...(signal.tier3Evidence?.maxPainDistancePct != null ? { maxPainDistancePct: signal.tier3Evidence.maxPainDistancePct } : {}),
            ...(signal.tier3Evidence?.sgxNiftyChangePct != null ? { sgxNiftyChangePct: signal.tier3Evidence.sgxNiftyChangePct } : {}),
            ...(signal.tier3Evidence?.shortCoveringSignal != null ? { shortCoveringSignal: signal.tier3Evidence.shortCoveringSignal } : {}),
          });

          logger.info({
            assetId: asset.id,
            direction: signal.direction,
            confidence: signal.confidence,
            priceScore: signal.priceScore.toFixed(3),
            regime: signal.regime,
          }, "market-scheduler: snapshot created from ensemble");
        }
      } catch (err) {
        logger.warn({ asset: asset.id, err: err instanceof Error ? err.message : err }, "market-scheduler: snapshot update failed");
      }
    } catch (err) {
      failed++;
      logger.warn({ asset: asset.id, err: err instanceof Error ? err.message : err }, "market-scheduler: ensemble failed");
    }
  }
  logger.info({ window, ok, failed }, "market-scheduler: ensemble cycle complete");
  // touch cutoff so the linter doesn't complain in case we wire it later
  void cutoff;
}

// ── Session priors lifecycle ──────────────────────────────────────────────────
// Load EOD data from previous session once at market open and hold constant all
// day. Track the trading date in memory so the 5-minute cycle never re-fetches.

let _priorsLoadedFor: string | null = null;

function todayIstDateKey(): string {
  const now = new Date();
  const istMin = now.getUTCMinutes() + now.getUTCHours() * 60 + 330;
  const istDate = new Date(now.getTime());
  istDate.setUTCMinutes(istMin);
  return istDate.toISOString().slice(0, 10);
}

function isWeekendForDate(d: Date): boolean {
  const day = d.getUTCDay();
  return day === 0 || day === 6;
}

async function onMarketOpen(): Promise<void> {
  const today = todayIstDateKey();
  if (_priorsLoadedFor === today) return; // already loaded for this session
  try {
    const priors = await fetchSessionPriors();
    setSessionPriors(priors);
    resetSignalState(); // drop any prior-session ticks from the intraday signal buffer
    _priorsLoadedFor = today;
    logger.info({
      fiiNet: priors.fiiNetFlowCrore,
      diiNet: priors.diiNetFlowCrore,
      deliveryPct: priors.deliveryPct,
      fiiParticipantOINet: priors.fiiParticipantOINet,
      tradingDate: priors.tradingDate,
    }, "market-scheduler: session priors loaded at market open — frozen for today");
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err }, "market-scheduler: session prior load failed");
  }
}

// Reset flip guards once when transitioning into pre-market for a new trading
// day. Tomorrow's first prediction starts with no inertia from yesterday's
// confirmed BULLISH/BEARISH state.
let _flipGuardsResetFor: string | null = null;

async function resetFlipGuardsForNewSession(): Promise<void> {
  const today = todayIstDateKey();
  if (_flipGuardsResetFor === today) return;
  try {
    await db
      .update(flipGuardsTable)
      .set({
        pendingDirection: null,
        pendingCount: 0,
        confirmedDirection: "uncertain",
        updatedAt: new Date(),
      });
    _flipGuardsResetFor = today;
    logger.info({ tradingDate: today }, "market-scheduler: flip guards reset for new session");
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : err }, "market-scheduler: flip guard reset failed");
  }
}

async function runCycle(): Promise<void> {
  const window = currentWindow();
  logger.info({ window }, "market-scheduler: cycle starting");

  // HMM regime detection runs in every cycle — Yahoo data is fresh 24/7, so the
  // regime stays current even outside market hours, ready for the next open.
  await detectAndStoreRegime();

  // Skip ensemble + snapshot generation when market is closed.
  // No new market_snapshots rows are written; UI shows "Markets closed".
  if (window === "closed") {
    logger.info({ window }, "market-scheduler: market closed — skipping ensemble + snapshot");
    return;
  }

  // Session priors: load once per session at first open cycle (or pre-market).
  // The 5-minute live cycle never re-fetches these EOD signals.
  if (_priorsLoadedFor !== todayIstDateKey()) {
    await onMarketOpen();
  }
  // Ensure priors exist on cold start mid-day so live cycles can compose them.
  if (!getSessionPriors()) {
    await onMarketOpen();
  }

  // Fresh trading day → wipe stale flip guard state from yesterday before any
  // ensemble runs, so the first prediction isn't anchored to yesterday's confirmed direction.
  await resetFlipGuardsForNewSession();

  // Run ensemble (creates market_snapshots row)
  await runEnsembleForAllAssets(window);
}

function scheduleNext(): void {
  const window = currentWindow();
  const delay = cadenceForWindow(window);
  setTimeout(async () => {
    try {
      await runCycle();
    } catch (err) {
      logger.error({ err }, "market-scheduler: cycle threw");
    }
    scheduleNext();
  }, delay);
}

export function startMarketScheduler(): void {
  const window = currentWindow();
  logger.info({ window, firstRunMs: FIRST_RUN_DELAY_MS }, "market-scheduler: registering");
  setTimeout(async () => {
    try {
      await runCycle();
    } catch (err) {
      logger.error({ err }, "market-scheduler: initial cycle threw");
    }
    scheduleNext();
  }, FIRST_RUN_DELAY_MS);

  // Start 30-second tier3 + price refresh cycle (Option A: live signal updates)
  startTier3RefreshTimer();
}

// ── 30-second tier3 + price refresh (Option A) ────────────────────────────────
// Refreshes existing market_snapshots with live tier3 + current price so the UI
// option signal reacts intraday without waiting for the next ensemble cycle.

const TIER3_REFRESH_MS = 30_000; // 30 seconds

function startTier3RefreshTimer(): void {
  logger.info({ intervalMs: TIER3_REFRESH_MS }, "market-scheduler: tier3 refresh timer starting");
  setInterval(async () => {
    try {
      await refreshSnapshotTier3();
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : err }, "market-scheduler: tier3 refresh failed");
    }
  }, TIER3_REFRESH_MS);
}

async function refreshSnapshotTier3(): Promise<void> {
  const window = currentWindow();
  if (window === "closed") return; // only refresh during market hours

  // 1. Fetch fresh tier3 (PCR, Max Pain, VIX, ADR, etc.)
  const tier3 = await fetchTier3Snapshot();

  // 1b. Feed the intraday microstructure signal engine one tick, then read its verdict.
  // Only record when we actually have option-chain microstructure (spot + OI present);
  // the Firecrawl fallbacks return zeros which would poison the rolling windows.
  if (tier3.spotPrice && tier3.callOI > 0 && tier3.putOI > 0) {
    recordObservation({
      t: Date.now(),
      price: tier3.spotPrice,
      callOI: tier3.callOI,
      putOI: tier3.putOI,
      optionVolume: tier3.optionVolume,
      atmIV: tier3.impliedVolPct ?? 0,
      atmGamma: tier3.atmGamma,
    });
  }
  const intraday = computeIntradaySignal();

  // 2. Fetch current prices for all assets (live intraday, not daily close)
  const prices = await Promise.all(
    FORECAST_ASSETS.map(async (asset) => {
      try {
        const yahooSymbol = asset.symbol === "NIFTY" ? "^NSEI" :
                            asset.symbol === "SENSEX" ? "^BSESN" :
                            asset.symbol === "GOLD" ? "GC=F" :
                            asset.symbol === "SILVER" ? "SI=F" :
                            `${asset.symbol}.NS`;
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?interval=1d&range=1d`;
        const resp = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(8000) });
        if (!resp.ok) return { assetId: asset.id, price: null as number | null, changePct: 0 };
        const json = await resp.json() as {
          chart?: { result?: Array<{ meta?: { regularMarketPrice?: number; previousClose?: number } }> };
        };
        const meta = json.chart?.result?.[0]?.meta;
        if (meta?.regularMarketPrice != null) {
          const prev = meta.previousClose ?? meta.regularMarketPrice;
          return {
            assetId: asset.id,
            price: meta.regularMarketPrice,
            changePct: prev ? ((meta.regularMarketPrice - prev) / prev) * 100 : 0,
          };
        }
      } catch {
        // skip
      }
      return { assetId: asset.id, price: null as number | null, changePct: 0 };
    })
  );

  // 3. Find today's latest snapshot per asset and UPDATE with fresh data
  const today = todayIstDateKey();
  const todayStart = new Date(`${today}T00:00:00+05:30`);

  for (const asset of FORECAST_ASSETS) {
    const priceInfo = prices.find(p => p.assetId === asset.id);
    if (!priceInfo || priceInfo.price === null) continue;

    try {
      // Get latest snapshot for this asset today
      const rows = await db
        .select()
        .from(marketSnapshotsTable)
        .where(
          and(
            eq(marketSnapshotsTable.assetId, asset.id),
            gt(marketSnapshotsTable.snapshotAt, todayStart)
          )
        )
        .orderBy(desc(marketSnapshotsTable.snapshotAt))
        .limit(1);

      if (rows.length === 0) continue; // no snapshot yet — ensemble cycle will create it
      const snapshot = rows[0]!;

      // Compute fresh max pain distance using current price
      let freshMaxPainDistance: number | null = null;
      if (tier3.maxPainStrike !== null && priceInfo.price > 0) {
        freshMaxPainDistance = ((priceInfo.price - tier3.maxPainStrike) / tier3.maxPainStrike) * 100;
      }

      // Only update if something materially changed
      const oldTier3 = snapshot.tier3Evidence ? JSON.parse(snapshot.tier3Evidence) as Record<string, unknown> : {};
      const oldPcr = typeof oldTier3.putCallRatio === "number" ? oldTier3.putCallRatio : null;
      const oldMaxPain = snapshot.maxPainDistancePct ?? null;
      const oldPrice = snapshot.realPriceAtSnapshot !== null ? parseFloat(snapshot.realPriceAtSnapshot) : null;

      const pcrChanged = oldPcr === null || tier3.putCallRatio === null || Math.abs(tier3.putCallRatio - oldPcr) > 0.02;
      const maxPainChanged = oldMaxPain === null || freshMaxPainDistance === null || Math.abs(freshMaxPainDistance - oldMaxPain) > 0.10;
      const priceChanged = oldPrice === null || Math.abs(priceInfo.price - oldPrice) / oldPrice > 0.001;

      if (!pcrChanged && !maxPainChanged && !priceChanged) continue;

      // Build updated tier3 evidence
      const updatedTier3 = {
        ...oldTier3,
        putCallRatio: tier3.putCallRatio,
        advanceDeclineRatio: tier3.advanceDeclineRatio,
        indiaVix5dChange: tier3.indiaVix5dChange,
        maxPainStrike: tier3.maxPainStrike,
        maxPainDistancePct: freshMaxPainDistance,
        sgxNiftyChangePct: tier3.sgxNiftyChangePct,
        shortCoveringSignal: tier3.shortCoveringSignal,
        intradaySignal: intraday, // microstructure gate verdict — must be persisted for the executor to read it
      };

      await db
        .update(marketSnapshotsTable)
        .set({
          tier3Evidence: JSON.stringify(updatedTier3),
          realPriceAtSnapshot: priceInfo.price.toString(),
          maxPainDistancePct: freshMaxPainDistance,
        })
        .where(eq(marketSnapshotsTable.id, snapshot.id));

      logger.info({
        assetId: asset.id,
        oldPcr: oldPcr !== null ? oldPcr.toFixed(3) : "null",
        newPcr: tier3.putCallRatio !== null ? tier3.putCallRatio.toFixed(3) : "null",
        oldMaxPain: oldMaxPain !== null ? oldMaxPain.toFixed(3) : "null",
        newMaxPain: freshMaxPainDistance !== null ? freshMaxPainDistance.toFixed(3) : "null",
        oldPrice: oldPrice !== null ? oldPrice.toFixed(2) : "null",
        newPrice: priceInfo.price.toFixed(2),
      }, "market-scheduler: snapshot tier3 refreshed");
    } catch (err) {
      logger.warn({ asset: asset.id, err: err instanceof Error ? err.message : err }, "market-scheduler: refresh snapshot failed");
    }
  }
}

// Re-exports consumed by intelligence.ts and other services
export { detectRegime } from "./hmm-regime.js";
export { fetchRegimeFeatures, fetchNSEPriceData } from "./nse-direct-scraper.js";
export { runMarketAgent } from "./market-agent.js";
