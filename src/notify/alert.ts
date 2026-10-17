import { TelegramNotifier } from "./telegram";

/**
 * Saluran peringatan: email via Resend (utama bila terpasang) dan Telegram (cadangan).
 * Email: secret RESEND_API_KEY + ALERT_EMAIL_TO; opsional ALERT_EMAIL_FROM (bawaan onboarding@resend.dev).
 * Paket gratis Resend hanya mengirim ke alamat email yang dipakai mendaftar di Resend.
 */
export type Channel = "email" | "telegram";

export function notificationConfigured(env: any): Channel | null {
  if (env?.RESEND_API_KEY && env?.ALERT_EMAIL_TO) return "email";
  if (env?.TELEGRAM_BOT_TOKEN && env?.TELEGRAM_CHAT_ID) return "telegram";
  return null;
}

export async function sendEmail(env: any, subject: string, text: string): Promise<{ ok: boolean; error: string | null }> {
  const key: string = env?.RESEND_API_KEY ?? "";
  const to: string = env?.ALERT_EMAIL_TO ?? "";
  if (!key || !to) return { ok: false, error: "RESEND_API_KEY atau ALERT_EMAIL_TO belum diset" };
  const clean = (s: string) => s.split(key).join("***").slice(0, 200);
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "User-Agent": "mab-terminal/1.0" },
      body: JSON.stringify({
        from: env?.ALERT_EMAIL_FROM || "MAB-Terminal <onboarding@resend.dev>",
        to: [to],
        subject,
        text,
      }),
    });
    if (!res.ok) return { ok: false, error: clean(`Resend HTTP ${res.status}: ${await res.text()}`) };
    return { ok: true, error: null };
  } catch (e) {
    return { ok: false, error: clean(String(e)) };
  }
}

/** Kirim lewat email; bila gagal atau tidak terpasang, coba Telegram. Tidak pernah melempar galat. */
export async function sendNotification(
  env: any,
  subject: string,
  text: string
): Promise<{ ok: boolean; channel: Channel | null; error: string | null }> {
  const errors: string[] = [];
  if (env?.RESEND_API_KEY && env?.ALERT_EMAIL_TO) {
    const r = await sendEmail(env, subject, text);
    if (r.ok) return { ok: true, channel: "email", error: null };
    errors.push(r.error ?? "email gagal");
  }
  if (env?.TELEGRAM_BOT_TOKEN && env?.TELEGRAM_CHAT_ID) {
    try {
      const tg = new TelegramNotifier(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID);
      if (await tg.sendAlert(text, null)) return { ok: true, channel: "telegram", error: null };
      errors.push(`telegram: ${tg.lastError ?? "gagal"}`);
    } catch (e) {
      errors.push(`telegram: ${String(e).slice(0, 80)}`);
    }
  }
  return { ok: false, channel: null, error: errors.length ? errors.join(" | ") : "tidak ada saluran peringatan yang terpasang" };
}
