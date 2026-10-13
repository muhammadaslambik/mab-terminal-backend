import type { Candle } from "../engines/types";
import type { IdxStock } from "../feed/pasardana";
import { atr, lastNum } from "../utils/indicators";

// Satuan sudah diverifikasi dari respons Pasardana asli: Value dan Capitalization dalam Rupiah,
// Roe berupa pecahan, FreeFloatPct berupa persen.
const TOP_N = 20;
const POOL_FOR_GAINERS = 100; // top gainer dicari di antara 100 saham dengan nilai transaksi terbesar
const MIN_TURNOVER_RP = 1_000_000_000;
const MICRO_CAP_RP = 500_000_000_000;
const FREE_FLOAT_MAX = 30; // kepemilikan publik > 30% dianggap jelek (owner dominan lebih baik)
const CRASH_1Y = -0.5; // turun >= 50% dalam 1 tahun = indikasi saham gorengan
const PE_DISCOUNT = 0.7; // PER < 70% median PER sektor
const MAX_PE = 200; // PER ekstrem (laba hampir nol) tidak dihitung
const MIN_SECTOR_SIZE = 5;
const ATR_MIN_PCT = 4;

export interface ScreenItem {
  code: string;
  name?: string;
  sector?: string;
  last?: number;
  changePct?: number;
  valueRp?: number;
  pbv?: number;
  per?: number;
  roe?: number;
  freeFloatPct?: number;
  marketCapRp?: number;
  return1y?: number; // pecahan, -0.5 = turun 50%
  atrPct?: number;
}

export interface IdxScreen {
  generatedAt: string;
  source: "pasardana" | "yahoo";
  total: number; // jumlah saham yang dipindai / ukuran daftar pantau
  scanned: number; // jumlah yang punya data lengkap
  topValue: ScreenItem[];
  topGainers: ScreenItem[];
  valueCandidates: ScreenItem[]; // penyaring awal Andry Hakim v1/v3 (hanya sumber Pasardana)
  shellCandidates: ScreenItem[]; // penyaring awal Andry Hakim v2/v3 (hanya sumber Pasardana)
  highAtr: ScreenItem[];
  sectorPe: Record<string, number>;
}

