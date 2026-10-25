// Arus Global: fxflow (8 mata uang) + aset lain (emas, DXY, BTC, ETF proksi) + stablecoin. Tanpa KV: cache memori 15 dtk.
// Semua angka dari TradingView scanner (gratis, tidak resmi) dan DefiLlama. Bukan data arus dana nyata.
import { loadFxFlow, TFS, NORM, type Tf, type FxFlow } from "./fxflow";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36";
const COLS = ["name", "close", "change", "change|15", "change|60", "change|240", "Perf.W", "Perf.1M"];
const COL_TF: Record<number, Tf> = { 2: "d1", 3: "m15", 4: "h1", 5: "h4", 6: "w1", 7: "m1" };
// Pengali skala (ESTIMASI KASAR): emas dan BTC lebih bergejolak daripada kekuatan satu mata uang.
const VOL: Record<string, number> = { XAU: 1.5, BTC: 3 };

type TfMap = Record<Tf, number | null>;
interface Def { id: string; label: string; sub: string; group: string; sym: string; mkt: string }
const DEFS: Def[] = [
  { id: "XAU", label: "EMAS", sub: "Emas XAU/USD", group: "core", sym: "OANDA:XAUUSD", mkt: "cfd" },
  { id: "DXY", label: "DOLAR AS", sub: "Indeks dolar DXY", group: "core", sym: "TVC:DXY", mkt: "cfd" },
  { id: "TOTAL", label: "CRYPTO", sub: "Total kapitalisasi crypto", group: "core", sym: "CRYPTOCAP:TOTAL", mkt: "cfd" },
  { id: "BTC", label: "BTC", sub: "Bitcoin BTC/USDT", group: "core", sym: "BINANCE:BTCUSDT", mkt: "crypto" },
  { id: "SPY", label: "SAHAM AS", sub: "S&P 500 (SPY)", group: "etf", sym: "AMEX:SPY", mkt: "america" },
  { id: "VXUS", label: "SAHAM DUNIA", sub: "Saham di luar AS (VXUS)", group: "etf", sym: "NASDAQ:VXUS", mkt: "america" },
  { id: "VNQ", label: "PROPERTI", sub: "Properti/REIT (VNQ)", group: "etf", sym: "AMEX:VNQ", mkt: "america" },
  { id: "USO", label: "MINYAK", sub: "Minyak WTI (USO)", group: "etf", sym: "AMEX:USO", mkt: "america" },
  { id: "LQD", label: "OBLIGASI KORP", sub: "Obligasi korporasi (LQD)", group: "etf", sym: "AMEX:LQD", mkt: "america" },
  { id: "SGOV", label: "SGOV", sub: "T-bill ETF", group: "tbill", sym: "NYSE:SGOV", mkt: "america" },
  { id: "BIL", label: "BIL", sub: "T-bill ETF", group: "tbill", sym: "AMEX:BIL", mkt: "america" },
  { id: "USFR", label: "USFR", sub: "T-bill ETF", group: "tbill", sym: "AMEX:USFR", mkt: "america" },
  { id: "TFLO", label: "TFLO", sub: "T-bill ETF", group: "tbill", sym: "AMEX:TFLO", mkt: "america" },
  { id: "BILS", label: "BILS", sub: "T-bill ETF", group: "tbill", sym: "AMEX:BILS", mkt: "america" },
];

export interface FlowAsset { id: string; label: string; sub: string; group: string; symbol: string; close: number | null; chg: TfMap; perf: TfMap | null; score: TfMap | null }
export interface FlowAll extends FxFlow {
  assets: FlowAsset[];
  stable: { usdt: number; usdc: number; now: number; week: number; month: number } | null;
  errors: string[];
}

const emptyTf = (): TfMap => ({ m15: null, h1: null, h4: null, d1: null, w1: null, m1: null });

async function post(url: string, body: unknown): Promise<any> {
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), 10000);
  try {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "User-Agent": UA }, body: JSON.stringify(body), signal: ctl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(to);
  }
}

