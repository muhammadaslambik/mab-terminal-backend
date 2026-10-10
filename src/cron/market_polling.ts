import { BinanceFeed } from "../feed/binance";
import { YahooFeed } from "../feed/yahoo";

export async function handleMarketPolling(env: any, ctx: any): Promise<void> {
  const binance = new BinanceFeed();
  const yahoo = new YahooFeed();

  // Jalankan polling multi-aset secara paralel untuk performa optimal
  ctx.waitUntil(
    Promise.all([
      // 1. Polling Kripto 24/7 (Tanpa Libur)
      binance.getPrice("BTC").then(async (res) => {
        if (res && env.KV_CACHE) await env.KV_CACHE.put("PRICE_BTC", res.price.toString());
      }),
      binance.getPrice("ETH").then(async (res) => {
        if (res && env.KV_CACHE) await env.KV_CACHE.put("PRICE_ETH", res.price.toString());
      }),
      // 2. Polling Emas Futures (Akan otomatis mengembalikan null saat akhir pekan tiba)
      yahoo.getTickerSummary("GC=F").then(async (res) => {
        if (res && env.KV_CACHE) await env.KV_CACHE.put("PRICE_XAUUSD", res.price.toString());
      })
    ]).then(() => {
      console.log(`[${new Date().toISOString()}] Polling data harga pasar berhasil diperbarui ke KV Cache.`);
    })
  );
}
