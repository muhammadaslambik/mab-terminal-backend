import type { AssetClass } from "./engines/types";

export default {
  async fetch(request: Request, env: any, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      return Response.json({ status: "healthy" });
    }

    if (url.pathname === "/api/signals") {
      const auth = request.headers.get("Authorization");
      if (!env.API_TOKEN || auth !== `Bearer ${env.API_TOKEN}`) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }

      // Contoh: /api/signals?symbols=BTC,ETH
      const symbols = (url.searchParams.get("symbols") ?? "BTC,ETH")
        .split(",")
        .map((s) => s.trim().toUpperCase())
        .filter((s) => /^[A-Z0-9]{2,10}$/.test(s))
        .slice(0, 5);

      const { analyzeCrypto } = await import("./core/analysis_service");
      const signals = await Promise.all(
        symbols.map(async (s) => {
          try {
            const cached: any = env.KV_CACHE ? await env.KV_CACHE.get(`SIGNAL_${s}`, "json") : null;
            if (cached) return { symbol: s, computedAt: cached.computedAt, decision: cached.decision };
            return { symbol: s, computedAt: Date.now(), decision: await analyzeCrypto(s) };
          } catch (err) {
            return { symbol: s, error: String(err) };
          }
        })
      );
      return Response.json({ generatedAt: new Date().toISOString(), signals });
    }

    if (url.pathname === "/api/idx/screen" || url.pathname === "/api/idx/probe") {
      const auth = request.headers.get("Authorization");
      if (!env.API_TOKEN || auth !== `Bearer ${env.API_TOKEN}`) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }
      try {
        if (url.pathname === "/api/idx/probe") {
          const { PasardanaFeed } = await import("./feed/pasardana");
          return Response.json(await new PasardanaFeed().probe());
        }
        const cached: any = env.KV_CACHE ? await env.KV_CACHE.get("IDX_SCREEN", "json") : null;
        if (cached) return Response.json(cached);
        const { handleIdxScreening } = await import("./cron/idx_screening");
        const screen = await handleIdxScreening({});
        return screen ? Response.json(screen) : Response.json({ error: "Data Pasardana tidak tersedia, coba /api/idx/probe" }, { status: 502 });
      } catch (err) {
        return Response.json({ error: String(err) }, { status: 502 });
      }
    }

    if (url.pathname === "/api/trade-test") {
      // Hanya boleh diakses dengan token rahasia
      const auth = request.headers.get("Authorization");
      if (!env.API_TOKEN || auth !== `Bearer ${env.API_TOKEN}`) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }

      try {
        // Dimuat hanya saat route ini dipanggil
        const { MarketOrchestrator } = await import("./core/orchestrator");
        const { buildMockInput } = await import("./utils/mock");

        // Contoh: /api/trade-test?asset=XAUUSD (default CRYPTO karena buka 24/7)
        const asset = (url.searchParams.get("asset") ?? "CRYPTO") as AssetClass;
        const input = buildMockInput(asset);
        const riskMetrics = { currentDrawdownPercent: 1.2, isKillSwitchTriggered: false, safeModeActive: false };

        const decision = await new MarketOrchestrator().orchestrateAssetAnalysis(input, riskMetrics);
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
          try {
            const { handleIdxScreening } = await import("./cron/idx_screening");
            await handleIdxScreening(env);
          } catch (err) {
            console.error("IDX screening gagal:", err);
          }
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
