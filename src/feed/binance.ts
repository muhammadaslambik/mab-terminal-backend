import type { Candle } from "../engines/types";

export interface CryptoPriceData {
  symbol: string;
  price: number;
  timestamp: number;
}

export type KlineInterval = "1h" | "4h" | "1d" | "1w";

export class BinanceFeed {
  // data-api.binance.vision = endpoint data pasar publik (tanpa API key), lebih jarang diblokir per wilayah.
  // api.binance.com sebagai cadangan.
  private bases = ["https://data-api.binance.vision", "https://api.binance.com"];

  /** BTC -> BTCUSDT */
  private toPair(symbol: string): string {
    const s = symbol.toUpperCase();
    return s.endsWith("USDT") ? s : `${s}USDT`;
  }

  private async request(path: string): Promise<any | null> {
    for (const base of this.bases) {
      try {
        const res = await fetch(`${base}${path}`);
        if (res.ok) return await res.json();
      } catch {
        // coba base URL berikutnya
      }
    }
    return null;
  }

  /** Harga spot terkini untuk BTC, ETH, PAXG, dst. */
  public async getPrice(symbol: string): Promise<CryptoPriceData | null> {
    const data = await this.request(`/api/v3/ticker/price?symbol=${this.toPair(symbol)}`);
    if (!data || data.price === undefined) return null;
    const price = parseFloat(data.price);
    return Number.isFinite(price) ? { symbol: data.symbol, price, timestamp: Date.now() } : null;
  }

  /**
   * Candle OHLCV (lama -> baru). Secara default candle yang masih berjalan dibuang,
   * supaya sinyal dihitung dari candle yang sudah tutup dan tidak berubah-ubah.
   */
  public async getCandles(symbol: string, interval: KlineInterval = "1d", limit = 300, includeOpen = false): Promise<Candle[]> {
    const data = await this.request(`/api/v3/klines?symbol=${this.toPair(symbol)}&interval=${interval}&limit=${limit}`);
    if (!Array.isArray(data)) return [];
    const now = Date.now();
    return data
      .filter((k: any[]) => includeOpen || Number(k[6]) < now) // k[6] = waktu tutup candle
      .map((k: any[]) => ({
        time: new Date(Number(k[0])).toISOString(),
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        close: parseFloat(k[4]),
        volume: parseFloat(k[5]),
      }));
  }
}
