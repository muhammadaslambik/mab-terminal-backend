import type { IdxStock } from "../feed/pasardana";

// --- Parameter (kalibrasi setelah /api/idx/probe) ---
const TOP_N = 20;
const POOL_FOR_GAINERS = 100; // top gainer dicari hanya di antara 100 saham dengan nilai transaksi terbesar
const MIN_TURNOVER_RP = 1_000_000_000; // asumsi field Value dalam Rupiah
const CAP_UNIT = 1; // pengali Capitalization -> Rupiah (ubah jika probe menunjukkan satuan lain, mis. 1_000_000)
const MICRO_CAP_RP = 500_000_000_000;
const PE_DISCOUNT = 0.7; // PER < 70% median PER sektor
const MAX_PE = 200; // PER ekstrem diabaikan saat menghitung median
const MIN_SECTOR_SIZE = 5;

export interface ScreenItem {
  code: string;
  name: string;
  sector?: string;
  last?: number;
  changePct?: number;
  value?: number;
  pbv?: number;
  per?: number;
  marketCapRp?: number;
}

export interface IdxScreen {
  generatedAt: string;
  total: number;
  topValue: ScreenItem[];
  topGainers: ScreenItem[];
  valueCandidates: ScreenItem[]; // lolos penyaring awal Andry Hakim v1/v3 (Track A)
  shellCandidates: ScreenItem[]; // lolos penyaring awal Andry Hakim v2/v3 (Track B)
  sectorPe: Record<string, number>;
}

const item = (s: IdxStock): ScreenItem => ({
  code: s.code,
  name: s.name,
  sector: s.sector,
  last: s.last,
  changePct: s.changePct !== undefined ? Math.round(s.changePct * 100) / 100 : undefined,
  value: s.value,
  pbv: s.pbv,
  per: s.per,
  marketCapRp: s.marketCap !== undefined ? s.marketCap * CAP_UNIT : undefined,
});

const median = (a: number[]): number => {
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Median PER positif per sektor (dipakai sebagai "PER rata-rata industri"). */
export function computeSectorPe(stocks: IdxStock[]): Record<string, number> {
  const bySector = new Map<string, number[]>();
  for (const s of stocks) {
    if (!s.sector || s.per === undefined || s.per <= 0 || s.per > MAX_PE) continue;
    const arr = bySector.get(s.sector) ?? [];
    arr.push(s.per);
    bySector.set(s.sector, arr);
  }
  const out: Record<string, number> = {};
  for (const [sector, arr] of bySector) if (arr.length >= MIN_SECTOR_SIZE) out[sector] = Math.round(median(arr) * 100) / 100;
  return out;
}

export function screenIdx(stocks: IdxStock[], now = new Date().toISOString()): IdxScreen {
  const traded = stocks.filter((s) => (s.value ?? 0) > 0);
  const byValue = [...traded].sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
  const topValue = byValue.slice(0, TOP_N);

  const topGainers = byValue
    .slice(0, POOL_FOR_GAINERS)
    .filter((s) => s.changePct !== undefined && s.changePct > 0)
    .sort((a, b) => (b.changePct ?? 0) - (a.changePct ?? 0))
    .slice(0, TOP_N);

  const sectorPe = computeSectorPe(stocks);

  const valueCandidates = stocks
    .filter((s) => {
      const pe = s.sector ? sectorPe[s.sector] : undefined;
      return (
        s.pbv !== undefined && s.pbv > 0 && s.pbv < 1 &&
        s.per !== undefined && s.per > 0 && pe !== undefined && s.per < pe * PE_DISCOUNT &&
        (s.value ?? 0) >= MIN_TURNOVER_RP
      );
    })
    .sort((a, b) => (a.pbv ?? 0) - (b.pbv ?? 0))
    .slice(0, TOP_N);

  const shellCandidates = traded
    .filter((s) => s.marketCap !== undefined && s.marketCap * CAP_UNIT > 0 && s.marketCap * CAP_UNIT < MICRO_CAP_RP && s.pbv !== undefined && s.pbv < 1)
    .sort((a, b) => (a.marketCap ?? 0) - (b.marketCap ?? 0))
    .slice(0, TOP_N);

  return {
    generatedAt: now,
    total: stocks.length,
    topValue: topValue.map(item),
    topGainers: topGainers.map(item),
    valueCandidates: valueCandidates.map(item),
    shellCandidates: shellCandidates.map(item),
    sectorPe,
  };
}

/** Isi AnalysisInput.marketRank untuk satu saham (dipakai Remora). */
export function marketRankFor(screen: IdxScreen, code: string): { topGainer: boolean; topValue: boolean } {
  const c = code.toUpperCase().replace(/\.JK$/, "");
  return { topGainer: screen.topGainers.some((s) => s.code === c), topValue: screen.topValue.some((s) => s.code === c) };
}
