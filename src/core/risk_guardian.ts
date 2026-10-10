import type { RiskMetrics } from "../engines/types";

export class RiskGuardian {
  constructor(private maxDrawdownPercent = 5) {}

  check(m: RiskMetrics): { allowed: boolean; reason: string } {
    if (m.isKillSwitchTriggered) return { allowed: false, reason: "Kill switch aktif" };
    if (m.safeModeActive) return { allowed: false, reason: "Safe mode aktif" };
    if (m.currentDrawdownPercent >= this.maxDrawdownPercent) {
      return { allowed: false, reason: `Drawdown ${m.currentDrawdownPercent}% melewati batas ${this.maxDrawdownPercent}%` };
    }
    return { allowed: true, reason: "OK" };
  }
}
