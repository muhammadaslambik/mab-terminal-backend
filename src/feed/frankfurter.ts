export class FrankfurterFeed {
  /**
   * Mendapatkan konversi valuta asing dasar
   */
  public async getLatestRate(from: string = "USD", to: string = "IDR"): Promise<number | null> {
    try {
      const response = await fetch(`https://frankfurter.app{from}&to=${to}`);
      if (!response.ok) return null;

      const data: any = await response.json();
      return data.rates[to] || null;
    } catch (error) {
      return null;
    }
  }
}
