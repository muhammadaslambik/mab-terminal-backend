import { composition, INTEL_SCHEMA, type CacingScreen, type IntelItem } from "../core/cacing_screen";

/**
 * Intel idx.co.id hasil kolektor (KV INTEL_IDX) untuk satu emiten, siap dipakai analisa.
 * Hanya intel skema terbaru yang dipercaya. DER tersedia walau komposisi pemegang saham tidak lengkap
 * (DER berasal dari laporan keuangan); persen publik/owner hanya bila komposisi lengkap.
 */
export interface IdxIntelView {
  code: string;
  fsDate: string | null;
  receivedAt: string | null;
  der?: number;
  publicPct?: number; // persen saham beredar (tanpa treasury), dasar aturan float 30%
  ownerPct?: number;
  treasuryPct?: number;
  marketCapRp?: number; // dari saringan TradingView (Rupiah penuh)
  complete: boolean;
  announcements: Array<{ date: string; level: string; title: string; pdf: string | null }>;
}

export async function loadIdxIntel(env: any, code: string): Promise<IdxIntelView | null> {
  const kv = env?.KV_CACHE;
  if (!kv) return null;
  const doc: any = await kv.get("INTEL_IDX", "json");
  const item: IntelItem | undefined = ((doc?.items ?? []) as IntelItem[]).find((i) => i?.code === code);
  if (!item || item.schema !== INTEL_SCHEMA) return null;

  const screen: CacingScreen | null = await kv.get("CACING_SCREEN", "json");
  const cand = screen?.candidates?.find((c) => c.code === code);
  const comp = item.complete === true ? composition(item) : null;
  return {
    code,
    fsDate: item.fsDate ?? null,
    receivedAt: item.receivedAt ?? null,
    der: typeof item.der === "number" ? item.der : undefined,
    publicPct: comp?.publicPct,
    ownerPct: comp?.ownerPct,
    treasuryPct: typeof item.treasuryPct === "number" ? item.treasuryPct : undefined,
    marketCapRp: cand ? cand.marketCapBn * 1e9 : undefined,
    complete: item.complete === true,
    announcements: (item.announcements ?? []).map((a) => ({ date: String(a.date).slice(0, 10), level: a.level, title: a.title, pdf: a.pdf ?? null })),
  };
}
