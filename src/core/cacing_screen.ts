import { fetchTvRows, type TvRow } from "../feed/tradingview";
import {
  collectLiquidity,
  liquidityOf,
  MIN_DAILY_VALUE_IDR,
  type LiquidityInfo,
  type LiquidityStatus,
  type LiquiditySnapshot,
} from "../feed/liquidity";

// Konstanta samakan dengan an4_andry_hakim.ts (v2 cacing-naga)
export const DER_MAX = 0.1; // total liabilitas / ekuitas (definisi IDX)
export const MARKET_CAP_MAX = 500_000_000_000; // Rp500 miliar, strict (<)
// Float TradingView TIDAK dipakai menyaring: ukurannya berbeda dari "Non Warkat" IDX dan meleset ke dua arah (selisih terukur -16 s.d. +31 poin).
// Kapitalisasi dan DER dari TradingView terbukti identik dengan IDX; keputusan float diserahkan ke data IDX (intel).
export const FLOAT_MAX_TV: number | null = null;
export const FLOAT_GAP_FLAG_PCT = 10; // selisih antar-sumber float di atas ini diberi tanda (ambang awal)

export interface CacingCandidate {
  code: string;
  name: string | null;
  close: number | null;
  marketCapBn: number;
  derIdx: number;
  floatPct: number | null; // float TradingView, hanya informasi
  liabilitiesBn: number;
  equityBn: number;
  pbv: number;
  navPerShare: number;
  priceToNav: number | null;
}

export interface CacingScreen {
  computedAt: string;
  source: "tradingview";
  params: { derMax: number; marketCapMaxBn: number; floatMaxPct: number | null };
  totals: { rows: number; stocks: number; passed: number };
  typesSeen: Record<string, number>;
  dropped: { notStock: number; noData: number; equityNonPositive: number; marketCap: number; der: number };
  candidates: CacingCandidate[];
  note: string;
}

const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;

export function screenCacingNaga(rows: TvRow[], now = new Date()): CacingScreen {
  const dropped = { notStock: 0, noData: 0, equityNonPositive: 0, marketCap: 0, der: 0 };
  const typesSeen: Record<string, number> = {};
  const candidates: CacingCandidate[] = [];
  let stocks = 0;

  for (const r of rows) {
    const t = r.type ?? "null";
    typesSeen[t] = (typesSeen[t] ?? 0) + 1;
    if (r.type !== null && r.type !== "stock") {
      dropped.notStock++;
      continue;
    }
    stocks++;
    if (r.marketCap === null || r.liabilities === null || r.equity === null || r.shares === null || r.shares <= 0) {
      dropped.noData++;
      continue;
    }
    if (r.equity <= 0) {
      dropped.equityNonPositive++;
      continue;
    }
    if (!(r.marketCap < MARKET_CAP_MAX)) {
      dropped.marketCap++;
      continue;
    }
    const der = r.liabilities / r.equity;
    if (!(der >= 0 && der <= DER_MAX)) {
      dropped.der++;
      continue;
    }
    const floatPct = r.floatShares !== null ? (r.floatShares / r.shares) * 100 : null;
    const nav = r.equity / r.shares;
    candidates.push({
      code: r.code,
      name: r.name,
      close: r.close,
      marketCapBn: round(r.marketCap / 1e9, 1),
      derIdx: round(der, 3),
      floatPct: floatPct === null ? null : round(floatPct, 2),
      liabilitiesBn: round(r.liabilities / 1e9, 2),
      equityBn: round(r.equity / 1e9, 2),
      pbv: round(r.marketCap / r.equity, 2),
      navPerShare: round(nav, 1),
      priceToNav: r.close !== null && nav > 0 ? round(r.close / nav, 2) : null,
    });
  }
  candidates.sort((a, b) => (a.floatPct ?? 999) - (b.floatPct ?? 999));

  return {
    computedAt: now.toISOString(),
    source: "tradingview",
    params: { derMax: DER_MAX, marketCapMaxBn: MARKET_CAP_MAX / 1e9, floatMaxPct: FLOAT_MAX_TV },
    totals: { rows: rows.length, stocks, passed: candidates.length },
    typesSeen,
    dropped,
    candidates,
    note: "Daftar pantauan struktur. Komposisi pengendali (owner 70-99%) dan pengumuman resmi tidak tersedia tanpa idx.co.id. Nilai transaksi dan dana masuk dibaca manual.",
  };
}

