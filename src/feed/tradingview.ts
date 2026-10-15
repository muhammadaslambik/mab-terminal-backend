// Data keuangan seluruh pasar IDX dari scanner TradingView (tanpa idx.co.id).
// Angka total liabilitas dan ekuitas terbukti identik dengan laporan IDX (uji IGAR, Okt 2026).

export interface TvRow {
  code: string;
  name: string | null;
  type: string | null;
  close: number | null;
  marketCap: number | null;
  liabilities: number | null;
  equity: number | null;
  assets: number | null;
  shares: number | null;
  floatShares: number | null;
}

const URL_SCAN = "https://scanner.tradingview.com/indonesia/scan";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const COLUMNS = [
  "description",
  "type",
  "close",
  "market_cap_basic",
  "total_liabilities_fq",
  "total_equity_fq",
  "total_assets",
  "total_shares_outstanding_fundamental",
  "float_shares_outstanding",
];
const PAGE = 500;
const MAX_PAGES = 4; // batas subrequest

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

export async function fetchTvRows(fetchFn: typeof fetch = fetch): Promise<TvRow[]> {
  const out: TvRow[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await fetchFn(URL_SCAN, {
      method: "POST",
      headers: {
        "User-Agent": UA,
        "Content-Type": "application/json",
        Accept: "application/json",
        Origin: "https://www.tradingview.com",
        Referer: "https://www.tradingview.com/",
      },
      body: JSON.stringify({
        columns: COLUMNS,
        range: [page * PAGE, (page + 1) * PAGE],
        sort: { sortBy: "market_cap_basic", sortOrder: "asc" },
        options: { lang: "id" },
      }),
    });
    if (!res.ok) throw new Error(`TradingView HTTP ${res.status}`);
    const j: any = await res.json();
    const data: any[] = Array.isArray(j?.data) ? j.data : [];
    for (const r of data) {
      const d: unknown[] = Array.isArray(r?.d) ? r.d : [];
      out.push({
        code: String(r?.s ?? "").replace(/^IDX:/, "").trim(),
        name: str(d[0]),
        type: str(d[1]),
        close: num(d[2]),
        marketCap: num(d[3]),
        liabilities: num(d[4]),
        equity: num(d[5]),
        assets: num(d[6]),
        shares: num(d[7]),
        floatShares: num(d[8]),
      });
    }
    if (data.length < PAGE) break;
  }
  return out.filter((r) => r.code.length > 0);
}
