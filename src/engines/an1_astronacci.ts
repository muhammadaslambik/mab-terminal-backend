/**
 * an1_astronacci — Astronacci (Asst. Prof. Dr. Gema Goeyardi)
 * Pilar 1: Time Engine   -> IS_TIME_ZONE (jendela ±3 hari dari tanggal target pembalikan)
 * Pilar 2: Price Engine  -> Fibonacci 50%/61.8% + Hook Pattern (Stochastic 14,3,3 golden cross di oversold)
 * Pilar 3: Risk Engine   -> alokasi & stop loss per kelas aset
 * Hanya Long (Buy on Weakness) pada tren naik. Asumsi: candle harian.
 */
import type { AnalysisInput, AssetClass, Candle, Engine, EngineSignal } from "./types";
import { abstain, fmt, hold } from "./common";
import { cleanCandles, ema, highestIndex, isMarketClosed, lastNum, lowestIndex, stochastic } from "../utils/indicators";

const NAME = "an1_astronacci";
const MIN_CANDLES = 210; // cukup untuk EMA200
const SWING_LOOKBACK = 50;
const TIME_WINDOW_DAYS = 3;
const CYCLE_DAYS = [90, 105, 120]; // klaster siklus waktu jangka menengah
const GOLD_SL_BUFFER = 3; // poin di bawah swing low (aturan: 2-5 poin)
const REQUIRE_TIME_ZONE = true; // ubah ke false jika ingin time zone hanya jadi bonus

/* ------------------------------- TIME ENGINE ------------------------------ */

/** Perkiraan ekuinoks/solstis (±1 hari) sebagai titik balik astronomis dasar. */
const astronomicalDates = (year: number): string[] => [
  `${year}-03-20`,
  `${year}-06-21`,
  `${year}-09-22`,
  `${year}-12-21`,
];

/** Kumpulkan tanggal target: input manual + siklus 90/105/120 hari dari swing low + titik astronomis. */
export function buildTimeTargets(candles: Candle[], now: string, extra: string[] = []): string[] {
  const targets = new Set<string>(extra);
  const win = candles.slice(-150);
  if (win.length) {
    const pivot = Date.parse(win[lowestIndex(win, 0, win.length - 1)].time);
    for (const d of CYCLE_DAYS) targets.add(new Date(pivot + d * 86_400_000).toISOString().slice(0, 10));
  }
  const y = new Date(now).getUTCFullYear();
  for (const yy of [y - 1, y, y + 1]) astronomicalDates(yy).forEach((d) => targets.add(d));
  return [...targets];
}

/** IS_TIME_ZONE = true jika tanggal berada dalam ±3 hari dari salah satu target. */
export function checkTimeWindow(now: string, targets: string[], windowDays = TIME_WINDOW_DAYS): boolean {
  const t = Date.parse(now.slice(0, 10));
  return targets.some((d) => Math.abs(t - Date.parse(d)) <= windowDays * 86_400_000);
}

/* ------------------------------- PRICE ENGINE ----------------------------- */

export interface FibLevels {
  swingHigh: number;
  swingLow: number;
  level500: number;
  level618: number;
}

/** Swing High dalam 50 candle terakhir, dan Swing Low sebelum high tersebut. */
export function calculateFibonacciLevels(candles: Candle[]): FibLevels | null {
  const w = candles.slice(-SWING_LOOKBACK);
  if (w.length < 10) return null;
  const hi = highestIndex(w, 0, w.length - 1);
  if (hi < 3) return null; // high terlalu dekat awal: belum ada ayunan naik
  const lo = lowestIndex(w, 0, hi);
  const swingHigh = w[hi].high;
  const swingLow = w[lo].low;
  const range = swingHigh - swingLow;
  if (range <= 0) return null;
  return { swingHigh, swingLow, level500: swingHigh - range * 0.5, level618: swingHigh - range * 0.618 };
}

/** Hook Pattern: harga di Golden Ratio Zone + Stochastic golden cross dari area oversold (<20). */
export function detectHookPattern(candles: Candle[], fib: FibLevels): boolean {
  const { k, d } = stochastic(candles, 14, 3, 3);
  const i = candles.length - 1;
  if (i < 1 || [k[i], d[i], k[i - 1], d[i - 1]].some(Number.isNaN)) return false;
  const close = candles[i].close;
  const inZone = close <= fib.level500 && close >= fib.level618;
  const goldenCross = k[i - 1] <= d[i - 1] && k[i] > d[i];
  const wasOversold = Math.min(k[i - 1], d[i - 1]) < 20;
  return inZone && goldenCross && wasOversold;
}

