export interface CryptoPriceData {
  symbol: string;
  price: number;
  timestamp: number;
}

export class BinanceFeed {
  private baseUrl = "https://binance.com";

  /**
   * Mengambil data harga aktual spot untuk BTC, ETH, atau PAXG
   */
  public async getPrice(symbol: string): Promise<CryptoPriceData | null> {
    try {
      // Mengubah format (misal BTC -> BTCUSDT)
      const pair = symbol.endsWith("USDT") ? symbol : `${symbol}USDT`;
      const response = await fetch(`${this.baseUrl}/ticker/price?symbol=${pair}`);
      
      if (!response.ok) return null;
      
      const data: any = await response.json();
      return {
        symbol: data.symbol,
        price: parseFloat(data.price),
        timestamp: Date.now()
      };
    } catch (error) {
      return null; // Fallback jika API bermasalah atau akhir pekan
    }
  }
}
