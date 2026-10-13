import type { AnalysisInput, Fundamentals, RiskMetrics, TradeDecision } from "../engines/types";
import { BinanceFeed } from "../feed/binance";
import { YahooFeed } from "../feed/yahoo";
import { PasardanaFeed, type IdxStock } from "../feed/pasardana";
import { getIntel } from "../data/intel";
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

/** Data satu saham dari Pasardana (market cap, free float, PBV, PER, return 1 tahun); undefined jika gagal. */
async function lookupPasardana(code: string): Promise<IdxStock | undefined> {
  try {
    const rows = await new PasardanaFeed().getStocks({ search: code, perPage: 10 });
    return rows.find((r) => r.code === code);
  } catch {
    return undefined;
  }
}

/**
 * Analisa satu saham Indonesia: candle harian Yahoo (kode tanpa ".JK"), data Pasardana, dan riset manual
 * di src/data/intel.ts (DER, rumor, suntikan dana, pembeli). Tanpa DER di intel, engine Andry Hakim abstain.
 * Remora butuh order book, jadi abstain.
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

  const stock = await lookupPasardana(symbol);
  const entry = getIntel(symbol);
  const fundamentals: Fundamentals | undefined =
    stock || entry
      ? {
          marketCap: stock?.marketCap,
          pbv: stock?.pbv,
          pe: stock?.per,
          freeFloatPercent: stock?.freeFloatPct,
          return1y: stock?.oneYear,
          sharesOutstanding: stock?.marketCap && stock.last && stock.last > 0 ? stock.marketCap / stock.last : undefined,
          der: entry?.der,
          netProfitQuarters: entry?.netProfitQuarters,
          ocfQuarters: entry?.ocfQuarters,
        }
      : undefined;

  const input: AnalysisInput = {
    symbol,
    assetClass: "ID_STOCK",
    now: new Date().toISOString(),
    equity,
    candles,
    marketRank,
    fundamentals,
    compliance: entry?.voluntaryInterimAudit !== undefined ? { voluntaryInterimAudit: entry.voluntaryInterimAudit } : undefined,
    intel: entry ? { rumor: entry.rumor, injection: entry.injection, acquirer: entry.acquirer, valuation: entry.valuation, notes: entry.notes } : undefined,
  };
  return new MarketOrchestrator().orchestrateAssetAnalysis(input, risk);
}
