// Wire News nyata: judul berita bisnis dari 6 RSS media Indonesia yang sama dengan pemantau rumor.
// Hanya judul + tautan + sumber + waktu terbit (bukan isi artikel). Cache KV 10 menit; digabung dengan cache lama (maks 72 jam).
import { RUMOR_FEEDS, RUMOR_RE, parseRss } from "./rumor_rss";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36";
const KEY = "NEWS_WIRE";
const FRESH_MS = 10 * 60 * 1000;
const KEEP_MS = 72 * 3600 * 1000;
const MAX_ITEMS = 60;
const PER_FEED = 30;
const KV_TTL_S = 3 * 24 * 3600;

export interface NewsItem {
  title: string;
  link: string;
  source: string;
  ts: number; // ms epoch
  time: string; // ISO
  corporateAction: boolean;
}

async function fetchFeed(name: string, url: string, now: number): Promise<{ items: NewsItem[]; error: string | null }> {
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/rss+xml, application/xml, text/xml, */*" } });
    if (!res.ok) return { items: [], error: `${name}: HTTP ${res.status}` };
    const items: NewsItem[] = parseRss(await res.text(), PER_FEED).map((it) => {
      let ts = Date.parse(it.pubDate);
      if (!isFinite(ts) || ts > now + 3600000) ts = now; // tanggal rusak atau di masa depan
      return { title: it.title, link: it.link, source: name, ts, time: new Date(ts).toISOString(), corporateAction: RUMOR_RE.test(it.title) };
    });
    return { items, error: null };
  } catch (e) {
    return { items: [], error: `${name}: ${String(e).slice(0, 80)}` };
  }
}

export async function loadNews(env: any, refresh = false): Promise<Record<string, unknown>> {
  const kv = env?.KV_CACHE;
  const now = Date.now();
  let cached: any = null;
  if (kv) {
    try {
      cached = await kv.get(KEY, "json");
    } catch (_e) {
      cached = null;
    }
  }
  if (!refresh && cached?.builtAt && now - Date.parse(cached.builtAt) < FRESH_MS) return { ...cached, cache: "hit" };

  const results = await Promise.all(RUMOR_FEEDS.map((f) => fetchFeed(f.name, f.url, now)));
  const feedErrors = results.map((r) => r.error).filter((e): e is string => e !== null);
  const okFeeds = results.filter((r) => r.error === null).length;
  if (okFeeds === 0 && cached) return { ...cached, cache: "stale", staleReason: "semua RSS gagal", feedErrors };

  const byLink = new Map<string, NewsItem>();
  for (const it of (cached?.items ?? []) as NewsItem[]) if (it?.link && now - it.ts < KEEP_MS) byLink.set(it.link, it);
  for (const r of results) for (const it of r.items) byLink.set(it.link, it);
  const items = Array.from(byLink.values())
    .sort((a, b) => b.ts - a.ts)
    .slice(0, MAX_ITEMS);

  const payload = {
    builtAt: new Date(now).toISOString(),
    okFeeds,
    totalFeeds: RUMOR_FEEDS.length,
    feedErrors,
    count: items.length,
    items,
    note: "Judul dari RSS media Indonesia (bisnis/pasar). Bukan kawat berita global dan bukan konfirmasi; baca sumbernya.",
  };
  if (kv) {
    try {
      await kv.put(KEY, JSON.stringify(payload), { expirationTtl: KV_TTL_S });
    } catch (_e) {
      // gagal simpan cache tidak boleh menggagalkan respons
    }
  }
  return { ...payload, cache: "miss" };
}
