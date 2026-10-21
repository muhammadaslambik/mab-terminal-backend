// Pengurai RSS khusus berita (terpisah dari parseRss milik pemantau rumor). Tanpa impor agar mudah diuji.
const ent = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");

export const SUMMARY_MAX = 400;

/** Bersihkan deskripsi RSS: buang CDATA, dekode entitas (IDX menulis HTML ter-escape), buang tag, rapikan spasi, potong. */
export function cleanSummary(raw: string, max = SUMMARY_MAX): string {
  let s = raw.replace(/<!\[CDATA\[|\]\]>/g, "");
  s = ent(s); // &lt;img ... -> <img ...
  s = s.replace(/<[^>]*>/g, " ");
  s = ent(s); // sisa entitas setelah tag dibuang
  s = s.replace(/\s+/g, " ").trim();
  if (s.length > max) s = s.slice(0, max).replace(/\s+\S*$/, "") + "...";
  return s;
}

export function parseRssNews(xml: string, max = 100): { title: string; link: string; pubDate: string; summary: string }[] {
  const out: { title: string; link: string; pubDate: string; summary: string }[] = [];
  const blocks = xml.split(/<item[\s>]/).slice(1);
  for (const raw of blocks) {
    const block = raw.split("</item>")[0];
    const t = block.match(/<title[^>]*>([\s\S]*?)<\/title>/);
    const l = block.match(/<link[^>]*>([\s\S]*?)<\/link>/);
    const p = block.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/);
    const d = block.match(/<description[^>]*>([\s\S]*?)<\/description>/);
    if (!t || !l) continue;
    const title = ent(t[1].replace(/<!\[CDATA\[|\]\]>/g, "")).trim();
    const link = ent(l[1].replace(/<!\[CDATA\[|\]\]>/g, "")).trim();
    if (!title || !link) continue;
    out.push({ title, link, pubDate: p ? ent(p[1].replace(/<!\[CDATA\[|\]\]>/g, "")).trim() : "", summary: d ? cleanSummary(d[1]) : "" });
    if (out.length >= max) break;
  }
  return out;
}
