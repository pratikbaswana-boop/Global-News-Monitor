import { NewsArticle } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatRelativeTime } from "@/lib/format";
import { Globe2 } from "lucide-react";

interface ArticleCardProps {
  article: NewsArticle;
  onClick: () => void;
}

export function ArticleCard({ article, onClick }: ArticleCardProps) {
  const getCategoryColor = (category: string) => {
    switch (category) {
      case "tensions": return "bg-destructive text-destructive-foreground hover:bg-destructive/90";
      case "sanctions": return "bg-amber-500 text-amber-950 hover:bg-amber-500/90";
      case "deals": return "bg-blue-500 text-blue-950 hover:bg-blue-500/90";
      case "politics": return "bg-slate-500 text-slate-950 hover:bg-slate-500/90";
      default: return "bg-secondary text-secondary-foreground hover:bg-secondary/90";
    }
  };

  const getSourceColor = (source: string) => {
    switch (source) {
      case "NewsAPI": return "text-emerald-400 border-emerald-400/30 bg-emerald-400/10";
      case "GNews": return "text-violet-400 border-violet-400/30 bg-violet-400/10";
      case "Guardian": return "text-rose-400 border-rose-400/30 bg-rose-400/10";
      default: return "text-muted-foreground border-border bg-muted/50";
    }
  };

  return (
    <Card
      onClick={onClick}
      className="overflow-hidden rounded-lg bg-[#10131b] hover:bg-[#161923] transition-all duration-300 group flex flex-col cursor-pointer hover:-translate-y-1 hover:shadow-lg hover:shadow-primary/5 border border-transparent hover:border-primary/20"
    >
      {article.imageUrl && (
        <div className="h-48 overflow-hidden relative">
          <div className="absolute inset-0 bg-gradient-to-t from-[#10131b] via-transparent to-transparent z-10" />
          <img
            src={article.imageUrl}
            alt={article.title}
            className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
            onError={(e) => {
              (e.target as HTMLImageElement).style.display = 'none';
            }}
          />
        </div>
      )}
      <CardContent className="p-5 flex flex-col flex-1 gap-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex gap-2 items-center">
            <Badge variant="outline" className={`rounded-md px-2 py-0.5 text-[10px] font-mono font-semibold tracking-wide border ${getSourceColor(article.sourceName)}`}>
              {article.sourceName}
            </Badge>
            <span className="text-[11px] text-muted-foreground font-mono">
              {formatRelativeTime(article.publishedAt)}
            </span>
          </div>
          <Badge className={`rounded-md uppercase text-[10px] tracking-wider font-bold px-2 py-0.5 ${getCategoryColor(article.category)}`}>
            {article.category}
          </Badge>
        </div>

        <div className="flex-1">
          <h3 className="text-base font-bold leading-snug group-hover:text-primary transition-colors text-foreground mb-2" style={{ fontFamily: "'Inter', sans-serif" }}>
            <span className="line-clamp-3">{article.title}</span>
          </h3>
          <p className="text-sm text-muted-foreground/80 line-clamp-2 leading-relaxed">
            {article.description}
          </p>
        </div>

        {article.countries.length > 0 && (
          <div className="flex items-center gap-1.5 mt-2 pt-3">
            <Globe2 className="h-3.5 w-3.5 text-muted-foreground/60 shrink-0" />
            <div className="flex flex-wrap gap-1.5">
              {article.countries.map(country => (
                <span key={country} className="text-[11px] text-muted-foreground/70 font-medium bg-muted/30 px-1.5 py-0.5 rounded">
                  {country}
                </span>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
