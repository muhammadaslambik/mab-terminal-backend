/**
 * an2_kalimasada — Prof Kalimasada
 * Pilar 1: Alokasi portofolio (Core 70-80%, Spekulatif maks 1-2%/aset & 20% total) + DCA saat RSI mingguan < 35
 * Pilar 2: Smart Money Concepts: BOS bullish -> Fair Value Gap -> konfirmasi momentum di TF rendah (RSI/Stoch < 30)
 * Pilar 3: Risiko 1% per trade, RRR minimal 1:2, jurnal trading otomatis
 * Hanya Long.
 */
import type { AnalysisInput, Candle, Engine, EngineSignal, JournalEntry } from "./types";
import { abstain, fmt, hold } from "./common";
import { cleanCandles, highestIndex, isMarketClosed, lastNum, lowestIndex, pivotHighs, pivotLows, rsi, stochastic } from "../utils/indicators";

const NAME = "an2_kalimasada";
const PIVOT = 3; // candle kiri/kanan untuk swing
const BOS_MAX_AGE = 20; // BOS dianggap valid jika terjadi dalam 20 candle terakhir
const MIN_RRR = 2; // batalkan order jika RRR < 1:2
const RISK_PER_TRADE_PCT = 1; // risiko 1% ekuitas (aturan: 1%-2%)
const MAX_ACTIVE_POSITION_PCT = 25; // batas nilai posisi aktif (bisa disesuaikan)
const SPECULATIVE_MAX_PCT = 2; // alokasi maks per aset spekulatif
const OVERSOLD = 30;
const DCA_RSI_MAX = 35; // RSI mingguan/bulanan < 35 = fase jenuh
const DCA_TRANCHE_PCT = 5; // porsi tiap DCA (% ekuitas) — bisa disesuaikan
const MIN_CANDLES = 60;

/* --------------------------- PILAR 1: ALOKASI ---------------------------- */

export function evaluatePortfolioAllocation(totalEquity: number) {
  return {
    core: { minPct: 70, maxPct: 80, minAmount: totalEquity * 0.7, maxAmount: totalEquity * 0.8 },
    speculative: {
      perAssetMaxPct: 2,
      totalMaxPct: 20,
      perAssetMaxAmount: totalEquity * 0.02,
      totalMaxAmount: totalEquity * 0.2,
    },
  };
}

/** Mitigasi risiko stablecoin tunggal: dana cadangan dibagi 60% USDT, 40% USDC. */
export function allocateStablecoinReserve(cash: number): { USDT: number; USDC: number } {
  return { USDT: cash * 0.6, USDC: cash * 0.4 };
}

/** Aset inti: BTC, ETH, XAUUSD. Lainnya dianggap spekulatif kecuali input.tier diisi. */
function resolveTier(input: AnalysisInput): "CORE" | "SPECULATIVE" {
  if (input.tier) return input.tier;
  const s = input.symbol.toUpperCase();
  return s.startsWith("BTC") || s.startsWith("ETH") || s === "XAUUSD" ? "CORE" : "SPECULATIVE";
}

/* ----------------------------- PILAR 2: SMC ------------------------------ */

export interface FairValueGap {
  bottom: number;
  top: number;
  index: number;
}

export interface SmcSetup {
  bosLevel: number;
  breakIndex: number;
  originLow: number;
  impulseHigh: number;
  fvg: FairValueGap | null;
}

/** FVG bullish terbaru (low candle ke-3 > high candle ke-1) yang belum ditutup. */
export function checkFvgImbalance(c: Candle[], fromIndex: number): FairValueGap | null {
  for (let i = c.length - 1; i >= Math.max(fromIndex, 2); i--) {
    const bottom = c[i - 2].high;
    const top = c[i].low;
    if (top <= bottom) continue;
    let filled = false;
    for (let j = i + 1; j < c.length; j++) {
      if (c[j].close < bottom) {
        filled = true;
        break;
      }
    }
    if (!filled) return { bottom, top, index: i };
  }
  return null;
}

/** BOS bullish terbaru (close menembus swing high) + FVG sesudahnya. */
export function detectSmartMoneySignals(c: Candle[]): SmcSetup | null {
  const highs = pivotHighs(c, PIVOT, PIVOT);
  const lows = pivotLows(c, PIVOT, PIVOT);
  let best: { sh: number; br: number } | null = null;
  for (const sh of highs) {
    const level = c[sh].high;
    for (let i = sh + 1; i < c.length; i++) {
      if (c[i].close > level) {
        if (c.length - 1 - i <= BOS_MAX_AGE && (!best || i > best.br)) best = { sh, br: i };
        break;
      }
    }
  }
  if (!best) return null;
  const { sh, br } = best;
  const lowsBefore = lows.filter((l) => l < br);
  const originIdx = lowsBefore.length ? lowsBefore[lowsBefore.length - 1] : lowestIndex(c, Math.max(0, sh - 10), br);
  const impulseIdx = highestIndex(c, br, c.length - 1);
  return {
    bosLevel: c[sh].high,
    breakIndex: br,
    originLow: c[originIdx].low,
    impulseHigh: c[impulseIdx].high,
    fvg: checkFvgImbalance(c, br + 1),
  };
}

