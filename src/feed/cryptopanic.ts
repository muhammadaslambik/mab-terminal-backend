import { NewsRssFeed } from "./news_rss";

export interface CryptoPanicNewsItem {
  title: string;
  url: string;
  published_at: string;
  sentiment: string;
}

export class CryptoPanicFeed {
  private rssFeed = new NewsRssFeed();

  /**
   * Mengambil berita crypto terhangat melalui RSS Feed Publik CryptoPanic secara 100% gratis tanpa API Key
   */
  public async fetchCryptoNews(): Promise<CryptoPanicNewsItem[]> {
    try {
      // Menggunakan URL RSS publik resmi dari CryptoPanic
      const publicRssUrl = "https://cryptopanic.com";
      const newsItems = await this.rssFeed.fetchRssFeed(publicRssUrl);
      
      if (!newsItems || newsItems.length === 0) return [];

      return newsItems.map((item) => ({
        title: item.title,
        url: item.link,
        published_at: item.pubDate,
        sentiment: "neutral" // Skoring sentimen default untuk paket gratis RSS
      }));
    } catch (error) {
      return [];
    }
  }
}