const KEY = "CACING_SCREEN";
const TTL_S = 3 * 24 * 3600;

export async function runCacingScreen(env: any, fetchFn: typeof fetch = fetch): Promise<CacingScreen> {
  const screen = screenCacingNaga(await fetchTvRows(fetchFn));
  if (env?.KV_CACHE) await env.KV_CACHE.put(KEY, JSON.stringify(screen), { expirationTtl: TTL_S });
  return screen;
}

export async function loadOrRunCacingScreen(env: any, refresh = false, fetchFn: typeof fetch = fetch): Promise<CacingScreen> {
  if (!refresh && env?.KV_CACHE) {
    const cached: CacingScreen | null = await env.KV_CACHE.get(KEY, "json");
    if (cached) return cached;
  }
  return runCacingScreen(env, fetchFn);
}

/* ------------------------------ likuiditas ------------------------------ */

const LIQ_KEY = "CACING_LIQ";
const LIQ_TTL_S = 3 * 24 * 3600;

async function runLiquidity(env: any, codes: string[], now: Date): Promise<LiquiditySnapshot> {
  const snap = await collectLiquidity(codes, undefined, { now });
  if (env?.KV_CACHE) await env.KV_CACHE.put(LIQ_KEY, JSON.stringify(snap), { expirationTtl: LIQ_TTL_S });
  return snap;
}

/** Dipanggil cron (0 14): hitung ulang likuiditas untuk kandidat saringan yang tersimpan. Maks ~12 subrequest Pasardana + 2-3 KV. */
export async function runCacingLiquidity(env: any, now = new Date()): Promise<LiquiditySnapshot> {
  const screen = await loadOrRunCacingScreen(env);
  return runLiquidity(env, screen.candidates.map((c) => c.code), now);
}

async function loadOrRunLiquidity(env: any, screen: CacingScreen, refresh: boolean, now: Date): Promise<LiquiditySnapshot> {
  const codes = screen.candidates.map((c) => c.code);
  if (!refresh && env?.KV_CACHE) {
    const cached: LiquiditySnapshot | null = await env.KV_CACHE.get(LIQ_KEY, "json");
    if (cached && cached.v === 3) {
      const known = new Set<string>(Object.keys(cached.byCode).concat(cached.notFound));
      if (codes.every((c) => known.has(c))) return cached; // semua kandidat sudah tercakup
    }
  }
  return runLiquidity(env, codes, now);
}

/* ------------------------- penilaian gabungan ------------------------- */

// Samakan dengan an4_andry_hakim.ts (v2) dan collector/collect_intel.py
export const PUBLIC_MAX_PCT = 30; // publik = "Masyarakat Non Warkat" (batas atas; di atas ini cenderung gorengan)
export const OWNER_MIN_PCT = 70; // owner = semua pemegang selain Non Warkat dan treasury
export const OWNER_MAX_PCT = 99;
export const ONE_YEAR_DROP_LIMIT = -0.5; // turun >= 50% dalam setahun = gugur (pecahan)

export type PriceGate = "ok" | "gugur" | "tidak_ada_data" | "satuan_janggal";
export type Tier = "inti" | "gugur" | "belum_ada_intel";

