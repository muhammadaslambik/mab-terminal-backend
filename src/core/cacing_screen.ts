import { fetchTvRows, type TvRow } from "../feed/tradingview";

// Konstanta samakan dengan an4_andry_hakim.ts (v2 cacing-naga)
export const DER_MAX = 0.1; // total liabilitas / ekuitas (definisi IDX)
export const MARKET_CAP_MAX = 500_000_000_000; // Rp500 miliar, strict (<)
export const FLOAT_MAX_TV = 40; // persen. Float TradingView memakai ukuran lain dari "Non Warkat" IDX, jadi sengaja longgar

export interface CacingCandidate {
  code: string;
  name: string | null;
  close: number | null;
  marketCapBn: number;
  derIdx: number;
  floatPct: number;
  liabilitiesBn: number;
  equityBn: number;
  pbv: number;
  navPerShare: number;
  priceToNav: number | null;
}

export interface CacingScreen {
  computedAt: string;
  source: "tradingview";
  params: { derMax: number; marketCapMaxBn: number; floatMaxPct: number };
  totals: { rows: number; stocks: number; passed: number };
  typesSeen: Record<string, number>;
  dropped: { notStock: number; noData: number; equityNonPositive: number; marketCap: number; der: number; float: number };
  candidates: CacingCandidate[];
  note: string;
}

const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;

export function screenCacingNaga(rows: TvRow[], now = new Date()): CacingScreen {
  const dropped = { notStock: 0, noData: 0, equityNonPositive: 0, marketCap: 0, der: 0, float: 0 };
  const typesSeen: Record<string, number> = {};
  const candidates: CacingCandidate[] = [];
  let stocks = 0;

  for (const r of rows) {
    const t = r.type ?? "null";
    typesSeen[t] = (typesSeen[t] ?? 0) + 1;
    if (r.type !== null && r.type !== "stock") {
      dropped.notStock++;
      continue;
    }
    stocks++;
    if (r.marketCap === null || r.liabilities === null || r.equity === null || r.shares === null || r.floatShares === null || r.shares <= 0) {
      dropped.noData++;
      continue;
    }
    if (r.equity <= 0) {
      dropped.equityNonPositive++;
      continue;
    }
    if (!(r.marketCap < MARKET_CAP_MAX)) {
      dropped.marketCap++;
      continue;
    }
    const der = r.liabilities / r.equity;
    if (!(der >= 0 && der <= DER_MAX)) {
      dropped.der++;
      continue;
    }
    const floatPct = (r.floatShares / r.shares) * 100;
    if (floatPct > FLOAT_MAX_TV) {
      dropped.float++;
      continue;
    }
    const nav = r.equity / r.shares;
    candidates.push({
      code: r.code,
      name: r.name,
      close: r.close,
      marketCapBn: round(r.marketCap / 1e9, 1),
      derIdx: round(der, 3),
      floatPct: round(floatPct, 2),
      liabilitiesBn: round(r.liabilities / 1e9, 2),
      equityBn: round(r.equity / 1e9, 2),
      pbv: round(r.marketCap / r.equity, 2),
      navPerShare: round(nav, 1),
      priceToNav: r.close !== null && nav > 0 ? round(r.close / nav, 2) : null,
    });
  }
  candidates.sort((a, b) => a.floatPct - b.floatPct);

  return {
    computedAt: now.toISOString(),
    source: "tradingview",
    params: { derMax: DER_MAX, marketCapMaxBn: MARKET_CAP_MAX / 1e9, floatMaxPct: FLOAT_MAX_TV },
    totals: { rows: rows.length, stocks, passed: candidates.length },
    typesSeen,
    dropped,
    candidates,
    note: "Daftar pantauan struktur. Komposisi pengendali (owner 70-99%) dan pengumuman resmi tidak tersedia tanpa idx.co.id. Nilai transaksi dan dana masuk dibaca manual.",
  };
}

const KEY = "CACING_SCREEN";
const TTL_S = 3 * 24 * 3600;

export async function runCacingScreen(env: any, fetchFn: typeof fetch = fetch): Promise<CacingScreen> {
  const screen = screenCacingNaga(await fetchTvRows(fetchFn));
  if (env?.KV_CACHE) await env.KV_CACHE.put(KEY, JSON.stringify(screen), { expirationTtl: TTL_S });
  return screen;
}

export async function loadOrRunCacingScreen(env: any, refresh = false, fetchFn: typeof fetch = fetch): Promise<CacingScreen> {
  if (!refresh && env?.KV_CACHE) {
    const cached: CacingScreen | null = await env.KV_CACHE.get(KEY, "json");
    if (cached) return cached;
  }
  return runCacingScreen(env, fetchFn);
}
