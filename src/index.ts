import { handleMarketPolling } from "./cron/market_polling";
import { handleScreeningPagi } from "./cron/screening_pagi";
import { handleKeepAlive } from "./cron/keep_alive"; // Tambahkan ini
import { MarketOrchestrator } from "./core/orchestrator";

export default {
  async fetch(request: Request, env: any, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    
    if (url.pathname === "/api/health") {
      return new Response(JSON.stringify({ status: "healthy" }), { headers: { "Content-Type": "application/json" } });
    }

    if (url.pathname === "/api/trade-test") {
      const orchestrator = new MarketOrchestrator();
      const mockMarketData = { current: 2650, high: 2700, low: 2600, ema50: 2620, ema200: 2500, stochK: 18, stochD: 15 };
      const mockRiskMetrics = { currentDrawdownPercent: 1.2, isKillSwitchTriggered: false, safeModeActive: false };
      const mockTargetDates = ["2026-10-12"]; 

      const decision = await orchestrator.orchestrateAssetAnalysis("XAUUSD", mockMarketData, mockRiskMetrics, JSON.stringify(mockTargetDates));
      return new Response(JSON.stringify({ result: decision }), { headers: { "Content-Type": "application/json" } });
    }

    return new Response("MAB-Terminal Live Cloud Worker Running.", { status: 200 });
  },

  /**
   * Mengatur Eksekusi Cloudflare Cron Triggers Otomatis saat Laptop Mati
   */
  async scheduled(event: any, env: any, ctx: ExecutionContext): Promise<void> {
    switch (event.cron) {
      case "*/5 * * * *":
        await handleMarketPolling(env, ctx);
        break;
      case "0 1 * * *":
        await handleScreeningPagi(env, ctx);
        break;
      case "0 0 */3 * *":
        // Dieksekusi otomatis setiap 3 hari sekali oleh Cloudflare Edge
        await handleKeepAlive(env, ctx);
        break;
      default:
        console.log(`Cron ${event.cron} triggered.`);
    }
  }
};
