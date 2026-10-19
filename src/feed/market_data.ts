// Data pasar global nyata untuk frontend: harga + deret harian (Yahoo Finance) dan yield ID 10Y (TradingView).
// Satu build = ~30 fetch (batas 50). Hasil disimpan di KV MARKET_OVERVIEW (segar 5 menit). Bukan data tick; harian + harga terakhir.
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
const KEY = "MARKET_OVERVIEW";
const FRESH_MS = 5 * 60 * 1000;
const KV_TTL_S = 24 * 3600;
const MAX_POINTS = 41; // 41 penutupan = 40 periode

export type MarketGroup = "index" | "fx" | "cmdty" | "crypto" | "us" | "id";
export interface MarketSymbol {
  id: string;
  label: string;
  symbol: string;
  group: MarketGroup;
  region?: string;
}

export const MARKET_SYMBOLS: MarketSymbol[] = [
  { id: "US", label: "S&P 500", symbol: "^GSPC", group: "index", region: "US" },
  { id: "EU", label: "Euro Stoxx 50", symbol: "^STOXX50E", group: "index", region: "EU" },
  { id: "CN", label: "Shanghai Composite", symbol: "000001.SS", group: "index", region: "CN" },
  { id: "JP", label: "Nikkei 225", symbol: "^N225", group: "index", region: "JP" },
  { id: "ID", label: "IHSG", symbol: "^JKSE", group: "index", region: "ID" },
  { id: "IN", label: "BSE Sensex", symbol: "^BSESN", group: "index", region: "IN" },
  { id: "BR", label: "Bovespa", symbol: "^BVSP", group: "index", region: "BR" },
  { id: "USDIDR", label: "USD/IDR", symbol: "USDIDR=X", group: "fx" },
  { id: "EURUSD", label: "EUR/USD", symbol: "EURUSD=X", group: "fx" },
  { id: "USDJPY", label: "USD/JPY", symbol: "JPY=X", group: "fx" },
  { id: "DXY", label: "DXY", symbol: "DX-Y.NYB", group: "fx" },
  { id: "XAU", label: "Emas (GC=F, berjangka)", symbol: "GC=F", group: "cmdty" },
  { id: "WTI", label: "WTI", symbol: "CL=F", group: "cmdty" },
  { id: "XAG", label: "Perak (SI=F, berjangka)", symbol: "SI=F", group: "cmdty" },
  { id: "US10Y", label: "US 10Y (%)", symbol: "^TNX", group: "cmdty" },
  { id: "BTC", label: "BTC/USD", symbol: "BTC-USD", group: "crypto" },
  { id: "ETH", label: "ETH/USD", symbol: "ETH-USD", group: "crypto" },
  { id: "SOL", label: "SOL/USD", symbol: "SOL-USD", group: "crypto" },
  { id: "AAPL", label: "Apple", symbol: "AAPL", group: "us" },
  { id: "NVDA", label: "NVIDIA", symbol: "NVDA", group: "us" },
  { id: "MSFT", label: "Microsoft", symbol: "MSFT", group: "us" },
  { id: "TSLA", label: "Tesla", symbol: "TSLA", group: "us" },
  { id: "AMZN", label: "Amazon", symbol: "AMZN", group: "us" },
  { id: "BBCA", label: "BBCA", symbol: "BBCA.JK", group: "id" },
  { id: "BBRI", label: "BBRI", symbol: "BBRI.JK", group: "id" },
  { id: "BMRI", label: "BMRI", symbol: "BMRI.JK", group: "id" },
  { id: "TLKM", label: "TLKM", symbol: "TLKM.JK", group: "id" },
  { id: "ASII", label: "ASII", symbol: "ASII.JK", group: "id" },
  { id: "GOTO", label: "GOTO", symbol: "GOTO.JK", group: "id" },
];

const num = (v: unknown): number | null => (typeof v === "number" && isFinite(v) ? v : null);
const r4 = (v: number) => Math.round(v * 10000) / 10000;
const pctFrom = (last: number, ref: number | undefined) => (ref !== undefined && ref !== 0 ? r4((last / ref - 1) * 100) : null);

