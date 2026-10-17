export class TelegramNotifier {
  private botToken: string;
  private chatId: string;
  /** Penyebab kegagalan kirim terakhir (token tidak pernah ikut tertulis). */
  public lastError: string | null = null;

  constructor(botToken: string, chatId: string) {
    this.botToken = botToken;
    this.chatId = chatId;
  }

  /**
   * Kirim pesan ke chat Telegram. parseMode "Markdown" (bawaan, kompatibel dengan pemanggil lama)
   * atau null untuk teks polos (aman untuk judul berita yang memuat _ * ` [).
   */
  public async sendAlert(message: string, parseMode: "Markdown" | null = "Markdown"): Promise<boolean> {
    this.lastError = null;
    if (!this.botToken || !this.chatId) {
      this.lastError = "token atau chat id kosong";
      return false;
    }
    try {
      const body: Record<string, unknown> = {
        chat_id: this.chatId,
        text: message.length > 4000 ? message.slice(0, 3990) + "..." : message,
        disable_web_page_preview: true,
      };
      if (parseMode) body.parse_mode = parseMode;
      const res = await fetch(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const text = (await res.text()).slice(0, 120);
        this.lastError = `HTTP ${res.status}: ${text}`.split(this.botToken).join("***");
        return false;
      }
      return true;
    } catch (e) {
      this.lastError = String(e).split(this.botToken).join("***").slice(0, 160);
      return false;
    }
  }
}

export interface TelegramChat {
  id: number | string;
  type: string;
  name: string;
}

/**
 * Bantu menemukan chat id: memeriksa token (getMe) lalu membaca pesan yang pernah dikirim ke bot (getUpdates).
 * Token tidak pernah ikut keluar di hasil maupun galat.
 */
export async function discoverTelegramChats(
  botToken: string,
  fetchFn: typeof fetch = fetch
): Promise<{ ok: boolean; bot: string | null; chats: TelegramChat[]; hint: string | null; error: string | null }> {
  const clean = (s: string) => s.split(botToken).join("***").slice(0, 160);
  const call = async (method: string) => {
    const res = await fetchFn(`https://api.telegram.org/bot${botToken}/${method}`);
    const text = await res.text();
    let j: any = null;
    try {
      j = JSON.parse(text);
    } catch {
      /* bukan JSON */
    }
    return { status: res.status, j, text };
  };
  const fail = (error: string) => ({ ok: false, bot: null as string | null, chats: [] as TelegramChat[], hint: null as string | null, error: clean(error) });
  try {
    const me = await call("getMe");
    if (!me.j?.ok) return fail(`getMe HTTP ${me.status}: ${me.j?.description ?? me.text}`);
    const bot: string | null = me.j.result?.username ?? null;
    const up = await call("getUpdates");
    if (!up.j?.ok) return { ...fail(`getUpdates HTTP ${up.status}: ${up.j?.description ?? up.text}`), bot };
    const seen = new Map<string, TelegramChat>();
    for (const u of (up.j.result ?? []) as any[]) {
      const chat = u.message?.chat ?? u.edited_message?.chat ?? u.channel_post?.chat ?? u.my_chat_member?.chat;
      if (chat?.id === undefined || seen.has(String(chat.id))) continue;
      const name: string = chat.title ?? ([chat.first_name, chat.last_name].filter(Boolean).join(" ") || chat.username || "");
      seen.set(String(chat.id), { id: chat.id, type: chat.type ?? "", name });
    }
    const chats = Array.from(seen.values());
    return { ok: true, bot, chats, hint: chats.length === 0 ? `Belum ada pesan untuk bot. Kirim satu pesan apa saja ke @${bot} di Telegram, lalu ulangi.` : null, error: null };
  } catch (e) {
    return fail(String(e));
  }
}
