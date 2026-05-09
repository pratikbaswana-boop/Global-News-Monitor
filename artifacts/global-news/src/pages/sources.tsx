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
            <h1 className="text-3xl font-bold tracking-tight mb-2">Data Sources</h1>
            <p className="text-muted-foreground">Overview of incoming intel streams and collection metrics.</p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {/* NewsAPI */}
            <Card className="border-emerald-500/20 bg-emerald-500/5">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-emerald-400">
                  <Database className="h-5 w-5" />
                  NewsAPI
                </CardTitle>
                <CardDescription>Global aggregator stream</CardDescription>
              </CardHeader>
              <CardContent>
                {isLoading ? (
                  <Skeleton className="h-12 w-full" />
                ) : summaryData ? (
                  <div className="space-y-4">
                    <div className="flex flex-col gap-1">
                      <span className="text-4xl font-mono font-bold text-foreground">
                        {summaryData.bySource.newsapi.toLocaleString()}
                      </span>
                      <span className="text-sm text-muted-foreground uppercase tracking-wider font-semibold">Articles Indexed</span>
                    </div>
                    <div className="pt-4 border-t border-emerald-500/20 text-xs text-emerald-500/80 font-mono">
                      Status: Active & connected
                    </div>
                  </div>
                ) : null}
              </CardContent>
            </Card>

            {/* GNews */}
            <Card className="border-violet-500/20 bg-violet-500/5">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-violet-400">
                  <Zap className="h-5 w-5" />
                  GNews
                </CardTitle>
                <CardDescription>Real-time Google News feed</CardDescription>
              </CardHeader>
              <CardContent>
                {isLoading ? (
                  <Skeleton className="h-12 w-full" />
                ) : summaryData ? (
                  <div className="space-y-4">
                    <div className="flex flex-col gap-1">
                      <span className="text-4xl font-mono font-bold text-foreground">
                        {summaryData.bySource.gnews.toLocaleString()}
                      </span>
                      <span className="text-sm text-muted-foreground uppercase tracking-wider font-semibold">Articles Indexed</span>
                    </div>
                    <div className="pt-4 border-t border-violet-500/20 text-xs text-violet-500/80 font-mono">
                      Status: Active & connected
                    </div>
                  </div>
                ) : null}
              </CardContent>
            </Card>

            {/* Guardian */}
            <Card className="border-rose-500/20 bg-rose-500/5">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-rose-400">
                  <SiTheguardian className="h-5 w-5" />
                  The Guardian
                </CardTitle>
                <CardDescription>Direct publisher API</CardDescription>
              </CardHeader>
              <CardContent>
                {isLoading ? (
                  <Skeleton className="h-12 w-full" />
                ) : summaryData ? (
                  <div className="space-y-4">
                    <div className="flex flex-col gap-1">
                      <span className="text-4xl font-mono font-bold text-foreground">
                        {summaryData.bySource.guardian.toLocaleString()}
                      </span>
                      <span className="text-sm text-muted-foreground uppercase tracking-wider font-semibold">Articles Indexed</span>
                    </div>
                    <div className="pt-4 border-t border-rose-500/20 text-xs text-rose-500/80 font-mono">
                      Status: Active & connected
                    </div>
                  </div>
                ) : null}
              </CardContent>
            </Card>
          </div>

          {/* System Health */}
          <Card className="mt-8 border-border">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-lg">
                <HardDrive className="h-5 w-5 text-primary" />
                System Health
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-4 text-sm font-mono p-4 bg-muted/30 rounded-md border border-border">
                <Shield className="h-5 w-5 text-emerald-500" />
                <div className="flex flex-col">
                  <span className="text-foreground font-semibold">All Systems Operational</span>
                  {summaryData && (
                    <span className="text-muted-foreground">Last DB sync: {new Date(summaryData.lastUpdated).toLocaleString()}</span>
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
