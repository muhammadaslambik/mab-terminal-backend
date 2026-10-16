import { PasardanaFeed, type IdxStock } from "./pasardana";

/**
 * Likuiditas kandidat dari Pasardana. PENTING: `Value` Pasardana adalah data HARIAN (ada `lastDate`),
 * bukan rata-rata. Satu hari sepi pada saham kecil bisa menyesatkan, jadi status ini hanya penyaring kasar.
 */
export const MIN_DAILY_VALUE_IDR = 100_000_000; // Rp100 juta per hari (ambang awal, bisa diubah)
export const STALE_DAYS = 7; // lastDate lebih tua dari ini dianggap tidak aktif/disuspen

export type LiquidityStatus = "ok" | "rendah" | "usang" | "tidak_ada_data";
export type UnitCheck = "cocok" | "janggal" | "tidak_dicek";

export interface LiqPoint {
  valueIdr: number | null;
  volume: number | null;
  frequency: number | null;
  last: number | null;
  lastDate: string | null;
  oneYear: number | null; // return 1 tahun, pecahan (-0.5 = -50%); satuan diverifikasi di viewCacing
  freeFloatPct: number | null; // persen (64.62 = 64,62%), ukuran Pasardana
  unitCheck: UnitCheck;
}

export interface LiquiditySnapshot {
  v: number; // versi skema (3 = memuat oneYear dan freeFloatPct); snapshot lama dihitung ulang
  computedAt: string;
  source: "pasardana";
  basis: string;
  minValueIdr: number;
  pages: number;
  stocksSeen: number;
  truncated: boolean; // batas halaman habis sebelum semua kode ditemukan
  error: string | null; // galat di tengah jalan (data sebagian tetap dipakai)
  notFound: string[];
  byCode: Record<string, LiqPoint>;
}

export interface LiquidityInfo {
  status: LiquidityStatus;
  valueIdr: number | null;
  volume: number | null;
  frequency: number | null;
  lastDate: string | null;
  oneYear: number | null; // return 1 tahun, pecahan (-0.5 = -50%); satuan diverifikasi di viewCacing
  freeFloatPct: number | null; // persen (64.62 = 64,62%), ukuran Pasardana
  unitCheck: UnitCheck;
}

export interface StockSource {
  getStocks(q: { page?: number; perPage?: number }): Promise<IdxStock[]>;
}

/** Value/Volume harus mendekati harga terakhir bila Value=Rupiah dan Volume=lembar. Selisih besar = satuan janggal (mis. lot). */
export function checkUnits(value: number | null, volume: number | null, last: number | null): UnitCheck {
  if (value === null || volume === null || last === null || value <= 0 || volume <= 0 || last <= 0) return "tidak_dicek";
  const ratio = value / volume / last;
  return ratio >= 0.5 && ratio <= 2 ? "cocok" : "janggal";
}

const orNull = (v: number | undefined): number | null => (v === undefined ? null : v);

export async function collectLiquidity(
  codes: string[],
  feed: StockSource = new PasardanaFeed(),
  opts: { maxPages?: number; perPage?: number; now?: Date } = {}
): Promise<LiquiditySnapshot> {
  const maxPages = opts.maxPages ?? 12;
  const perPage = opts.perPage ?? 500;
  const now = opts.now ?? new Date();
  const want = new Set(codes.map((c) => c.toUpperCase()));
  const found = new Map<string, IdxStock>();
  const all = new Set<string>();
  let pages = 0;
  let exhausted = false;
  let error: string | null = null;

  if (want.size > 0) {
    for (let page = 1; page <= maxPages; page++) {
      let rows: IdxStock[];
      try {
        rows = await feed.getStocks({ page, perPage });
      } catch (e) {
        if (pages === 0) throw e;
        error = String(e);
        break;
      }
      pages++;
      const before = all.size;
      for (const s of rows) {
        const c = s.code.toUpperCase();
        all.add(c);
        if (want.has(c)) found.set(c, s);
      }
      if (rows.length === 0 || all.size === before) {
        exhausted = true; // sudah habis (atau server mengulang halaman yang sama)
        break;
      }
      if (found.size === want.size) break; // semua kandidat sudah ketemu, hemat subrequest
    }
  }

  const byCode: Record<string, LiqPoint> = {};
  const notFound: string[] = [];
  for (const c of want) {
    const s = found.get(c);
    if (!s) {
      notFound.push(c);
      continue;
    }
    const valueIdr = orNull(s.value);
    const volume = orNull(s.volume);
    const last = orNull(s.last);
    byCode[c] = {
      valueIdr,
      volume,
      frequency: orNull(s.frequency),
      last,
      lastDate: s.lastDate ?? null,
      oneYear: orNull(s.oneYear),
      freeFloatPct: orNull(s.freeFloatPct),
      unitCheck: checkUnits(valueIdr, volume, last),
    };
  }

  return {
    v: 3,
    computedAt: now.toISOString(),
    source: "pasardana",
    basis: "nilai transaksi SATU HARI (field Value, Rupiah), bukan rata-rata",
    minValueIdr: MIN_DAILY_VALUE_IDR,
    pages,
    stocksSeen: all.size,
    truncated: want.size > 0 && !exhausted && found.size < want.size && error === null,
    error,
    notFound,
    byCode,
  };
}

export function liquidityOf(snap: LiquiditySnapshot | null, code: string, now: Date = new Date()): LiquidityInfo {
  const empty: LiquidityInfo = { status: "tidak_ada_data", valueIdr: null, volume: null, frequency: null, lastDate: null, oneYear: null, freeFloatPct: null, unitCheck: "tidak_dicek" };
  const p = snap?.byCode[code.toUpperCase()];
  if (!p || p.valueIdr === null) return p ? { ...empty, volume: p.volume, frequency: p.frequency, lastDate: p.lastDate, oneYear: p.oneYear ?? null, freeFloatPct: p.freeFloatPct ?? null } : empty;

  let status: LiquidityStatus = p.valueIdr >= MIN_DAILY_VALUE_IDR ? "ok" : "rendah";
  if (p.lastDate) {
    const t = Date.parse(p.lastDate);
    if (Number.isFinite(t) && now.getTime() - t > STALE_DAYS * 86_400_000) status = "usang";
  }
  return { status, valueIdr: p.valueIdr, volume: p.volume, frequency: p.frequency, lastDate: p.lastDate, oneYear: p.oneYear ?? null, freeFloatPct: p.freeFloatPct ?? null, unitCheck: p.unitCheck };
}
