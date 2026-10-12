import type { AnalysisInput, RiskMetrics, TradeDecision } from "../engines/types";
import { BinanceFeed } from "../feed/binance";
import { YahooFeed } from "../feed/yahoo";
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

/**
 * Analisa satu saham Indonesia dari candle harian Yahoo (kode tanpa ".JK").
 * Saat ini hanya engine berbasis candle yang aktif; Andry Hakim butuh data fundamental
 * dan Remora butuh order book, jadi keduanya otomatis abstain.
 */
export async function analyzeIdx(
  code: string,
  marketRank?: { topGainer?: boolean; topValue?: boolean },
  equity = 100_000_000,
  risk: RiskMetrics = NO_RISK
): Promise<TradeDecision> {
  const symbol = code.toUpperCase().replace(/\.JK$/, "");
  const candles = await new YahooFeed().getCandles(`${symbol}.JK`, "2y", "1d");
  if (candles.length === 0) throw new Error(`Data candle ${symbol}.JK kosong (Yahoo tidak merespons)`);

  const input: AnalysisInput = {
    symbol,
    assetClass: "ID_STOCK",
    now: new Date().toISOString(),
    equity,
    candles,
    marketRank,
  };
  return new MarketOrchestrator().orchestrateAssetAnalysis(input, risk);
}
