import { YahooFeed } from "../feed/yahoo";
import { IDX_UNIVERSE } from "../core/idx_universe";
import { screenUniverse, type IdxScreen } from "../core/idx_screener";

const MAX_PER_RUN = 35; // batas aman jatah 50 request per eksekusi (paket gratis)

/** Ambil candle harian seluruh daftar pantau dari Yahoo, buat peringkat, simpan ke KV bila terpasang. */
export async function handleIdxScreening(env: any): Promise<IdxScreen | null> {
  const yahoo = new YahooFeed();
  const codes = IDX_UNIVERSE.slice(0, MAX_PER_RUN);
  const results = await Promise.allSettled(codes.map(async (code) => ({ code, candles: await yahoo.getCandles(`${code}.JK`, "6mo", "1d") })));
  const data = results.filter((r): r is PromiseFulfilledResult<{ code: string; candles: any[] }> => r.status === "fulfilled").map((r) => r.value);
  const screen = screenUniverse(data);
  if (screen.scanned === 0) {
    console.error("Yahoo: tidak ada data saham .JK. Jalankan /api/idx/probe.");
    return null;
  }
  if (env.KV_CACHE) await env.KV_CACHE.put("IDX_SCREEN", JSON.stringify(screen), { expirationTtl: 3 * 86400 });
  console.log(`[idx] ${screen.scanned}/${screen.universe} saham | topValue=${screen.topValue[0]?.code} topGainer=${screen.topGainers[0]?.code}`);
  return screen;
}
