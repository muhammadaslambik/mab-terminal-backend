// Aliran dana FOREX: kekuatan 8 mata uang (USD EUR GBP JPY CHF AUD CAD NZD) terhadap keranjangnya, dari TradingView scanner
// (gratis, tidak resmi; satu permintaan POST untuk semua pasangan). Tanpa KV: cache memori 15 dtk per isolate.
// Persen = kinerja mata uang vs rata-rata keranjang (8/7 x selisih terhadap rata-rata). Skor = kekuatan relatif terhadap
// "gerak normal" per timeframe (ANGKA GERAK NORMAL ADALAH ESTIMASI KASAR, bukan statistik historis terukur), skala -100..+100.

export const TFS = ["m15", "h1", "h4", "d1", "w1", "m1"] as const;
export type Tf = (typeof TFS)[number];
export const CCYS = ["USD", "EUR", "GBP", "JPY", "CHF", "AUD", "CAD", "NZD"] as const;

const URL_FX = "https://scanner.tradingview.com/forex/scan";
const COLS = ["name", "close", "change", "change|15", "change|60", "change|240", "Perf.W", "Perf.1M"];
// indeks kolom (setelah name dan close) -> timeframe
const COL_TF: Record<number, Tf> = { 2: "d1", 3: "m15", 4: "h1", 5: "h4", 6: "w1", 7: "m1" };
const PAIRS: [string, string, string][] = [
  ["FX:EURUSD", "EUR", "USD"],
  ["FX:GBPUSD", "GBP", "USD"],
  ["FX:AUDUSD", "AUD", "USD"],
  ["FX:NZDUSD", "NZD", "USD"],
  ["FX:USDJPY", "USD", "JPY"],
  ["FX:USDCAD", "USD", "CAD"],
  ["FX:USDCHF", "USD", "CHF"],
];
// Estimasi gerak normal (persen) kekuatan satu mata uang per timeframe. Dipakai hanya untuk menskala bar -100..+100.
export const NORM: Record<Tf, number> = { m15: 0.06, h1: 0.12, h4: 0.25, d1: 0.4, w1: 0.9, m1: 2.0 };

export interface FxCcy {
  code: string;
  perf: Record<Tf, number | null>; // persen vs keranjang
  score: Record<Tf, number | null>; // -100..+100
}
export interface FxFlow {
  builtAt: string;
  source: string;
  pairs: { symbol: string; close: number | null; chg: Record<Tf, number | null> }[];
  currencies: FxCcy[];
  missing: string[];
  norm: Record<Tf, number>;
  note: string;
}

const emptyTf = (): Record<Tf, number | null> => ({ m15: null, h1: null, h4: null, d1: null, w1: null, m1: null });
const r3 = (x: number) => Math.round(x * 1000) / 1000;

/** Hitung kekuatan tiap mata uang dari perubahan pasangan (persen). Murni, mudah diuji. */
export function computeFlow(rows: { symbol: string; close: number | null; chg: Record<Tf, number | null> }[]): { currencies: FxCcy[]; missing: string[] } {
  const bySym = new Map(rows.map((r) => [r.symbol, r]));
  const currencies: FxCcy[] = CCYS.map((code) => ({ code, perf: emptyTf(), score: emptyTf() }));
  for (const tf of TFS) {
    const v: Record<string, number> = { USD: 0 };
    for (const [sym, base, quote] of PAIRS) {
      const p = bySym.get(sym)?.chg[tf];
      if (typeof p !== "number" || !isFinite(p) || p <= -100) continue;
      const l = Math.log(1 + p / 100);
      if (quote === "USD") v[base] = l;
      else v[quote] = -l; // base === USD
    }
    const known = Object.keys(v);
    const n = known.length;
    if (n < 3) continue;
    const mean = known.reduce((s, k) => s + v[k], 0) / n;
    for (const c of currencies) {
      if (!(c.code in v)) continue;
      const perf = 100 * (n / (n - 1)) * (v[c.code] - mean);
      c.perf[tf] = r3(perf);
      c.score[tf] = Math.round(100 * Math.tanh(perf / NORM[tf]));
    }
  }
  const missing = PAIRS.map((p) => p[0]).filter((s) => !bySym.has(s));
  return { currencies, missing };
}

let memo: { at: number; data: FxFlow } | null = null;

export async function loadFxFlow(_env?: unknown): Promise<FxFlow> {
  const now = Date.now();
  if (memo && now - memo.at < 15000) return memo.data;
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), 10000);
  let json: any;
  try {
    const res = await fetch(URL_FX, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36" },
      body: JSON.stringify({ symbols: { tickers: PAIRS.map((p) => p[0]) }, columns: COLS }),
      signal: ctl.signal,
    });
    if (!res.ok) throw new Error(`TradingView scanner HTTP ${res.status}`);
    json = await res.json();
  } finally {
    clearTimeout(to);
  }
  const rows = (Array.isArray(json?.data) ? json.data : []).map((r: any) => {
    const d: unknown[] = Array.isArray(r?.d) ? r.d : [];
    const chg = emptyTf();
    for (const [i, tf] of Object.entries(COL_TF)) {
      const x = d[Number(i)];
      chg[tf] = typeof x === "number" && isFinite(x) ? x : null;
    }
    const close = typeof d[1] === "number" ? (d[1] as number) : null;
    return { symbol: String(r?.s ?? ""), close, chg };
  });
  const { currencies, missing } = computeFlow(rows);
  const data: FxFlow = {
    builtAt: new Date(now).toISOString(),
    source: "TradingView scanner (gratis, tidak resmi)",
    pairs: rows,
    currencies,
    missing,
    norm: NORM,
    note: "15m/1H/4H/1D = candle yang sedang berjalan; 1W/1M = 7 dan 30 hari bergulir. Persen = kinerja vs keranjang 8 mata uang. Skor -100..+100 diskalakan dengan estimasi gerak normal (bukan statistik terukur). Bukan saran investasi.",
  };
  memo = { at: now, data };
  return data;
}
