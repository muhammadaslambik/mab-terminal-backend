// Pemantau rumor korporasi dari RSS media Indonesia yang terbukti bisa dijangkau Worker (uji Okt 2026).
// Jaring kasar: mencocokkan kata kunci aksi korporasi dan emiten (kode atau nama) pada JUDUL. Bukan pengganti pengumuman resmi.
// Peringatan (email Resend, cadangan Telegram) hanya untuk emiten tingkat "inti" (lihat loadWatchlist) yang judulnya memuat kata kunci aksi korporasi.
import { loadWatchlist, type WatchEmiten } from "../core/cacing_screen";
import { notificationConfigured, sendNotification } from "../notify/alert";

export const RUMOR_FEEDS: { name: string; url: string }[] = [
  { name: "CNBC Indonesia", url: "https://www.cnbcindonesia.com/market/rss" },
  { name: "CNN Indonesia", url: "https://www.cnnindonesia.com/ekonomi/rss" },
  { name: "Liputan6", url: "https://feed.liputan6.com/rss/bisnis" },
  { name: "Antara", url: "https://www.antaranews.com/rss/ekonomi.xml" },
  { name: "Tempo", url: "https://rss.tempo.co/bisnis" },
  { name: "IDX Channel", url: "https://www.idxchannel.com/rss" },
];

export const RUMOR_RE =
  /akuisisi|private placement|pengambilalihan|ambil alih|investor strategis|penambahan modal|aksi korporasi|rights issue|masuk investor|suntikan modal|backdoor listing|penempatan terbatas|tender offer|pengendali baru|perubahan pengendali|setoran modal/i;

export interface RumorItem {
  title: string;
  link: string;
  pubDate: string;
  source: string;
  kind: "rumor" | "emiten";
  codes: string[];
  firstSeen: string;
  pendingAlert?: boolean; // true = perlu dikirim ke Telegram (dicoba ulang tiap polling sampai berhasil)
}

const KEY_ITEMS = "RUMOR_LATEST";
const KEY_LAST = "RUMOR_LAST_POLL";
const MIN_INTERVAL_MS = 30 * 60 * 1000;
const KEEP_MS = 14 * 24 * 3600 * 1000;
const MAX_ITEMS = 200;
const MAX_IN_MESSAGE = 8;

const decode = (s: string) =>
  s
    .replace(/<!\[CDATA\[|\]\]>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();

export function parseRss(xml: string, max = 100): { title: string; link: string; pubDate: string }[] {
  const out: { title: string; link: string; pubDate: string }[] = [];
  const blocks = xml.split(/<item[\s>]/).slice(1);
  for (const raw of blocks) {
    const block = raw.split("</item>")[0];
    const t = block.match(/<title[^>]*>([\s\S]*?)<\/title>/);
    const l = block.match(/<link[^>]*>([\s\S]*?)<\/link>/);
    const p = block.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/);
    if (!t || !l) continue;
    const title = decode(t[1]);
    const link = decode(l[1]);
    if (!title || !link) continue;
    out.push({ title, link, pubDate: p ? decode(p[1]) : "" });
    if (out.length >= max) break;
  }
  return out;
}

export function matchCodes(title: string, codes: string[]): string[] {
  return codes.filter((c) => new RegExp(`(^|[^A-Za-z0-9])${c}([^A-Za-z0-9]|$)`).test(title));
}