interface IntelAnn {
  date: string;
  level: string;
  title: string;
  pdf?: string | null;
}
export interface IntelItem {
  code: string;
  schema?: number;
  der?: number | null;
  fsDate?: string | null;
  publicNonWarkatPct?: number | null; // Masyarakat Non Warkat (mentah, dari seluruh saham)
  publicBigPct?: number | null; // baris >5% bernama "Masyarakat" (publik terkonsolidasi)
  ownerTotalPct?: number | null; // semua baris lain selain treasury (mentah)
  treasuryPct?: number | null;
  holdersTotalPct?: number | null; // jumlah seluruh baris; harus ~100, bila tidak komposisi tidak lengkap
  complete?: boolean | null;
  topHolder?: { name?: string | null; pct?: number | null; controller?: boolean } | null;
  holders?: Array<{ kategori?: string | null; nama?: string | null; pct?: number | null; controller?: boolean }>;
  announcements?: IntelAnn[];
  receivedAt?: string;
}

export const INTEL_SCHEMA = 2; // samakan dengan collector/collect_intel.py
// Persentase dihitung dari saham BEREDAR (tanpa treasury, yang tidak punya hak suara). Ubah ke false bila ingin dasar seluruh saham.
export const TREASURY_EXCLUDED_FROM_BASE = true;

/** Publik dan owner (persen dari saham beredar). null bila data tidak cukup. */
export function composition(intel: IntelItem): { publicPct: number; ownerPct: number } | null {
  const { publicNonWarkatPct: nw, publicBigPct: big, ownerTotalPct: own, treasuryPct: tr } = intel;
  if (typeof nw !== "number" || typeof big !== "number" || typeof own !== "number" || typeof tr !== "number") return null;
  const base = TREASURY_EXCLUDED_FROM_BASE ? 100 - tr : 100;
  if (!(base > 0)) return null;
  return { publicPct: round(((nw + big) / base) * 100, 2), ownerPct: round((own / base) * 100, 2) };
}

/** Aturan keputusan. Tanpa data IDX -> belum_ada_intel. Likuiditas tidak menggugurkan (sepi justru pintu masuk teori). */
export function judge(intel: IntelItem | null, oneYear: number | null, oneYearUnitOk: boolean) {
  const reasons: string[] = [];
  const warnings: string[] = [];
  let priceGate: PriceGate;
  if (!oneYearUnitOk) {
    priceGate = "satuan_janggal";
    warnings.push("satuan return 1 tahun Pasardana janggal, aturan harga tidak diterapkan");
  } else if (oneYear === null) {
    priceGate = "tidak_ada_data";
    warnings.push("return 1 tahun tidak tersedia, aturan harga tidak diperiksa");
  } else if (oneYear <= ONE_YEAR_DROP_LIMIT) {
    priceGate = "gugur";
    reasons.push(`turun ${Math.round(-oneYear * 100)}% dalam setahun (batas ${Math.round(-ONE_YEAR_DROP_LIMIT * 100)}%)`);
  } else {
    priceGate = "ok";
  }

  let unknown = false;
  let comp: { publicPct: number; ownerPct: number } | null = null;
  if (!intel) {
    unknown = true;
  } else if (intel.schema !== INTEL_SCHEMA) {
    unknown = true;
    warnings.push("intel versi lama, jalankan ulang kolektor");
  } else if (intel.complete !== true) {
    unknown = true;
    warnings.push(`komposisi pemegang saham tidak lengkap (jumlah baris ${intel.holdersTotalPct ?? "?"}%), tidak dinilai`);
  } else {
    const der = intel.der;
    if (typeof der !== "number") unknown = true;
    else if (!(der >= 0 && der <= DER_MAX)) reasons.push(`DER IDX ${der} di atas ${DER_MAX}`);
    comp = composition(intel);
    if (!comp) {
      unknown = true;
    } else {
      if (comp.publicPct > PUBLIC_MAX_PCT) reasons.push(`publik ${comp.publicPct}% di atas ${PUBLIC_MAX_PCT}% (float tinggi, risiko gorengan)`);
      if (comp.ownerPct < OWNER_MIN_PCT || comp.ownerPct > OWNER_MAX_PCT) reasons.push(`owner ${comp.ownerPct}% di luar ${OWNER_MIN_PCT}-${OWNER_MAX_PCT}%`);
    }
  }
  const tier: Tier = reasons.length > 0 ? "gugur" : unknown ? "belum_ada_intel" : "inti";
  return { tier, priceGate, reasons, warnings, comp };
}

