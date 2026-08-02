import { pgTable, text, integer, timestamp, primaryKey, index } from "drizzle-orm/pg-core";
import { rawArticlesTable } from "./raw-articles";

export const articleAssetTagsTable = pgTable(
  "article_asset_tags",
  {
    articleId: text("article_id").notNull().references(() => rawArticlesTable.id),
    assetId: text("asset_id").notNull(),
    matchedDrivers: text("matched_drivers").array().notNull(),
    driverScore: integer("driver_score").notNull(),
    taggedAt: timestamp("tagged_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.articleId, t.assetId] }),
    index("idx_article_asset_tags_asset").on(t.assetId),
    index("idx_article_asset_tags_article").on(t.articleId),
  ],
);
