// Diagnosa sumber data pasar global dari Worker produksi (bukan dari PC rumah).
// Hanya membaca. Tiap grup <= 8 fetch supaya aman terhadap batas 50 subrequest. Bukan jaminan data selalu tersedia.
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

export const PROBE_GROUPS: Record<string, string[]> = {
  index: ["^JKSE", "^GSPC", "^IXIC", "^STOXX50E", "000001.SS", "^N225", "^BSESN", "^BVSP"],
  fx: ["USDIDR=X", "EURUSD=X", "JPY=X", "DX-Y.NYB"],
  cmdty: ["GC=F", "CL=F", "SI=F", "^TNX"],
  crypto: ["BTC-USD", "ETH-USD", "SOL-USD"],
  us: ["AAPL", "NVDA", "MSFT", "TSLA", "AMZN"],
  id: ["BBCA.JK", "BBRI.JK", "BMRI.JK", "TLKM.JK", "ASII.JK", "GOTO.JK"],
};

const num = (v: unknown): number | null => (typeof v === "number" && isFinite(v) ? v : null);
const r4 = (v: number) => Math.round(v * 10000) / 10000;

async function probeYahoo(symbol: string): Promise<Record<string, unknown>> {
  const t0 = Date.now();
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=5d&interval=1d`;
    const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
    const ms = Date.now() - t0;
    if (!r.ok) return { symbol, ok: false, status: r.status, ms };
    const j: any = await r.json();
    const res = j?.chart?.result?.[0];
    if (!res) return { symbol, ok: false, status: r.status, error: String(j?.chart?.error?.description ?? "tanpa result").slice(0, 120), ms };
    const m = res.meta ?? {};
    const closes: unknown[] = res.indicators?.quote?.[0]?.close ?? [];
    const valid = closes.filter((c): c is number => num(c) !== null);
    const price = num(m.regularMarketPrice);
    const last = valid.length >= 2 ? valid[valid.length - 1] : null;
    const prev = valid.length >= 2 ? valid[valid.length - 2] : null;
    const t = num(m.regularMarketTime);
    return {
      symbol,
      ok: price !== null,
      status: r.status,
      price,
      changePct1d: last !== null && prev !== null && prev !== 0 ? r4((last / prev - 1) * 100) : null,
      currency: m.currency ?? null,
      exchange: m.exchangeName ?? null,
      type: m.instrumentType ?? null,
      asOf: t !== null ? new Date(t * 1000).toISOString() : null,
      ageHours: t !== null ? Math.round(((Date.now() - t * 1000) / 3600000) * 10) / 10 : null,
      points: valid.length,
      ms,
    };
  } catch (e) {
    return { symbol, ok: false, error: String(e).slice(0, 120), ms: Date.now() - t0 };
  }
}

async function probeTv(): Promise<Record<string, unknown>> {
  const tickers = ["TVC:ID10Y", "TVC:US10Y", "TVC:DXY", "FX_IDC:USDIDR", "OANDA:XAUUSD"];
  const t0 = Date.now();
  try {
    const r = await fetch("https://scanner.tradingview.com/global/scan", {
      method: "POST",
      headers: { "content-type": "application/json", "User-Agent": UA },
      body: JSON.stringify({ symbols: { tickers }, columns: ["name", "close", "change", "description"] }),
    });
    const ms = Date.now() - t0;
    if (!r.ok) return { ok: false, status: r.status, ms };
    const j: any = await r.json();
    const rows = (Array.isArray(j?.data) ? j.data : []).map((x: any) => ({
      symbol: x?.s,
      name: x?.d?.[0] ?? null,
      close: num(x?.d?.[1]),
      changePct: num(x?.d?.[2]),
      description: x?.d?.[3] ?? null,
    }));
    return { ok: rows.length > 0, status: r.status, asked: tickers.length, got: rows.length, rows, ms };
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 120), ms: Date.now() - t0 };
  }
}

export async function probeMarket(group: string | null) {
  const generatedAt = new Date().toISOString();
  const note = "Diagnosa dari Worker produksi. Hanya membaca; bukan jaminan data selalu tersedia atau terbaru.";
  if (group === "tv") return { generatedAt, group, result: await probeTv(), note };
  const syms = group ? PROBE_GROUPS[group] : undefined;
  if (!syms) return { generatedAt, error: "Pilih group", groups: [...Object.keys(PROBE_GROUPS), "tv"], note };
  const results = await Promise.all(syms.map((s) => probeYahoo(s)));
  return { generatedAt, group, ok: results.filter((x) => x.ok === true).length, total: results.length, results, note };
}
