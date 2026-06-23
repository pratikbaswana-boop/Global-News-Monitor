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
} from "lucide-react";

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
  minConfidence: string;
  onlyIntraday: boolean;
}

interface TradePreferencesResponse {
  assets: Array<{ id: string; name: string; symbol: string; exchange: string }>;
  preferences: TradePreference[];
}

const API_BASE = "/api";

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

  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [updatingPrefs, setUpdatingPrefs] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);

  // Handle Kite OAuth callback redirect
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const requestToken = params.get("request_token");
    const status = params.get("status");

    if (requestToken && status === "success" && userId && apiKey && apiSecret) {
      // Auto-exchange after redirect
      exchangeToken(requestToken);
      // Clean URL
      window.history.replaceState({}, document.title, window.location.pathname);
    }
  }, [userId, apiKey, apiSecret]);

  async function exchangeToken(requestToken: string) {
    setConnecting(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/broker/callback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestToken, userId, apiKey, apiSecret }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to connect");
      }
      await refetchStatus();
      await refetchPrefs();
      setApiKey("");
      setApiSecret("");
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

      // 2. Open Kite login in popup
      const popup = window.open(loginUrl, "kite_oauth", "width=500,height=600");
      if (!popup) {
        // Fallback: redirect full page
        window.location.href = loginUrl;
        return;
      }

      // 3. Poll for redirect
      const interval = setInterval(() => {
        try {
          if (popup.closed) {
            clearInterval(interval);
            setConnecting(false);
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
                        return (
                          <div
                            key={asset.id}
                            className={`flex items-center justify-between p-4 rounded-lg border transition-colors ${
                              enabled
                                ? "bg-primary/5 border-primary/30"
                                : "bg-[#0c0e14] border-border/20"
                            }`}
                          >
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
                            <Switch
                              checked={enabled}
                              onCheckedChange={(v) => toggleAsset(asset.id, v)}
                              disabled={updating}
                            />
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
                      Risk Settings
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="p-4">
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-sm">
                      <div className="space-y-1">
                        <p className="text-xs text-muted-foreground">Max Risk / Trade</p>
                        <p className="font-mono text-primary">2%</p>
                      </div>
                      <div className="space-y-1">
                        <p className="text-xs text-muted-foreground">Default Product</p>
                        <p className="font-mono text-primary">MIS (Intraday)</p>
                      </div>
                      <div className="space-y-1">
                        <p className="text-xs text-muted-foreground">Target / Stop</p>
                        <p className="font-mono text-primary">1.2% / 2.0%</p>
                      </div>
                    </div>
                    <p className="text-[10px] text-muted-foreground/50 mt-4">
                      Risk settings can be customized per asset in the Asset Preferences panel above.
                    </p>
                  </CardContent>
                </Card>
              )}
            </div>
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
