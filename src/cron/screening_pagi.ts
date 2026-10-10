import { YahooFeed } from "../feed/yahoo";

export async function handleScreeningPagi(env: any, ctx: any): Promise<void> {
  const yahoo = new YahooFeed();
  // Saring saham utama pilihan LQ45 / Kompas100
  const watchList = ["BBCA.JK", "BBRI.JK", "TLKM.JK", "ASII.JK"];

  ctx.waitUntil(
    Promise.all(
      watchList.map(async (ticker) => {
        const data = await yahoo.getTickerSummary(ticker);
        if (data && env.KV_CACHE) {
          // Menyimpan basis baseline harga harian untuk dianalisis oleh modul core/orchestrator
          await env.KV_CACHE.put(`SCREENING_${ticker}`, JSON.stringify(data));
        }
      })
    ).then(() => {
      console.log("Proses pemindaian pasar pagi (Screening Pagi) selesai dieksekusi.");
    })
  );
}
