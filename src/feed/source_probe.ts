// Uji sumber data alternatif (selain idx.co.id) dari Cloudflare Worker.
// Total sekitar 9 request kecil. Jalankan pada Worker yang sudah di-deploy.

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export interface SourceCheck {
  name: string;
  ok: boolean;
  status: number | null;
  detail: unknown;
  error: string | null;
}

const fail = (name: string, e: unknown): SourceCheck => ({ name, ok: false, status: null, detail: null, error: String(e) });

// 1) Pasardana: lihat SEMUA nama field satu emiten (cari DER, utang, aset, pemegang saham)
async function probePasardana(): Promise<SourceCheck> {
  try {
    const url = "https://pasardana.id/api/StockSearchResult/GetAll?Keywords=IGAR&pageBegin=0&pageLength=2&sortField=Code&sortOrder=asc";
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json", Referer: "https://pasardana.id/" } });
    const text = await res.text();
    let keys: string[] = [];
    let first: any = null;
    try {
      const j: any = JSON.parse(text);
      const arr = Array.isArray(j) ? j : j.data ?? j.Data ?? [];
      first = arr[0] ?? null;
      keys = first ? Object.keys(first) : [];
    } catch {
      // bukan JSON
    }
    const interesting = keys.filter((k) => /der|debt|liab|equity|utang|hutang|asset|aset|share|saham|holder|float/i.test(k));
    return {
      name: "pasardana_fields",
      ok: res.ok && keys.length > 0,
      status: res.status,
      detail: { totalKeys: keys.length, interesting, allKeys: keys, sample: keys.length ? undefined : text.slice(0, 150) },
      error: null,
    };
  } catch (e) {
    return fail("pasardana_fields", e);
  }
}

// 2) TradingView scanner: satu kolom per request supaya kolom tak dikenal tidak merusak yang lain
export async function tvColumn(col: string): Promise<SourceCheck> {
  try {
    const res = await fetch("https://scanner.tradingview.com/indonesia/scan", {
      method: "POST",
      headers: {
        "User-Agent": UA,
        "Content-Type": "application/json",
        Accept: "application/json",
        Origin: "https://www.tradingview.com",
        Referer: "https://www.tradingview.com/",
      },
      body: JSON.stringify({ symbols: { tickers: ["IDX:IGAR", "IDX:BESS"] }, columns: ["name", col] }),
    });
    const text = await res.text();
    let rows: unknown = null;
    try {
      const j: any = JSON.parse(text);
      rows = Array.isArray(j.data) ? j.data.map((r: any) => r.d) : null;
    } catch {
      // bukan JSON
    }
    return {
      name: `tv:${col}`,
      ok: res.ok && Array.isArray(rows) && rows.length > 0,
      status: res.status,
      detail: rows ?? text.slice(0, 160).replace(/\s+/g, " "),
      error: null,
    };
  } catch (e) {
    return fail(`tv:${col}`, e);
  }
}

// 3) Google News RSS untuk rumor korporasi
async function probeNews(): Promise<SourceCheck> {
  try {
    const q = 'akuisisi OR "private placement" OR "investor strategis" saham Tbk when:7d';
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=id&gl=ID&ceid=ID:id`;
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/rss+xml, application/xml, text/xml" } });
    const text = await res.text();
    const titles = [...text.matchAll(/<item>[\s\S]*?<title>([\s\S]*?)<\/title>/g)]
      .map((m) => m[1].replace(/<!\[CDATA\[|\]\]>/g, "").trim())
      .slice(0, 8);
    return {
      name: "gnews_rss",
      ok: res.ok && titles.length > 0,
      status: res.status,
      detail: { itemsSeen: titles.length, titles, sample: titles.length ? undefined : text.slice(0, 150) },
      error: null,
    };
  } catch (e) {
    return fail("gnews_rss", e);
  }
}

export async function probeSources(): Promise<{ results: SourceCheck[] }> {
  const results: SourceCheck[] = [];
  results.push(await probePasardana());
  for (const col of ["close", "market_cap_basic", "debt_to_equity", "total_debt", "total_assets", "float_shares_outstanding", "total_shares_outstanding_fundamental"]) {
    results.push(await tvColumn(col));
  }
  results.push(await probeNews());
  return { results };
}

// ---- Uji RSS media Indonesia (alamat kandidat dari ingatan, belum diverifikasi) dan kolom liabilitas TradingView ----
const RSS_CANDIDATES: string[] = [
  "https://www.cnbcindonesia.com/market/rss",
  "https://rss.kontan.co.id/v3/investasi",
  "https://www.bisnis.com/rss",
  "https://www.antaranews.com/rss/ekonomi.xml",
  "https://rss.tempo.co/bisnis",
  "https://www.cnnindonesia.com/ekonomi/rss",
  "https://feed.liputan6.com/rss/bisnis",
  "https://rss.detik.com/index.php/finance",
  "https://www.idxchannel.com/rss",
  "https://emitennews.com/feed",
];

const RUMOR_RE = /akuisisi|private placement|pengambilalihan|investor strategis|penambahan modal|aksi korporasi|rights issue|masuk investor|ambil alih/i;

async function probeRssOne(url: string): Promise<{ url: string; status: number | null; items: number; hits: number; titles: string[]; error: string | null }> {
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/rss+xml, application/xml, text/xml, */*" } });
    const text = await res.text();
    const titles = [...text.matchAll(/<item[^>]*>[\s\S]*?<title[^>]*>([\s\S]*?)<\/title>/g)]
      .map((m) => m[1].replace(/<!\[CDATA\[|\]\]>/g, "").trim());
    return {
      url,
      status: res.status,
      items: titles.length,
      hits: titles.filter((t) => RUMOR_RE.test(t)).length,
      titles: titles.slice(0, 2),
      error: null,
    };
  } catch (e) {
    return { url, status: null, items: 0, hits: 0, titles: [], error: String(e) };
  }
}

export async function probeRss() {
  const feeds = [];
  for (const u of RSS_CANDIDATES) feeds.push(await probeRssOne(u));
  const liabilityCols: SourceCheck[] = [];
  for (const col of ["total_liabilities_fq", "total_liabilities_fy", "total_equity_fq", "total_current_liabilities_fq", "total_debt_fq"]) {
    liabilityCols.push(await tvColumn(col));
  }
  return { feeds, liabilityCols };
}
