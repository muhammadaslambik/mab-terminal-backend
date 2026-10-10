export interface RssNewsItem {
  title: string;
  link: string;
  pubDate: string;
}

export class NewsRssFeed {
  /**
   * Mengambil dan memparsing berita dari umpan RSS Media Finansial makro
   */
  public async fetchRssFeed(rssUrl: string): Promise<RssNewsItem[]> {
    try {
      const response = await fetch(rssUrl, {
        headers: { "User-Agent": "Mozilla/5.0 (Cloudflare Worker)" }
      });
      if (!response.ok) return [];

      const xmlText = await response.text();
      const items: RssNewsItem[] = [];
      
      // Memecah dokumen berdasarkan tag <item>
      const itemMatches = xmlText.split("<item>");
      // Abaikan elemen pertama karena merupakan metadata sebelum list item
      for (let i = 1; i < itemMatches.length; i++) {
        const itemBlock = itemMatches[i].split("</item>")[0];
        
        const titleMatch = itemBlock.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) || itemBlock.match(/<title>(.*?)<\/title>/);
        const linkMatch = itemBlock.match(/<link>(.*?)<\/link>/);
        const pubDateMatch = itemBlock.match(/<pubDate>(.*?)<\/pubDate>/);

        if (titleMatch && linkMatch) {
          items.push({
            title: titleMatch[1].trim(),
            link: linkMatch[1].trim(),
            pubDate: pubDateMatch ? pubDateMatch[1].trim() : new Date().toISOString()
          });
        }
        if (items.length >= 10) break; // Batasi 10 berita teratas demi efisiensi memori
      }
      return items;
    } catch (error) {
      return [];
    }
  }
}
