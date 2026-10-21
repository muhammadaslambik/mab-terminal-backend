// Terjemahan judul lewat Workers AI (binding "AI"). Tahap uji: rute /api/market/translate-probe.
const MODEL = "@cf/meta/m2m100-1.2b";

export async function translateOne(env: any, text: string, from = "en", to = "id"): Promise<string> {
  const r: any = await env.AI.run(MODEL, { text, source_lang: from, target_lang: to });
  const out = r?.translated_text;
  if (typeof out !== "string" || !out.trim()) throw new Error("hasil kosong");
  return out.trim();
}

const SAMPLES = [
  "Gold edges higher as traders weigh Fed rate cut bets",
  "Bitcoin slips below $70,000 as ETF outflows continue",
  "Wall Street closes mixed after tech earnings disappoint",
];

export async function probeTranslate(env: any): Promise<Record<string, unknown>> {
  if (!env?.AI) return { ok: false, error: 'binding "AI" tidak terpasang (cek wrangler.toml)', model: MODEL };
  const results: { src: string; out: string | null; ms: number; error: string | null }[] = [];
  for (const src of SAMPLES) {
    const t0 = Date.now();
    try {
      const out = await translateOne(env, src);
      results.push({ src, out, ms: Date.now() - t0, error: null });
    } catch (e) {
      results.push({ src, out: null, ms: Date.now() - t0, error: String(e).slice(0, 160) });
    }
  }
  return { ok: results.every((r) => r.error === null), model: MODEL, results, note: "Uji manual. Kuota Workers AI gratis harian belum diketahui." };
}
