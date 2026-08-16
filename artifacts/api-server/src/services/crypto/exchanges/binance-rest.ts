// Binance REST API client — order placement, cancellation, position/balance queries.
//
// Used for the execution path (not the hot data path — that's the WS connector).
// Implements the broker-adapter interface so the system can support multiple
// exchanges behind a common interface.
//
// Security: API keys are read from environment variables, never hardcoded.
// Required env vars:
//   BINANCE_API_KEY    — API key
//   BINANCE_API_SECRET — API secret (for HMAC signing)
//   BINANCE_TESTNET    — "true" to use testnet endpoints

import crypto from "node:crypto";
import { logger } from "../../../lib/logger.js";
import { randomUUID } from "node:crypto";
import { db } from "@workspace/db";
import { cryptoOrdersTable } from "@workspace/db";
import { enqueueAudit } from "../../../lib/audit-queue.js";
import type {
  CryptoOrderRequest,
  CryptoOrderResponse,
  CryptoPosition,
  CryptoBalance,
  CryptoOrderStatus,
} from "../types.js";

const BINANCE_SPOT_REST = process.env["BINANCE_TESTNET"] === "true"
  ? "https://testnet.binance.vision"
  : "https://api.binance.com";

const BINANCE_FUTURES_REST = process.env["BINANCE_TESTNET"] === "true"
  ? "https://testnet.binancefuture.com"
  : "https://fapi.binance.com";

const API_KEY = process.env["BINANCE_API_KEY"] ?? "";
const API_SECRET = process.env["BINANCE_API_SECRET"] ?? "";

let _userId = process.env["CRYPTO_USER_ID"] ?? "crypto-default";

function getBaseUrl(marketType: "spot" | "perp"): string {
  return marketType === "perp" ? BINANCE_FUTURES_REST : BINANCE_SPOT_REST;
}

function sign(queryString: string): string {
  return crypto.createHmac("sha256", API_SECRET).update(queryString).digest("hex");
}

async function binanceRequest(
  method: "GET" | "POST" | "DELETE",
  path: string,
  params: Record<string, string | number | boolean | undefined>,
  marketType: "spot" | "perp" = "spot",
  isSigned = true,
): Promise<any> {
  if (!API_KEY || !API_SECRET) {
    throw new Error("Binance API credentials not configured (BINANCE_API_KEY / BINANCE_API_SECRET)");
  }

  const base = getBaseUrl(marketType);
  const ts = Date.now();
  const allParams: Record<string, string> = { timestamp: String(ts) };
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) {
      allParams[k] = String(v);
    }
  }

  let queryString = new URLSearchParams(allParams).toString();
  if (isSigned) {
    queryString += `&signature=${sign(queryString)}`;
  }

  const url = `${base}${path}?${queryString}`;

  const res = await fetch(url, {
    method,
    headers: {
      "X-MBX-APIKEY": API_KEY,
      "Content-Type": "application/json",
    },
  });

  const data = await res.json();

  if (!res.ok) {
    const errMsg = (data as any)?.msg ?? `HTTP ${res.status}`;
    logger.error({ method, path, status: res.status, msg: errMsg }, "binance-rest: request failed");
    throw new Error(`Binance API error: ${errMsg}`);
  }

  return data;
}

// ── Order placement ───────────────────────────────────────────────────────────

