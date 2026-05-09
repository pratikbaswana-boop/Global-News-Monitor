import { NewsArticle } from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatRelativeTime } from "@/lib/format";
import { ExternalLink, Globe2, X, User2, Calendar } from "lucide-react";

interface ArticleModalProps {
  article: NewsArticle | null;
  onClose: () => void;
}

export function ArticleModal({ article, onClose }: ArticleModalProps) {
  if (!article) return null;

  const getCategoryColor = (category: string) => {
    switch (category) {
      case "tensions": return "bg-destructive text-destructive-foreground";
      case "sanctions": return "bg-amber-500 text-amber-950";
      case "deals": return "bg-blue-500 text-blue-950";
      case "politics": return "bg-slate-500 text-slate-50";
      default: return "bg-secondary text-secondary-foreground";
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
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="relative bg-card border border-border rounded-xl shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col overflow-hidden">
        {/* Close button */}
        <button
          onClick={onClose}
          className="absolute top-4 right-4 z-10 rounded-full p-1.5 bg-background/80 hover:bg-muted border border-border transition-colors"
        >
          <X className="h-4 w-4 text-muted-foreground" />
        </button>

        {/* Hero image */}
        {article.imageUrl && (
          <div className="h-56 overflow-hidden shrink-0 border-b border-border/50">
            <img
              src={article.imageUrl}
              alt={article.title}
              className="w-full h-full object-cover"
              onError={(e) => { (e.target as HTMLImageElement).parentElement!.style.display = "none"; }}
            />
          </div>
        )}

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-5">
          {/* Meta row */}
          <div className="flex items-center gap-2 flex-wrap">
            <Badge variant="outline" className={`rounded-sm px-1.5 py-0.5 text-xs font-mono font-medium ${getSourceColor(article.sourceName)}`}>
              {article.sourceName}
            </Badge>
            <Badge className={`rounded-sm uppercase text-[10px] tracking-wider font-bold px-2 py-0.5 ${getCategoryColor(article.category)}`}>
              {article.category}
            </Badge>
            <span className="text-xs text-muted-foreground font-mono flex items-center gap-1 ml-auto">
              <Calendar className="h-3 w-3" />
              {formatRelativeTime(article.publishedAt)}
            </span>
          </div>

          {/* Title */}
          <h2 className="text-xl font-bold leading-snug text-foreground">
            {article.title}
          </h2>

          {/* Source name */}
          <p className="text-xs text-muted-foreground font-medium uppercase tracking-wider">
            {article.source}
          </p>

          {/* Description */}
          <div className="text-sm text-muted-foreground leading-relaxed border-l-2 border-primary/30 pl-4">
            {article.description || "No preview available for this article."}
          </div>

          {/* Countries */}
          {article.countries.length > 0 && (
            <div className="flex items-start gap-2 pt-2">
              <Globe2 className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
              <div className="flex flex-wrap gap-1.5">
                {article.countries.map((c) => (
                  <span key={c} className="text-xs bg-muted px-2 py-0.5 rounded-full text-muted-foreground border border-border/50">
                    {c}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Leaders */}
          {article.leaders.length > 0 && (
            <div className="flex items-start gap-2">
              <User2 className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
              <div className="flex flex-wrap gap-1.5">
                {article.leaders.map((l) => (
                  <span key={l} className="text-xs bg-muted px-2 py-0.5 rounded-full text-muted-foreground border border-border/50">
                    {l}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-border bg-muted/30 shrink-0">
          <a
            href={article.url}
            target="_blank"
            rel="noopener noreferrer"
            className="w-full"
          >
            <Button className="w-full gap-2" variant="outline">
              <ExternalLink className="h-4 w-4" />
              Read full article on {article.source}
            </Button>
          </a>
        </div>
      </div>
    </div>
  );
}
