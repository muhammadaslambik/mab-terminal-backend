export class TelegramNotifier {
  private botToken: string;
  private chatId: string;

  constructor(botToken: string, chatId: string) {
    this.botToken = botToken;
    this.chatId = chatId;
  }

  /**
   * Mengirimkan pesan alert instan ke grup/chat Telegram pribadi Anda
   */
  public async sendAlert(message: string): Promise<boolean> {
    if (!this.botToken || !this.chatId) return false;

    try {
      const url = `https://telegram.org{this.botToken}/sendMessage`;
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: this.chatId,
          text: message,
          parse_mode: "Markdown"
        })
      });

      return response.ok;
    } catch (error) {
      return false;
    }
  }
}
