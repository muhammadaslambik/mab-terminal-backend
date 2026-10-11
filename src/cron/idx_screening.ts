import { PasardanaFeed } from "../feed/pasardana";
import { screenIdx, type IdxScreen } from "../core/idx_screener";

/** Ambil seluruh saham dari Pasardana, saring kandidat, simpan ke KV (jika terpasang). */
export async function handleIdxScreening(env: any): Promise<IdxScreen | null> {
  const stocks = await new PasardanaFeed().getAllStocks();
  if (stocks.length === 0) {
    console.error("Pasardana: tidak ada data saham (diblokir atau format berubah). Jalankan /api/idx/probe.");
    return null;
  }
  const screen = screenIdx(stocks);
  if (env.KV_CACHE) await env.KV_CACHE.put("IDX_SCREEN", JSON.stringify(screen), { expirationTtl: 3 * 86400 });
  console.log(`[idx] ${screen.total} saham | value=${screen.valueCandidates.length} shell=${screen.shellCandidates.length} gainers=${screen.topGainers.length}`);
  return screen;
}
