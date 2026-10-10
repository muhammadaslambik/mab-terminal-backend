import { handleRadar } from "./routes/radar";
import { handleSahamID } from "./routes/saham-id";
import { handleSahamUS } from "./routes/saham-us";
import { handleCrypto } from "./routes/crypto";
import { handleXauusd } from "./routes/xauusd";
import { handleLab } from "./routes/lab";
import { handleNews } from "./routes/news";
import { handleHealth } from "./routes/health";
import { runScheduled } from "./cron/_dispatcher";

export interface Env {
  CACHE: KVNamespace;
  FINNHUB_KEY?: string;
  TELEGRAM_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  NEON_CONNECTION_STRING?: string;
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_KEY?: string;
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
};

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

    const url = new URL(req.url);
    const path = url.pathname;
    const json = (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json", ...CORS },
      });

    try {
      if (path === "/api/health") return json(await handleHealth(env));
      if (path === "/api/radar") return json(await handleRadar(env));
      if (path === "/api/saham-id") return json(await handleSahamID(url, env));
      if (path === "/api/saham-us") return json(await handleSahamUS(url, env));
      if (path === "/api/crypto") return json(await handleCrypto(url, env));
      if (path === "/api/xauusd") return json(await handleXauusd(url, env));
      if (path === "/api/news") return json(await handleNews(url, env));
      if (path === "/api/lab/backtest" && req.method === "POST")
        return json(await handleLab(await req.json(), env));
      return json({ error: "not_found", path }, 404);
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runScheduled(event.cron, env));
  },
};
