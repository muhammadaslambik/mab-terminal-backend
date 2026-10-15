import type { AssetClass } from "./engines/types";

const unauthorized = () => Response.json({ error: "Unauthorized" }, { status: 401 });

export default {
  async fetch(request: Request, env: any, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const authorized = !!env.API_TOKEN && request.headers.get("Authorization") === `Bearer ${env.API_TOKEN}`;

    if (url.pathname === "/api/health") {
      return Response.json({ status: "healthy" });
    }

    // Sinyal engine. Contoh: /api/signals?symbols=BTC,ETH  atau  /api/signals?market=idx&symbols=BBCA,BBRI
    if (url.pathname === "/api/signals") {
      if (!authorized) return unauthorized();
      const market = url.searchParams.get("market") === "idx" ? "idx" : "crypto";
      const symbols = (url.searchParams.get("symbols") ?? (market === "idx" ? "BBCA,BBRI" : "BTC,ETH"))
        .split(",")
        .map((s) => s.trim().toUpperCase())
        .filter((s) => /^[A-Z0-9]{2,10}$/.test(s))
        .slice(0, 5);

      const svc = await import("./core/analysis_service");
      const { marketRankFor } = await import("./core/idx_screener");
      const screen: any = market === "idx" && env.KV_CACHE ? await env.KV_CACHE.get("IDX_SCREEN", "json") : null;

      const signals = await Promise.all(
        symbols.map(async (s) => {
          try {
            const key = market === "idx" ? `SIGNAL_IDX_${s}` : `SIGNAL_${s}`;
            const cached: any = env.KV_CACHE ? await env.KV_CACHE.get(key, "json") : null;
            if (cached) return { symbol: s, computedAt: cached.computedAt, decision: cached.decision };
            const decision = market === "idx" ? await svc.analyzeIdx(s, screen ? marketRankFor(screen, s) : undefined) : await svc.analyzeCrypto(s);
            return { symbol: s, computedAt: Date.now(), decision };
          } catch (err) {
            return { symbol: s, error: String(err) };
          }
        })
      );
      return Response.json({ generatedAt: new Date().toISOString(), market, signals });
    }

    // Diagnosa sumber data saham Indonesia (Yahoo) dan peringkat harian
    if (url.pathname === "/api/idx/probe" || url.pathname === "/api/idx/screen") {
      if (!authorized) return unauthorized();
      try {
        if (url.pathname === "/api/idx/probe") {
          // /api/idx/probe?source=idx -> uji idx.co.id dari Worker (3 request)
          if (url.searchParams.get("source") === "idx") {
            const { probeIdx } = await import("./feed/idx_probe");
            return Response.json(await probeIdx());
          }
          // /api/idx/probe?source=pasardana -> uji Pasardana dari Worker (bukan dari browser)
          if (url.searchParams.get("source") === "pasardana") {
            const { PasardanaFeed } = await import("./feed/pasardana");
            return Response.json(await new PasardanaFeed().probe());
          }
          const { YahooFeed } = await import("./feed/yahoo");
          const symbol = (url.searchParams.get("symbol") ?? "BBCA.JK").toUpperCase();
          if (!/^[A-Z0-9.=^-]{1,15}$/.test(symbol)) return Response.json({ error: "Simbol tidak valid" }, { status: 400 });
          return Response.json(await new YahooFeed().probe(symbol));
        }
        const cached: any = env.KV_CACHE ? await env.KV_CACHE.get("IDX_SCREEN", "json") : null;
        if (cached) return Response.json(cached);
        const { handleIdxScreening } = await import("./cron/idx_screening");
        const screen = await handleIdxScreening({});
        return screen ? Response.json(screen) : Response.json({ error: "Data Yahoo tidak tersedia, coba /api/idx/probe" }, { status: 502 });
      } catch (err) {
        return Response.json({ error: String(err) }, { status: 502 });
      }
    }

    if (url.pathname === "/api/trade-test") {
      if (!authorized) return unauthorized();
      try {
        const { MarketOrchestrator } = await import("./core/orchestrator");
        const { buildMockInput } = await import("./utils/mock");
        // Contoh: /api/trade-test?asset=XAUUSD (default CRYPTO karena buka 24/7)
        const asset = (url.searchParams.get("asset") ?? "CRYPTO") as AssetClass;
        const riskMetrics = { currentDrawdownPercent: 1.2, isKillSwitchTriggered: false, safeModeActive: false };
        const decision = await new MarketOrchestrator().orchestrateAssetAnalysis(buildMockInput(asset), riskMetrics);
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
