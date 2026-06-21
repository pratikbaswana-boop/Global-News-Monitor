import { useGetTrendingTopics, getGetTrendingTopicsQueryKey } from "@workspace/api-client-react";
import { AppLayout } from "@/components/layout";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import { TrendingUp, Map, Users, Hash } from "lucide-react";

export default function Trending() {
  const { data: trendingData, isLoading } = useGetTrendingTopics({
    query: { queryKey: getGetTrendingTopicsQueryKey() }
  });

  return (
    <AppLayout>
      <div className="flex-1 overflow-y-auto">
        <div className="p-6 max-w-screen-2xl mx-auto space-y-6">
          <div>
            <h1 className="text-3xl font-bold tracking-tight mb-2" style={{ fontFamily: "'Inter', sans-serif" }}>Trending Vectors</h1>
            <p className="text-muted-foreground/70 text-sm">Entity frequency analysis across all monitored data sources.</p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {/* Countries */}
            <Card className="bg-[#10131b] border-border/20 rounded-lg">
              <CardHeader className="pb-3 border-b border-border/20">
                <CardTitle className="flex items-center gap-2 text-sm font-bold" style={{ fontFamily: "'Inter', sans-serif" }}>
                  <Map className="h-4 w-4 text-primary" />
                  Geopolitical Hotspots
                </CardTitle>
                <CardDescription className="text-xs text-muted-foreground/60">Most frequently mentioned countries</CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                {isLoading ? (
                  <div className="p-5 space-y-5">
                    {[...Array(10)].map((_, i) => (
                      <div key={i} className="space-y-2">
                        <div className="flex justify-between"><Skeleton className="h-4 w-32 bg-muted/30" /><Skeleton className="h-4 w-8 bg-muted/30" /></div>
                        <div className="h-1 bg-muted/30 rounded-full" />
                      </div>
                    ))}
                  </div>
                ) : trendingData?.countries ? (
                  <div className="divide-y divide-border/10">
                    {trendingData.countries.map((item, idx) => {
                      const max = trendingData.countries[0]?.count || 1;
                      return (
                        <div key={item.name} className="px-5 py-3 hover:bg-muted/20 transition-colors flex items-center gap-4">
                          <div className="font-mono text-muted-foreground/40 text-[11px] w-5">{(idx + 1).toString().padStart(2, '0')}</div>
                          <div className="flex-1 space-y-1.5">
                            <div className="flex justify-between items-end">
                              <span className="font-medium text-sm">{item.name}</span>
                              <span className="text-[11px] font-mono text-muted-foreground">{item.count}</span>
                            </div>
                            <div className="h-1 w-full bg-muted/30 rounded-full overflow-hidden">
                              <div className="h-full bg-primary/60 rounded-full" style={{ width: `${(item.count / max) * 100}%` }} />
                            </div>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                ) : null}
              </CardContent>
            </Card>

            {/* Leaders */}
            <Card className="bg-[#10131b] border-border/20 rounded-lg">
              <CardHeader className="pb-3 border-b border-border/20">
                <CardTitle className="flex items-center gap-2 text-sm font-bold" style={{ fontFamily: "'Inter', sans-serif" }}>
                  <Users className="h-4 w-4 text-amber-400" />
                  Key Figures
                </CardTitle>
                <CardDescription className="text-xs text-muted-foreground/60">Most frequently mentioned leaders</CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                {isLoading ? (
                  <div className="p-5 space-y-5">
                    {[...Array(10)].map((_, i) => (
                      <div key={i} className="space-y-2">
                        <div className="flex justify-between"><Skeleton className="h-4 w-32 bg-muted/30" /><Skeleton className="h-4 w-8 bg-muted/30" /></div>
                        <div className="h-1 bg-muted/30 rounded-full" />
                      </div>
                    ))}
                  </div>
                ) : trendingData?.leaders ? (
                  <div className="divide-y divide-border/10">
                    {trendingData.leaders.map((item, idx) => {
                      const max = trendingData.leaders[0]?.count || 1;
                      return (
                        <div key={item.name} className="px-5 py-3 hover:bg-muted/20 transition-colors flex items-center gap-4">
                          <div className="font-mono text-muted-foreground/40 text-[11px] w-5">{(idx + 1).toString().padStart(2, '0')}</div>
                          <div className="flex-1 space-y-1.5">
                            <div className="flex justify-between items-end">
                              <span className="font-medium text-sm">{item.name}</span>
                              <span className="text-[11px] font-mono text-muted-foreground">{item.count}</span>
                            </div>
                            <div className="h-1 w-full bg-muted/30 rounded-full overflow-hidden">
                              <div className="h-full bg-amber-400/60 rounded-full" style={{ width: `${(item.count / max) * 100}%` }} />
                            </div>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                ) : null}
              </CardContent>
            </Card>

            {/* Topics */}
            <Card className="bg-[#10131b] border-border/20 rounded-lg">
              <CardHeader className="pb-3 border-b border-border/20">
                <CardTitle className="flex items-center gap-2 text-sm font-bold" style={{ fontFamily: "'Inter', sans-serif" }}>
                  <Hash className="h-4 w-4 text-blue-400" />
                  Emerging Themes
                </CardTitle>
                <CardDescription className="text-xs text-muted-foreground/60">Most frequently mentioned topics</CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                {isLoading ? (
                  <div className="p-5 space-y-5">
                    {[...Array(10)].map((_, i) => (
                      <div key={i} className="space-y-2">
                        <div className="flex justify-between"><Skeleton className="h-4 w-32 bg-muted/30" /><Skeleton className="h-4 w-8 bg-muted/30" /></div>
                        <div className="h-1 bg-muted/30 rounded-full" />
                      </div>
                    ))}
                  </div>
                ) : trendingData?.topics ? (
                  <div className="divide-y divide-border/10">
                    {trendingData.topics.map((item, idx) => {
                      const max = trendingData.topics[0]?.count || 1;
                      return (
                        <div key={item.name} className="px-5 py-3 hover:bg-muted/20 transition-colors flex items-center gap-4">
                          <div className="font-mono text-muted-foreground/40 text-[11px] w-5">{(idx + 1).toString().padStart(2, '0')}</div>
                          <div className="flex-1 space-y-1.5">
                            <div className="flex justify-between items-end">
                              <span className="font-medium text-sm capitalize">{item.name}</span>
                              <span className="text-[11px] font-mono text-muted-foreground">{item.count}</span>
                            </div>
                            <div className="h-1 w-full bg-muted/30 rounded-full overflow-hidden">
                              <div className="h-full bg-blue-400/60 rounded-full" style={{ width: `${(item.count / max) * 100}%` }} />
                            </div>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                ) : null}
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
