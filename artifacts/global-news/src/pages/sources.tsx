import { useGetNewsSummary, getGetNewsSummaryQueryKey } from "@workspace/api-client-react";
import { AppLayout } from "@/components/layout";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Database, Zap, HardDrive, Shield } from "lucide-react";
import { SiTheguardian } from "react-icons/si";

export default function Sources() {
  const { data: summaryData, isLoading } = useGetNewsSummary({
    query: { queryKey: getGetNewsSummaryQueryKey() }
  });

  return (
    <AppLayout>
      <div className="flex-1 overflow-y-auto">
        <div className="p-6 max-w-screen-2xl mx-auto space-y-6">
          <div>
            <h1 className="text-3xl font-bold tracking-tight mb-2" style={{ fontFamily: "'Inter', sans-serif" }}>Data Sources</h1>
            <p className="text-muted-foreground/70 text-sm">Overview of incoming intel streams and collection metrics.</p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {/* NewsAPI */}
            <Card className="bg-[#0a1512] border border-emerald-400/15 rounded-lg hover:bg-[#0d1a16] transition-colors">
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-emerald-400 text-sm font-bold" style={{ fontFamily: "'Inter', sans-serif" }}>
                  <Database className="h-4 w-4" />
                  NewsAPI
                </CardTitle>
                <CardDescription className="text-xs text-muted-foreground/60">Global aggregator stream</CardDescription>
              </CardHeader>
              <CardContent>
                {isLoading ? (
                  <Skeleton className="h-12 w-full bg-muted/30" />
                ) : summaryData ? (
                  <div className="space-y-4">
                    <div className="flex flex-col gap-1">
                      <span className="text-4xl font-mono font-bold text-foreground">
                        {(summaryData.bySource?.newsapi ?? 0).toLocaleString()}
                      </span>
                      <span className="text-[10px] text-muted-foreground uppercase tracking-[0.12em] font-bold">Articles Indexed</span>
                    </div>
                    <div className="pt-3 text-[11px] text-emerald-400/70 font-mono flex items-center gap-1.5">
                      <span className="h-1.5 w-1.5 rounded-full bg-emerald-400/80 inline-block" />
                      Active & connected
                    </div>
                  </div>
                ) : null}
              </CardContent>
            </Card>

            {/* GNews */}
            <Card className="bg-[#100a15] border border-violet-400/15 rounded-lg hover:bg-[#140d1a] transition-colors">
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-violet-400 text-sm font-bold" style={{ fontFamily: "'Inter', sans-serif" }}>
                  <Zap className="h-4 w-4" />
                  GNews
                </CardTitle>
                <CardDescription className="text-xs text-muted-foreground/60">Real-time Google News feed</CardDescription>
              </CardHeader>
              <CardContent>
                {isLoading ? (
                  <Skeleton className="h-12 w-full bg-muted/30" />
                ) : summaryData ? (
                  <div className="space-y-4">
                    <div className="flex flex-col gap-1">
                      <span className="text-4xl font-mono font-bold text-foreground">
                        {(summaryData.bySource?.gnews ?? 0).toLocaleString()}
                      </span>
                      <span className="text-[10px] text-muted-foreground uppercase tracking-[0.12em] font-bold">Articles Indexed</span>
                    </div>
                    <div className="pt-3 text-[11px] text-violet-400/70 font-mono flex items-center gap-1.5">
                      <span className="h-1.5 w-1.5 rounded-full bg-violet-400/80 inline-block" />
                      Active & connected
                    </div>
                  </div>
                ) : null}
              </CardContent>
            </Card>

            {/* Guardian */}
            <Card className="bg-[#150a0e] border border-rose-400/15 rounded-lg hover:bg-[#1a0d12] transition-colors">
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-rose-400 text-sm font-bold" style={{ fontFamily: "'Inter', sans-serif" }}>
                  <SiTheguardian className="h-4 w-4" />
                  The Guardian
                </CardTitle>
                <CardDescription className="text-xs text-muted-foreground/60">Direct publisher API</CardDescription>
              </CardHeader>
              <CardContent>
                {isLoading ? (
                  <Skeleton className="h-12 w-full bg-muted/30" />
                ) : summaryData ? (
                  <div className="space-y-4">
                    <div className="flex flex-col gap-1">
                      <span className="text-4xl font-mono font-bold text-foreground">
                        {(summaryData.bySource?.guardian ?? 0).toLocaleString()}
                      </span>
                      <span className="text-[10px] text-muted-foreground uppercase tracking-[0.12em] font-bold">Articles Indexed</span>
                    </div>
                    <div className="pt-3 text-[11px] text-rose-400/70 font-mono flex items-center gap-1.5">
                      <span className="h-1.5 w-1.5 rounded-full bg-rose-400/80 inline-block" />
                      Active & connected
                    </div>
                  </div>
                ) : null}
              </CardContent>
            </Card>
          </div>

          {/* System Health */}
          <Card className="mt-6 bg-[#10131b] border-border/20 rounded-lg">
            <CardHeader className="pb-3 border-b border-border/20">
              <CardTitle className="flex items-center gap-2 text-sm font-bold" style={{ fontFamily: "'Inter', sans-serif" }}>
                <HardDrive className="h-4 w-4 text-primary" />
                System Health
              </CardTitle>
            </CardHeader>
            <CardContent className="p-4">
              <div className="flex items-center gap-4 text-sm p-4 bg-[#0c0e14] rounded-lg border border-border/20">
                <Shield className="h-5 w-5 text-emerald-400" />
                <div className="flex flex-col">
                  <span className="text-foreground font-semibold">All Systems Operational</span>
                  {summaryData && (
                    <span className="text-muted-foreground/60 text-xs font-mono mt-0.5">Last DB sync: {summaryData.lastUpdated ? new Date(summaryData.lastUpdated).toLocaleString() : "—"}</span>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </AppLayout>
  );
}
