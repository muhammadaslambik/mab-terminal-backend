export interface CryptoPanicNewsItem {
  title: string;
  url: string;
  published_at: string;
  sentiment: string; // bullish, bearish, or neutral
}

export class CryptoPanicFeed {
  private authToken: string;

  constructor(authToken: string) {
    this.authToken = authToken;
  }

  public async fetchCryptoNews(): Promise<CryptoPanicNewsItem[]> {
    if (!this.authToken) return [];
    try {
      // Mengambil umpan berita terhangat/hot filter
      const url = `https://api.cryptopanic.com/api/v1/posts/?auth_token=${this.authToken}&public=true&filter=hot`;
      const response = await fetch(url);
      if (!response.ok) return [];

      const data: any = await response.json();
      if (!data.results) return [];

      return data.results.map((item: any) => {
        let sentiment = "neutral";
        if (item.votes) {
          if (item.votes.bullish > item.votes.bearish) sentiment = "bullish";
          else if (item.votes.bearish > item.votes.bullish) sentiment = "bearish";
        }
        return {
          title: item.title,
          url: item.url,
          published_at: item.published_at,
          sentiment: sentiment
        };
      });
    } catch (error) {
      return [];
    }
  }
}
