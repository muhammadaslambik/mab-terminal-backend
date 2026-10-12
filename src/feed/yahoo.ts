import type { Candle } from "../engines/types";

export interface MarketDataSummary {
  symbol: string;
  price: number;
  high: number;
  low: number;
  close: number;
}

// Endpoint chart v8 Yahoo Finance (tanpa API key). Tidak resmi, jadi dua host dicoba bergantian.
const HOSTS = ["https://query1.finance.yahoo.com", "https://query2.finance.yahoo.com"];
const HEADERS: Record<string, string> = {
  Accept: "application/json",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
};

const lastNumber = (a: unknown): number | undefined => {
  if (!Array.isArray(a)) return undefined;
  for (let i = a.length - 1; i >= 0; i--) if (typeof a[i] === "number") return a[i];
  return undefined;
};

export class YahooFeed {
  private async chart(symbol: string, range: string, interval: string): Promise<any | null> {
    for (const host of HOSTS) {
      try {
        const url = `${host}/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`;
        const res = await fetch(url, { headers: HEADERS });
        if (!res.ok) continue;
        const data: any = await res.json();
        const result = data?.chart?.result?.[0];
        if (result) return result;
      } catch {
        // coba host berikutnya
      }
    }
    return null;
  }

  /** Ringkasan harga terkini, mis. "GC=F" (emas futures) atau "BBCA.JK". null jika gagal / pasar tutup. */
  public async getTickerSummary(symbol: string): Promise<MarketDataSummary | null> {
    const r = await this.chart(symbol, "1d", "1d");
    if (!r) return null;
    const price = r.meta?.regularMarketPrice;
    if (typeof price !== "number") return null;
    const q = r.indicators?.quote?.[0] ?? {};
    return {
      symbol: r.meta.symbol ?? symbol,
      price,
      high: lastNumber(q.high) ?? price,
      low: lastNumber(q.low) ?? price,
      close: lastNumber(q.close) ?? price,
    };
  }

  /**
   * Candle OHLCV (lama -> baru), mis. getCandles("BBCA.JK", "1y", "1d").
   * Baris kosong (libur/NaN) dibuang. Candle harian hari ini yang belum tutup juga dibuang,
   * supaya sinyal dihitung dari candle yang sudah final.
   */
  public async getCandles(symbol: string, range = "1y", interval = "1d", includeOpen = false): Promise<Candle[]> {
    const r = await this.chart(symbol, range, interval);
    const ts: unknown = r?.timestamp;
    const q = r?.indicators?.quote?.[0];
    if (!Array.isArray(ts) || !q) return [];

    const out: Candle[] = [];
    for (let i = 0; i < ts.length; i++) {
      const o = q.open?.[i];
      const h = q.high?.[i];
      const l = q.low?.[i];
      const c = q.close?.[i];
      const v = q.volume?.[i];
      if ([o, h, l, c].some((x) => typeof x !== "number")) continue;
      out.push({ time: new Date(Number(ts[i]) * 1000).toISOString(), open: o, high: h, low: l, close: c, volume: typeof v === "number" ? v : 0 });
    }

    const session = r?.meta?.currentTradingPeriod?.regular;
    if (!includeOpen && (interval === "1d" || interval === "1wk") && session && out.length) {
      const lastTs = Date.parse(out[out.length - 1].time) / 1000;
      const nowS = Date.now() / 1000;
      if (lastTs >= session.start && nowS < session.end) out.pop(); // sesi hari ini masih berjalan
    }
    return out;
  }

  /** Diagnosa: status HTTP dan ringkasan data untuk satu simbol. */
  public async probe(symbol = "BBCA.JK") {
    const url = `${HOSTS[0]}/v8/finance/chart/${encodeURIComponent(symbol)}?range=1mo&interval=1d`;
    try {
      const res = await fetch(url, { headers: HEADERS });
      const text = await res.text();
      let json: any = null;
      try {
        json = JSON.parse(text);
      } catch {
        /* bukan JSON */
      }
      const result = json?.chart?.result?.[0];
      const candles = await this.getCandles(symbol, "1mo", "1d");
      return {
        ok: res.ok,
        status: res.status,
        symbol: result?.meta?.symbol,
        currency: result?.meta?.currency,
        exchange: result?.meta?.exchangeName,
        candleCount: candles.length,
        lastCandle: candles[candles.length - 1],
        error: json?.chart?.error,
        bodyPreview: json ? undefined : text.slice(0, 300),
      };
    } catch (err) {
      return { ok: false, status: 0, error: String(err) };
    }
  }
}
