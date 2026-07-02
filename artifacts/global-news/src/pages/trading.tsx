import React, { useState, useEffect, useCallback } from "react";
import { AppLayout } from "@/components/layout";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { useAuth } from "@/hooks/use-auth";
import {
  Link2,
  Link2Off,
  TrendingUp,
  Shield,
  Settings,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Loader2,
  Unplug,
  Wallet,
  Activity,
  BarChart3,
  History,
  Target,
  ArrowUpRight,
  ArrowDownRight,
} from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

interface BrokerStatus {
  connected: boolean;
  autoTradeEnabled: boolean;
  brokerName: string;
  expiresAt: string | null;
}

interface TradePreference {
  id: string;
  userId: string;
  assetId: string;
  assetSymbol: string;
  enabled: boolean;
  maxRiskPerTradePct: number | null;
  defaultProduct: string | null;
  defaultOrderType: string | null;
  customQuantity: number | null;
  targetPct: string;
  stopLossPct: string;
  useGttBracket: boolean;
  exitStrategy: string;
  trailGapPct: string;
  minConfidence: string;
  onlyIntraday: boolean;
}

interface TradePreferencesResponse {
  assets: Array<{ id: string; name: string; symbol: string; exchange: string }>;
  preferences: TradePreference[];
}

const API_BASE = "/api";

interface MarketData {
  spotPrice: number;
  callOI: number;
  putOI: number;
  optionVolume: number;
  atmIV: number;
  atmGamma: number;
  pcr: number;
  maxPainStrike: number | null;
  source: string;
}

interface Execution {
  id: string;
  assetSymbol: string;
  direction: string;
  quantity: number;
  entryPrice: number;
  currentPrice: number | null;
  unrealizedPnl: number | null;
  realisedPnl: number | null;
  highestPriceReached: number | null;
  stopLossPrice: number | null;
  exitPrice: number | null;
  exitStrategy: string | null;
  exitReason: string | null;
  status: string;
  notes: string | null;
  executedAt: string;
  closedAt: string | null;
}

interface OrderInfo {
  order_id: string;
  tradingsymbol: string;
  exchange: string;
  transaction_type: string;
  order_type: string;
  product: string;
  status: string;
  quantity: number;
  price: number;
  average_price: number;
  filled_quantity: number;
  status_message: string | null;
  order_timestamp: string;
}

function useMarketData() {
  const [data, setData] = useState<MarketData | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/trading/market-data`);
      if (res.ok) {
        setData(await res.json());
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 10000);
    return () => clearInterval(interval);
  }, [fetchData]);

  return { data, loading, refetch: fetchData };
}

function useExecutions(userId: string | undefined) {
  const [data, setData] = useState<{ executions: Execution[] } | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    if (!userId) return;
    try {
      const res = await fetch(`${API_BASE}/trading/executions?userId=${encodeURIComponent(userId)}`);
      if (res.ok) {
        setData(await res.json());
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 5000);
    return () => clearInterval(interval);
  }, [fetchData]);

  return { data, loading, refetch: fetchData };
}

function useOrders(userId: string | undefined) {
  const [data, setData] = useState<{ orders: OrderInfo[] } | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    if (!userId) return;
    try {
      const res = await fetch(`${API_BASE}/trading/orders?userId=${encodeURIComponent(userId)}`);
      if (res.ok) {
        setData(await res.json());
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 10000);
    return () => clearInterval(interval);
  }, [fetchData]);

  return { data, loading, refetch: fetchData };
}

function formatNumber(n: number | null | undefined, decimals = 2): string {
  if (n === null || n === undefined) return "—";
  return n.toLocaleString("en-IN", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function formatPnl(n: number | null | undefined): { text: string; color: string } {
  if (n === null || n === undefined) return { text: "—", color: "text-muted-foreground" };
  const text = (n >= 0 ? "+" : "") + formatNumber(n);
  const color = n >= 0 ? "text-emerald-400" : "text-red-400";
  return { text, color };
}

function useBrokerStatus(userId: string | undefined) {
  const [status, setStatus] = useState<BrokerStatus | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchStatus = useCallback(async () => {
    if (!userId) return;
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/broker/status?userId=${encodeURIComponent(userId)}`);
      if (res.ok) {
        setStatus(await res.json());
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  return { status, loading, refetch: fetchStatus };
}

