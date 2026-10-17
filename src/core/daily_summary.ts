// Ringkasan harian cacing-naga: bandingkan tingkat hari ini dengan baseline kemarin (KV DAILY_BASELINE).
// Email hanya dikirim bila ada perubahan tingkat, kandidat masuk/keluar, atau data basi. Hari pertama: kirim daftar inti sebagai baseline.
// Hanya membaca cache KV (CACING_SCREEN, CACING_LIQ, INTEL_IDX), tanpa jaringan selain email.
import { judge, type CacingScreen, type IntelItem, type Tier } from "./cacing_screen";
import { liquidityOf } from "../feed/liquidity";

const BASELINE_KEY = "DAILY_BASELINE";
const SCREEN_MAX_AGE_H = 20; // saringan dihitung 01:00 UTC; ringkasan jalan 14:00 UTC (normal ±13 jam)
const LIQ_MAX_AGE_H = 20; // likuiditas dihitung tepat sebelum ringkasan (normal ±0 jam)
// Ambang "mendekati batas" hanyalah tebakan awal, hanya keterangan
const NEAR_DROP = -0.4;
const NEAR_CAP_BN = 475;

interface Row {
  tier: Tier;
  reasons: string[];
  oneYear: number | null;
  marketCapBn: number;
}

const ageH = (iso: string | null | undefined, now: number) => (iso ? (now - Date.parse(iso)) / 3600000 : Infinity);

export async function runDailySummary(env: any, now = new Date()): Promise<{ sent: boolean; reason: string }> {
  const kv = env?.KV_CACHE;
  if (!kv) return { sent: false, reason: "KV tidak ada" };
  const screen: CacingScreen | null = await kv.get("CACING_SCREEN", "json");
  if (!screen) return { sent: false, reason: "CACING_SCREEN kosong" };
  const rawSnap: any = await kv.get("CACING_LIQ", "json");
  const snap = rawSnap && rawSnap.v === 3 ? rawSnap : null;
  const intelDoc: any = await kv.get("INTEL_IDX", "json");
  const baseline: any = await kv.get(BASELINE_KEY, "json");

  const intelBy = new Map<string, IntelItem>();
  for (const it of (intelDoc?.items ?? []) as IntelItem[]) if (it?.code) intelBy.set(it.code, it);
  const liqs = screen.candidates.map((c) => liquidityOf(snap, c.code, now));
  const unitOk = liqs.every((l: any) => l.oneYear === null || l.oneYear >= -1);

  const rows: Record<string, Row> = {};
  screen.candidates.forEach((c, i) => {
    const oneYear: number | null = (liqs[i] as any).oneYear ?? null;
    const j = judge(intelBy.get(c.code) ?? null, oneYear, unitOk);
    rows[c.code] = { tier: j.tier, reasons: j.reasons, oneYear, marketCapBn: c.marketCapBn };
  });

  const nowMs = now.getTime();
  const stale: string[] = [];
  if (ageH(screen.computedAt, nowMs) > SCREEN_MAX_AGE_H) stale.push(`saringan TradingView terakhir dihitung ${screen.computedAt}`);
  if (!snap) stale.push("snapshot likuiditas tidak ada/versi lama");
  else if (ageH(snap.computedAt, nowMs) > LIQ_MAX_AGE_H) stale.push(`likuiditas Pasardana terakhir dihitung ${snap.computedAt}`);
  if (!unitOk) stale.push("satuan return 1 tahun janggal, aturan harga tidak diterapkan");

  const prev: Record<string, { tier: Tier; reasons: string[] }> | null = baseline?.tiers ?? null;
  const changes: string[] = [];
  if (prev) {
    for (const [code, r] of Object.entries(rows)) {
      const p = prev[code];
      const why = r.reasons.length ? ` (${r.reasons.join("; ")})` : "";
      if (!p) changes.push(`${code}: BARU di saringan, tingkat ${r.tier}${why}`);
      else if (p.tier !== r.tier) changes.push(`${code}: ${p.tier} -> ${r.tier}${why}`);
    }
    for (const [code, p] of Object.entries(prev)) {
      if (!rows[code]) changes.push(`${code}: KELUAR dari saringan (kapitalisasi/DER berubah), tadi ${p.tier}`);
    }
  }

  const inti = Object.entries(rows).filter(([, r]) => r.tier === "inti");
  const near = inti
    .filter(([, r]) => (r.oneYear !== null && r.oneYear <= NEAR_DROP) || r.marketCapBn >= NEAR_CAP_BN)
    .map(([code, r]) => `${code}: kap Rp${r.marketCapBn} M, return 1 th ${r.oneYear === null ? "?" : Math.round(r.oneYear * 100) + "%"}`);

  const first = !prev;
  if (!first && changes.length === 0 && stale.length === 0) return { sent: false, reason: "tidak ada perubahan" };

  const wib = new Date(nowMs + 7 * 3600000).toISOString().slice(0, 10);
  const parts: string[] = [`Ringkasan cacing-naga ${wib} (WIB)`, `Inti: ${inti.length} | gugur: ${Object.values(rows).filter((r) => r.tier === "gugur").length} | belum_ada_intel: ${Object.values(rows).filter((r) => r.tier === "belum_ada_intel").length}`];
  if (first) parts.push("", "Baseline pertama (belum ada pembanding kemarin). Inti: " + (inti.map(([c]) => c).join(", ") || "-"));
  if (changes.length) parts.push("", "PERUBAHAN:", ...changes.map((x) => "- " + x));
  if (stale.length) parts.push("", "DATA BASI/JANGGAL:", ...stale.map((x) => "- " + x));
  if (near.length) parts.push("", "Inti mendekati batas (ambang tebakan awal):", ...near.map((x) => "- " + x));
  parts.push("", "Daftar pantauan, bukan sinyal beli. Baca pengumuman asli sebelum bertindak.");

  const { notificationConfigured, sendNotification } = await import("../notify/alert");
  if (!notificationConfigured(env)) return { sent: false, reason: "saluran email belum dikonfigurasi" };
  const r: any = await sendNotification(env, `MAB-Terminal: ringkasan cacing-naga ${wib}`, parts.join("\n"));
  if (!r?.ok) return { sent: false, reason: "pengiriman email gagal" };

  const tiers: Record<string, { tier: Tier; reasons: string[] }> = {};
  for (const [code, r2] of Object.entries(rows)) tiers[code] = { tier: r2.tier, reasons: r2.reasons };
  await kv.put(BASELINE_KEY, JSON.stringify({ savedAt: now.toISOString(), tiers }));
  return { sent: true, reason: first ? "baseline pertama" : "ada perubahan/data basi" };
}
