import { describe, it, expect, vi } from "vitest";

// Mock the DB: chainable thenable resolving to configurable rows.
let mockRows: any[] = [];
vi.mock("@workspace/db", () => {
  const rawArticlesTable = { _t: "rawArticles", publishedAt: "published_at" };
  function builder(): any {
    const b: any = {
      from() { return b; },
      where() { return b; },
      orderBy() { return b; },
      limit() { return b; },
      then(res: (r: unknown[]) => void) { res(mockRows); },
    };
    return b;
  }
  return { db: { select: () => builder() }, rawArticlesTable };
});
vi.mock("../../lib/logger.js", () => ({ logger: { info() {}, warn() {}, error() {}, debug() {} } }));

import { getNewsWindowStart, getRelevantNewsByAsset } from "../stock-news.js";

const hoursBetween = (a: Date, b: Date) => Math.round((b.getTime() - a.getTime()) / 3_600_000);

describe("getNewsWindowStart — back to last trading day", () => {
  it("midweek (Wed) → 24h", () => {
    const now = new Date("2026-06-24T06:30:00Z"); // Wed noon IST
    expect(hoursBetween(getNewsWindowStart(now), now)).toBe(24);
  });
  it("Monday → reaches back through the weekend to Friday (72h)", () => {
    const now = new Date("2026-06-29T06:30:00Z"); // Mon noon IST
    expect(hoursBetween(getNewsWindowStart(now), now)).toBe(72);
  });
  it("Saturday → 48h", () => {
    const now = new Date("2026-06-27T06:30:00Z"); // Sat noon IST
    expect(hoursBetween(getNewsWindowStart(now), now)).toBe(48);
  });
});

describe("getRelevantNewsByAsset — driver matching", () => {
  const now = new Date("2026-06-24T06:30:00Z");
  const recent = new Date("2026-06-24T04:00:00Z");
  const art = (title: string, body: string) => ({
    title, body, feedId: "reuters", publishedAt: recent, credibilityTier: 1,
  });

  it("matches each instrument on its drivers, not its own name", async () => {
    mockRows = [
      art("RBI holds repo rate steady, FII inflows resume", "monetary policy mpc decision"),
      art("Reliance Jio cuts 5G tariffs, ARPU set to rise", "jio platforms telecom tariff"),
      art("TCS wins $1bn BFSI deal, order book swells", "it services deal wins tcv discretionary spend"),
      art("Gold climbs as Fed signals rate cut, dollar weakens", "safe haven real yields treasury yield"),
      art("Local cricket club wins weekend tournament", "sports match report"),
    ];

    const map = await getRelevantNewsByAsset(
      [
        { id: "nifty50", name: "NIFTY 50" },
        { id: "reliance", name: "Reliance Industries" },
        { id: "tcs", name: "TCS" },
        { id: "gold", name: "Gold" },
      ],
      now,
    );

    const nifty = map.get("nifty50")!;
    // The Nifty article never says "Nifty" — it matched via RBI/repo/FII drivers.
    expect(nifty).toContain("RBI holds repo rate");
    expect(nifty).not.toContain("Reliance Jio");
    expect(nifty).not.toContain("cricket");

    expect(map.get("reliance")).toContain("Reliance Jio cuts 5G tariffs");
    expect(map.get("tcs")).toContain("TCS wins $1bn BFSI deal");
    expect(map.get("gold")).toContain("Gold climbs as Fed signals rate cut");

    // The off-topic article is in nobody's summary.
    for (const v of map.values()) expect(v).not.toContain("cricket");
  });

  it("reports 'none found' when no driver matches", async () => {
    mockRows = [art("Local cricket club wins weekend tournament", "sports match report")];
    const map = await getRelevantNewsByAsset([{ id: "reliance", name: "Reliance Industries" }], now);
    expect(map.get("reliance")).toContain("none found on its drivers");
  });
});
