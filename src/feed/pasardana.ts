/**
 * Feed data harian saham Indonesia dari Pasardana (endpoint tidak resmi).
 * Cara pemanggilan mengikuti repo risan/indonesia-stock-exchange (api/client.js dan api/index.js),
 * ditulis ulang agar berjalan di Cloudflare Worker (fetch, tanpa axios/Vercel).
 *
 * PERINGATAN: bentuk respons dan satuan angka belum diverifikasi dengan data nyata.
 * Jalankan /api/idx/probe sekali, lalu cek satuan Capitalization dan Value.
 */

const BASE = "https://pasardana.id/api";
const HEADERS: Record<string, string> = {
  Accept: "application/json",
  Pragma: "no-cache",
  Referer: "https://pasardana.id/stock/search",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
};

export interface IdxStock {
  code: string;
  name: string;
  sector?: string;
  subSector?: string;
  last?: number;
  prevClose?: number;
  open?: number;
  high?: number;
  low?: number;
  per?: number;
  pbv?: number;
  volume?: number;
  value?: number; // nilai transaksi (diasumsikan Rupiah)
  frequency?: number;
  changePct?: number; // dihitung dari Last vs PrevClosingPrice
  marketCap?: number; // satuan mengikuti Pasardana (lihat CAP_UNIT di idx_screener)
  beta?: number;
  roe?: number; // pecahan (0.04 = 4%)
  freeFloatPct?: number; // persen (64.62 = 64,62%)
  perAnnualized?: number;
  lastDate?: string;
}

export interface StockQuery {
  search?: string;
  page?: number;
  perPage?: number;
  sortBy?: string;
  sortDirection?: "ASC" | "DESC";
  indexId?: number;
  sectorId?: number;
  subSectorId?: number;
}

/* ------------------------------ helper parsing ----------------------------- */

const num = (v: unknown): number | undefined => {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string") {
    const n = parseFloat(v.replace(/,/g, ""));
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
};

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** Ambil field tanpa peduli huruf besar/kecil. */
function field(rec: any, name: string): unknown {
  if (rec[name] !== undefined && rec[name] !== null) return rec[name];
  const lower = name.toLowerCase();
  for (const k of Object.keys(rec)) if (k.toLowerCase() === lower) return rec[k];
  return undefined;
}

/** Respons bisa berupa array langsung atau objek pembungkus; cari array barisnya. */
export function extractRows(payload: any): any[] {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === "object") {
    for (const k of ["Data", "data", "Result", "result", "Items", "items", "Rows", "rows", "Stocks", "stocks"]) {
      if (Array.isArray(payload[k])) return payload[k];
    }
    for (const v of Object.values(payload)) if (Array.isArray(v)) return v as any[];
  }
  return [];
}

export function normalizeStock(rec: any): IdxStock | null {
  if (!rec || typeof rec !== "object") return null;
  const code = str(field(rec, "Code"));
  if (!code) return null;
  const last = num(field(rec, "Last")) ?? num(field(rec, "AdjustedClosingPrice"));
  const prevClose = num(field(rec, "PrevClosingPrice"));
  const changePct = last !== undefined && prevClose !== undefined && prevClose > 0 ? ((last - prevClose) / prevClose) * 100 : undefined;
  return {
    code,
    name: str(field(rec, "Name")) ?? code,
    sector: str(field(rec, "NewSectorName")) ?? str(field(rec, "SectorName")),
    subSector: str(field(rec, "SubSectorName")),
    last,
    prevClose,
    open: num(field(rec, "AdjustedOpenPrice")),
    high: num(field(rec, "AdjustedHighPrice")),
    low: num(field(rec, "AdjustedLowPrice")),
    per: num(field(rec, "Per")),
    pbv: num(field(rec, "Pbr")),
    volume: num(field(rec, "Volume")),
    value: num(field(rec, "Value")),
    frequency: num(field(rec, "Frequency")),
    changePct,
    marketCap: num(field(rec, "Capitalization")),
    beta: num(field(rec, "BetaOneYear")),
    roe: num(field(rec, "Roe")),
    freeFloatPct: num(field(rec, "FreeFloatPct")),
    perAnnualized: num(field(rec, "PerAnnualized")),
    lastDate: str(field(rec, "LastDate")),
  };
}

/* ---------------------------------- feed ----------------------------------- */

export class PasardanaFeed {
  private async request(path: string, params: Record<string, string | number | undefined> = {}) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") qs.set(k, String(v));
    const query = qs.toString();
    const res = await fetch(`${BASE}${path}${query ? `?${query}` : ""}`, { headers: HEADERS });
    const text = await res.text();
    let payload: any = null;
    try {
      payload = JSON.parse(text);
    } catch {
      /* bukan JSON (mis. halaman blokir) */
    }
    return { ok: res.ok, status: res.status, payload, text };
  }

  /** Satu halaman daftar saham (parameter sama dengan repo asal). */
  public async getStocks(q: StockQuery = {}): Promise<IdxStock[]> {
    const r = await this.request("/StockSearchResult/GetAll", {
      Keywords: q.search,
      pageBegin: q.page ?? 1,
      pageLength: q.perPage ?? 25,
      sortField: q.sortBy ?? "Code",
      sortOrder: (q.sortDirection ?? "ASC").toUpperCase(),
      Index: q.indexId,
      StockSector: q.sectorId,
      StockSubSector: q.subSectorId,
    });
    if (!r.ok) throw new Error(`Pasardana HTTP ${r.status}`);
    return extractRows(r.payload).map(normalizeStock).filter((s): s is IdxStock => s !== null);
  }

  /**
   * Seluruh saham, halaman demi halaman. Berhenti saat halaman kosong atau tidak ada kode baru
   * (server boleh membatasi pageLength di bawah yang diminta). Maks 12 request.
   */
  public async getAllStocks(maxPages = 12, perPage = 500, extra: StockQuery = {}): Promise<IdxStock[]> {
    const byCode = new Map<string, IdxStock>();
    for (let page = 1; page <= maxPages; page++) {
      const rows = await this.getStocks({ ...extra, page, perPage });
      const before = byCode.size;
      for (const s of rows) byCode.set(s.code, s);
      if (rows.length === 0 || byCode.size === before) break;
    }
    return [...byCode.values()];
  }

  public async getIndices(): Promise<{ id: number; name: string }[]> {
    const r = await this.request("/Stock/GetIndexFilters");
    if (!r.ok) throw new Error(`Pasardana HTTP ${r.status}`);
    return extractRows(r.payload)
      .map((i: any) => ({ id: Number(field(i, "Id")), name: String(field(i, "Name") ?? "") }))
      .filter((i) => Number.isFinite(i.id));
  }

  /** Diagnosa: status HTTP, bentuk respons, nama field, dan contoh data mentah. */
  public async probe() {
    const r = await this.request("/StockSearchResult/GetAll", { pageBegin: 1, pageLength: 3, sortField: "Value", sortOrder: "DESC" });
    const rows = extractRows(r.payload);
    return {
      ok: r.ok,
      status: r.status,
      isJson: r.payload !== null,
      topLevelKeys: r.payload && !Array.isArray(r.payload) && typeof r.payload === "object" ? Object.keys(r.payload) : "(array/bukan objek)",
      rowCount: rows.length,
      fields: rows[0] ? Object.keys(rows[0]) : [],
      sample: rows.slice(0, 2),
      bodyPreview: r.payload === null ? r.text?.slice(0, 300) : undefined,
    };
  }
}
