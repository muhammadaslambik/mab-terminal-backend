// Heartbeat cron: tiap cron mencatat waktu, durasi, dan hasil ke KV agar kegagalan/basi terlihat di /api/health.
// Cron */5 hanya menulis tiap 30 menit saat sukses (hemat batas tulis KV paket gratis); kegagalan selalu ditulis.

export interface CronMeta { name: string; maxAgeMin: number }

export const CRON_EXPECT: Record<string, CronMeta> = {
  "*/5 * * * *": { name: "poll_5m", maxAgeMin: 45 },
  "0 1 * * *": { name: "screen_0800wib", maxAgeMin: 26 * 60 },
  "0 14 * * *": { name: "liquidity_2100wib", maxAgeMin: 26 * 60 },
  "0 13 * * *": { name: "health_check_2000wib", maxAgeMin: 26 * 60 },
  "0 0 */3 * *": { name: "keep_alive", maxAgeMin: 100 * 60 },
};

const KV_METHODS = new Set(["get", "put", "delete", "list", "getWithMetadata"]);

function countKv(kv: any, counter: { kv: number }): any {
  return new Proxy(kv, {
    get(target, prop) {
      const v = (target as any)[prop];
      if (typeof v !== "function") return v;
      if (KV_METHODS.has(String(prop))) {
        return (...args: any[]) => {
          counter.kv++;
          return v.apply(target, args);
        };
      }
      return v.bind(target);
    },
  });
}

/** fn menerima env yang operasi KV-nya dihitung; fetch global juga dihitung selama fn berjalan (perkiraan subrequest, batas 50). */
export async function runWithHeartbeat(env: any, event: any, fn: (countedEnv: any) => Promise<void>): Promise<void> {
  const meta = CRON_EXPECT[event?.cron];
  const t0 = Date.now();
  const counter = { kv: 0, fetch: 0 };
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((...args: any[]) => {
    counter.fetch++;
    return (realFetch as any)(...args);
  }) as typeof fetch;
  const countedEnv = env?.KV_CACHE ? { ...env, KV_CACHE: countKv(env.KV_CACHE, counter) } : env;
  let failure: unknown = null;
  try {
    await fn(countedEnv);
  } catch (e) {
    failure = e;
  } finally {
    globalThis.fetch = realFetch;
  }
  if (meta && env?.KV_CACHE) {
    const nominal = new Date(typeof event?.scheduledTime === "number" ? event.scheduledTime : t0);
    const throttled = meta.name === "poll_5m" && failure === null && nominal.getUTCMinutes() % 30 !== 0;
    if (!throttled) {
      try {
        await env.KV_CACHE.put(
          `HEARTBEAT_${meta.name}`,
          JSON.stringify({
            name: meta.name,
            cron: event.cron,
            lastRunAt: new Date(t0).toISOString(),
            durationMs: Date.now() - t0,
            ok: failure === null,
            error: failure === null ? null : String(failure).slice(0, 300),
            // perkiraan; belum termasuk 1 tulis heartbeat ini dan pekerjaan latar (waitUntil)
            subrequests: { fetch: counter.fetch, kv: counter.kv, total: counter.fetch + counter.kv },
          })
        );
      } catch (_e) {
        // heartbeat tidak boleh menggagalkan cron
      }
    }
  }
  if (failure !== null) throw failure;
}

export async function readHeartbeats(env: any): Promise<{ status: "healthy" | "degraded"; now: string; crons: any[] }> {
  const now = Date.now();
  const crons: any[] = [];
  let degraded = false;
  for (const [cron, meta] of Object.entries(CRON_EXPECT)) {
    let hb: any = null;
    try {
      hb = env.KV_CACHE ? await env.KV_CACHE.get(`HEARTBEAT_${meta.name}`, "json") : null;
    } catch (_e) {
      hb = null;
    }
    if (!hb) {
      crons.push({ name: meta.name, cron, state: "belum_ada" });
      continue;
    }
    const ageMin = Math.round((now - Date.parse(hb.lastRunAt)) / 60000);
    const stale = !Number.isFinite(ageMin) || ageMin > meta.maxAgeMin;
    const state = hb.ok === false ? "gagal" : stale ? "basi" : "ok";
    if (state !== "ok") degraded = true;
    crons.push({ name: meta.name, cron, state, lastRunAt: hb.lastRunAt, ageMin, maxAgeMin: meta.maxAgeMin, durationMs: hb.durationMs, subrequests: hb.subrequests ?? null, error: hb.error });
  }
  return { status: degraded ? "degraded" : "healthy", now: new Date(now).toISOString(), crons };
}
