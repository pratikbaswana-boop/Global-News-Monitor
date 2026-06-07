import React, { useState as useReactState, useRef } from "react";
import { useGetNews, useGetNewsSummary, useGetTrendingTopics, getGetNewsQueryKey, getGetNewsSummaryQueryKey, getGetTrendingTopicsQueryKey } from "@workspace/api-client-react";
import { AppLayout } from "@/components/layout";
import { ArticleCard } from "@/components/article-card";
import { ArticleModal } from "@/components/article-modal";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Activity, ArrowDownUp, Clock, Database, Search, SearchX, TrendingUp, X } from "lucide-react";
import { GetNewsCategory, NewsArticle } from "@workspace/api-client-react";

export default function Dashboard() {
  const [category, setCategory] = useReactState<GetNewsCategory>("all");
  const [selectedArticle, setSelectedArticle] = useReactState<NewsArticle | null>(null);
  const [searchInput, setSearchInput] = useReactState("");
  const [activeSearch, setActiveSearch] = useReactState("");
  const [sort, setSort] = useReactState<"newest" | "oldest">("newest");
  const searchRef = useRef<HTMLInputElement>(null);

  const newsParams = {
    category: category === "all" ? undefined : category,
    pageSize: 20,
    ...(activeSearch ? { search: activeSearch } : {}),
    sort,
  };

  const { data: newsData, isLoading: isLoadingNews } = useGetNews(
    newsParams,
    { query: { queryKey: getGetNewsQueryKey(newsParams) } }
  );

  const { data: summaryData, isLoading: isLoadingSummary } = useGetNewsSummary({
    query: { queryKey: getGetNewsSummaryQueryKey() }
  });

  const { data: trendingData, isLoading: isLoadingTrending } = useGetTrendingTopics({
    query: { queryKey: getGetTrendingTopicsQueryKey() }
  });

  function handleSearchSubmit(e: React.FormEvent) {
    e.preventDefault();
    setActiveSearch(searchInput.trim());
  }

  function clearSearch() {
    setSearchInput("");
    setActiveSearch("");
    searchRef.current?.focus();
  }

  return (
    <AppLayout>
      <div className="flex-1 overflow-y-auto">
        <div className="p-6 max-w-screen-2xl mx-auto space-y-6">
          {/* Top Status Bar */}
          <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 bg-[#10131b] border border-border/30 p-4 rounded-lg">
            <div className="flex items-center gap-3">
              <div className="h-8 w-8 rounded-lg bg-primary/10 flex items-center justify-center">
                <Activity className="h-4 w-4 text-primary" />
              </div>
              <h1 className="text-xl font-bold tracking-tight" style={{ fontFamily: "'Space Grotesk', sans-serif" }}>Global Intelligence Terminal</h1>
            </div>

            <div className="flex items-center gap-6 text-sm font-mono text-muted-foreground">
              {isLoadingSummary ? (
                <Skeleton className="h-4 w-48 bg-muted/40" />
              ) : summaryData ? (
                <>
                  <div className="flex items-center gap-2" title="Loaded in feed (latest 500)">
                    <Database className="h-4 w-4 text-muted-foreground/60" />
                    <span>{(summaryData.totalArticles ?? 0).toLocaleString()} Signals</span>
                    {summaryData.totalDbArticles != null && summaryData.totalDbArticles !== summaryData.totalArticles && (
                      <span className="text-[10px] text-muted-foreground/50 font-mono">/ {summaryData.totalDbArticles.toLocaleString()} in DB</span>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <Clock className="h-4 w-4 text-muted-foreground/60" />
                    <span>Updated: {summaryData.lastUpdated ? new Date(summaryData.lastUpdated).toLocaleTimeString() : "—"}</span>
                  </div>
                </>
              ) : null}
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
            {/* Main Feed */}
            <div className="lg:col-span-3 space-y-4">
              {/* Search + Sort bar */}
              <div className="flex items-center gap-2">
                <form onSubmit={handleSearchSubmit} className="relative flex-1">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground/50" />
                  <input
                    ref={searchRef}
                    type="text"
                    value={searchInput}
                    onChange={(e) => setSearchInput(e.target.value)}
                    placeholder="Search signals... (searches cache, then DB)"
                    className="w-full bg-[#10131b] border border-border/30 rounded-md pl-9 pr-8 py-2 text-sm text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:ring-1 focus:ring-primary/40 font-mono"
                  />
                  {searchInput && (
                    <button
                      type="button"
                      onClick={clearSearch}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground/50 hover:text-foreground"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </form>
                <button
                  onClick={() => setSort(sort === "newest" ? "oldest" : "newest")}
                  className="flex items-center gap-1.5 px-3 py-2 rounded-md border border-border/30 bg-[#10131b] text-xs font-mono text-muted-foreground hover:text-foreground hover:border-border/60 transition-colors shrink-0"
                  title={sort === "newest" ? "Showing newest first" : "Showing oldest first"}
                >
                  <ArrowDownUp className="h-3.5 w-3.5" />
                  {sort === "newest" ? "Newest" : "Oldest"}
                </button>
              </div>

              {activeSearch && (
                <div className="flex items-center gap-2 text-xs font-mono text-muted-foreground">
                  <span>Results for</span>
                  <span className="text-primary font-semibold">"{activeSearch}"</span>
                  <span>· {newsData?.totalResults ?? 0} found</span>
                  <button onClick={clearSearch} className="ml-1 text-muted-foreground/50 hover:text-foreground underline">clear</button>
                </div>
              )}

              <div className="flex items-center justify-between border-b border-border/30 pb-2">
                <Tabs value={category} onValueChange={(v) => setCategory(v as GetNewsCategory)} className="w-full">
                  <TabsList className="bg-transparent border-none p-0 h-auto gap-6 justify-start w-full overflow-x-auto">
                    <TabsTrigger value="all" className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none px-1 pb-2 pt-0 uppercase tracking-[0.12em] text-[11px] font-bold text-muted-foreground data-[state=active]:text-primary">
                      All Signals
                    </TabsTrigger>
                    <TabsTrigger value="politics" className="rounded-none border-b-2 border-transparent data-[state=active]:border-slate-400 data-[state=active]:bg-transparent data-[state=active]:shadow-none px-1 pb-2 pt-0 uppercase tracking-[0.12em] text-[11px] font-bold text-muted-foreground data-[state=active]:text-slate-400">
                      Politics
                    </TabsTrigger>
                    <TabsTrigger value="deals" className="rounded-none border-b-2 border-transparent data-[state=active]:border-blue-400 data-[state=active]:bg-transparent data-[state=active]:shadow-none px-1 pb-2 pt-0 uppercase tracking-[0.12em] text-[11px] font-bold text-muted-foreground data-[state=active]:text-blue-400">
                      Deals
                    </TabsTrigger>
                    <TabsTrigger value="sanctions" className="rounded-none border-b-2 border-transparent data-[state=active]:border-amber-400 data-[state=active]:bg-transparent data-[state=active]:shadow-none px-1 pb-2 pt-0 uppercase tracking-[0.12em] text-[11px] font-bold text-muted-foreground data-[state=active]:text-amber-400">
                      Sanctions
                    </TabsTrigger>
                    <TabsTrigger value="tensions" className="rounded-none border-b-2 border-transparent data-[state=active]:border-red-400 data-[state=active]:bg-transparent data-[state=active]:shadow-none px-1 pb-2 pt-0 uppercase tracking-[0.12em] text-[11px] font-bold text-muted-foreground data-[state=active]:text-red-400">
                      Tensions
                    </TabsTrigger>
                  </TabsList>
                </Tabs>
              </div>

              {isLoadingNews ? (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                  {[...Array(6)].map((_, i) => (
                    <Card key={i} className="overflow-hidden rounded-lg bg-[#10131b] border border-border/20">
                      <Skeleton className="h-48 w-full rounded-none bg-muted/30" />
                      <CardContent className="p-5 space-y-3">
                        <div className="flex justify-between">
                          <Skeleton className="h-4 w-16 bg-muted/30" />
                          <Skeleton className="h-4 w-20 bg-muted/30" />
                        </div>
                        <Skeleton className="h-6 w-full bg-muted/30" />
                        <Skeleton className="h-6 w-3/4 bg-muted/30" />
                        <Skeleton className="h-4 w-full mt-4 bg-muted/30" />
                        <Skeleton className="h-4 w-2/3 bg-muted/30" />
                      </CardContent>
                    </Card>
                  ))}
                </div>
              ) : newsData?.articles && newsData.articles.length > 0 ? (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                  {newsData.articles.map(article => (
                    <ArticleCard key={article.id} article={article} onClick={() => setSelectedArticle(article)} />
                  ))}
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center py-20 text-center text-muted-foreground bg-[#10131b] border border-border/20 rounded-lg">
                  <SearchX className="h-12 w-12 mb-4 text-muted-foreground/30" />
                  <p className="text-lg font-medium text-foreground">No signals detected</p>
                  <p className="text-sm text-muted-foreground/60">Try adjusting your filters or checking back later.</p>
                </div>
              )}
            </div>

            {/* Sidebar */}
            <div className="space-y-5">
              <Card className="bg-[#10131b] border-border/20 shadow-none rounded-lg">
                <CardHeader className="pb-3 border-b border-border/20">
                  <CardTitle className="text-[11px] font-bold uppercase tracking-[0.12em] flex items-center gap-2 text-muted-foreground">
                    <TrendingUp className="h-4 w-4 text-primary" />
                    Hot Vectors
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                  {isLoadingTrending ? (
                    <div className="p-4 space-y-4">
                      {[...Array(5)].map((_, i) => (
                        <div key={i} className="space-y-2">
                          <div className="flex justify-between">
                            <Skeleton className="h-4 w-24 bg-muted/30" />
                            <Skeleton className="h-4 w-8 bg-muted/30" />
                          </div>
                          <Skeleton className="h-1 w-full bg-muted/30" />
                        </div>
                      ))}
                    </div>
                  ) : trendingData?.countries && trendingData.countries.length > 0 ? (
                    <div className="p-4 space-y-4">
                      {trendingData.countries.slice(0, 8).map((country) => {
                        const maxCount = trendingData.countries[0]?.count || 1;
                        const percentage = (country.count / maxCount) * 100;
                        return (
                          <div key={country.name} className="space-y-1.5 group cursor-default">
                            <div className="flex justify-between items-end text-sm">
                              <span className="font-medium group-hover:text-primary transition-colors">{country.name}</span>
                              <span className="text-[11px] font-mono text-muted-foreground">{country.count}</span>
                            </div>
                            <div className="h-1 w-full bg-muted/30 rounded-full overflow-hidden">
                              <div className="h-full bg-primary/70 rounded-full transition-all" style={{ width: `${percentage}%` }} />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  ) : null}
                </CardContent>
              </Card>

              {summaryData && (
                <Card className="bg-[#10131b] border-border/20 shadow-none rounded-lg">
                  <CardHeader className="pb-3 border-b border-border/20">
                    <CardTitle className="text-[11px] font-bold uppercase tracking-[0.12em] text-muted-foreground">
                      Source Distribution
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="p-4 space-y-4">
                    <div className="space-y-1.5">
                      <div className="flex justify-between text-sm">
                        <span className="text-emerald-400 font-medium text-xs">NewsAPI</span>
                        <span className="text-[11px] font-mono text-muted-foreground">{summaryData.bySource?.newsapi ?? 0}</span>
                      </div>
                      <div className="h-1 w-full bg-muted/30 rounded-full overflow-hidden">
                        <div className="h-full bg-emerald-400/70 rounded-full" style={{ width: `${((summaryData.bySource?.newsapi ?? 0) / (summaryData.totalArticles || 1)) * 100}%` }} />
                      </div>
                    </div>
                    <div className="space-y-1.5">
                      <div className="flex justify-between text-sm">
                        <span className="text-violet-400 font-medium text-xs">GNews</span>
                        <span className="text-[11px] font-mono text-muted-foreground">{summaryData.bySource?.gnews ?? 0}</span>
                      </div>
                      <div className="h-1 w-full bg-muted/30 rounded-full overflow-hidden">
                        <div className="h-full bg-violet-400/70 rounded-full" style={{ width: `${((summaryData.bySource?.gnews ?? 0) / (summaryData.totalArticles || 1)) * 100}%` }} />
                      </div>
                    </div>
                    <div className="space-y-1.5">
                      <div className="flex justify-between text-sm">
                        <span className="text-rose-400 font-medium text-xs">The Guardian</span>
                        <span className="text-[11px] font-mono text-muted-foreground">{summaryData.bySource?.guardian ?? 0}</span>
                      </div>
                      <div className="h-1 w-full bg-muted/30 rounded-full overflow-hidden">
                        <div className="h-full bg-rose-400/70 rounded-full" style={{ width: `${((summaryData.bySource?.guardian ?? 0) / (summaryData.totalArticles || 1)) * 100}%` }} />
                      </div>
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