/** Nama emiten tanpa "PT/Tbk/Persero"; hanya dipakai bila minimal 2 kata (nama satu kata terlalu umum). */
export function nameKey(name?: string | null): string | null {
  if (!name) return null;
  const k = name
    .replace(/\b(PT|Tbk|Persero)\b\.?/gi, " ")
    .replace(/[.,()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return k.split(" ").length >= 2 ? k : null;
}

/** Cocok bila judul memuat kode (kata utuh, huruf besar) ATAU nama emiten (tanpa membedakan huruf besar/kecil). */
export function matchEmiten(title: string, list: WatchEmiten[]): string[] {
  const lower = title.toLowerCase();
  return list
    .filter((e) => {
      if (new RegExp(`(^|[^A-Za-z0-9])${e.code}([^A-Za-z0-9]|$)`).test(title)) return true;
      const k = nameKey(e.name);
      return k !== null && lower.includes(k.toLowerCase());
    })
    .map((e) => e.code);
}

async function readItems(env: any): Promise<RumorItem[]> {
  if (!env?.KV_CACHE) return [];
  return ((await env.KV_CACHE.get(KEY_ITEMS, "json")) as RumorItem[] | null) ?? [];
}

function alertText(items: RumorItem[]): string {
  const shown = items.slice(0, MAX_IN_MESSAGE);
  const lines = ["MAB-Terminal: rumor aksi korporasi pada emiten pantauan inti", ""];
  for (const i of shown) lines.push(`${i.codes.join(",")}: ${i.title} (${i.source})`, i.link, "");
  if (items.length > shown.length) lines.push(`+${items.length - shown.length} judul lain, lihat /api/idx/rumor?matched=1`, "");
  lines.push("Ini jaring kasar dari judul berita, bukan konfirmasi. Baca sumbernya dan cek pengumuman resmi IDX.");
  return lines.join("\n");
}

export async function runRumorPoll(
  env: any,
  opts: { force?: boolean; now?: number; fetchFn?: typeof fetch } = {}
): Promise<{ skipped: boolean; fetched: number; added: number; total: number; feedErrors: string[]; alerted: number; alertError: string | null }> {
  const now = opts.now ?? Date.now();
  const fetchFn = opts.fetchFn ?? fetch;
  const kv = env?.KV_CACHE;
  const skipped = (feedErrors: string[]) => ({ skipped: true, fetched: 0, added: 0, total: 0, feedErrors, alerted: 0, alertError: null });
  if (!kv) return skipped(["KV_CACHE tidak terpasang"]);

  if (!opts.force) {
    const last = Number(await kv.get(KEY_LAST)) || 0;
    if (now - last < MIN_INTERVAL_MS) return skipped([]);
  }
  // Dicatat SEBELUM jaringan: kegagalan RSS tidak boleh memicu polling tiap 5 menit.
  await kv.put(KEY_LAST, String(now));

  const watch = await loadWatchlist(env, new Date(now));
  const notifyOn = notificationConfigured(env) !== null;

  const existing = await readItems(env);
  const seen = new Set(existing.map((i) => i.link));
  const fresh: RumorItem[] = [];
  const feedErrors: string[] = [];
  let fetched = 0;

  for (const f of RUMOR_FEEDS) {
    try {
      const res = await fetchFn(f.url, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36", Accept: "application/rss+xml, application/xml, text/xml, */*" },
      });
      if (!res.ok) {
        feedErrors.push(`${f.name}: HTTP ${res.status}`);
        continue;
      }
      for (const it of parseRss(await res.text())) {
        fetched++;
        if (seen.has(it.link)) continue;
        const rumor = RUMOR_RE.test(it.title);
        const hit = matchEmiten(it.title, watch.all);
        if (!rumor && hit.length === 0) continue;
        seen.add(it.link);
        const item: RumorItem = {
          title: it.title,
          link: it.link,
          pubDate: it.pubDate,
          source: f.name,
          kind: rumor ? "rumor" : "emiten",
          codes: hit,
          firstSeen: new Date(now).toISOString(),
        };
        // Peringatan hanya bila: kata kunci aksi korporasi + menyebut emiten inti + saluran peringatan terpasang (tanpa saluran tidak ada tunggakan)
        if (notifyOn && rumor && hit.some((c) => watch.inti.has(c))) item.pendingAlert = true;
        fresh.push(item);
      }
    } catch (e) {
      feedErrors.push(`${f.name}: ${String(e).slice(0, 80)}`);
    }
  }

  const cutoff = now - KEEP_MS;
  const merged = [...fresh, ...existing]
    .filter((i) => Date.parse(i.firstSeen) >= cutoff)
    .slice(0, MAX_ITEMS);

  let alerted = 0;
  let alertError: string | null = null;
  const pending = merged.filter((i) => i.pendingAlert === true);
  if (notifyOn && pending.length > 0) {
    const codes = Array.from(new Set(pending.flatMap((i) => i.codes))).slice(0, 5).join(", ");
    const r = await sendNotification(env, `MAB-Terminal: rumor aksi korporasi (${codes})`, alertText(pending));
    if (r.ok) {
      for (const i of pending) i.pendingAlert = false;
      alerted = pending.length;
    } else {
      alertError = r.error ?? "gagal kirim";
    }
  }

  await kv.put(KEY_ITEMS, JSON.stringify(merged));
  return { skipped: false, fetched, added: fresh.length, total: merged.length, feedErrors, alerted, alertError };
}

export async function readRumors(env: any, onlyMatched: boolean): Promise<{ count: number; lastPollAt: string | null; items: RumorItem[] }> {
  const items = (await readItems(env)).filter((i) => !onlyMatched || i.codes.length > 0);
  const last = env?.KV_CACHE ? Number(await env.KV_CACHE.get(KEY_LAST)) || 0 : 0;
  return { count: items.length, lastPollAt: last ? new Date(last).toISOString() : null, items };
}
