import type { AssetClass } from "./engines/types";

const unauthorized = () => Response.json({ error: "Unauthorized" }, { status: 401 });

export default {
  async fetch(request: Request, env: any, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const authorized = !!env.API_TOKEN && request.headers.get("Authorization") === `Bearer ${env.API_TOKEN}`;

    if (url.pathname === "/api/health") {
      // Tanpa token: hanya status hidup. Dengan token: heartbeat tiap cron (ok/basi/gagal).
      if (!authorized) return Response.json({ status: "healthy" });
      const { readHeartbeats } = await import("./core/heartbeat");
      return Response.json(await readHeartbeats(env));
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
            const decision = market === "idx" ? await svc.analyzeIdx(s, screen ? marketRankFor(screen, s) : undefined, undefined, undefined, env) : await svc.analyzeCrypto(s);
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
          // /api/idx/probe?source=rss -> uji 10 RSS media + kolom liabilitas TradingView (15 request)
          if (url.searchParams.get("source") === "rss") {
            const { probeRss } = await import("./feed/source_probe");
            return Response.json(await probeRss());
          }
          // /api/idx/probe?source=sources -> uji Pasardana (semua field), TradingView, Google News RSS (9 request)
          if (url.searchParams.get("source") === "sources") {
            const { probeSources } = await import("./feed/source_probe");
            return Response.json(await probeSources());
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

    // Saringan cacing-naga dari TradingView + likuiditas Pasardana. ?refresh=1 memaksa hitung ulang keduanya
    if (url.pathname === "/api/idx/cacing") {
      if (!authorized) return unauthorized();
      try {
        const { viewCacing } = await import("./core/cacing_screen");
        return Response.json(await viewCacing(env, url.searchParams.get("refresh") === "1"));
      } catch (err) {
        return Response.json({ error: String(err) }, { status: 502 });
      }
    }

    // Intel idx.co.id hasil kolektor (jalan di PC rumah, IDX memblokir IP cloud).
    // POST: gabung per kode ke KV INTEL_IDX. GET: baca semua, atau ?code=XXXX satu emiten.
    if (url.pathname === "/api/intel") {
      if (!authorized) return unauthorized();
      if (!env.KV_CACHE) return Response.json({ error: "KV_CACHE tidak terpasang" }, { status: 500 });
      try {
        if (request.method === "POST") {
          const text = await request.text();
          if (text.length > 1_000_000) return Response.json({ error: "Muatan terlalu besar" }, {status: 413 });
          let body: any;
          try {
            body = JSON.parse(text);
          } catch (_e) {
            return Response.json({ error: "JSON tidak valid" }, { status: 400 });
          }
          const incoming: any[] | null = Array.isArray(body?.items) ? body.items : null;
          if (!incoming || incoming.length === 0 || incoming.length > 100) {
            return Response.json({ error: "items harus berisi 1-100 elemen" }, { status: 400 });
          }
          const now = new Date().toISOString();
          const prev: any = await env.KV_CACHE.get("INTEL_IDX", "json");
          const byCode = new Map<string, any>();
          for (const it of prev?.items ?? []) if (it?.code) byCode.set(it.code, it);
          let accepted = 0;
          let keptPrevious = 0;
          for (const it of incoming) {
            const code = typeof it?.code === "string" ? it.code.trim().toUpperCase() : "";
            if (!/^[A-Z0-9]{2,6}$/.test(code)) continue;
            // Data baru yang komposisinya tidak lengkap tidak boleh menimpa data lengkap sebelumnya (respons IDX kadang kehilangan baris)
            const old = byCode.get(code);
            if (it?.complete !== true && old?.complete === true && old?.schema === it?.schema) {
              keptPrevious++;
              continue;
            }
            byCode.set(code, { ...it, code, receivedAt: now });
            accepted++;
          }
          if (accepted === 0 && keptPrevious === 0) return Response.json({ error: "Tidak ada item dengan kode valid" }, { status: 400 });
          const merged = {
            updatedAt: now,
            collectedAt: body.collectedAt ?? null,
            financialPeriod: body.financialPeriod ?? null,
            publicDefinition: body.publicDefinition ?? "Masyarakat Non Warkat",
            items: Array.from(byCode.values()),
          };
          await env.KV_CACHE.put("INTEL_IDX", JSON.stringify(merged));
          return Response.json({ ok: true, accepted, keptPrevious, total: merged.items.length, updatedAt: now });
        }
        if (request.method === "GET") {
          const data: any = await env.KV_CACHE.get("INTEL_IDX", "json");
          if (!data) return Response.json({ error: "Belum ada intel. Jalankan kolektor dengan --push." }, { status: 404 });
          const code = url.searchParams.get("code")?.trim().toUpperCase();
          if (code) {
            const item = (data.items ?? []).find((i: any) => i.code === code);
            return item ? Response.json(item) : Response.json({ error: `Tidak ada intel untuk ${code}` }, { status: 404 });
          }
          return Response.json(data);
        }
        return Response.json({ error: "Method tidak didukung" }, { status: 405 });
      } catch (err) {
        return Response.json({ error: String(err) }, { status: 500 });
      }
    }

    // Tes saluran peringatan (email Resend, cadangan Telegram): membuktikan secret di Worker benar tanpa menampilkannya
    if (url.pathname === "/api/notify/test") {
      if (!authorized) return unauthorized();
      const { notificationConfigured, sendNotification } = await import("./notify/alert");
      if (!notificationConfigured(env)) {
        return Response.json({ ok: false, error: "Belum ada saluran: set RESEND_API_KEY + ALERT_EMAIL_TO (email) atau TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID" }, { status: 400 });
      }
      const r = await sendNotification(env, "MAB-Terminal: tes notifikasi", "Tes notifikasi MAB-Terminal berhasil. Bila Anda membaca ini, saluran peringatan bekerja.");
      return Response.json(r, { status: r.ok ? 200 : 502 });
    }

    // Cari chat id Telegram: kirim satu pesan ke bot Anda, lalu panggil rute ini (hanya butuh TELEGRAM_BOT_TOKEN; token tidak ditampilkan)
    if (url.pathname === "/api/telegram/chat-id") {
      if (!authorized) return unauthorized();
      if (!env.TELEGRAM_BOT_TOKEN) return Response.json({ ok: false, error: "TELEGRAM_BOT_TOKEN belum diset sebagai secret" }, { status: 400 });
      const { discoverTelegramChats } = await import("./notify/telegram");
      const r = await discoverTelegramChats(env.TELEGRAM_BOT_TOKEN);
      return Response.json(r, { status: r.ok ? 200 : 502 });
    }

    // Tes notifikasi Telegram: membuktikan secret TELEGRAM_BOT_TOKEN dan TELEGRAM_CHAT_ID di Worker benar (token tidak pernah ditampilkan)
    if (url.pathname === "/api/telegram/test") {
      if (!authorized) return unauthorized();
      if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
        return Response.json({ ok: false, error: "TELEGRAM_BOT_TOKEN atau TELEGRAM_CHAT_ID belumdiset sebagai secret" }, { status: 400 });
      }
      const { TelegramNotifier } = await import("./notify/telegram");
      const tg = new TelegramNotifier(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID);
      const ok = await tg.sendAlert("MAB-Terminal: tes notifikasi Telegram berhasil.", null);
      return Response.json({ ok, error: tg.lastError }, { status: ok ? 200 : 502 });
    }

    // Rumor korporasi dari RSS media. ?matched=1 hanya yang menyebut emiten shortlist, ?refresh=1 polling sekarang
    if (url.pathname === "/api/idx/rumor") {
      if (!authorized) return unauthorized();
      try {
        const rumor = await import("./feed/rumor_rss");
        const poll = url.searchParams.get("refresh") === "1" ? await rumor.runRumorPoll(env, { force: true }) : undefined;
        return Response.json({ poll, ...(await rumor.readRumors(env, url.searchParams.get("matched") === "1")) });
      } catch (err) {
        return Response.json({ error: String(err) }, { status: 502 });
      }
    }

    // Wire News nyata (judul RSS media Indonesia), cache KV 10 menit. ?refresh=1 memaksa ambil ulang (6 fetch)
    if (url.pathname === "/api/market/news") {
      if (!authorized) return unauthorized();
      try {
        const { loadNews } = await import("./feed/news_wire");
        return Response.json(await loadNews(env, url.searchParams.get("refresh") === "1"));
      } catch (err) {
        return Response.json({ error: String(err) }, { status: 502 });
      }
    }

    // Data pasar nyata untuk frontend (Yahoo + TradingView), cache KV 5 menit. ?refresh=1 memaksa build ulang (~30 fetch)
    if (url.pathname === "/api/market/overview") {
      if (!authorized) return unauthorized();
      try {
        const { loadMarketOverview } = await import("./feed/market_data");
        return Response.json(await loadMarketOverview(env, url.searchParams.get("refresh") === "1"));
      } catch (err) {
        return Response.json({ error: String(err) }, { status: 502 });
      }
    }

    // Diagnosa sumber data pasar global dari Worker. /api/market/probe?group=index|fx|cmdty|crypto|us|id|tv (hanya lewat Worker langsung, tidak ada di proxy Pages)
    if (url.pathname === "/api/market/probe") {
      if (!authorized) return unauthorized();
      try {
        const { probeMarket } = await import("./feed/market_probe");
        return Response.json(await probeMarket(url.searchParams.get("group")));
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
      const { runWithHeartbeat } = await import("./core/heartbeat");
      await runWithHeartbeat(env, event, async (env) => {
        switch (event.cron) {
          case "*/5 * * * *": {
            const { handleMarketPolling } = await import("./cron/market_polling");
            await handleMarketPolling(env, ctx);
            try {
              const { runRumorPoll } = await import("./feed/rumor_rss");
              await runRumorPoll(env);
            } catch (err) {
              console.error("Rumor poll gagal:", err);
            }
            break;
          }
          case "0 1 * * *": {
            try {
              const { runCacingScreen } = await import("./core/cacing_screen");
              await runCacingScreen(env);
            } catch (err) {
              console.error("Saringan cacing-naga gagal:", err);
            }
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
          case "0 14 * * *": {
            // 21:00 WIB, setelah bursa tutup: nilai transaksi harian kandidat cacing-naga dari Pasardana.
            // (rekap_sore belum tersambung; bila nanti disambung, taruh di case ini setelah blok likuiditas.)
            try {
              const { runCacingLiquidity } = await import("./core/cacing_screen");
              await runCacingLiquidity(env);
            } catch (err) {
              console.error("Likuiditas cacing-naga gagal:", err);
            }
            try {
              const { runDailySummary } = await import("./core/daily_summary");
              const res = await runDailySummary(env);
              console.log("Ringkasan harian:", res.sent ? "terkirim" : "tidak dikirim", res.reason);
            } catch (err) {
              console.error("Ringkasan harian gagal:", err);
            }
            break;
          }
          case "0 13 * * *": {
            // 20:00 WIB: email hanya bila ada cron basi/gagal (tidak ada email bila sehat).
            const { runHealthAlert } = await import("./core/health_alert");
            await runHealthAlert(env);
            break;
          }
          default:
            console.log(`Cron ${event.cron} belum punya handler.`);
        }
      });
    } catch (err) {
      console.error(`Cron ${event.cron} gagal:`, err);
      throw err; // supaya kegagalan tercatat di dashboard Cloudflare
    }
  },
};
