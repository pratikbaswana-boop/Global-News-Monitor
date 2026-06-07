#!/usr/bin/env python3
"""One-time backfill: fetch last 30 days from newly added RSS feeds."""

import os
import re
import subprocess
import sys
import uuid
import urllib.request
from datetime import datetime, timedelta, timezone

NEW_FEEDS = [
    {"id": "reuters-commodities",   "url": "https://feeds.reuters.com/reuters/commoditiesNews",       "tier": 1},
    {"id": "reuters-business",      "url": "https://feeds.reuters.com/reuters/businessNews",          "tier": 1},
    {"id": "oilprice-energy",       "url": "https://oilprice.com/rss/energy.xml",                    "tier": 2},
    {"id": "business-standard-all", "url": "https://www.business-standard.com/rss/rss_xml.php?category=all", "tier": 2},
    {"id": "moneycontrol-news",     "url": "https://www.moneycontrol.com/rss/news.xml",                "tier": 2},
    {"id": "et-industry",           "url": "https://economictimes.indiatimes.com/industry/rssfeeds/13352306.cms", "tier": 2},
    {"id": "long-war-journal",      "url": "https://www.longwarjournal.org/feed/",                     "tier": 2},
    {"id": "defense-news",          "url": "https://www.defensenews.com/arc/outboundfeeds/rss/?outputType=xml", "tier": 2},
    {"id": "occrp",                 "url": "https://www.occrp.org/en/rss",                             "tier": 2},
    {"id": "icij",                  "url": "https://www.icij.org/feed/",                               "tier": 2},
    {"id": "cnbc-top",              "url": "https://www.cnbc.com/id/100003114/device/rss/rss.html",    "tier": 2},
    {"id": "worldbank-news",        "url": "https://www.worldbank.org/en/news/all/rss",                "tier": 1},
]

CUTOFF = datetime.now(timezone.utc) - timedelta(days=30)
USER_AGENT = "Mozilla/5.0 (compatible; HarnessBot/1.0; +https://harness.ai)"

def db_query(sql: str) -> list:
    """Run SQL inside the postgres Docker container."""
    result = subprocess.run(
        ["docker", "exec", "-i", "gnm_postgres_prod", "psql", "-U", "gnm", "-d", "gnm", "-t", "-A", "-c", sql],
        capture_output=True, text=True,
    )
    return [line.strip() for line in result.stdout.strip().split("\n") if line.strip()]

def fetch_xml(url: str) -> str:
    req = urllib.request.Request(url, headers={
        "User-Agent": USER_AGENT,
        "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
    })
    with urllib.request.urlopen(req, timeout=15) as resp:
        return resp.read().decode("utf-8", errors="replace")

def parse_rss(xml: str):
    items = []
    for block in re.findall(r'<(?:item|entry)[\s>]([\s\S]*?)</(?:item|entry)>', xml, re.IGNORECASE):
        title_match = re.search(r'<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?</title>', block, re.IGNORECASE)
        title = (title_match.group(1) if title_match else "").strip()
        if not title:
            continue

        link_match = re.search(r'<link[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?</link>', block, re.IGNORECASE)
        link_href = re.search(r'<link[^>]+href="([^"]+)"', block, re.IGNORECASE)
        url = (link_match.group(1) if link_match else (link_href.group(1) if link_href else "")).strip()
        if not url or not url.startswith("http"):
            continue

        desc_match = re.search(r'<(description|content:encoded|summary)[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?</(?:description|content:encoded|summary)>', block, re.IGNORECASE)
        body = (desc_match.group(2) if desc_match else "").strip()
        body = re.sub(r'<[^>]+>', ' ', body)

        date_match = re.search(r'<(?:pubDate|published|updated|dc:date)[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?</(?:pubDate|published|updated|dc:date)>', block, re.IGNORECASE)
        date_str = (date_match.group(1) if date_match else "").strip()
        pub_date = parse_date(date_str)

        items.append({"title": title, "url": url, "body": body, "publishedAt": pub_date})
    return items

def parse_date(s: str) -> datetime:
    formats = [
        "%a, %d %b %Y %H:%M:%S %z",
        "%Y-%m-%dT%H:%M:%S%z",
        "%Y-%m-%dT%H:%M:%SZ",
        "%Y-%m-%d %H:%M:%S",
        "%d %b %Y %H:%M:%S %z",
    ]
    for fmt in formats:
        try:
            return datetime.strptime(s, fmt)
        except ValueError:
            continue
    return datetime.now(timezone.utc)

def esc(s: str) -> str:
    return s.replace("'", "''")

def main():
    # Pre-load all existing URLs from DB
    print("Loading existing URLs from DB ...")
    existing_rows = db_query("SELECT url FROM raw_articles;")
    seen_urls = set(existing_rows)
    print(f"  -> {len(seen_urls)} existing URLs")

    all_sql = []

    for feed in NEW_FEEDS:
        feed_id = feed["id"]
        tier = feed["tier"]
        print(f"Fetching {feed_id} ...")
        try:
            xml = fetch_xml(feed["url"])
            articles = parse_rss(xml)
            print(f"  -> {len(articles)} items parsed")

            new_count = 0
            for a in articles:
                url = a["url"]
                if url in seen_urls:
                    continue
                seen_urls.add(url)

                pub = a["publishedAt"]
                if pub.tzinfo is None:
                    pub = pub.replace(tzinfo=timezone.utc)
                if pub < CUTOFF:
                    continue

                article_id = str(uuid.uuid4())
                title = esc(a["title"])[:500]
                body = esc(a["body"])[:5000]
                pub_iso = pub.isoformat()

                all_sql.append(
                    f"INSERT INTO raw_articles (id, feed_id, url, title, body, published_at, credibility_tier, is_state_media, bias_flag, dedup_status, corroboration_count, requires_corroboration) "
                    f"VALUES ('{article_id}', '{feed_id}', '{esc(url)}', '{title}', '{body}', '{pub_iso}', {tier}, false, false, 'pending', 0, false);"
                )
                new_count += 1

            print(f"  -> {new_count} new inserts queued")
        except Exception as e:
            print(f"  -> ERROR: {e}", file=sys.stderr)

    if not all_sql:
        print("\nNo new articles to insert.")
        return

    sql_path = "/tmp/backfill.sql"
    with open(sql_path, "w") as f:
        f.write("\n".join(all_sql))

    print(f"\nWriting {len(all_sql)} statements to {sql_path}")
    print("Executing via docker exec postgres ...")
    result = subprocess.run(
        ["docker", "exec", "-i", "gnm_postgres_prod", "psql", "-U", "gnm", "-d", "gnm", "-f", "-"],
        input="\n".join(all_sql),
        capture_output=True, text=True,
    )
    print(result.stdout)
    if result.stderr:
        print(result.stderr, file=sys.stderr)
    print(f"Exit code: {result.returncode}")

if __name__ == "__main__":
    main()
