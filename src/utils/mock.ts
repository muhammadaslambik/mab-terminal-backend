import type { AnalysisInput, AssetClass, Candle } from "../engines/types";

/** Generator angka acak deterministik (supaya hasil tes konsisten). */
function lcg(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

/** Data sintetis untuk /api/trade-test. Bukan data pasar sungguhan. */
export function buildMockInput(assetClass: AssetClass = "CRYPTO", now = new Date().toISOString()): AnalysisInput {
  const rnd = lcg(42);
  const candles: Candle[] = [];
  let price = assetClass === "XAUUSD" ? 2400 : 100;
  const start = Date.parse(now.slice(0, 10)) - 259 * 86_400_000;
  for (let i = 0; i < 260; i++) {
    const open = price;
    const close = open * (1 + 0.0015 + (rnd() - 0.5) * 0.03);
    const high = Math.max(open, close) * (1 + rnd() * 0.01);
    const low = Math.min(open, close) * (1 - rnd() * 0.01);
    candles.push({
      time: new Date(start + i * 86_400_000).toISOString().slice(0, 10),
      open,
      high,
      low,
      close,
      volume: 1_000_000 * (0.5 + rnd()),
    });
    price = close;
  }
  return { symbol: assetClass === "XAUUSD" ? "XAUUSD" : "BTCUSD", assetClass, now, equity: 10_000, candles };
}