const TIER_RANK: Record<Tier, number> = { inti: 0, belum_ada_intel: 1, gugur: 2 };

/** Tampilan untuk /api/idx/cacing: struktur TradingView + likuiditas Pasardana + komposisi/pengumuman IDX (intel) + putusan. */
export async function viewCacing(env: any, refresh = false, fetchFn: typeof fetch = fetch, now = new Date()) {
  const screen = await loadOrRunCacingScreen(env, refresh, fetchFn);
  let snap: LiquiditySnapshot | null = null;
  let liquidityError: string | null = null;
  try {
    snap = await loadOrRunLiquidity(env, screen, refresh, now);
  } catch (e) {
    liquidityError = String(e);
  }

  let intelDoc: any = null;
  let intelError: string | null = null;
  try {
    intelDoc = env?.KV_CACHE ? await env.KV_CACHE.get("INTEL_IDX", "json") : null;
  } catch (e) {
    intelError = String(e);
  }
  const intelBy = new Map<string, IntelItem>();
  for (const it of (intelDoc?.items ?? []) as IntelItem[]) if (it?.code) intelBy.set(it.code, it);

  // Return 1 tahun tidak boleh < -100%. Bila ada yang di bawah itu, satuannya bukan pecahan: aturan harga tidak dipakai.
  const liqs = screen.candidates.map((c) => liquidityOf(snap, c.code, now));
  const oneYearUnitOk = liqs.every((l) => l.oneYear === null || l.oneYear >= -1);

  const summary: Record<LiquidityStatus, number> = { ok: 0, rendah: 0, usang: 0, tidak_ada_data: 0 };
  const tiers: Record<Tier, number> = { inti: 0, belum_ada_intel: 0, gugur: 0 };
  let unitJanggal = 0;
  let floatGapFlagged = 0;
  const candidates = screen.candidates.map((c, i) => {
    const liquidity: LiquidityInfo = liqs[i];
    summary[liquidity.status]++;
    if (liquidity.unitCheck === "janggal") unitJanggal++;
    const intel = intelBy.get(c.code) ?? null;
    const j = judge(intel, liquidity.oneYear, oneYearUnitOk);
    tiers[j.tier]++;
    const anns = intel?.announcements ?? [];
    const idxPub = j.comp?.publicPct ?? null;
    const fvals = [c.floatPct, liquidity.freeFloatPct, idxPub].filter((x): x is number => typeof x === "number");
    const gapPts = fvals.length >= 2 ? round(Math.max(...fvals) - Math.min(...fvals), 1) : null;
    const gapFlag = gapPts !== null && gapPts > FLOAT_GAP_FLAG_PCT;
    if (gapFlag) floatGapFlagged++;
    return {
      ...c,
      tier: j.tier,
      reasons: j.reasons,
      warnings: j.warnings,
      priceGate: j.priceGate,
      floatCheck: { tradingview: c.floatPct, pasardana: liquidity.freeFloatPct, idxPublic: idxPub, gapPts, flag: gapFlag ? "selisih_besar" : null },
      liquidity,
      intel: intel
        ? {
            fsDate: intel.fsDate ?? null,
            der: intel.der ?? null,
            adjusted: j.comp, // persen dari saham beredar: dasar putusan
            publicNonWarkatPct: intel.publicNonWarkatPct ?? null,
            publicBigPct: intel.publicBigPct ?? null,
            ownerTotalPct: intel.ownerTotalPct ?? null,
            treasuryPct: intel.treasuryPct ?? null,
            holdersTotalPct: intel.holdersTotalPct ?? null,
            complete: intel.complete ?? null,
            topHolder: intel.topHolder ?? null,
            holders: intel.holders ?? [],
            receivedAt: intel.receivedAt ?? null,
            strongCount: anns.filter((a) => a.level === "kuat").length,
            announcements: anns.map((a) => ({ date: String(a.date).slice(0, 10), level: a.level, title: a.title, pdf: a.pdf ?? null })),
          }
        : null,
    };
  });
  const pubKey = (x: { intel: { adjusted: { publicPct: number } | null } | null; floatPct: number | null }) => x.intel?.adjusted?.publicPct ?? x.floatPct ?? 999;
  candidates.sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || pubKey(a) - pubKey(b));

  return {
    ...screen,
    candidates,
    judgement: {
      rules: {
        derMax: DER_MAX,
        publicMaxPct: PUBLIC_MAX_PCT,
        ownerMinPct: OWNER_MIN_PCT,
        ownerMaxPct: OWNER_MAX_PCT,
        oneYearDropLimit: ONE_YEAR_DROP_LIMIT,
        treasuryExcludedFromBase: TREASURY_EXCLUDED_FROM_BASE,
      },
      tiers,
      oneYearUnitOk,
      intelUpdatedAt: intelDoc?.updatedAt ?? null,
      intelError,
      floatGapFlagged,
      note: "Daftar pantauan, bukan sinyal beli. Judul pengumuman bukan konfirmasi: arah transaksi, nilai, dan dana masuk dibaca manual dari PDF. Saringan awal tidak memakai float; penentu adalah publik non-warkat IDX. Emiten tanpa intel (belum_ada_intel) belum bisa dinilai, jalankan kolektor.",
    },
    liquidity: {
      minValueIdr: MIN_DAILY_VALUE_IDR,
      basis: snap?.basis ?? null,
      asOf: snap?.computedAt ?? null,
      summary,
      unitJanggal,
      pages: snap?.pages ?? 0,
      stocksSeen: snap?.stocksSeen ?? 0,
      truncated: snap?.truncated ?? false,
      error: liquidityError ?? snap?.error ?? null,
      note: "Nilai transaksi satu hari, bukan rata-rata: penyaring kasar. unitJanggal > 0 berarti satuan Value/Volume Pasardana perlu dicek ulang sebelum ambang dipercaya.",
    },
  };
}

