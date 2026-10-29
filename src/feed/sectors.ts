// Rotasi sektor: ETF sektor AS, ETF negara/obligasi, dan sektor IDX dari TradingView scanner.
// 3 subrequest per build, cache memori 30 dtk, tanpa KV.
// Catatan: ini perubahan HARGA (bukan arus dana). Sektor IDX = rata-rata tertimbang kapitalisasi.

const SCAN = "https://scanner.tradingview.com";

const US: [string, string][] = [
  ["AMEX:XLK", "Teknologi"], ["AMEX:XLF", "Keuangan"], ["AMEX:XLE", "Energi"], ["AMEX:XLV", "Kesehatan"],
  ["AMEX:XLY", "Konsumer siklikal"], ["AMEX:XLP", "Konsumer pokok"], ["AMEX:XLI", "Industri"], ["AMEX:XLU", "Utilitas"],
  ["AMEX:XLB", "Bahan baku"], ["AMEX:XLRE", "Properti"], ["AMEX:XLC", "Komunikasi"],
];
const WORLD: [string, string][] = [
  ["AMEX:EWJ", "Jepang"], ["AMEX:FXI", "China"], ["AMEX:EWZ", "Brasil"], ["AMEX:EWG", "Jerman"], ["AMEX:EWU", "Inggris"],
  ["AMEX:EWY", "Korea Selatan"], ["AMEX:EWT", "Taiwan"], ["AMEX:EIDO", "Indonesia"],
  ["NASDAQ:TLT", "Obligasi AS 20+ th"], ["NASDAQ:IEF", "Obligasi AS 7-10 th"],
];

const num = (v: any): number | null => (typeof v === "number" && isFinite(v) ? v : null);

async function scan(market: string, body: any): Promise<{ data: { s: string; d: any[] }[] }> {
  const r = await fetch(`${SCAN}/${market}/scan`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()) as any;
}

async function etfs(list: [string, string][]) {
  const j = await scan("america", {
    symbols: { tickers: list.map((x) => x[0]) },
    columns: ["name", "close", "change", "Perf.W", "Perf.1M", "Perf.3M", "Perf.YTD"],
  });
  const by = new Map(j.data.map((x) => [x.s, x.d]));
  return list
    .map(([s, label]) => {
      const d = by.get(s);
      if (!d) return null;
      return { t: String(d[0]), name: label, close: num(d[1]), d1: num(d[2]), w1: num(d[3]), m1: num(d[4]), m3: num(d[5]), ytd: num(d[6]) };
    })
    .filter(Boolean);
}

async function idxSectors() {
  const j = await scan("indonesia", {
    columns: ["name", "sector", "market_cap_basic", "change", "Perf.W", "Perf.1M"],
    range: [0, 1000],
    sort: { sortBy: "market_cap_basic", sortOrder: "desc" },
  });
  const g = new Map<string, any>();
  for (const x of j.data) {
    const sec = x.d[1];
    const mc = num(x.d[2]);
    if (!sec || !mc || mc <= 0) continue;
    let a = g.get(sec);
    if (!a) g.set(sec, (a = { sector: sec, n: 0, mcap: 0, s: [0, 0, 0], w: [0, 0, 0] }));
    a.n++;
    a.mcap += mc;
    [3, 4, 5].forEach((k, i) => {
      const v = num(x.d[k]);
      if (v !== null) {
        a.s[i] += v * mc;
        a.w[i] += mc;
      }
    });
  }
  return Array.from(g.values())
    .map((a) => ({
      sector: a.sector as string,
      n: a.n as number,
      mcap: a.mcap as number,
      d1: a.w[0] ? a.s[0] / a.w[0] : null,
      w1: a.w[1] ? a.s[1] / a.w[1] : null,
      m1: a.w[2] ? a.s[2] / a.w[2] : null,
    }))
    .sort((p, q) => q.mcap - p.mcap);
}

let memo: { at: number; data: any } | null = null;

export async function loadSectors(_env?: any): Promise<any> {
  if (memo && Date.now() - memo.at < 30_000) return memo.data;
  const errors: string[] = [];
  const [us, world, idx] = await Promise.all([
    etfs(US).catch((e) => (errors.push("us: " + String(e)), [])),
    etfs(WORLD).catch((e) => (errors.push("world: " + String(e)), [])),
    idxSectors().catch((e) => (errors.push("idx: " + String(e)), [])),
  ]);
  const data = {
    updatedAt: new Date().toISOString(),
    note: "Perubahan harga (bukan arus dana). Sektor IDX = rata-rata tertimbang kapitalisasi, klasifikasi TradingView.",
    us,
    world,
    idx,
    errors,
  };
  if (us.length || world.length || idx.length) memo = { at: Date.now(), data };
  return data;
}
