// Wire News nyata, berkategori. Indonesia (6 RSS) tetap di "items"; berita asing di "global" (amerika, dunia, crypto, xauusd).
// Judul + tautan + sumber + waktu + cuplikan deskripsi RSS (bukan isi artikel penuh). Cache KV 10 menit; digabung dengan cache lama (maks 72 jam).
// Judul asing diterjemahkan bertahap lewat Workers AI (hasil disimpan di item: titleId), dengan batas harian.
import { RUMOR_FEEDS, RUMOR_RE } from "./rumor_rss";
import { parseRssNews } from "./news_parse";
import { translateOne } from "./translate";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36";
const KEY = "NEWS_WIRE";
const FRESH_MS = 10 * 60 * 1000;
const KEEP_MS = 72 * 3600 * 1000;
const STALE_MS = 72 * 3600 * 1000;
const MAX_ID = 60;
const MAX_GLOBAL = 25;
const PER_FEED = 30;
const KV_TTL_S = 3 * 24 * 3600;
const TR_PER_RUN = 6; // terjemahan per pembangunan biasa
const TR_PER_REFRESH = 25; // terjemahan per ?refresh=1
const TR_MAX_FAIL = 2; // percobaan maksimal per judul
const TR_STOP_AFTER = 3; // berhenti setelah sekian galat beruntun (kuota habis / gangguan AI)
const TR_DAILY_CAP = 400; // batas per hari UTC (kuota gratis Workers AI belum diketahui)

export type NewsCat = "indonesia" | "amerika" | "dunia" | "crypto" | "xauusd";
const GLOBAL_CATS: NewsCat[] = ["amerika", "dunia", "crypto", "xauusd"];

interface Feed {
  name: string;
  url: string;
  category: NewsCat;
  lang: "id" | "en";
}

const FEEDS: Feed[] = [
  ...RUMOR_FEEDS.map((f) => ({ name: f.name, url: f.url, category: "indonesia" as NewsCat, lang: "id" as const })),
  { name: "MarketWatch", url: "https://feeds.content.dowjones.io/public/rss/mw_topstories", category: "amerika", lang: "en" },
  { name: "BBC Business", url: "https://feeds.bbci.co.uk/news/business/rss.xml", category: "dunia", lang: "en" },
  { name: "Cointelegraph", url: "https://cointelegraph.com/rss", category: "crypto", lang: "en" },
  { name: "Decrypt", url: "https://decrypt.co/feed", category: "crypto", lang: "en" },
  { name: "Google News (emas)", url: "https://news.google.com/rss/search?q=gold+price+XAUUSD&hl=en-US&gl=US&ceid=US:en", category: "xauusd", lang: "en" },
];

export interface NewsItem {
  title: string;
  link: string;
  source: string;
  ts: number; // ms epoch
  time: string; // ISO
  corporateAction: boolean;
  summary: string; // cuplikan deskripsi RSS apa adanya (sudah dibersihkan dari tag); "" bila feed tidak menyediakan
  category: NewsCat;
  lang: "id" | "en";
  titleId?: string; // terjemahan judul (mesin) untuk berita berbahasa Inggris
  trFail?: number; // jumlah percobaan terjemahan yang gagal (maks 2 percobaan per judul)
}

interface FeedResult {
  feed: Feed;
  items: NewsItem[];
  error: string | null;
  newestTs: number | null;
}

