import type { AnalysisInput, RiskMetrics, TradeDecision } from "../engines/types";
import { BinanceFeed } from "../feed/binance";
import { MarketOrchestrator } from "./orchestrator";

// Sementara: belum ada pelacakan portofolio, jadi risk guard memakai nilai netral.
const NO_RISK: RiskMetrics = { currentDrawdownPercent: 0, isKillSwitchTriggered: false, safeModeActive: false };

/**
 * Analisa satu aset kripto: ambil candle (harian untuk engine, 4 jam untuk konfirmasi momentum,
 * mingguan untuk DCA), jalankan semua engine lewat orchestrator.
 */
export async function analyzeCrypto(symbol: string, equity = 10_000, risk: RiskMetrics = NO_RISK): Promise<TradeDecision> {
  const binance = new BinanceFeed();
  const [candles, candlesLow, candlesHigh] = await Promise.all([
    binance.getCandles(symbol, "1d", 300),
    binance.getCandles(symbol, "4h", 100),
    binance.getCandles(symbol, "1w", 60),
  ]);
  if (candles.length === 0) throw new Error(`Data candle ${symbol} kosong (Binance tidak merespons)`);

  const input: AnalysisInput = {
    symbol: `${symbol.toUpperCase()}USDT`,
    assetClass: "CRYPTO",
    now: new Date().toISOString(),
    equity,
    candles,
    candlesLow,
    candlesHigh,
  };
  return new MarketOrchestrator().orchestrateAssetAnalysis(input, risk);
}
