import type { Action, EngineSignal } from "../engines/types";

export interface CombinedSignal {
  action: Action;
  confidence: number;
  reason: string;
  lead?: EngineSignal; // sinyal engine yang memimpin (berisi entry, stop loss, ukuran posisi, dst.)
}

export class SignalManager {
  constructor(private minScore = 0.5) {}

  combine(signals: EngineSignal[]): CombinedSignal {
    const active = signals.filter((s) => s.confidence > 0);
    if (active.length === 0) return { action: "HOLD", confidence: 0, reason: "Tidak ada engine aktif" };

    // Sinyal keluar (stop loss, take profit, exit valuasi) selalu didahulukan dari voting
    const exits = active.filter((s) => s.action === "SELL" && s.tags?.includes("EXIT"));
    if (exits.length) {
      const lead = exits.reduce((m, s) => (s.confidence > m.confidence ? s : m));
      return { action: "SELL", confidence: lead.confidence, reason: `EXIT oleh ${lead.engine}: ${lead.reason}`, lead };
    }

    // Strategi mandiri (Andry Hakim, Remora) tidak perlu konsensus dengan engine teknikal
    const standalone = active.filter((s) => s.action === "BUY" && s.tags?.includes("STANDALONE"));
    if (standalone.length) {
      const lead = standalone.reduce((m, s) => (s.confidence > m.confidence ? s : m));
      return { action: "BUY", confidence: lead.confidence, reason: `Strategi mandiri ${lead.engine}: ${lead.reason}`, lead };
    }

    const total = active.reduce((sum, s) => sum + s.confidence, 0);
    const score = (a: Action) => active.filter((s) => s.action === a).reduce((sum, s) => sum + s.confidence, 0);
    const buy = score("BUY");
    const sell = score("SELL");
    const pick = (a: Action) => active.filter((s) => s.action === a).reduce((m, s) => (s.confidence > m.confidence ? s : m));

    if (buy > sell && buy / total >= this.minScore) {
      return { action: "BUY", confidence: buy / total, reason: "Mayoritas engine BUY", lead: pick("BUY") };
    }
    if (sell > buy && sell / total >= this.minScore) {
      return { action: "SELL", confidence: sell / total, reason: "Mayoritas engine SELL", lead: pick("SELL") };
    }
    return { action: "HOLD", confidence: 0, reason: "Tidak ada konsensus" };
  }
}
