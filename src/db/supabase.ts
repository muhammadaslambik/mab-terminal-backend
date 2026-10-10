export class SupabaseDatabase {
  private url: string;
  private apiKey: string;

  constructor(url: string, apiKey: string) {
    this.url = url;
    this.apiKey = apiKey;
  }

  /**
   * Menyimpan log sinyal trading hasil kalkulasi bot ke tabel database Supabase
   */
  public async logSignal(signalData: any): Promise<boolean> {
    if (!this.url || !this.apiKey) return false;

    try {
      const response = await fetch(`${this.url}/rest/v1/trading_signals`, {
        method: "POST",
        headers: {
          "apikey": this.apiKey,
          "Authorization": `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          "Prefer": "return=minimal"
        },
        body: JSON.stringify({
          asset: signalData.asset,
          action: signalData.status,
          price: signalData.price,
          details: JSON.stringify(signalData.details),
          created_at: new Date().toISOString()
        })
      });

      return response.ok;
    } catch (error) {
      return false;
    }
  }
}
