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
            <h1 className="text-3xl font-bold tracking-tight mb-2">Trending Vectors</h1>
            <p className="text-muted-foreground">Entity frequency analysis across all monitored data sources.</p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {/* Countries */}
            <Card className="border-border">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Map className="h-5 w-5 text-primary" />
                  Geopolitical Hotspots
                </CardTitle>
                <CardDescription>Most frequently mentioned countries</CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                {isLoading ? (
                  <div className="p-6 space-y-6">
                    {[...Array(10)].map((_, i) => (
                      <div key={i} className="space-y-2">
                        <div className="flex justify-between"><Skeleton className="h-4 w-32" /><Skeleton className="h-4 w-8" /></div>
                        <Skeleton className="h-2 w-full" />
                      </div>
                    ))}
                  </div>
                ) : trendingData?.countries ? (
                  <div className="divide-y divide-border">
                    {trendingData.countries.map((item, idx) => {
                      const max = trendingData.countries[0]?.count || 1;
                      return (
                        <div key={item.name} className="p-4 hover:bg-muted/30 transition-colors flex items-center gap-4">
                          <div className="font-mono text-muted-foreground text-xs w-4">{(idx + 1).toString().padStart(2, '0')}</div>
                          <div className="flex-1 space-y-1.5">
                            <div className="flex justify-between items-end">
                              <span className="font-medium text-sm">{item.name}</span>
                              <span className="text-xs font-mono">{item.count}</span>
                            </div>
                            <Progress value={(item.count / max) * 100} className="h-1.5 bg-muted [&>div]:bg-primary" />
                          </div>
                        </div>
                      )
                    })}
                  </div>
                ) : null}
              </CardContent>
            </Card>

            {/* Leaders */}
            <Card className="border-border">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Users className="h-5 w-5 text-amber-500" />
                  Key Figures
                </CardTitle>
                <CardDescription>Most frequently mentioned leaders</CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                {isLoading ? (
                  <div className="p-6 space-y-6">
                    {[...Array(10)].map((_, i) => (
                      <div key={i} className="space-y-2">
                        <div className="flex justify-between"><Skeleton className="h-4 w-32" /><Skeleton className="h-4 w-8" /></div>
                        <Skeleton className="h-2 w-full" />
                      </div>
                    ))}
                  </div>
                ) : trendingData?.leaders ? (
                  <div className="divide-y divide-border">
                    {trendingData.leaders.map((item, idx) => {
                      const max = trendingData.leaders[0]?.count || 1;
                      return (
                        <div key={item.name} className="p-4 hover:bg-muted/30 transition-colors flex items-center gap-4">
                          <div className="font-mono text-muted-foreground text-xs w-4">{(idx + 1).toString().padStart(2, '0')}</div>
                          <div className="flex-1 space-y-1.5">
                            <div className="flex justify-between items-end">
                              <span className="font-medium text-sm">{item.name}</span>
                              <span className="text-xs font-mono">{item.count}</span>
                            </div>
                            <Progress value={(item.count / max) * 100} className="h-1.5 bg-muted [&>div]:bg-amber-500" />
                          </div>
                        </div>
                      )
                    })}
                  </div>
                ) : null}
              </CardContent>
            </Card>

            {/* Topics */}
            <Card className="border-border">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Hash className="h-5 w-5 text-blue-500" />
                  Emerging Themes
                </CardTitle>
                <CardDescription>Most frequently mentioned topics</CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                {isLoading ? (
                  <div className="p-6 space-y-6">
                    {[...Array(10)].map((_, i) => (
                      <div key={i} className="space-y-2">
                        <div className="flex justify-between"><Skeleton className="h-4 w-32" /><Skeleton className="h-4 w-8" /></div>
                        <Skeleton className="h-2 w-full" />
                      </div>
                    ))}
                  </div>
                ) : trendingData?.topics ? (
                  <div className="divide-y divide-border">
                    {trendingData.topics.map((item, idx) => {
                      const max = trendingData.topics[0]?.count || 1;
                      return (
                        <div key={item.name} className="p-4 hover:bg-muted/30 transition-colors flex items-center gap-4">
                          <div className="font-mono text-muted-foreground text-xs w-4">{(idx + 1).toString().padStart(2, '0')}</div>
                          <div className="flex-1 space-y-1.5">
                            <div className="flex justify-between items-end">
                              <span className="font-medium text-sm capitalize">{item.name}</span>
                              <span className="text-xs font-mono">{item.count}</span>
                            </div>
                            <Progress value={(item.count / max) * 100} className="h-1.5 bg-muted [&>div]:bg-blue-500" />
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