async function fetchOne(s: MarketSymbol): Promise<Record<string, unknown>> {
  const base = { id: s.id, label: s.label, symbol: s.symbol, group: s.group, region: s.region ?? null, source: "Yahoo Finance" };
  try {
    const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(s.symbol)}?range=3mo&interval=1d`, {
      headers: { "User-Agent": UA, Accept: "application/json" },
    });
    if (!r.ok) return { ...base, ok: false, error: `HTTP ${r.status}` };
    const j: any = await r.json();
    const res = j?.chart?.result?.[0];
    if (!res) return { ...base, ok: false, error: String(j?.chart?.error?.description ?? "tanpa result").slice(0, 100) };
    const ts: unknown[] = res.timestamp ?? [];
    const cl: unknown[] = res.indicators?.quote?.[0]?.close ?? [];
    const times: number[] = [];
    const closes: number[] = [];
    for (let i = 0; i < cl.length; i++) {
      const c = num(cl[i]);
      const t = num(ts[i]);
      if (c !== null && t !== null) {
        closes.push(c);
        times.push(t);
      }
    }
    const m = res.meta ?? {};
    const price = num(m.regularMarketPrice) ?? (closes.length ? closes[closes.length - 1] : null);
    if (price === null || closes.length < 2) return { ...base, ok: false, error: "data tidak cukup" };
    const n = closes.length;
    const lastT = num(m.regularMarketTime);
    return {
      ...base,
      ok: true,
      price,
      currency: m.currency ?? null,
      exchange: m.exchangeName ?? null,
      asOf: lastT !== null ? new Date(lastT * 1000).toISOString() : new Date(times[n - 1] * 1000).toISOString(),
      perf: {
        d1: pctFrom(closes[n - 1], closes[n - 2]),
        w1: pctFrom(closes[n - 1], closes[n - 6]),
        m1: pctFrom(closes[n - 1], closes[n - 22]),
        m3: pctFrom(closes[n - 1], closes[0]),
      },
      points: n,
      closes: closes.slice(-MAX_POINTS),
      times: times.slice(-MAX_POINTS),
    };
  } catch (e) {
    return { ...base, ok: false, error: String(e).slice(0, 100) };
  }
}

async function fetchYields(): Promise<Record<string, unknown>> {
  try {
    const r = await fetch("https://scanner.tradingview.com/global/scan", {
      method: "POST",
      headers: { "content-type": "application/json", "User-Agent": UA },
      body: JSON.stringify({ symbols: { tickers: ["TVC:ID10Y", "TVC:US10Y"] }, columns: ["name", "close", "change"] }),
    });
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
    const j: any = await r.json();
    const out: Record<string, unknown> = { ok: true, source: "TradingView" };
    for (const row of Array.isArray(j?.data) ? j.data : []) {
      const name = String(row?.d?.[0] ?? "").toLowerCase();
      if (name) out[name] = { close: num(row?.d?.[1]), changePct: num(row?.d?.[2]) };
    }
    return out;
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 100) };
  }
}

export async function buildMarketOverview(): Promise<Record<string, unknown>> {
  const [quotes, yields] = await Promise.all([Promise.all(MARKET_SYMBOLS.map(fetchOne)), fetchYields()]);
  return {
    builtAt: new Date().toISOString(),
    okCount: quotes.filter((q) => q.ok === true).length,
    total: quotes.length,
    quotes,
    yields,
    note: "Sumber gratis, tidak real-time tick: harga terakhir + penutupan harian. Tiap angka punya asOf. Bukan nasihat investasi.",
  };
}

/** Cache KV 5 menit. Bila build gagal (kurang dari separuh simbol ok) dan ada cache lama, sajikan cache lama dengan stale=true. */
export async function loadMarketOverview(env: any, refresh = false): Promise<Record<string, unknown>> {
  const kv = env?.KV_CACHE;
  let cached: any = null;
  if (kv) {
    try {
      cached = await kv.get(KEY, "json");
    } catch (_e) {
      cached = null;
    }
  }
  if (!refresh && cached?.builtAt && Date.now() - Date.parse(cached.builtAt) < FRESH_MS) return { ...cached, cache: "hit" };
  const fresh: any = await buildMarketOverview();
  if (fresh.okCount < MARKET_SYMBOLS.length / 2 && cached) return { ...cached, cache: "stale", staleReason: `build baru hanya ${fresh.okCount}/${fresh.total} simbol` };
  if (kv) {
    try {
      await kv.put(KEY, JSON.stringify(fresh), { expirationTtl: KV_TTL_S });
    } catch (_e) {
      // gagal simpan cache tidak boleh menggagalkan respons
    }
  }
  return { ...fresh, cache: "miss" };
}
