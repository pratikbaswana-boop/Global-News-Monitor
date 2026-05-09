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
      className="overflow-hidden border-border/50 hover:border-primary/40 transition-all duration-200 bg-card group flex flex-col cursor-pointer hover:shadow-md hover:shadow-primary/5"
    >
      {article.imageUrl && (
        <div className="h-48 overflow-hidden relative border-b border-border/50">
          <div className="absolute inset-0 bg-black/20 group-hover:bg-black/10 transition-colors z-10" />
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
            <Badge variant="outline" className={`rounded-sm px-1.5 py-0.5 text-xs font-mono font-medium ${getSourceColor(article.sourceName)}`}>
              {article.sourceName}
            </Badge>
            <span className="text-xs text-muted-foreground font-mono">
              {formatRelativeTime(article.publishedAt)}
            </span>
          </div>
          <Badge className={`rounded-sm uppercase text-[10px] tracking-wider font-bold px-2 py-0.5 ${getCategoryColor(article.category)}`}>
            {article.category}
          </Badge>
        </div>

        <div className="flex-1">
          <h3 className="text-lg font-bold leading-tight group-hover:text-primary transition-colors text-foreground mb-2">
            <span className="line-clamp-3">{article.title}</span>
          </h3>
          <p className="text-sm text-muted-foreground line-clamp-2 leading-relaxed">
            {article.description}
          </p>
        </div>

        {article.countries.length > 0 && (
          <div className="flex items-center gap-1.5 mt-2 pt-3 border-t border-border/40">
            <Globe2 className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <div className="flex flex-wrap gap-1">
              {article.countries.map(country => (
                <span key={country} className="text-xs text-muted-foreground font-medium">
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
