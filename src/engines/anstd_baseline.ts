/** anstd_baseline — pembanding sederhana: EMA50/EMA200 + Stochastic (14,3,3). */
import type { AnalysisInput, Engine, EngineSignal } from "./types";
import { abstain, hold } from "./common";
import { cleanCandles, ema, isMarketClosed, lastNum, stochastic } from "../utils/indicators";

const NAME = "anstd_baseline";

export const anstdBaseline: Engine = {
  name: NAME,
  analyze(input: AnalysisInput): EngineSignal {
    if (isMarketClosed(input.assetClass, input.now)) return abstain(NAME, "Pasar tutup (akhir pekan)", ["MARKET_CLOSED"]);
    const candles = cleanCandles(input.candles);
    if (candles.length < 210) return abstain(NAME, `Data kurang: ${candles.length}/210 candle`, ["DATA_INSUFFICIENT"]);

    const closes = candles.map((c) => c.close);
    const close = lastNum(closes);
    const e50 = lastNum(ema(closes, 50));
    const e200 = lastNum(ema(closes, 200));
    const k = lastNum(stochastic(candles).k);

    if (close > e50 && e50 > e200 && k < 20) {
      return { engine: NAME, action: "BUY", confidence: 0.6, reason: "Uptrend + stochastic oversold", entry: close, tags: ["BASELINE"] };
    }
    if (close < e50 && e50 < e200 && k > 80) {
      return { engine: NAME, action: "SELL", confidence: 0.6, reason: "Downtrend + stochastic overbought", entry: close, tags: ["BASELINE"] };
    }
    return hold(NAME, "Tidak ada sinyal");
  },
};
