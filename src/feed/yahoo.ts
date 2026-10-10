export interface MarketDataSummary {
  symbol: string;
  price: number;
  high: number;
  low: number;
  close: number;
}

export class YahooFeed {
  /**
   * Mengambil ringkasan harga menggunakan query v8 yahoo finance api publik
   */
  public async getTickerSummary(symbol: string): Promise<MarketDataSummary | null> {
    try {
      const url = `https://yahoo.com{symbol}?interval=1d&range=1d`;
      const response = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0' } // Mengelabui filter rate limit
      });

      if (!response.ok) return null;

      const data: any = await response.json();
      const result = data.chart.result[0];
      const indicators = result.indicators.quote[0];

      return {
        symbol: result.meta.symbol,
        price: result.meta.regularMarketPrice,
        high: indicators.high[0] || result.meta.regularMarketPrice,
        low: indicators.low[0] || result.meta.regularMarketPrice,
        close: indicators.close[0] || result.meta.regularMarketPrice
      };
    } catch (error) {
      return null; // Return null jika pasar tutup di akhir pekan
    }
  }
}