const median = (a: number[]): number => {
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Median PER positif per sektor = "PER rata-rata industri". */
export function computeSectorPe(stocks: IdxStock[]): Record<string, number> {
  const bySector = new Map<string, number[]>();
  for (const s of stocks) {
    if (!s.sector || s.per === undefined || s.per <= 0 || s.per > MAX_PE) continue;
    const arr = bySector.get(s.sector) ?? [];
    arr.push(s.per);
    bySector.set(s.sector, arr);
  }
  const out: Record<string, number> = {};
  for (const [sector, arr] of bySector) if (arr.length >= MIN_SECTOR_SIZE) out[sector] = round2(median(arr));
  return out;
}

const fromStock = (s: IdxStock): ScreenItem => ({
  code: s.code,
  name: s.name,
  sector: s.sector,
  last: s.last,
  changePct: s.changePct !== undefined ? round2(s.changePct) : undefined,
  valueRp: s.value,
  pbv: s.pbv !== undefined ? round2(s.pbv) : undefined,
  per: s.per !== undefined ? round2(s.per) : undefined,
  roe: s.roe !== undefined ? Math.round(s.roe * 10000) / 10000 : undefined,
  freeFloatPct: s.freeFloatPct,
  marketCapRp: s.marketCap,
  return1y: s.oneYear !== undefined ? round2(s.oneYear) : undefined,
});

/** Penyaringan seluruh pasar dari data Pasardana (harga, PER, PBV, market cap, free float, ROE). */
export function screenMarket(stocks: IdxStock[], now = new Date().toISOString()): IdxScreen {
  const traded = stocks.filter((s) => (s.value ?? 0) > 0);
  const byValue = [...traded].sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
  const sectorPe = computeSectorPe(stocks);

  const topGainers = byValue
    .slice(0, POOL_FOR_GAINERS)
    .filter((s) => s.changePct !== undefined && s.changePct > 0)
    .sort((a, b) => (b.changePct ?? 0) - (a.changePct ?? 0))
    .slice(0, TOP_N);

  // Value: PBV < 1, PER di bawah 70% median sektor, laba positif (ROE > 0), likuid
  const valueCandidates = stocks
    .filter((s) => {
      const pe = s.sector ? sectorPe[s.sector] : undefined;
      return (
        s.pbv !== undefined && s.pbv > 0 && s.pbv < 1 &&
        s.per !== undefined && s.per > 0 && pe !== undefined && s.per < pe * PE_DISCOUNT &&
        s.roe !== undefined && s.roe > 0 &&
        (s.value ?? 0) >= MIN_TURNOVER_RP
      );
    })
    .sort((a, b) => (a.pbv ?? 0) - (b.pbv ?? 0))
    .slice(0, TOP_N);

  // Calon target suntikan dana: market cap < Rp500 miliar, PBV < 1 (termasuk negatif), kepemilikan publik <= 30%
  // (makin kecil makin baik), tidak hancur >= 50% dalam 1 tahun. Hutang (DER) belum ada di Pasardana: cek di data/intel.ts.
  const shellCandidates = traded
    .filter(
      (s) =>
        s.marketCap !== undefined && s.marketCap > 0 && s.marketCap < MICRO_CAP_RP &&
        s.pbv !== undefined && s.pbv < 1 &&
        s.freeFloatPct !== undefined && s.freeFloatPct > 0 && s.freeFloatPct <= FREE_FLOAT_MAX &&
        (s.oneYear === undefined || s.oneYear > CRASH_1Y)
    )
    .sort((a, b) => (a.freeFloatPct ?? 0) - (b.freeFloatPct ?? 0) || (a.marketCap ?? 0) - (b.marketCap ?? 0))
    .slice(0, TOP_N);

  return {
    generatedAt: now,
    source: "pasardana",
    total: stocks.length,
    scanned: traded.length,
    topValue: byValue.slice(0, TOP_N).map(fromStock),
    topGainers: topGainers.map(fromStock),
    valueCandidates: valueCandidates.map(fromStock),
    shellCandidates: shellCandidates.map(fromStock),
    highAtr: [],
    sectorPe,
  };
}

/** Cadangan bila Pasardana gagal: peringkat dari candle harian daftar pantau (tanpa data fundamental). */
export function screenUniverse(data: { code: string; candles: Candle[] }[], now = new Date().toISOString()): IdxScreen {
  const items: ScreenItem[] = [];
  for (const { code, candles } of data) {
    if (candles.length < 16) continue;
    const last = candles[candles.length - 1];
    const prev = candles[candles.length - 2];
    if (!(prev.close > 0) || !(last.close > 0)) continue;
    items.push({
      code,
      last: last.close,
      changePct: round2(((last.close - prev.close) / prev.close) * 100),
      valueRp: last.close * last.volume,
      atrPct: round2((lastNum(atr(candles, 14)) / last.close) * 100),
    });
  }
  const byValue = [...items].sort((a, b) => (b.valueRp ?? 0) - (a.valueRp ?? 0));
  return {
    generatedAt: now,
    source: "yahoo",
    total: data.length,
    scanned: items.length,
    topValue: byValue.slice(0, 10),
    topGainers: items.filter((i) => (i.changePct ?? 0) > 0).sort((a, b) => (b.changePct ?? 0) - (a.changePct ?? 0)).slice(0, 10),
    valueCandidates: [],
    shellCandidates: [],
    highAtr: items.filter((i) => (i.atrPct ?? 0) > ATR_MIN_PCT).sort((a, b) => (b.atrPct ?? 0) - (a.atrPct ?? 0)),
    sectorPe: {},
  };
}

/** Isi AnalysisInput.marketRank untuk satu saham (dipakai Remora). */
export function marketRankFor(screen: IdxScreen, code: string): { topGainer: boolean; topValue: boolean } {
  const c = code.toUpperCase().replace(/\.JK$/, "");
  return { topGainer: screen.topGainers.some((s) => s.code === c), topValue: screen.topValue.some((s) => s.code === c) };
}
