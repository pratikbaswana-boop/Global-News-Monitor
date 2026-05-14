import React, { useState as useReactState } from "react";
import { useGetNews, useGetNewsSummary, useGetTrendingTopics, getGetNewsQueryKey, getGetNewsSummaryQueryKey, getGetTrendingTopicsQueryKey } from "@workspace/api-client-react";
import { AppLayout } from "@/components/layout";
import { ArticleCard } from "@/components/article-card";
import { ArticleModal } from "@/components/article-modal";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Activity, Clock, Database, SearchX, TrendingUp } from "lucide-react";
import { GetNewsCategory, NewsArticle } from "@workspace/api-client-react";

export default function Dashboard() {
  const [category, setCategory] = useReactState<GetNewsCategory>("all");
  const [selectedArticle, setSelectedArticle] = useReactState<NewsArticle | null>(null);

  const { data: newsData, isLoading: isLoadingNews } = useGetNews(
    { category: category === "all" ? undefined : category, pageSize: 20 },
    { query: { queryKey: getGetNewsQueryKey({ category: category === "all" ? undefined : category, pageSize: 20 }) } }
  );

  const { data: summaryData, isLoading: isLoadingSummary } = useGetNewsSummary({
    query: { queryKey: getGetNewsSummaryQueryKey() }
  });

  const { data: trendingData, isLoading: isLoadingTrending } = useGetTrendingTopics({
    query: { queryKey: getGetTrendingTopicsQueryKey() }
  });

  return (
    <AppLayout>
      <div className="flex-1 overflow-y-auto">
        <div className="p-6 max-w-screen-2xl mx-auto space-y-6">
          {/* Top Status Bar */}
          <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 bg-card border border-border p-4 rounded-lg shadow-sm">
            <div className="flex items-center gap-2">
              <Activity className="h-5 w-5 text-primary" />
              <h1 className="text-xl font-bold tracking-tight">Global Intelligence Terminal</h1>
            </div>

            <div className="flex items-center gap-6 text-sm font-mono text-muted-foreground">
              {isLoadingSummary ? (
                <Skeleton className="h-4 w-48" />
              ) : summaryData ? (
                <>
                  <div className="flex items-center gap-2">
                    <Database className="h-4 w-4" />
                    <span>{(summaryData.totalArticles ?? 0).toLocaleString()} Signals</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Clock className="h-4 w-4" />
                    <span>Updated: {summaryData.lastUpdated ? new Date(summaryData.lastUpdated).toLocaleTimeString() : "—"}</span>
                  </div>
                </>
              ) : null}
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
            {/* Main Feed */}
            <div className="lg:col-span-3 space-y-4">
              <div className="flex items-center justify-between border-b border-border pb-2">
                <Tabs value={category} onValueChange={(v) => setCategory(v as GetNewsCategory)} className="w-full">
                  <TabsList className="bg-transparent border-none p-0 h-auto gap-4 justify-start w-full overflow-x-auto">
                    <TabsTrigger value="all" className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none px-1 pb-2 pt-0 uppercase tracking-wider text-xs font-bold">
                      All Signals
                    </TabsTrigger>
                    <TabsTrigger value="politics" className="rounded-none border-b-2 border-transparent data-[state=active]:border-slate-500 data-[state=active]:bg-transparent data-[state=active]:shadow-none px-1 pb-2 pt-0 uppercase tracking-wider text-xs font-bold">
                      Politics
                    </TabsTrigger>
                    <TabsTrigger value="deals" className="rounded-none border-b-2 border-transparent data-[state=active]:border-blue-500 data-[state=active]:bg-transparent data-[state=active]:shadow-none px-1 pb-2 pt-0 uppercase tracking-wider text-xs font-bold">
                      Deals
                    </TabsTrigger>
                    <TabsTrigger value="sanctions" className="rounded-none border-b-2 border-transparent data-[state=active]:border-amber-500 data-[state=active]:bg-transparent data-[state=active]:shadow-none px-1 pb-2 pt-0 uppercase tracking-wider text-xs font-bold">
                      Sanctions
                    </TabsTrigger>
                    <TabsTrigger value="tensions" className="rounded-none border-b-2 border-transparent data-[state=active]:border-destructive data-[state=active]:bg-transparent data-[state=active]:shadow-none px-1 pb-2 pt-0 uppercase tracking-wider text-xs font-bold">
                      Tensions
                    </TabsTrigger>
                  </TabsList>
                </Tabs>
              </div>

              {isLoadingNews ? (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {[...Array(6)].map((_, i) => (
                    <Card key={i} className="overflow-hidden">
                      <Skeleton className="h-48 w-full rounded-none" />
                      <CardContent className="p-5 space-y-3">
                        <div className="flex justify-between">
                          <Skeleton className="h-4 w-16" />
                          <Skeleton className="h-4 w-20" />
                        </div>
                        <Skeleton className="h-6 w-full" />
                        <Skeleton className="h-6 w-3/4" />
                        <Skeleton className="h-4 w-full mt-4" />
                        <Skeleton className="h-4 w-2/3" />
                      </CardContent>
                    </Card>
                  ))}
                </div>
              ) : newsData?.articles && newsData.articles.length > 0 ? (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {newsData.articles.map(article => (
                    <ArticleCard key={article.id} article={article} onClick={() => setSelectedArticle(article)} />
                  ))}
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center py-20 text-center text-muted-foreground bg-card border border-border rounded-lg border-dashed">
                  <SearchX className="h-12 w-12 mb-4 text-muted" />
                  <p className="text-lg font-medium text-foreground">No signals detected</p>
                  <p className="text-sm">Try adjusting your filters or checking back later.</p>
                </div>
              )}
            </div>

            {/* Sidebar */}
            <div className="space-y-6">
              <Card className="bg-card/50 border-border shadow-none">
                <CardHeader className="pb-3 border-b border-border/50">
                  <CardTitle className="text-sm font-bold uppercase tracking-wider flex items-center gap-2">
                    <TrendingUp className="h-4 w-4" />
                    Hot Vectors
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                  {isLoadingTrending ? (
                    <div className="p-4 space-y-4">
                      {[...Array(5)].map((_, i) => (
                        <div key={i} className="space-y-2">
                          <div className="flex justify-between">
                            <Skeleton className="h-4 w-24" />
                            <Skeleton className="h-4 w-8" />
                          </div>
                          <Skeleton className="h-1.5 w-full" />
                        </div>
                      ))}
                    </div>
                  ) : trendingData?.countries && trendingData.countries.length > 0 ? (
                    <div className="p-4 space-y-5">
                      {trendingData.countries.slice(0, 8).map((country) => {
                        const maxCount = trendingData.countries[0]?.count || 1;
                        const percentage = (country.count / maxCount) * 100;
                        return (
                          <div key={country.name} className="space-y-1.5 group">
                            <div className="flex justify-between items-end text-sm">
                              <span className="font-medium group-hover:text-primary transition-colors">{country.name}</span>
                              <span className="text-xs font-mono text-muted-foreground">{country.count}</span>
                            </div>
                            <Progress value={percentage} className="h-1.5" />
                          </div>
                        );
                      })}
                    </div>
                  ) : null}
                </CardContent>
              </Card>

              {summaryData && (
                <Card className="bg-card/50 border-border shadow-none">
                  <CardHeader className="pb-3 border-b border-border/50">
                    <CardTitle className="text-sm font-bold uppercase tracking-wider">
                      Source Distribution
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="p-4 space-y-4">
                    <div className="space-y-1.5">
                      <div className="flex justify-between text-sm">
                        <span className="text-emerald-400 font-medium">NewsAPI</span>
                        <span className="text-xs font-mono">{summaryData.bySource?.newsapi ?? 0}</span>
                      </div>
                      <Progress value={((summaryData.bySource?.newsapi ?? 0) / (summaryData.totalArticles || 1)) * 100} className="h-1 bg-muted [&>div]:bg-emerald-400" />
                    </div>
                    <div className="space-y-1.5">
                      <div className="flex justify-between text-sm">
                        <span className="text-violet-400 font-medium">GNews</span>
                        <span className="text-xs font-mono">{summaryData.bySource?.gnews ?? 0}</span>
                      </div>
                      <Progress value={((summaryData.bySource?.gnews ?? 0) / (summaryData.totalArticles || 1)) * 100} className="h-1 bg-muted [&>div]:bg-violet-400" />
                    </div>
                    <div className="space-y-1.5">
                      <div className="flex justify-between text-sm">
                        <span className="text-rose-400 font-medium">The Guardian</span>
                        <span className="text-xs font-mono">{summaryData.bySource?.guardian ?? 0}</span>
                      </div>
                      <Progress value={((summaryData.bySource?.guardian ?? 0) / (summaryData.totalArticles || 1)) * 100} className="h-1 bg-muted [&>div]:bg-rose-400" />
                    </div>
                  </CardContent>
                </Card>
              )}
            </div>
          </div>
        </div>
      </div>

      <ArticleModal article={selectedArticle} onClose={() => setSelectedArticle(null)} />
    </AppLayout>
  );
}