async function scan(mkt: string, defs: Def[]): Promise<FlowAsset[]> {
  const json = await post(`https://scanner.tradingview.com/${mkt}/scan`, { symbols: { tickers: defs.map((d) => d.sym) }, columns: COLS });
  const rows: any[] = Array.isArray(json?.data) ? json.data : [];
  const out: FlowAsset[] = [];
  for (const d of defs) {
    const r = rows.find((x) => x?.s === d.sym);
    if (!r) continue;
    const arr: unknown[] = Array.isArray(r.d) ? r.d : [];
    const chg = emptyTf();
    for (const [i, tf] of Object.entries(COL_TF)) {
      const x = arr[Number(i)];
      chg[tf] = typeof x === "number" && isFinite(x) ? x : null;
    }
    out.push({ id: d.id, label: d.label, sub: d.sub, group: d.group, symbol: d.sym, close: typeof arr[1] === "number" ? (arr[1] as number) : null, chg, perf: null, score: null });
  }
  return out;
}

/** perf emas/BTC = perubahan harga (USD) minus rata-rata nilai 8 mata uang terhadap USD pada timeframe yang sama. */
function addPerf(a: FlowAsset, fx: FxFlow): void {
  const perf = emptyTf();
  const score = emptyTf();
  for (const tf of TFS) {
    const own = a.chg[tf];
    if (own == null || own <= -100) continue;
    const v: number[] = [0];
    for (const p of fx.pairs) {
      const c = p.chg[tf];
      if (c == null || c <= -100) continue;
      const l = Math.log(1 + c / 100);
      v.push(p.symbol.endsWith("USD") ? l : -l);
    }
    if (v.length < 4) continue;
    const mean = v.reduce((s, x) => s + x, 0) / v.length;
    const pf = 100 * (Math.log(1 + own / 100) - mean);
    perf[tf] = Math.round(pf * 1000) / 1000;
    score[tf] = Math.round(100 * Math.tanh(pf / (NORM[tf] * (VOL[a.id] ?? 1))));
  }
  a.perf = perf;
  a.score = score;
}

async function stables(): Promise<FlowAll["stable"]> {
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), 10000);
  try {
    const res = await fetch("https://stablecoins.llama.fi/stablecoins?includePrices=false", { headers: { "User-Agent": UA }, signal: ctl.signal });
    if (!res.ok) throw new Error(`DefiLlama HTTP ${res.status}`);
    const j: any = await res.json();
    const pick = (sym: string) => (Array.isArray(j?.peggedAssets) ? j.peggedAssets : []).find((a: any) => a?.symbol === sym);
    const g = (a: any, k: string): number => (typeof a?.[k]?.peggedUSD === "number" ? a[k].peggedUSD : NaN);
    const t = pick("USDT"), c = pick("USDC");
    const now = g(t, "circulating") + g(c, "circulating"), week = g(t, "circulatingPrevWeek") + g(c, "circulatingPrevWeek"), month = g(t, "circulatingPrevMonth") + g(c, "circulatingPrevMonth");
    if (![now, week, month].every(isFinite)) throw new Error("data stablecoin tidak lengkap");
    return { usdt: g(t, "circulating"), usdc: g(c, "circulating"), now, week, month };
  } finally {
    clearTimeout(to);
  }
}

let memo: { at: number; data: FlowAll } | null = null;

export async function loadFlow(env?: unknown): Promise<FlowAll> {
  const now = Date.now();
  if (memo && now - memo.at < 15000) return memo.data;
  const fx = await loadFxFlow(env);
  const mkts = ["cfd", "crypto", "america"];
  const [scans, sres] = await Promise.all([Promise.allSettled(mkts.map((m) => scan(m, DEFS.filter((d) => d.mkt === m)))), Promise.allSettled([stables()])]);
  const errors: string[] = [];
  const assets: FlowAsset[] = [];
  scans.forEach((r, i) => {
    if (r.status === "fulfilled") assets.push(...r.value);
    else errors.push(`${mkts[i]}: ${String(r.reason).slice(0, 80)}`);
  });
  let stable: FlowAll["stable"] = null;
  const sr = sres[0];
  if (sr.status === "fulfilled") stable = sr.value;
  else errors.push(`stablecoin: ${String(sr.reason).slice(0, 80)}`);
  for (const a of assets) if (a.id === "XAU" || a.id === "BTC") addPerf(a, fx);
  const data: FlowAll = { ...fx, assets, stable, errors };
  memo = { at: now, data };
  return data;
}