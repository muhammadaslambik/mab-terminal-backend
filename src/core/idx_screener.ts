import type { Candle } from "../engines/types";
import { atr, lastNum } from "../utils/indicators";

const TOP_N = 10;
const ATR_MIN_PCT = 4; // syarat volatilitas Remora

export interface ScreenItem {
  code: string;
  last: number;
  changePct: number; // perubahan harga hari terakhir (%)
  valueRp: number; // nilai transaksi hari terakhir = close x volume (Rupiah)
  atrPct: number; // ATR(14) / harga (%)
}

export interface IdxScreen {
  generatedAt: string;
  universe: number;
  scanned: number;
  topValue: ScreenItem[];
  topGainers: ScreenItem[];
  highAtr: ScreenItem[];
}

/** Peringkat dari candle harian yang sudah tutup. Tidak butuh data fundamental. */
export function screenUniverse(data: { code: string; candles: Candle[] }[], now = new Date().toISOString()): IdxScreen {
  const items: ScreenItem[] = [];
  for (const { code, candles } of data) {
    if (candles.length < 16) continue;
    const last = candles[candles.length - 1];
    const prev = candles[candles.length - 2];
    if (!(prev.close > 0) || !(last.close > 0)) continue;
    const atrPct = (lastNum(atr(candles, 14)) / last.close) * 100;
    items.push({
      code,
      last: last.close,
      changePct: Math.round(((last.close - prev.close) / prev.close) * 10000) / 100,
      valueRp: last.close * last.volume,
      atrPct: Math.round(atrPct * 100) / 100,
    });
  }
  const byValue = [...items].sort((a, b) => b.valueRp - a.valueRp);
  return {
    generatedAt: now,
    universe: data.length,
    scanned: items.length,
    topValue: byValue.slice(0, TOP_N),
    topGainers: items.filter((i) => i.changePct > 0).sort((a, b) => b.changePct - a.changePct).slice(0, TOP_N),
    highAtr: items.filter((i) => i.atrPct > ATR_MIN_PCT).sort((a, b) => b.atrPct - a.atrPct),
  };
}

/** Isi AnalysisInput.marketRank untuk satu saham (dipakai Remora). */
export function marketRankFor(screen: IdxScreen, code: string): { topGainer: boolean; topValue: boolean } {
  const c = code.toUpperCase().replace(/\.JK$/, "");
  return { topGainer: screen.topGainers.some((s) => s.code === c), topValue: screen.topValue.some((s) => s.code === c) };
}