function useTradePreferences(userId: string | undefined) {
  const [data, setData] = useState<TradePreferencesResponse | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchPrefs = useCallback(async () => {
    if (!userId) return;
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/broker/trade-preferences?userId=${encodeURIComponent(userId)}`);
      if (res.ok) {
        setData(await res.json());
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    fetchPrefs();
  }, [fetchPrefs]);

  return { data, loading, refetch: fetchPrefs };
}

export default function TradingPage() {
  const { user } = useAuth();
  const userId = user?.uid;

  const { status: brokerStatus, loading: statusLoading, refetch: refetchStatus } = useBrokerStatus(userId);
  const { data: prefsData, loading: prefsLoading, refetch: refetchPrefs } = useTradePreferences(userId);
  const { data: marketData, loading: marketLoading } = useMarketData();
  const { data: execData, loading: execLoading } = useExecutions(userId);
  const { data: ordersData, loading: ordersLoading } = useOrders(userId);

  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [updatingPrefs, setUpdatingPrefs] = useState<Record<string, boolean>>({});
  const [configuringAsset, setConfiguringAsset] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Handle Kite OAuth callback redirect (full-page redirect flow for mobile)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const requestToken = params.get("request_token");
    const status = params.get("status");

    if (requestToken && status === "success" && userId) {
      // Restore credentials from sessionStorage (saved before redirect to Kite)
      const savedKey = sessionStorage.getItem("kite_api_key") || "";
      const savedSecret = sessionStorage.getItem("kite_api_secret") || "";
      if (savedKey && savedSecret) {
        setApiKey(savedKey);
        setApiSecret(savedSecret);
        exchangeTokenWithCreds(requestToken, savedKey, savedSecret);
      }
      // Clean URL
      window.history.replaceState({}, document.title, window.location.pathname);
    }
  }, [userId]);

  async function exchangeToken(requestToken: string) {
    const trimmedKey = apiKey.trim();
    const trimmedSecret = apiSecret.trim();
    await exchangeTokenWithCreds(requestToken, trimmedKey, trimmedSecret);
  }

  async function exchangeTokenWithCreds(requestToken: string, trimmedKey: string, trimmedSecret: string) {
    setConnecting(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/broker/callback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestToken, userId, apiKey: trimmedKey, apiSecret: trimmedSecret }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to connect");
      }
      await refetchStatus();
      await refetchPrefs();
      setApiKey("");
      setApiSecret("");
      sessionStorage.removeItem("kite_api_key");
      sessionStorage.removeItem("kite_api_secret");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Connection failed");
    } finally {
      setConnecting(false);
    }
  }

  async function handleConnect() {
    if (!apiKey.trim() || !apiSecret.trim() || !userId) {
      setError("API Key and Secret are required");
      return;
    }
    setError(null);
    setConnecting(true);
    try {
      // 1. Get login URL from backend using user's API key
      const urlRes = await fetch(`${API_BASE}/broker/login-url?apiKey=${encodeURIComponent(apiKey)}`);
      if (!urlRes.ok) throw new Error("Failed to get login URL");
      const { loginUrl } = await urlRes.json();

      // Save credentials to sessionStorage so we can retrieve them after redirect
      sessionStorage.setItem("kite_api_key", apiKey.trim());
      sessionStorage.setItem("kite_api_secret", apiSecret.trim());

      // 2. Detect mobile — popup polling doesn't work on mobile browsers
      const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);

      if (isMobile) {
        // Full-page redirect flow for mobile
        window.location.href = loginUrl;
        return;
      }

      // 3. Open Kite login in popup (desktop)
      const popup = window.open(loginUrl, "kite_oauth", "width=500,height=600");
      if (!popup) {
        // Fallback: redirect full page
        window.location.href = loginUrl;
        return;
      }

      // 4. Poll for redirect
      const interval = setInterval(() => {
        try {
          if (popup.closed) {
            clearInterval(interval);
            setConnecting(false);
            sessionStorage.removeItem("kite_api_key");
            sessionStorage.removeItem("kite_api_secret");
            return;
          }
          const popupUrl = popup.location.href;
          if (popupUrl.includes("request_token")) {
            clearInterval(interval);
            const popupParams = new URLSearchParams(new URL(popupUrl).search);
            const requestToken = popupParams.get("request_token");
            popup.close();
            if (requestToken) {
              exchangeToken(requestToken);
            }
          }
        } catch {
          // cross-origin, ignore until redirect completes
        }
      }, 500);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Connection failed");
      setConnecting(false);
    }
  }

  async function handleDisconnect() {
    if (!userId) return;
    setDisconnecting(true);
    try {
      await fetch(`${API_BASE}/broker/disconnect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId }),
      });
      await refetchStatus();
    } catch {
      // ignore
    } finally {
      setDisconnecting(false);
    }
  }

  async function toggleAsset(assetId: string, enabled: boolean) {
    if (!userId) return;
    setUpdatingPrefs((prev) => ({ ...prev, [assetId]: true }));
    try {
      await fetch(`${API_BASE}/broker/trade-preferences`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, assetId, enabled }),
      });
      await refetchPrefs();
    } catch {
      // ignore
    } finally {
      setUpdatingPrefs((prev) => ({ ...prev, [assetId]: false }));
    }
  }

  async function updateAssetConfig(
    assetId: string,
    config: {
      exitStrategy?: string;
      trailGapPct?: string;
      stopLossPct?: string;
      targetPct?: string;
    }
  ) {
    if (!userId) return;
    setUpdatingPrefs((prev) => ({ ...prev, [assetId]: true }));
    try {
      await fetch(`${API_BASE}/broker/trade-preferences`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, assetId, ...config }),
      });
      await refetchPrefs();
    } catch {
      // ignore
    } finally {
      setUpdatingPrefs((prev) => ({ ...prev, [assetId]: false }));
    }
  }

  async function updateAutoTrade(enabled: boolean) {
    if (!userId) return;
    try {
      await fetch(`${API_BASE}/broker/settings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, autoTradeEnabled: enabled }),
      });
      await refetchStatus();
    } catch {
      // ignore
    }
  }

  const isConnected = brokerStatus?.connected ?? false;
  const expiresAt = brokerStatus?.expiresAt
    ? new Date(brokerStatus.expiresAt).toLocaleString()
    : null;

  return (
    <AppLayout>
      <div className="flex-1 overflow-y-auto">
        <div className="p-6 max-w-screen-2xl mx-auto space-y-6">
          {/* Header */}
          <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 bg-[#10131b] border border-border/30 p-4 rounded-lg">
            <div className="flex items-center gap-3">
              <div className="h-8 w-8 rounded-lg bg-primary/10 flex items-center justify-center">
                <Wallet className="h-4 w-4 text-primary" />
              </div>
              <div>
                <h1 className="text-xl font-bold tracking-tight" style={{ fontFamily: "'Inter', sans-serif" }}>Trading Hub</h1>
                <p className="text-xs text-muted-foreground">Connect your Zerodha account & manage auto-trade preferences</p>
              </div>
            </div>
            {statusLoading ? (
              <Skeleton className="h-6 w-32 bg-muted/40" />
            ) : (
              <Badge variant={isConnected ? "default" : "outline"} className={isConnected ? "bg-emerald-500/20 text-emerald-400 border-emerald-500/30" : "text-muted-foreground"}>
                {isConnected ? (
                  <><CheckCircle2 className="h-3 w-3 mr-1" /> Connected</>
                ) : (
                  <><XCircle className="h-3 w-3 mr-1" /> Disconnected</>
                )}
              </Badge>
            )}
          </div>

          {/* Error */}
          {error && (
            <div className="flex items-center gap-2 p-3 rounded-md bg-red-500/10 border border-red-500/30 text-red-400 text-sm">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              {error}
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Left: Broker Connection */}
            <div className="lg:col-span-1 space-y-5">
              <Card className="bg-[#10131b] border-border/20 shadow-none rounded-lg">
                <CardHeader className="pb-3 border-b border-border/20">
                  <CardTitle className="text-[11px] font-bold uppercase tracking-[0.12em] flex items-center gap-2 text-muted-foreground">
                    <Link2 className="h-4 w-4 text-primary" />
                    Broker Connection
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-4 space-y-4">
                  {statusLoading ? (
                    <div className="space-y-3">
                      <Skeleton className="h-4 w-full bg-muted/30" />
                      <Skeleton className="h-4 w-3/4 bg-muted/30" />
                    </div>
                  ) : isConnected ? (
                    <div className="space-y-4">
                      <div className="flex items-center gap-3">
                        <div className="h-10 w-10 rounded-full bg-emerald-500/10 flex items-center justify-center">
                          <CheckCircle2 className="h-5 w-5 text-emerald-400" />
                        </div>
                        <div>
                          <p className="text-sm font-medium text-emerald-400">Zerodha Connected</p>
                          <p className="text-xs text-muted-foreground">Auto-trading is {brokerStatus?.autoTradeEnabled ? "enabled" : "disabled"}</p>
                        </div>
                      </div>
                      {expiresAt && (
                        <p className="text-xs text-muted-foreground">Session expires: {expiresAt}</p>
                      )}
                      <div className="flex items-center gap-2 pt-2">
                        <Switch
                          checked={brokerStatus?.autoTradeEnabled ?? false}
                          onCheckedChange={updateAutoTrade}
                        />
                        <Label className="text-sm text-muted-foreground">Auto-Trade</Label>
                      </div>
                      <Button
                        variant="destructive"
                        size="sm"
                        className="w-full mt-2"
                        onClick={handleDisconnect}
                        disabled={disconnecting}
                      >
                        {disconnecting ? (
                          <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Disconnecting...</>
                        ) : (
                          <><Link2Off className="h-4 w-4 mr-2" /> Disconnect</>
                        )}
                      </Button>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      <div className="space-y-1.5">
                        <Label className="text-xs text-muted-foreground">Kite API Key</Label>
                        <Input
                          value={apiKey}
                          onChange={(e) => setApiKey(e.target.value)}
                          placeholder="Enter your Kite API Key"
                          className="bg-[#0c0e14] border-border/30 text-sm"
                          type="text"
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-xs text-muted-foreground">Kite API Secret</Label>
                        <Input
                          value={apiSecret}
                          onChange={(e) => setApiSecret(e.target.value)}
                          placeholder="Enter your Kite API Secret"
                          className="bg-[#0c0e14] border-border/30 text-sm"
                          type="password"
                        />
                      </div>
                      <Button
                        className="w-full mt-2"
                        onClick={handleConnect}
                        disabled={connecting || !apiKey.trim() || !apiSecret.trim()}
                      >
                        {connecting ? (
                          <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Connecting...</>
                        ) : (
                          <><Link2 className="h-4 w-4 mr-2" /> Connect Zerodha</>
                        )}
                      </Button>
                      <p className="text-[10px] text-muted-foreground/60 text-center pt-1">
                        Get your API key from <a href="https://kite.trade" target="_blank" rel="noopener noreferrer" className="underline text-primary/70">kite.trade</a>
                      </p>
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* Info Card */}
              <Card className="bg-[#10131b] border-border/20 shadow-none rounded-lg">
                <CardHeader className="pb-3 border-b border-border/20">
                  <CardTitle className="text-[11px] font-bold uppercase tracking-[0.12em] text-muted-foreground">
                    How It Works
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-4 space-y-3 text-xs text-muted-foreground">
                  <div className="flex gap-2">
                    <span className="text-primary font-bold">1.</span>
                    <span>Enter your Kite Connect API Key & Secret</span>
                  </div>
                  <div className="flex gap-2">
                    <span className="text-primary font-bold">2.</span>
                    <span>Click Connect — you will be redirected to Zerodha login</span>
                  </div>
                  <div className="flex gap-2">
                    <span className="text-primary font-bold">3.</span>
                    <span>After login, select which stocks to auto-trade</span>
                  </div>
                  <div className="flex gap-2">
                    <span className="text-primary font-bold">4.</span>
                    <span>Our AI places orders on your behalf during market hours</span>
                  </div>
                  <Separator className="my-2 bg-border/20" />
                  <p className="text-[10px] text-muted-foreground/50">
                    Your API credentials are stored encrypted. We never see your Zerodha password.
                  </p>
                </CardContent>
              </Card>
            </div>

            {/* Right: Asset Preferences */}
            <div className="lg:col-span-2 space-y-5">
              <Card className="bg-[#10131b] border-border/20 shadow-none rounded-lg">
                <CardHeader className="pb-3 border-b border-border/20">
                  <CardTitle className="text-[11px] font-bold uppercase tracking-[0.12em] flex items-center gap-2 text-muted-foreground">
                    <TrendingUp className="h-4 w-4 text-primary" />
                    Auto-Trade Assets
                  </CardTitle>
                  <CardDescription className="text-xs text-muted-foreground/60">
                    Toggle which assets our AI should trade on your account
                  </CardDescription>
                </CardHeader>
                <CardContent className="p-4">
                  {prefsLoading ? (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      {[...Array(5)].map((_, i) => (
                        <Skeleton key={i} className="h-20 bg-muted/30 rounded-lg" />
                      ))}
                    </div>
                  ) : !isConnected ? (
                    <div className="flex flex-col items-center justify-center py-12 text-center text-muted-foreground">
                      <Unplug className="h-10 w-10 mb-3 text-muted-foreground/30" />
                      <p className="text-sm font-medium">Connect your broker first</p>
                      <p className="text-xs text-muted-foreground/60">Asset preferences will appear here</p>
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      {prefsData?.assets.map((asset) => {
                        const pref = prefsData.preferences.find((p) => p.assetId === asset.id);
                        const enabled = pref?.enabled ?? false;
                        const updating = updatingPrefs[asset.id] ?? false;
                        const isConfiguring = configuringAsset === asset.id;
                        const exitStrategy = pref?.exitStrategy ?? "trailing_ratchet";
                        const trailGapPct = pref?.trailGapPct ?? "15";
                        const stopLossPct = pref?.stopLossPct ?? "2.0";
                        const targetPct = pref?.targetPct ?? "1.2";
                        return (
                          <div
                            key={asset.id}
                            className={`rounded-lg border transition-colors ${
                              enabled
                                ? "bg-primary/5 border-primary/30"
                                : "bg-[#0c0e14] border-border/20"
                            }`}
                          >
                            <div className="flex items-center justify-between p-4">
                              <div className="flex items-center gap-3">
                                <div
                                  className={`h-8 w-8 rounded-md flex items-center justify-center text-xs font-bold ${
                                    enabled ? "bg-primary/20 text-primary" : "bg-muted/30 text-muted-foreground"
                                  }`}
                                >
                                  {asset.symbol.slice(0, 2)}
                                </div>
                                <div>
                                  <p className="text-sm font-medium">{asset.name}</p>
                                  <p className="text-[10px] font-mono text-muted-foreground">
                                    {asset.symbol} · {asset.exchange}
                                  </p>
                                </div>
                              </div>
                              <div className="flex items-center gap-2">
                                {enabled && (
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-7 text-[10px] text-muted-foreground hover:text-primary"
                                    onClick={() => setConfiguringAsset(isConfiguring ? null : asset.id)}
                                  >
                                    <Settings className="h-3 w-3 mr-1" />
                                    {isConfiguring ? "Done" : "Config"}
                                  </Button>
                                )}
                                <Switch
                                  checked={enabled}
                                  onCheckedChange={(v) => toggleAsset(asset.id, v)}
                                  disabled={updating}
                                />
                              </div>
                            </div>

                            {enabled && isConfiguring && (
                              <div className="px-4 pb-4 space-y-3 border-t border-border/10 pt-3">
                                <div className="space-y-1.5">
                                  <Label className="text-[10px] text-muted-foreground">Exit Strategy</Label>
                                  <select
                                    className="w-full h-8 rounded-md border border-border/30 bg-[#0c0e14] px-2 text-xs text-muted-foreground"
                                    value={exitStrategy}
                                    onChange={(e) => updateAssetConfig(asset.id, { exitStrategy: e.target.value })}
                                    disabled={updating}
                                  >
                                    <option value="trailing_ratchet">Trailing Ratchet (No Target)</option>
                                    <option value="fixed_target">Fixed Target</option>
                                  </select>
                                </div>

                                {exitStrategy === "trailing_ratchet" ? (
                                  <div className="grid grid-cols-2 gap-3">
                                    <div className="space-y-1.5">
                                      <Label className="text-[10px] text-muted-foreground">Trail Gap %</Label>
                                      <Input
                                        type="number"
                                        min={5}
                                        max={50}
                                        step={1}
                                        value={trailGapPct}
                                        onChange={(e) => updateAssetConfig(asset.id, { trailGapPct: e.target.value })}
                                        disabled={updating}
                                        className="h-8 text-xs bg-[#0c0e14] border-border/30"
                                      />
                                    </div>
                                    <div className="space-y-1.5">
                                      <Label className="text-[10px] text-muted-foreground">Hard Stop %</Label>
                                      <Input
                                        type="number"
                                        min={0.5}
                                        max={100}
                                        step={0.1}
                                        value={stopLossPct}
                                        onChange={(e) => updateAssetConfig(asset.id, { stopLossPct: e.target.value })}
                                        disabled={updating}
                                        className="h-8 text-xs bg-[#0c0e14] border-border/30"
                                      />
                                    </div>
                                  </div>
                                ) : (
                                  <div className="grid grid-cols-2 gap-3">
                                    <div className="space-y-1.5">
                                      <Label className="text-[10px] text-muted-foreground">Target %</Label>
                                      <Input
                                        type="number"
                                        min={0.1}
                                        max={100}
                                        step={0.1}
                                        value={targetPct}
                                        onChange={(e) => updateAssetConfig(asset.id, { targetPct: e.target.value })}
                                        disabled={updating}
                                        className="h-8 text-xs bg-[#0c0e14] border-border/30"
                                      />
                                    </div>
                                    <div className="space-y-1.5">
                                      <Label className="text-[10px] text-muted-foreground">Stop Loss %</Label>
                                      <Input
                                        type="number"
                                        min={0.1}
                                        max={100}
                                        step={0.1}
                                        value={stopLossPct}
                                        onChange={(e) => updateAssetConfig(asset.id, { stopLossPct: e.target.value })}
                                        disabled={updating}
                                        className="h-8 text-xs bg-[#0c0e14] border-border/30"
                                      />
                                    </div>
                                  </div>
                                )}

                                <p className="text-[10px] text-muted-foreground/50">
                                  {exitStrategy === "trailing_ratchet"
                                    ? `Ratchet: every +10% milestone, floor = milestone × (1 - ${trailGapPct}%). Hard stop at -${stopLossPct}% before first milestone.`
                                    : `Fixed target: exit at +${targetPct}% or -${stopLossPct}%.`}
                                </p>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* Risk Settings */}
              {isConnected && prefsData && (
                <Card className="bg-[#10131b] border-border/20 shadow-none rounded-lg">
                  <CardHeader className="pb-3 border-b border-border/20">
                    <CardTitle className="text-[11px] font-bold uppercase tracking-[0.12em] flex items-center gap-2 text-muted-foreground">
                      <Shield className="h-4 w-4 text-primary" />
                      Strategy Overview
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="p-4">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
                      <div className="space-y-1">
                        <p className="text-xs text-muted-foreground">Default Exit Strategy</p>
                        <p className="font-mono text-primary">Trailing Ratchet</p>
                      </div>
                      <div className="space-y-1">
                        <p className="text-xs text-muted-foreground">Default Trail Gap</p>
                        <p className="font-mono text-primary">15% (Balanced)</p>
                      </div>
                    </div>
                    <div className="mt-3 p-3 rounded-md bg-muted/20 border border-border/10">
                      <p className="text-[10px] text-muted-foreground leading-relaxed">
                        <strong className="text-primary">Proportional Ratchet:</strong> Every +10% profit milestone,
                        the floor ratchets up to <em>milestone × (1 - gap%)</em>. No fixed take-profit ceiling
                        — lets winners run while locking in gains at each step.
                      </p>
                    </div>
                    <p className="text-[10px] text-muted-foreground/50 mt-3">
                      Click <strong>Config</strong> on any enabled asset above to customize gap %, hard stop, or switch to fixed target mode.
                    </p>
                  </CardContent>
                </Card>
              )}
            </div>
          </div>

          {/* Market Data + Trading Dashboard */}
          <div className="space-y-6">
            {/* NIFTY Market Data */}
            <Card className="bg-[#10131b] border-border/20 shadow-none rounded-lg">
              <CardHeader className="pb-3 border-b border-border/20">
                <CardTitle className="text-[11px] font-bold uppercase tracking-[0.12em] flex items-center gap-2 text-muted-foreground">
                  <BarChart3 className="h-4 w-4 text-primary" />
                  NIFTY Market Data
                </CardTitle>
                <CardDescription className="text-xs text-muted-foreground/60">
                  Real-time data from global Kite Connect (paid)
                </CardDescription>
              </CardHeader>
              <CardContent className="p-4">
                {marketLoading ? (
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                    {[...Array(4)].map((_, i) => <Skeleton key={i} className="h-16 bg-muted/30 rounded-lg" />)}
                  </div>
                ) : marketData ? (
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                    <div className="rounded-lg bg-[#0c0e14] border border-border/10 p-3">
                      <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Spot Price</p>
                      <p className="text-lg font-bold text-primary font-mono">{formatNumber(marketData.spotPrice, 0)}</p>
                    </div>
                    <div className="rounded-lg bg-[#0c0e14] border border-border/10 p-3">
                      <p className="text-[10px] text-muted-foreground uppercase tracking-wider">ATM IV</p>
                      <p className="text-lg font-bold font-mono">{formatNumber(marketData.atmIV, 1)}%</p>
                    </div>
                    <div className="rounded-lg bg-[#0c0e14] border border-border/10 p-3">
                      <p className="text-[10px] text-muted-foreground uppercase tracking-wider">PCR</p>
                      <p className={`text-lg font-bold font-mono ${marketData.pcr > 1 ? "text-emerald-400" : "text-red-400"}`}>{formatNumber(marketData.pcr, 3)}</p>
                    </div>
                    <div className="rounded-lg bg-[#0c0e14] border border-border/10 p-3">
                      <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Max Pain</p>
                      <p className="text-lg font-bold font-mono">{formatNumber(marketData.maxPainStrike, 0)}</p>
                    </div>
                    <div className="rounded-lg bg-[#0c0e14] border border-border/10 p-3">
                      <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Call OI</p>
                      <p className="text-sm font-mono text-red-400">{(marketData.callOI / 1000000).toFixed(2)}M</p>
                    </div>
                    <div className="rounded-lg bg-[#0c0e14] border border-border/10 p-3">
                      <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Put OI</p>
                      <p className="text-sm font-mono text-emerald-400">{(marketData.putOI / 1000000).toFixed(2)}M</p>
                    </div>
                    <div className="rounded-lg bg-[#0c0e14] border border-border/10 p-3">
                      <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Volume</p>
                      <p className="text-sm font-mono">{(marketData.optionVolume / 1000000).toFixed(2)}M</p>
                    </div>
                    <div className="rounded-lg bg-[#0c0e14] border border-border/10 p-3">
                      <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Gamma</p>
                      <p className="text-sm font-mono">{formatNumber(marketData.atmGamma, 6)}</p>
                    </div>
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground text-center py-4">Market data unavailable</p>
                )}
              </CardContent>
            </Card>

            {/* Active Trades + History Tabs */}
            {isConnected && (
              <Tabs defaultValue="active" className="w-full">
                <TabsList className="bg-[#10131b] border border-border/20">
                  <TabsTrigger value="active" className="data-[state=active]:bg-primary/10 data-[state=active]:text-primary">
                    <Activity className="h-3 w-3 mr-1" /> Active Trades
                  </TabsTrigger>
                  <TabsTrigger value="history" className="data-[state=active]:bg-primary/10 data-[state=active]:text-primary">
                    <History className="h-3 w-3 mr-1" /> Trade History
                  </TabsTrigger>
                  <TabsTrigger value="orders" className="data-[state=active]:bg-primary/10 data-[state=active]:text-primary">
                    <Target className="h-3 w-3 mr-1" /> Orders
                  </TabsTrigger>
                </TabsList>

                {/* Active Trades */}
                <TabsContent value="active" className="mt-4">
                  <Card className="bg-[#10131b] border-border/20 shadow-none rounded-lg">
                    <CardContent className="p-4">
                      {execLoading ? (
                        <div className="space-y-2">
                          {[...Array(3)].map((_, i) => <Skeleton key={i} className="h-12 bg-muted/30 rounded-lg" />)}
                        </div>
                      ) : (() => {
                        const openExecs = execData?.executions.filter((e) => e.status === "open") ?? [];
                        if (openExecs.length === 0) {
                          return (
                            <div className="flex flex-col items-center justify-center py-8 text-center text-muted-foreground">
                              <Activity className="h-8 w-8 mb-2 text-muted-foreground/30" />
                              <p className="text-sm">No active trades</p>
                            </div>
                          );
                        }
                        return (
                          <div className="space-y-2">
                            {openExecs.map((exec) => {
                              const pnl = formatPnl(exec.unrealizedPnl);
                              const pnlPct = exec.entryPrice > 0 && exec.currentPrice
                                ? ((exec.currentPrice - exec.entryPrice) / exec.entryPrice) * 100
                                : null;
                              return (
                                <div key={exec.id} className="rounded-lg border border-border/10 bg-[#0c0e14] p-3">
                                  <div className="flex items-center justify-between">
                                    <div className="flex items-center gap-3">
                                      <div className={`h-8 w-8 rounded-md flex items-center justify-center ${exec.direction === "up" ? "bg-emerald-500/10 text-emerald-400" : "bg-red-500/10 text-red-400"}`}>
                                        {exec.direction === "up" ? <ArrowUpRight className="h-4 w-4" /> : <ArrowDownRight className="h-4 w-4" />}
                                      </div>
                                      <div>
                                        <p className="text-sm font-mono font-medium">{exec.assetSymbol}</p>
                                        <p className="text-[10px] text-muted-foreground">
                                          Qty: {exec.quantity} · Entry: ₹{formatNumber(exec.entryPrice)}
                                        </p>
                                      </div>
                                    </div>
                                    <div className="text-right">
                                      <p className={`text-sm font-mono font-bold ${pnl.color}`}>{pnl.text}</p>
                                      {pnlPct !== null && (
                                        <p className={`text-[10px] ${pnlPct >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                                          {pnlPct >= 0 ? "+" : ""}{pnlPct.toFixed(1)}%
                                        </p>
                                      )}
                                    </div>
                                  </div>
                                  <div className="grid grid-cols-4 gap-2 mt-2 text-[10px]">
                                    <div>
                                      <span className="text-muted-foreground">Current: </span>
                                      <span className="font-mono">₹{formatNumber(exec.currentPrice)}</span>
                                    </div>
                                    <div>
                                      <span className="text-muted-foreground">Peak: </span>
                                      <span className="font-mono">₹{formatNumber(exec.highestPriceReached)}</span>
                                    </div>
                                    <div>
                                      <span className="text-muted-foreground">Stop: </span>
                                      <span className="font-mono text-red-400">₹{formatNumber(exec.stopLossPrice)}</span>
                                    </div>
                                    <div>
                                      <span className="text-muted-foreground">Strategy: </span>
                                      <span className="font-mono">{exec.exitStrategy?.replace(/_/g, " ") ?? "—"}</span>
                                    </div>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        );
                      })()}
                    </CardContent>
                  </Card>
                </TabsContent>

                {/* Trade History */}
                <TabsContent value="history" className="mt-4">
                  <Card className="bg-[#10131b] border-border/20 shadow-none rounded-lg">
                    <CardContent className="p-4">
                      {execLoading ? (
                        <div className="space-y-2">
                          {[...Array(3)].map((_, i) => <Skeleton key={i} className="h-12 bg-muted/30 rounded-lg" />)}
                        </div>
                      ) : (() => {
                        const closedExecs = execData?.executions.filter((e) => e.status === "closed") ?? [];
                        if (closedExecs.length === 0) {
                          return (
                            <div className="flex flex-col items-center justify-center py-8 text-center text-muted-foreground">
                              <History className="h-8 w-8 mb-2 text-muted-foreground/30" />
                              <p className="text-sm">No closed trades yet</p>
                            </div>
                          );
                        }
                        const totalPnl = closedExecs.reduce((sum, e) => sum + (e.realisedPnl ?? 0), 0);
                        const totalPnlFmt = formatPnl(totalPnl);
                        return (
                          <div className="space-y-3">
                            <div className="flex items-center justify-between p-3 rounded-lg bg-[#0c0e14] border border-border/10">
                              <span className="text-xs text-muted-foreground">Total Realised PnL</span>
                              <span className={`text-sm font-mono font-bold ${totalPnlFmt.color}`}>{totalPnlFmt.text}</span>
                            </div>
                            <div className="overflow-x-auto">
                              <table className="w-full text-xs">
                                <thead>
                                  <tr className="text-muted-foreground border-b border-border/10">
                                    <th className="text-left py-2 px-2">Symbol</th>
                                    <th className="text-right py-2 px-2">Qty</th>
                                    <th className="text-right py-2 px-2">Entry</th>
                                    <th className="text-right py-2 px-2">Exit</th>
                                    <th className="text-right py-2 px-2">PnL</th>
                                    <th className="text-center py-2 px-2">Reason</th>
                                    <th className="text-right py-2 px-2">Time</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {closedExecs.map((exec) => {
                                    const pnl = formatPnl(exec.realisedPnl);
                                    return (
                                      <tr key={exec.id} className="border-b border-border/5 hover:bg-muted/5">
                                        <td className="py-2 px-2 font-mono">{exec.assetSymbol}</td>
                                        <td className="py-2 px-2 text-right font-mono">{exec.quantity}</td>
                                        <td className="py-2 px-2 text-right font-mono">₹{formatNumber(exec.entryPrice)}</td>
                                        <td className="py-2 px-2 text-right font-mono">₹{formatNumber(exec.exitPrice)}</td>
                                        <td className={`py-2 px-2 text-right font-mono font-bold ${pnl.color}`}>{pnl.text}</td>
                                        <td className="py-2 px-2 text-center">
                                          <Badge variant="outline" className="text-[9px]">{exec.exitReason ?? "—"}</Badge>
                                        </td>
                                        <td className="py-2 px-2 text-right text-muted-foreground text-[10px]">
                                          {exec.closedAt ? new Date(exec.closedAt).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }) : "—"}
                                        </td>
                                      </tr>
                                    );
                                  })}
                                </tbody>
                              </table>
                            </div>
                          </div>
                        );
                      })()}
                    </CardContent>
                  </Card>
                </TabsContent>

                {/* Order History */}
                <TabsContent value="orders" className="mt-4">
                  <Card className="bg-[#10131b] border-border/20 shadow-none rounded-lg">
                    <CardContent className="p-4">
                      {ordersLoading ? (
                        <div className="space-y-2">
                          {[...Array(3)].map((_, i) => <Skeleton key={i} className="h-12 bg-muted/30 rounded-lg" />)}
                        </div>
                      ) : (() => {
                        const orders = ordersData?.orders ?? [];
                        if (orders.length === 0) {
                          return (
                            <div className="flex flex-col items-center justify-center py-8 text-center text-muted-foreground">
                              <Target className="h-8 w-8 mb-2 text-muted-foreground/30" />
                              <p className="text-sm">No orders yet</p>
                            </div>
                          );
                        }
                        return (
                          <div className="overflow-x-auto">
                            <table className="w-full text-xs">
                              <thead>
                                <tr className="text-muted-foreground border-b border-border/10">
                                  <th className="text-left py-2 px-2">Symbol</th>
                                  <th className="text-center py-2 px-2">Type</th>
                                  <th className="text-right py-2 px-2">Qty</th>
                                  <th className="text-right py-2 px-2">Price</th>
                                  <th className="text-center py-2 px-2">Status</th>
                                  <th className="text-right py-2 px-2">Time</th>
                                </tr>
                              </thead>
                              <tbody>
                                {orders.slice(0, 20).map((order) => (
                                  <tr key={order.order_id} className="border-b border-border/5 hover:bg-muted/5">
                                    <td className="py-2 px-2 font-mono">{order.tradingsymbol}</td>
                                    <td className="py-2 px-2 text-center">
                                      <Badge variant="outline" className={`text-[9px] ${order.transaction_type === "BUY" ? "text-emerald-400 border-emerald-500/30" : "text-red-400 border-red-500/30"}`}>
                                        {order.transaction_type}
                                      </Badge>
                                    </td>
                                    <td className="py-2 px-2 text-right font-mono">{order.filled_quantity}/{order.quantity}</td>
                                    <td className="py-2 px-2 text-right font-mono">₹{formatNumber(order.average_price || order.price)}</td>
                                    <td className="py-2 px-2 text-center">
                                      <Badge variant="outline" className={`text-[9px] ${
                                        order.status === "COMPLETE" ? "text-emerald-400 border-emerald-500/30" :
                                        order.status === "REJECTED" || order.status === "CANCELLED" ? "text-red-400 border-red-500/30" :
                                        "text-yellow-400 border-yellow-500/30"
                                      }`}>
                                        {order.status}
                                      </Badge>
                                    </td>
                                    <td className="py-2 px-2 text-right text-muted-foreground text-[10px]">
                                      {order.order_timestamp ? new Date(order.order_timestamp).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }) : "—"}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        );
                      })()}
                    </CardContent>
                  </Card>
                </TabsContent>
              </Tabs>
            )}
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
