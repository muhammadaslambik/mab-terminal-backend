export interface MarketData {
  current: number; high: number; low: number;
  ema50: number; ema200: number; stochK: number; stochD: number;
}

export interface RiskMetrics {
  currentDrawdownPercent: number;
  isKillSwitchTriggered: boolean;
  safeModeActive: boolean;
}

export interface TradeDecision {
  symbol: string;
  action: "BUY" | "SELL" | "HOLD";
  reason: string;
  targetDates: string[];
}

export class MarketOrchestrator {
  async orchestrateAssetAnalysis(
    symbol: string,
    marketData: MarketData,
    riskMetrics: RiskMetrics,
    targetDatesJson: string
  ): Promise<TradeDecision> {
    let targetDates: string[] = [];
    try {
      targetDates = JSON.parse(targetDatesJson);
    } catch {
      targetDates = [];
    }

    // Risk guard selalu didahulukan
    if (riskMetrics.isKillSwitchTriggered || riskMetrics.safeModeActive) {
      return { symbol, action: "HOLD", reason: "Risk guard aktif", targetDates };
    }

    const uptrend = marketData.current > marketData.ema50 && marketData.ema50 > marketData.ema200;
    const downtrend = marketData.current < marketData.ema50 && marketData.ema50 < marketData.ema200;

    if (uptrend && marketData.stochK < 20) {
      return { symbol, action: "BUY", reason: "Uptrend + stochastic oversold", targetDates };
    }
    if (downtrend && marketData.stochK > 80) {
      return { symbol, action: "SELL", reason: "Downtrend + stochastic overbought", targetDates };
    }
    return { symbol, action: "HOLD", reason: "Tidak ada sinyal", targetDates };
  }
}