export default {
  async fetch(request: Request, env: any, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      return Response.json({ status: "healthy" });
    }

    if (url.pathname === "/api/trade-test") {
      // Hanya boleh diakses dengan token rahasia
      const auth = request.headers.get("Authorization");
      if (!env.API_TOKEN || auth !== `Bearer ${env.API_TOKEN}`) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }

      try {
        const { MarketOrchestrator } = await import("./core/orchestrator");
        const orchestrator = new MarketOrchestrator();

        const mockMarketData = { current: 2650, high: 2700, low: 2600, ema50: 2620, ema200: 2500, stochK: 18, stochD: 15 };
        const mockRiskMetrics = { currentDrawdownPercent: 1.2, isKillSwitchTriggered: false, safeModeActive: false };
        const mockTargetDates = ["2026-10-12"];

        const decision = await orchestrator.orchestrateAssetAnalysis(
          "XAUUSD",
          mockMarketData,
          mockRiskMetrics,
          JSON.stringify(mockTargetDates)
        );
        return Response.json({ result: decision });
      } catch (err) {
        console.error("trade-test error:", err);
        return Response.json({ error: String(err) }, { status: 500 });
      }
    }

    return new Response("MAB-Terminal Live Cloud Worker Running.", { status: 200 });
  },

  async scheduled(event: any, env: any, ctx: ExecutionContext): Promise<void> {
    try {
      switch (event.cron) {
        case "*/5 * * * *": {
          const { handleMarketPolling } = await import("./cron/market_polling");
          await handleMarketPolling(env, ctx);
          break;
        }
        case "0 1 * * *": {
          const { handleScreeningPagi } = await import("./cron/screening_pagi");
          await handleScreeningPagi(env, ctx);
          break;
        }
        case "0 0 */3 * *": {
          const { handleKeepAlive } = await import("./cron/keep_alive");
          await handleKeepAlive(env, ctx);
          break;
        }
        default:
          console.log(`Cron ${event.cron} belum punya handler.`);
      }
    } catch (err) {
      console.error(`Cron ${event.cron} gagal:`, err);
      throw err; // supaya kegagalan tercatat di dashboard Cloudflare
    }
  },
};