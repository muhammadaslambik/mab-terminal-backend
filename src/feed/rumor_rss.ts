// Pemantau rumor korporasi dari RSS media Indonesia yang terbukti bisa dijangkau Worker (uji Okt 2026).
// Jaring kasar: hanya mencocokkan kata kunci dan kode emiten pada JUDUL. Bukan pengganti pengumuman resmi.

export const RUMOR_FEEDS: { name: string; url: string }[] = [
  { name: "CNBC Indonesia", url: "https://www.cnbcindonesia.com/market/rss" },
  { name: "CNN Indonesia", url: "https://www.cnnindonesia.com/ekonomi/rss" },
  { name: "Liputan6", url: "https://feed.liputan6.com/rss/bisnis" },
  { name: "Antara", url: "https://www.antaranews.com/rss/ekonomi.xml" },
  { name: "Tempo", url: "https://rss.tempo.co/bisnis" },
  { name: "IDX Channel", url: "https://www.idxchannel.com/rss" },
];

export const RUMOR_RE =
  /akuisisi|private placement|pengambilalihan|ambil alih|investor strategis|penambahan modal|aksi korporasi|rights issue|masuk investor|suntikan modal|backdoor listing/i;

export interface RumorItem {
  title: string;
  link: string;
  pubDate: string;
  source: string;
  kind: "rumor" | "emiten";
  codes: string[];
  firstSeen: string;
}

const KEY_ITEMS = "RUMOR_LATEST";
const KEY_LAST = "RUMOR_LAST_POLL";
const MIN_INTERVAL_MS = 30 * 60 * 1000;
const KEEP_MS = 14 * 24 * 3600 * 1000;
const MAX_ITEMS = 200;

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

async function readItems(env: any): Promise<RumorItem[]> {
  if (!env?.KV_CACHE) return [];
  return ((await env.KV_CACHE.get(KEY_ITEMS, "json")) as RumorItem[] | null) ?? [];
}

export async function runRumorPoll(
  env: any,
  opts: { force?: boolean; now?: number; fetchFn?: typeof fetch } = {}
): Promise<{ skipped: boolean; fetched: number; added: number; total: number; feedErrors: string[] }> {
  const now = opts.now ?? Date.now();
  const fetchFn = opts.fetchFn ?? fetch;
  const kv = env?.KV_CACHE;
  if (!kv) return { skipped: true, fetched: 0, added: 0, total: 0, feedErrors: ["KV_CACHE tidak terpasang"] };

  if (!opts.force) {
    const last = Number(await kv.get(KEY_LAST)) || 0;
    if (now - last < MIN_INTERVAL_MS) return { skipped: true, fetched: 0, added: 0, total: 0, feedErrors: [] };
  }

  const screen: any = await kv.get("CACING_SCREEN", "json");
  const codes: string[] = (screen?.candidates ?? []).map((c: any) => String(c.code)).filter((c: string) => /^[A-Z0-9]{2,6}$/.test(c));

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
        const hit = matchCodes(it.title, codes);
        if (!rumor && hit.length === 0) continue;
        seen.add(it.link);
        fresh.push({
          title: it.title,
          link: it.link,
          pubDate: it.pubDate,
          source: f.name,
          kind: rumor ? "rumor" : "emiten",
          codes: hit,
          firstSeen: new Date(now).toISOString(),
        });
      }
    } catch (e) {
      feedErrors.push(`${f.name}: ${String(e).slice(0, 80)}`);
    }
  }

  const cutoff = now - KEEP_MS;
  const merged = [...fresh, ...existing]
    .filter((i) => Date.parse(i.firstSeen) >= cutoff)
    .slice(0, MAX_ITEMS);
  await kv.put(KEY_ITEMS, JSON.stringify(merged));
  await kv.put(KEY_LAST, String(now));
  return { skipped: false, fetched, added: fresh.length, total: merged.length, feedErrors };
}

export async function readRumors(env: any, onlyMatched: boolean): Promise<{ count: number; items: RumorItem[] }> {
  const items = (await readItems(env)).filter((i) => !onlyMatched || i.codes.length > 0);
  return { count: items.length, items };
}
