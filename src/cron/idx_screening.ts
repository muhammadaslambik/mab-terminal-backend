import { PasardanaFeed } from "../feed/pasardana";
import { YahooFeed } from "../feed/yahoo";
import { IDX_UNIVERSE } from "../core/idx_universe";
import { screenMarket, screenUniverse, type IdxScreen } from "../core/idx_screener";

const MAX_YAHOO_PER_RUN = 35; // batas aman jatah 50 request per eksekusi (paket gratis)

/**
 * Penyaringan harian saham Indonesia.
 * Utama: Pasardana (seluruh pasar + PBV/PER/market cap/free float).
 * Cadangan: candle harian Yahoo untuk daftar pantau di idx_universe.ts.
 */
export async function handleIdxScreening(env: any): Promise<IdxScreen | null> {
  let screen: IdxScreen | null = null;

  try {
    const stocks = await new PasardanaFeed().getAllStocks();
    if (stocks.length > 0) screen = screenMarket(stocks);
    else console.error("Pasardana: data kosong, beralih ke Yahoo.");
  } catch (err) {
    console.error("Pasardana gagal, beralih ke Yahoo:", String(err));
  }

  if (!screen) {
    const yahoo = new YahooFeed();
    const codes = IDX_UNIVERSE.slice(0, MAX_YAHOO_PER_RUN);
    const results = await Promise.allSettled(codes.map(async (code) => ({ code, candles: await yahoo.getCandles(`${code}.JK`, "6mo", "1d") })));
    const data = results.filter((r): r is PromiseFulfilledResult<{ code: string; candles: any[] }> => r.status === "fulfilled").map((r) => r.value);
    const fallback = screenUniverse(data);
    if (fallback.scanned > 0) screen = fallback;
  }

  if (!screen) {
    console.error("Tidak ada sumber data saham yang berhasil. Jalankan /api/idx/probe dan /api/idx/probe?source=pasardana.");
    return null;
  }
  if (env.KV_CACHE) await env.KV_CACHE.put("IDX_SCREEN", JSON.stringify(screen), { expirationTtl: 3 * 86400 });
  console.log(`[idx] sumber=${screen.source} ${screen.scanned}/${screen.total} | value=${screen.valueCandidates.length} shell=${screen.shellCandidates.length} topValue=${screen.topValue[0]?.code}`);
  return screen;
}
