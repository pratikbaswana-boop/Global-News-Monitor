import { EventEmitter } from "events";
import { logger } from "../../lib/logger.js";

export const breakingNewsEmitter = new EventEmitter();

let lastTriggerAt = 0;
const DEBOUNCE_MS = 60 * 1000; // 1 min

export function shouldTriggerEnsemble(): boolean {
  const now = Date.now();
  if (now - lastTriggerAt < DEBOUNCE_MS) return false;
  lastTriggerAt = now;
  return true;
}

export function onNewArticle(article: {
  id: string;
  title: string;
  url: string;
  isBreaking: boolean;
  publishedAt: Date;
}): void {
  if (!article.isBreaking) return;
  if (!shouldTriggerEnsemble()) return;

  // Check if market is open (IST 09:15-15:30, Mon-Fri)
  const istMin = (new Date().getUTCHours() * 60 + new Date().getUTCMinutes() + 330) % (24 * 60);
  const istDay = new Date(new Date().getTime() + 330 * 60 * 1000).getUTCDay();
  if (istDay === 0 || istDay === 6) return; // weekend
  if (istMin < 555 || istMin >= 930) return; // outside 09:15-15:30 IST

  logger.info(
    { title: article.title.slice(0, 100), articleId: article.id },
    "breaking news → triggering immediate ensemble re-run",
  );
  breakingNewsEmitter.emit("triggerEnsemble", article);
}