async function fetchFeed(feed: Feed, now: number): Promise<FeedResult> {
  try {
    const res = await fetch(feed.url, { headers: { "User-Agent": UA, Accept: "application/rss+xml, application/xml, text/xml, */*" } });
    if (!res.ok) return { feed, items: [], error: `${feed.name}: HTTP ${res.status}`, newestTs: null };
    const items: NewsItem[] = parseRssNews(await res.text(), PER_FEED).map((it) => {
      let ts = Date.parse(it.pubDate);
      if (!isFinite(ts) || ts > now + 3600000) ts = now; // tanggal rusak atau di masa depan
      return {
        title: it.title,
        link: it.link,
        source: feed.name,
        ts,
        time: new Date(ts).toISOString(),
        corporateAction: feed.category === "indonesia" && RUMOR_RE.test(it.title),
        summary: it.summary,
        category: feed.category,
        lang: feed.lang,
      };
    });
    const newestTs = items.length ? Math.max(...items.map((i) => i.ts)) : null;
    return { feed, items, error: null, newestTs };
  } catch (e) {
    return { feed, items: [], error: `${feed.name}: ${String(e).slice(0, 80)}`, newestTs: null };
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

  const results = await Promise.all(FEEDS.map((f) => fetchFeed(f, now)));
  const feedErrors = results.map((r) => r.error).filter((e): e is string => e !== null);
  const okFeeds = results.filter((r) => r.error === null).length;
  if (okFeeds === 0 && cached) return { ...cached, cache: "stale", staleReason: "semua RSS gagal", feedErrors };

  // Gabungkan cache lama (tanpa menimpa terjemahan yang sudah ada) dengan hasil baru; buang yang lebih tua dari 72 jam.
  const byLink = new Map<string, NewsItem>();
  const old: NewsItem[] = [...((cached?.items ?? []) as NewsItem[])];
  for (const c of GLOBAL_CATS) old.push(...(((cached?.global ?? {})[c] ?? []) as NewsItem[]));
  for (const it of old) {
    if (it?.link && now - it.ts < KEEP_MS) byLink.set(it.link, { ...it, summary: it.summary ?? "", category: it.category ?? "indonesia", lang: it.lang ?? "id" });
  }
  for (const r of results) {
    for (const it of r.items) {
      if (now - it.ts >= KEEP_MS) continue;
      const prev = byLink.get(it.link);
      byLink.set(it.link, prev ? { ...it, titleId: prev.titleId, trFail: prev.trFail } : it);
    }
  }
  const all = Array.from(byLink.values()).sort((a, b) => b.ts - a.ts);
  const items = all.filter((i) => i.category === "indonesia").slice(0, MAX_ID);
  const global: Record<string, NewsItem[]> = {};
  for (const c of GLOBAL_CATS) global[c] = all.filter((i) => i.category === c).slice(0, MAX_GLOBAL);

  // Status per sumber (basi bila berita terbarunya lebih dari 72 jam atau feed tidak menghasilkan apa pun).
  const sources = results.map((r) => ({
    name: r.feed.name,
    category: r.feed.category,
    ok: r.error === null,
    fetched: r.items.length,
    newest: r.newestTs ? new Date(r.newestTs).toISOString() : null,
    stale: r.error === null && (r.newestTs === null || now - r.newestTs > STALE_MS),
  }));

  // Terjemahan judul asing, bertahap. Judul yang gagal dilewati; berhenti setelah 3 galat beruntun (mis. kuota habis).
  const day = new Date(now).toISOString().slice(0, 10);
  const prevTr = cached?.translate;
  let used = prevTr?.day === day && typeof prevTr.count === "number" ? prevTr.count : 0;
  let translatedNow = 0;
  let trError: string | null = null;
  let streak = 0;
  if (!env?.AI) {
    trError = "binding AI tidak terpasang";
  } else {
    const budget = refresh ? TR_PER_REFRESH : TR_PER_RUN;
    const todo = GLOBAL_CATS.flatMap((c) => global[c]).filter((i) => i.lang === "en" && !i.titleId && (i.trFail ?? 0) < TR_MAX_FAIL).sort((a, b) => b.ts - a.ts);
    for (const it of todo) {
      if (translatedNow >= budget) break;
      if (used >= TR_DAILY_CAP) {
        trError = "batas harian terjemahan tercapai";
        break;
      }
      try {
        it.titleId = await translateOne(env, it.title, "en", "id");
        translatedNow++;
        used++;
        streak = 0;
      } catch (e) {
        trError = String(e).slice(0, 100);
        it.trFail = (it.trFail ?? 0) + 1;
        streak++;
        if (streak >= TR_STOP_AFTER) break;
      }
    }
  }
  const pending = GLOBAL_CATS.flatMap((c) => global[c]).filter((i) => i.lang === "en" && !i.titleId && (i.trFail ?? 0) < TR_MAX_FAIL).length;

  const payload = {
    builtAt: new Date(now).toISOString(),
    okFeeds,
    totalFeeds: FEEDS.length,
    feedErrors,
    count: items.length,
    items,
    global,
    sources,
    translate: { day, count: used, cap: TR_DAILY_CAP, translatedNow, pending, error: trError },
    note: "Judul dan cuplikan deskripsi dari RSS media. Cuplikan bukan rangkuman isi artikel; bukan konfirmasi, baca sumbernya. Terjemahan judul adalah terjemahan mesin dan bisa keliru.",
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
