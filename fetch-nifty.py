import json, urllib.request, os
from datetime import datetime

SYMBOL = "^NSEI"
INTERVAL = "1m"
RANGE = "1d"
url = f"https://query1.finance.yahoo.com/v8/finance/chart/{SYMBOL}?interval={INTERVAL}&range={RANGE}"

req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
with urllib.request.urlopen(req) as res:
    data = json.load(res)

result = data.get("chart", {}).get("result", [None])[0]
if not result:
    print("No data:", data)
    exit(1)

ts = result.get("timestamp", [])
q = result.get("indicators", {}).get("quote", [{}])[0]
rows = []
for i, t in enumerate(ts):
    rows.append({
        "datetime": datetime.utcfromtimestamp(t).isoformat() + "Z",
        "open": q.get("open", [])[i] if i < len(q.get("open", [])) else None,
        "high": q.get("high", [])[i] if i < len(q.get("high", [])) else None,
        "low": q.get("low", [])[i] if i < len(q.get("low", [])) else None,
        "close": q.get("close", [])[i] if i < len(q.get("close", [])) else None,
        "volume": q.get("volume", [])[i] if i < len(q.get("volume", [])) else None,
    })

out = f"/Users/pratikbaswana/Downloads/nifty-1min-{datetime.utcnow().date().isoformat()}.json"
with open(out, "w") as f:
    json.dump(rows, f, indent=2)
print(f"Saved {len(rows)} 1-minute candles to {out}")
