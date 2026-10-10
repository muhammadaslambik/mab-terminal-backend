import type { AnalysisInput, Engine, EngineSignal, RiskMetrics, TradeDecision } from "../engines/types";
import { abstain } from "../engines/common";
import { engines } from "../engines/registry";
import { RiskGuardian } from "./risk_guardian";
import { SignalManager } from "./signal_manager";

/** Satu engine yang error tidak boleh menjatuhkan seluruh analisa. */
function safeAnalyze(engine: Engine, input: AnalysisInput): EngineSignal {
  try {
    return engine.analyze(input);
  } catch (err) {
    return abstain(engine.name, `Error: ${String(err)}`, ["ENGINE_ERROR"]);
  }
}

export class MarketOrchestrator {
  private guardian = new RiskGuardian();
  private manager = new SignalManager();

  async orchestrateAssetAnalysis(input: AnalysisInput, riskMetrics: RiskMetrics): Promise<TradeDecision> {
    const signals = engines.map((e) => safeAnalyze(e, input));
    const result = this.manager.combine(signals);
    const base = { symbol: input.symbol, targetDates: input.targetDates ?? [], signals };

    // Risk guard memblokir posisi baru, tetapi sinyal keluar tetap boleh lewat
    const risk = this.guardian.check(riskMetrics);
    if (!risk.allowed && result.action === "BUY") {
      return { ...base, action: "HOLD", confidence: 0, reason: `Entry diblokir: ${risk.reason}` };
    }
    return { ...base, action: result.action, confidence: result.confidence, reason: result.reason, lead: result.lead };
  }
}
