export class FinnhubFeed {
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  /**
   * Mengambil data harga saham US (Real-time Quote)
   */
  public async getQuote(symbol: string): Promise<number | null> {
    if (!this.apiKey) return null;
    try {
      const response = await fetch(`https://finnhub.io{symbol}&token=${this.apiKey}`);
      if (!response.ok) return null;

      const data: any = await response.json();
      return data.c || null; // 'c' adalah harga penutupan berjalan (current price)
    } catch (error) {
      return null;
    }
  }
}
