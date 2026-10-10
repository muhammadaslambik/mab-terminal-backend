import { BinanceFeed } from "../feed/binance";
import { YahooFeed } from "../feed/yahoo";
import { analyzeCrypto } from "../core/analysis_service";

const CRYPTO = ["BTC", "ETH"];
const SIGNAL_TTL_MS = 60 * 60 * 1000; // sinyal harian cukup dihitung ulang tiap 1 jam

export async function handleMarketPolling(env: any, ctx: any): Promise<void> {
  const binance = new BinanceFeed();
  const yahoo = new YahooFeed();
  const tasks: Promise<unknown>[] = [];

  // 1. Harga kripto 24/7
  for (const s of CRYPTO) {
    tasks.push(
      binance.getPrice(s).then(async (res) => {
        if (res && env.KV_CACHE) await env.KV_CACHE.put(`PRICE_${s}`, res.price.toString());
      })
    );
  }

  // 2. Emas futures (null saat akhir pekan)
  tasks.push(
    yahoo.getTickerSummary("GC=F").then(async (res) => {
      if (res && env.KV_CACHE) await env.KV_CACHE.put("PRICE_XAUUSD", res.price.toString());
    })
  );

  // 3. Sinyal engine untuk kripto (dihitung ulang paling cepat tiap 1 jam bila KV tersedia)
  for (const s of CRYPTO) {
    tasks.push(
      (async () => {
        if (env.KV_CACHE) {
          const cached: any = await env.KV_CACHE.get(`SIGNAL_${s}`, "json");
          if (cached && Date.now() - cached.computedAt < SIGNAL_TTL_MS) return;
        }
        const decision = await analyzeCrypto(s);
        console.log(`[signal] ${s}: ${decision.action} | ${decision.reason}`);
        if (env.KV_CACHE) {
          await env.KV_CACHE.put(`SIGNAL_${s}`, JSON.stringify({ computedAt: Date.now(), decision }), { expirationTtl: 86400 });
        }
      })()
    );
  }

  // Tunggu semuanya selesai; satu sumber yang gagal tidak membatalkan yang lain
  const results = await Promise.allSettled(tasks);
  const failed = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
  failed.forEach((f) => console.error("Polling gagal:", String(f.reason)));
  console.log(`[${new Date().toISOString()}] Polling selesai: ${results.length - failed.length}/${results.length} berhasil.`);
}