/* ---------------------------- PILAR 3: JURNAL ---------------------------- */

/** Susun catatan jurnal. Penyimpanan ke database dilakukan oleh pemanggil (cron/orchestrator). */
export function logTradingJournal(input: AnalysisInput, entry: number, stopLoss: number, takeProfit: number[], reasons: string[]): JournalEntry {
  return {
    symbol: input.symbol,
    entry,
    stopLoss,
    takeProfit,
    reasons,
    fearGreedIndex: input.fearGreedIndex,
    createdAt: input.now,
  };
}

/* --------------------------------- ENGINE -------------------------------- */

export const an2Kalimasada: Engine = {
  name: NAME,
  analyze(input: AnalysisInput): EngineSignal {
    if (isMarketClosed(input.assetClass, input.now)) return abstain(NAME, "Pasar tutup (akhir pekan)", ["MARKET_CLOSED"]);
    const candles = cleanCandles(input.candles);
    if (candles.length < MIN_CANDLES) return abstain(NAME, `Data kurang: ${candles.length}/${MIN_CANDLES} candle`, ["DATA_INSUFFICIENT"]);

    const tier = resolveTier(input);
    const close = candles[candles.length - 1].close;

    // --- Pilar 2: SMC (Active Trading) ---
    const smc = detectSmartMoneySignals(candles);
    if (smc && smc.fvg) {
      const { fvg } = smc;
      const entry = (fvg.bottom + fvg.top) / 2; // limit buy di tengah FVG
      const stopLoss = smc.originLow * 0.999;
      const risk = entry - stopLoss;
      if (risk <= 0) return hold(NAME, "Stop loss tidak valid (di atas entry)", ["INVALID_SL"]);
      const rrr = (smc.impulseHigh - entry) / risk;
      if (rrr < MIN_RRR) {
        return hold(NAME, `RRR 1:${fmt(rrr)} < 1:${MIN_RRR}, order dibatalkan`, ["RRR_REJECTED"]);
      }

      // Momentum di TF lebih rendah (fallback ke TF utama)
      const ltfRaw = cleanCandles(input.candlesLow ?? []);
      const ltf = ltfRaw.length >= 30 ? ltfRaw : candles;
      const rsiLtf = lastNum(rsi(ltf.map((x) => x.close), 14));
      const stochK = lastNum(stochastic(ltf).k);
      const oversold = rsiLtf < OVERSOLD || stochK < OVERSOLD;
      const inZone = close >= fvg.bottom && close <= fvg.top;

      let positionPct = RISK_PER_TRADE_PCT * (entry / risk); // risiko 1% ekuitas
      positionPct = Math.min(positionPct, tier === "SPECULATIVE" ? SPECULATIVE_MAX_PCT : MAX_ACTIVE_POSITION_PCT);
      const riskPct = positionPct * (risk / entry);
      const takeProfit = [smc.impulseHigh];
      const base = { entry, stopLoss, takeProfit, positionPct, riskPct, orderType: "LIMIT" as const };

      if (inZone && oversold) {
        const reasons = ["BOS bullish", "Entry di FVG", `RSI(14) TF rendah ${fmt(rsiLtf, 1)} / Stoch K ${fmt(stochK, 1)}`];
        return {
          engine: NAME,
          action: "BUY",
          confidence: 0.7,
          reason: `BOS + FVG + oversold, RRR 1:${fmt(rrr)}`,
          ...base,
          tags: ["BOS", "FVG", "MOMENTUM_OK"],
          journal: logTradingJournal(input, entry, stopLoss, takeProfit, reasons),
        };
      }
      return { engine: NAME, action: "HOLD", confidence: 0.3, reason: inZone ? "Harga di FVG, menunggu konfirmasi oversold" : "Menunggu retest ke area FVG", ...base, tags: ["LIMIT_ORDER_SETUP"] };
    }

    // --- Pilar 1: DCA aset inti saat RSI mingguan jenuh ---
    const weekly = cleanCandles(input.candlesHigh ?? []);
    if (tier === "CORE" && weekly.length >= 20) {
      const rsiW = lastNum(rsi(weekly.map((x) => x.close), 14));
      if (rsiW < DCA_RSI_MAX) {
        return {
          engine: NAME,
          action: "BUY",
          confidence: 0.65,
          reason: `DCA aset inti: RSI mingguan ${fmt(rsiW, 1)} < ${DCA_RSI_MAX}`,
          entry: close,
          positionPct: DCA_TRANCHE_PCT,
          orderType: "MARKET",
          tags: ["DCA_CORE"],
        };
      }
    }
    return hold(NAME, smc ? "BOS ada, belum ada FVG valid" : "Belum ada BOS bullish", ["NO_SETUP"]);
  },
};