/* ------------------------- daftar pantauan rumor ------------------------- */

export interface WatchEmiten {
  code: string;
  name: string | null;
}

/**
 * Untuk pemantau rumor: semua kandidat (untuk menandai judul) dan himpunan tingkat "inti" (untuk peringatan).
 * Hanya membaca cache KV (tanpa jaringan); 3 operasi KV.
 */
export async function loadWatchlist(env: any, now = new Date()): Promise<{ all: WatchEmiten[]; inti: Set<string> }> {
  const kv = env?.KV_CACHE;
  const none = { all: [] as WatchEmiten[], inti: new Set<string>() };
  if (!kv) return none;
  const screen: CacingScreen | null = await kv.get(KEY, "json");
  if (!screen) return none;
  const rawSnap: LiquiditySnapshot | null = await kv.get(LIQ_KEY, "json");
  const snap = rawSnap && rawSnap.v === 3 ? rawSnap : null;
  const intelDoc: any = await kv.get("INTEL_IDX", "json");
  const intelBy = new Map<string, IntelItem>();
  for (const it of (intelDoc?.items ?? []) as IntelItem[]) if (it?.code) intelBy.set(it.code, it);

  const liqs = screen.candidates.map((c) => liquidityOf(snap, c.code, now));
  const unitOk = liqs.every((l) => l.oneYear === null || l.oneYear >= -1);
  const inti = new Set<string>();
  screen.candidates.forEach((c, i) => {
    if (judge(intelBy.get(c.code) ?? null, liqs[i].oneYear, unitOk).tier === "inti") inti.add(c.code);
  });
  return { all: screen.candidates.map((c) => ({ code: c.code, name: c.name })), inti };
}
