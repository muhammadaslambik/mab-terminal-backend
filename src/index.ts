import { handleMarketPolling } from "./cron/market_polling";
import { handleScreeningPagi } from "./cron/screening_pagi";

export default {
  /**
   * Handler untuk melayani request API HTTP dari Frontend (Next.js/React)
   */
  async fetch(request: Request, env: any, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    
    // Rute pengecekan kesehatan server dasar
    if (url.pathname === "/api/health") {
      return new Response(JSON.stringify({ status: "healthy", timestamp: Date.now() }), {
        headers: { "Content-Type": "application/json" }
      });
    }

    return new Response("MAB-Terminal Worker Backend is Running.", { status: 200 });
  },

  /**
   * Handler Otomatis untuk Cloudflare Cron Triggers (Penjadwalan Mandiri)
   */
  async scheduled(event: any, env: any, ctx: ExecutionContext): Promise<void> {
    switch (event.cron) {
      case "*/5 * * * *":
        // Dieksekusi setiap 5 menit
        await handleMarketPolling(env, ctx);
        break;
      case "0 1 * * *":
        // Pukul 01:00 UTC atau 08:00 WIB pagi
        await handleScreeningPagi(env, ctx);
        break;
      default:
        console.log(`Pemicu cron [${event.cron}] terdeteksi aktif namun belum dikaitkan ke modul.`);
    }
  }
};