export async function placeCryptoOrder(
  userId: string,
  req: CryptoOrderRequest,
): Promise<CryptoOrderResponse> {
  const marketType: "spot" | "perp" = "spot"; // extend when perps are enabled

  const params: Record<string, string | number | boolean | undefined> = {
    symbol: req.symbol,
    side: req.side,
    type: req.type,
    quantity: req.quantity,
    newClientOrderId: req.clientOrderId,
  };

  if (req.price !== undefined && req.type === "LIMIT") {
    params.price = req.price;
    params.timeInForce = req.timeInForce ?? "GTC";
  }

  if (req.stopPrice !== undefined) {
    params.stopPrice = req.stopPrice;
  }

  if (req.reduceOnly) {
    params.reduceOnly = "true";
  }

  const response = await binanceRequest("POST", "/api/v3/order", params, marketType);

  const orderResponse: CryptoOrderResponse = {
    orderId: String(response.orderId),
    clientOrderId: response.clientOrderId ?? req.clientOrderId,
    status: mapBinanceStatus(response.status),
    executedQty: parseFloat(response.executedQty ?? "0"),
    avgPrice: response.avgPrice ? parseFloat(response.avgPrice) : null,
    symbol: response.symbol ?? req.symbol,
    side: response.side ?? req.side,
    type: response.type ?? req.type,
    quantity: parseFloat(response.origQty ?? String(req.quantity)),
    price: response.price ? parseFloat(response.price) : null,
    timestamp: response.transactTime ?? Date.now(),
  };

  // Persist to DB asynchronously
  enqueueAudit("crypto-order-insert", async () => {
    await db.insert(cryptoOrdersTable).values({
      id: randomUUID(),
      userId,
      exchange: "binance",
      exchangeOrderId: orderResponse.orderId,
      clientOrderId: orderResponse.clientOrderId,
      symbol: req.symbol,
      assetId: req.symbol.replace("USDT", "").toLowerCase(),
      side: req.side,
      type: req.type,
      timeInForce: req.timeInForce ?? "GTC",
      quantity: String(req.quantity),
      price: req.price ? String(req.price) : null,
      stopPrice: req.stopPrice ? String(req.stopPrice) : null,
      executedQty: String(orderResponse.executedQty),
      avgPrice: orderResponse.avgPrice ? String(orderResponse.avgPrice) : null,
      status: orderResponse.status,
      reduceOnly: req.reduceOnly ?? false,
      leverage: req.leverage ?? 1,
      marketType,
      isPaperTrade: false,
      placedAt: new Date(),
      updatedAt: new Date(),
    });
  });

  logger.info({
    symbol: req.symbol,
    side: req.side,
    type: req.type,
    orderId: orderResponse.orderId,
    status: orderResponse.status,
  }, "binance-rest: order placed");

  return orderResponse;
}

export async function cancelCryptoOrder(
  userId: string,
  symbol: string,
  orderId: string,
  marketType: "spot" | "perp" = "spot",
): Promise<void> {
  const path = marketType === "perp" ? "/fapi/v1/order" : "/api/v3/order";
  await binanceRequest("DELETE", path, { symbol, orderId }, marketType);
  logger.info({ symbol, orderId }, "binance-rest: order cancelled");
}

// ── Position & balance queries ────────────────────────────────────────────────

export async function getCryptoAccountBalances(marketType: "spot" | "perp" = "spot"): Promise<CryptoBalance[]> {
  const path = marketType === "perp" ? "/fapi/v2/balance" : "/api/v3/account";
  const data = await binanceRequest("GET", path, {}, marketType);

  if (marketType === "perp") {
    return (data as any[]).map((b) => ({
      asset: b.asset,
      free: parseFloat(b.availableBalance ?? "0"),
      locked: parseFloat(b.balance ?? "0") - parseFloat(b.availableBalance ?? "0"),
      timestamp: Date.now(),
    }));
  }

  const balances = (data.balances as any[]) ?? [];
  return balances.map((b) => ({
    asset: b.asset,
    free: parseFloat(b.free ?? "0"),
    locked: parseFloat(b.locked ?? "0"),
    timestamp: Date.now(),
  }));
}

export async function getCryptoPositions(): Promise<CryptoPosition[]> {
  const data = await binanceRequest("GET", "/fapi/v2/positionRisk", {}, "perp");
  return (data as any[])
    .filter((p) => parseFloat(p.positionAmt) !== 0)
    .map((p) => ({
      symbol: p.symbol,
      side: parseFloat(p.positionAmt) > 0 ? "LONG" : "SHORT",
      quantity: Math.abs(parseFloat(p.positionAmt)),
      entryPrice: parseFloat(p.entryPrice),
      markPrice: parseFloat(p.markPrice),
      unrealizedPnl: parseFloat(p.unRealizedProfit),
      leverage: parseInt(p.leverage, 10),
      marginType: p.marginType,
      liquidationPrice: p.liquidationPrice ? parseFloat(p.liquidationPrice) : null,
      timestamp: Date.now(),
    }));
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function mapBinanceStatus(status: string): CryptoOrderStatus {
  const map: Record<string, CryptoOrderStatus> = {
    NEW: "NEW",
    PARTIALLY_FILLED: "PARTIALLY_FILLED",
    FILLED: "FILLED",
    CANCELED: "CANCELLED",
    CANCELLED: "CANCELLED",
    REJECTED: "REJECTED",
    EXPIRED: "EXPIRED",
    PENDING_NEW: "PENDING",
  };
  return map[status] ?? "PENDING";
}

export function isBinanceConfigured(): boolean {
  return !!API_KEY && !!API_SECRET;
}

export function setCryptoUserId(userId: string): void {
  _userId = userId;
}