/* -------------------------------- RISK ENGINE ----------------------------- */

export interface SizeResult {
  maxAllocationPct: number;
  tranches: number;
  positionPct: number; // alokasi per tahap/layer (% ekuitas)
  riskPct: number; // risiko per tahap (% ekuitas)
  units?: number; // XAUUSD: ukuran posisi berdasar risiko 2%
}

export function calculatePositionSize(assetClass: AssetClass, equity: number, entry: number, stop: number): SizeResult {
  const dist = Math.max(entry - stop, 0);
  const slPct = entry > 0 ? dist / entry : 0;
  switch (assetClass) {
    case "CRYPTO": // swing, tanpa leverage, maks 15% portofolio, DCA bertahap
      return { maxAllocationPct: 15, tranches: 5, positionPct: 3, riskPct: 3 * slPct };
    case "XAUUSD": {
      // maks 10% ekuitas dibagi 3 layer; risiko maks 2% ekuitas per layer
      const units = dist > 0 ? (equity * 0.02) / dist : 0;
      return { maxAllocationPct: 10, tranches: 3, positionPct: 10 / 3, riskPct: 2, units };
    }
    case "ID_STOCK": // maks 40%, cicil 3x, stop maks 5% dari modal teralokasi
      return { maxAllocationPct: 40, tranches: 3, positionPct: 40 / 3, riskPct: (40 / 3) * slPct };
    case "US_STOCK": // maks 35%, cicil 3x
      return { maxAllocationPct: 35, tranches: 3, positionPct: 35 / 3, riskPct: (35 / 3) * slPct };
  }
}

function stopLossFor(assetClass: AssetClass, entry: number, swingLow: number): number {
  if (assetClass === "XAUUSD") return swingLow - GOLD_SL_BUFFER;
  if (assetClass === "ID_STOCK" || assetClass === "US_STOCK") return Math.max(swingLow, entry * 0.95);
  return swingLow;
}

/* ---------------------------------- ENGINE -------------------------------- */

export const an1Astronacci: Engine = {
  name: NAME,
  analyze(input: AnalysisInput): EngineSignal {
    if (isMarketClosed(input.assetClass, input.now)) {
      return abstain(NAME, "Pasar tutup (akhir pekan)", ["MARKET_CLOSED"]);
    }
    const candles = cleanCandles(input.candles); // buang NaN akibat bursa libur
    if (candles.length < MIN_CANDLES) {
      return abstain(NAME, `Data kurang: ${candles.length}/${MIN_CANDLES} candle`, ["DATA_INSUFFICIENT"]);
    }

    // 1) Tren naik: harga di atas EMA50 dan EMA200
    const closes = candles.map((c) => c.close);
    const close = lastNum(closes);
    const e50 = lastNum(ema(closes, 50));
    const e200 = lastNum(ema(closes, 200));
    if (!(close > e50 && close > e200)) return hold(NAME, "Tren tidak naik (harga di bawah EMA50/EMA200)", ["NO_UPTREND"]);

    // 2) Time Engine
    const targets = buildTimeTargets(candles, input.now, input.targetDates);
    const isTimeZone = checkTimeWindow(input.now, targets);
    if (REQUIRE_TIME_ZONE && !isTimeZone) return hold(NAME, "Di luar Time Zone", ["IS_TIME_ZONE=false"]);

    // 3) Price Engine
    const fib = calculateFibonacciLevels(candles);
    if (!fib) return hold(NAME, "Swing High/Low belum valid", ["NO_SWING"]);
    if (!detectHookPattern(candles, fib)) {
      return hold(NAME, `Belum ada Hook Pattern di zona ${fmt(fib.level618)}-${fmt(fib.level500)}`, ["NO_HOOK"]);
    }

    // 4) Risk Engine
    const entry = close;
    const stopLoss = stopLossFor(input.assetClass, entry, fib.swingLow);
    const size = calculatePositionSize(input.assetClass, input.equity, entry, stopLoss);
    const range = fib.swingHigh - fib.swingLow;
    return {
      engine: NAME,
      action: "BUY",
      confidence: 0.75,
      reason: `Hook Pattern di Golden Ratio Zone, Time Zone aktif, tahap 1/${size.tranches}`,
      entry,
      stopLoss,
      takeProfit: [fib.swingHigh, fib.swingLow + range * 1.272],
      positionPct: size.positionPct,
      riskPct: size.riskPct,
      orderType: input.assetClass === "CRYPTO" ? "MARKET" : "LIMIT",
      tags: ["IS_TIME_ZONE=true", "HOOK_PATTERN", `MAX_ALLOC=${size.maxAllocationPct}%`],
    };
  },
};
