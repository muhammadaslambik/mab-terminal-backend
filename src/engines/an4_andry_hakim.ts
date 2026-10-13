/**
 * an4_andry_hakim — Andry Hakim (khusus saham Indonesia / BEI)
 *   an4V1: Deep Value & Turnaround + Bandarmologi
 *   an4V2: "Cacing-Cacing Naga-Naga": perusahaan kecil, hutang hampir nol, dikuasai owner, dan akan membesar bila ada
 *          suntikan dana/aset NYATA >= Rp1 triliun. Beli cicil saat rumor, all-in saat fakta terkonfirmasi.
 *   an4V3: Hybrid Value-Event Engine (klasifikasi Track A/B/Hybrid + confluence scoring)
 * Data fundamental, broker summary, dan keterbukaan informasi dikirim lewat AnalysisInput.
 */
import type { Announcement, AnalysisInput, BrokerSummary, Candle, Engine, EngineSignal, Fundamentals, OrderType } from "./types";
import { abstain, fmt, hold, ownsPosition } from "./common";
import { cleanCandles, cmf, daysBetween, isMarketClosed, mean, obv, slope } from "../utils/indicators";

export const NAME_V1 = "an4_andry_hakim_v1";
export const NAME_V2 = "an4_andry_hakim_v2";
export const NAME_V3 = "an4_andry_hakim_v3";

const MIN_CANDLES = 80;
const MIN_TURNOVER = 1_000_000_000; // Rp1 Miliar (batas bawah likuiditas)
const LIQUIDITY_LOCK = 100_000_000; // Rp100 Juta: di bawah ini dilarang market order
const MICRO_CAP = 500_000_000_000; // Rp500 Miliar
const SUSPENSION_GAP_DAYS = 10;
const SPIKE_MULT = 6; // lonjakan > 500% = lebih dari 6x MA20 volume
const TRAILING = 0.15;
const SIDEWAYS_SHORT = 0.15; // rentang harga maks untuk "sideways" 30-60 hari
const SIDEWAYS_LONG = 0.2; // rentang harga maks untuk fase akumulasi panjang
const TRACK_B_PURE_MAX_EXPOSURE_PCT = 10; // batas bawah dari aturan 10-15%
// --- Tesis suntikan dana (V2) ---
const DER_MAX = 0.1; // "hutang hampir nol"
const FREE_FLOAT_MAX = 30; // kepemilikan publik > 30% dianggap jelek (owner >= 70%)
const CRASH_1Y = -0.5; // turun >= 50% dalam 1 tahun = indikasi saham gorengan
const INJECTION_MIN_RP = 1_000_000_000_000; // suntikan minimal Rp1 triliun
const CICIL_TRANCHE_PCT = 0.5; // satu tahap cicil (% ekuitas)
const CICIL_MAX_PCT = 2.5; // plafon total fase cicil per emiten
const PLANNED_TARGET_PCT = 5; // deal resmi >= Rp1 T tetapi dana belum masuk
const ALL_IN_TARGET_PCT = 10; // dana/aset >= Rp1 T benar-benar masuk
const STRATEGY_MAX_EXPOSURE_PCT = 20; // total eksposur seluruh posisi strategi ini
const REVIEW_DAYS = 180; // cicil tanpa konfirmasi selama 6 bulan -> tinjau ulang
const NAV_CHEAP_MAX = 0.7; // harga <= 70% NAV per saham = murah
const NAV_FAIR_MAX = 1.0; // harga <= NAV per saham = wajar; di atasnya mahal
const PHASE3_DAYS = 182; // ~6 bulan tanpa event -> evaluasi skema exit Track A

const KEYWORDS = [
  "perubahan pengendali",
  "pmthmetd",
  "private placement",
  "akuisisi",
  "peningkatan modal tanpa hmetd",
  "rupslb",
];
const CONTROL_KEYWORDS = ["perubahan pengendali", "pmthmetd"];
const CANCEL_WORDS = ["pembatalan", "dibatalkan", "tidak jadi"];

/* ------------------------- DATA VALIDATION & VOLUME ------------------------ */

export const averageTurnover = (c: Candle[], days = 20): number => mean(c.slice(-days).map((x) => x.close * x.volume));

/**
 * Suspensi bursa: jika jeda antar candle > 10 hari, volume bar pertama sesudah suspensi
 * dinetralkan (diganti median 20 bar sebelumnya) supaya tidak terbaca sebagai volume spike.
 */
export function neutralizeSuspensionGaps(candles: Candle[]): Candle[] {
  const out = candles.map((c) => ({ ...c }));
  for (let i = 1; i < out.length; i++) {
    if (daysBetween(out[i - 1].time, out[i].time) > SUSPENSION_GAP_DAYS) {
      const base = out
        .slice(Math.max(0, i - 20), i)
        .map((c) => c.volume)
        .sort((a, b) => a - b);
      out[i].volume = base.length ? base[Math.floor(base.length / 2)] : 0;
    }
  }
  return out;
}

export interface VolumeAccumulation {
  sideways: boolean;
  obvRising: boolean;
  cmfRising: boolean;
  accumulation: boolean;
}

/** Akumulasi price-volume murni: harga sideways tetapi OBV / CMF merangkak naik. */
export function volumeAccumulation(c: Candle[], window: number, maxRangePct: number): VolumeAccumulation {
  const none = { sideways: false, obvRising: false, cmfRising: false, accumulation: false };
  if (c.length < window + 20) return none;
  const closes = c.slice(-window).map((x) => x.close);
  const range = (Math.max(...closes) - Math.min(...closes)) / Math.min(...closes);
  const sideways = range <= maxRangePct;
  const obvW = obv(c).slice(-window);
  const cmfW = cmf(c, 20).slice(-window).filter(Number.isFinite);
  const obvRising = slope(obvW) > 0 && obvW[obvW.length - 1] > obvW[0];
  const cmfRising = cmfW.length >= 5 && slope(cmfW) > 0 && cmfW[cmfW.length - 1] > 0;
  return { sideways, obvRising, cmfRising, accumulation: sideways && (obvRising || cmfRising) };
}

/** Bandarmologi: Top Buyers > 50% volume 20 hari tanpa kenaikan harga drastis; fallback OBV/CMF. */
export function analyzeBandarmologiAccumulation(broker: BrokerSummary | undefined, c: Candle[]): { detected: boolean; source: "BROKER" | "OBV_CMF" } {
  const w = c.slice(-20);
  if (broker && broker.totalVolume > 0 && w.length >= 2) {
    const priceChange = (w[w.length - 1].close - w[0].close) / w[0].close;
    return { detected: broker.topBuyersVolume / broker.totalVolume > 0.5 && Math.abs(priceChange) < 0.1, source: "BROKER" };
  }
  return { detected: volumeAccumulation(c, 20, 0.1).accumulation, source: "OBV_CMF" };
}

/** Breakout dari sideways panjang dengan volume >= 2x rata-rata volume 20 hari. */
export function checkVolumeBreakout(c: Candle[]): { sideways: boolean; breakout: boolean; multiple: number } {
  if (c.length < 62) return { sideways: false, breakout: false, multiple: NaN };
  const last = c[c.length - 1];
  const prior = c.slice(-61, -1);
  const closes = prior.map((x) => x.close);
  const sideways = (Math.max(...closes) - Math.min(...closes)) / Math.min(...closes) <= SIDEWAYS_LONG;
  const prevHigh = Math.max(...prior.map((x) => x.high));
  const avgVol = mean(c.slice(-21, -1).map((x) => x.volume));
  const multiple = avgVol > 0 ? last.volume / avgVol : NaN;
  return { sideways, breakout: sideways && last.close > prevHigh && multiple >= 2, multiple };
}

export function detectVolSpike(c: Candle[]): { spike: boolean; multiple: number } {
  if (c.length < 22) return { spike: false, multiple: NaN };
  const avg = mean(c.slice(-21, -1).map((x) => x.volume));
  const multiple = avg > 0 ? c[c.length - 1].volume / avg : NaN;
  return { spike: Number.isFinite(multiple) && multiple > SPIKE_MULT, multiple };
}

/* --------------------------- TEXT MINING KETERBUKAAN ----------------------- */

export interface EventScan {
  hits: string[];
  anyEvent: boolean;
  controlChange: boolean;
  suddenAudit: boolean;
  cancelled: boolean; // pengumuman aksi korporasi yang menyebut pembatalan
}

export function parseCorporateAnnouncements(anns: Announcement[], sinceIso: string): EventScan {
  const since = sinceIso.slice(0, 10);
  const hits = new Set<string>();
  let suddenAudit = false;
  let cancelled = false;
  for (const a of anns) {
    if (a.date.slice(0, 10) < since) continue;
    const text = `${a.title} ${a.body ?? ""}`.toLowerCase();
    let hit = false;
    for (const k of KEYWORDS) {
      if (text.includes(k)) {
        hits.add(k);
        hit = true;
      }
    }
    if (hit && CANCEL_WORDS.some((w) => text.includes(w))) cancelled = true;
    if (text.includes("laporan keuangan interim") && text.includes("audit")) suddenAudit = true;
  }
  const list = [...hits];
  return { hits: list, anyEvent: list.length > 0, controlChange: list.some((k) => CONTROL_KEYWORDS.includes(k)), suddenAudit, cancelled };
}

const sinceDays = (nowIso: string, days: number): string => new Date(Date.parse(nowIso) - days * 86_400_000).toISOString().slice(0, 10);

/* ------------------------------ FUNDAMENTAL -------------------------------- */

/** Lapisan 0: veto mutlak untuk semua track. */
export function universalPrefilter(input: AnalysisInput): { passed: boolean; reason: string } {
  const f = input.fundamentals;
  const c = input.compliance;
  if (!f) return { passed: false, reason: "Data fundamental tidak tersedia" };
  if (c?.sanctionActive) return { passed: false, reason: "Sanksi OJK/BEI aktif" };
  if (c?.auditOpinion && c.auditOpinion.toUpperCase() !== "UNQUALIFIED") return { passed: false, reason: `Opini audit ${c.auditOpinion}` };
  if (c?.delistingWarning) return { passed: false, reason: "Peringatan delisting" };
  if ((c?.missingQuarters ?? 0) > 2) return { passed: false, reason: "Data keuangan hilang > 2 kuartal" };
  return { passed: true, reason: "OK" };
}

export interface TrackAResult {
  cheap: boolean;
  healthy: boolean;
  turnaround: boolean;
  profitUpQoQ: boolean;
  all: boolean;
}

export function screenFundamentalTurnaround(f: Fundamentals): TrackAResult {
  const pbvCheap = f.pbv !== undefined && (f.pbv < 1 || (f.avgPbv5y !== undefined && f.pbv < f.avgPbv5y));
  const peCheap = f.pe !== undefined && f.pe > 0 && f.industryPe !== undefined && f.pe < f.industryPe * 0.7;
  const cheap = pbvCheap && peCheap;
  const healthy = f.der !== undefined && f.der < 1 && f.operatingCashFlow !== undefined && f.operatingCashFlow > 0;
  const q = f.netProfitQuarters ?? [];
  const n = q.length;
  const growth2Q = n >= 3 && q[n - 1] > q[n - 2] && q[n - 2] > q[n - 3];
  const hadLoss = n >= 3 && q.slice(0, n - 2).some((x) => x < 0);
  const turnaround = (growth2Q && hadLoss) || f.macroCatalyst === true;
  const profitUpQoQ = n >= 2 && q[n - 1] > q[n - 2];
  return { cheap, healthy, turnaround, profitUpQoQ, all: cheap && healthy && turnaround };
}

export interface ShellResult {
  microCap: boolean;
  pbvDistress: boolean;
  stagnation: boolean;
  freeFloatOk: boolean;
  count: number;
}

/** Karakteristik cangkang. "Stagnasi" ditafsirkan sebagai OCF atau laba bersih negatif 4 kuartal terakhir. */
export function filterShellCompanies(f: Fundamentals): ShellResult {
  const microCap = f.marketCap !== undefined && f.marketCap < MICRO_CAP;
  const pbvDistress = f.pbv !== undefined && f.pbv < 1; // termasuk PBV negatif
  const neg4 = (a?: number[]): boolean => !!a && a.length >= 4 && a.slice(-4).every((x) => x < 0);
  const stagnation = neg4(f.ocfQuarters) || neg4(f.netProfitQuarters);
  const freeFloatOk = f.freeFloatPercent !== undefined && f.freeFloatPercent > 0 && f.freeFloatPercent <= FREE_FLOAT_MAX; // owner dominan
  return { microCap, pbvDistress, stagnation, freeFloatOk, count: [microCap, pbvDistress, stagnation, freeFloatOk].filter(Boolean).length };
}

/** Target nilai wajar: harga saat PBV = 0.8 dan PBV = 1.0 (berdasar nilai buku per saham). */
export function calculateIntrinsicTarget(f: Fundamentals, close: number): number[] {
  if (f.pbv === undefined || f.pbv <= 0) return [];
  const bvps = close / f.pbv;
  return [bvps * 0.8, bvps * 1.0];
}

export type TrackClass = "A" | "B" | "HYBRID_CANDIDATE" | "ELIMINASI";

/**
 * Klasifikasi track. Cabang "campuran" pada pohon keputusan asli tumpang-tindih dengan cabang Track B
 * (micro cap sudah masuk B), sehingga di sini cabang Hybrid dievaluasi sebelum Track B.
 */
export function classifyTrack(f: Fundamentals): TrackClass {
  if (f.pbv === undefined || f.pbv >= 1) return "ELIMINASI";
  const a = screenFundamentalTurnaround(f);
  const s = filterShellCompanies(f);
  const shellMarkers = f.pbv <= 0.1 || s.stagnation || s.freeFloatOk || s.microCap;
  const recentLoss = (f.netProfitQuarters ?? []).slice(-1).some((x) => x < 0);
  if (a.healthy && a.turnaround && !shellMarkers) return "A";
  if (a.healthy && (shellMarkers || recentLoss)) return "HYBRID_CANDIDATE";
  if (!a.healthy && shellMarkers) return "B";
  return "ELIMINASI";
}

/* ---------------------------- CONFLUENCE SCORING --------------------------- */

export interface ConfluenceFlags {
  cheap: boolean;
  healthy: boolean;
  turnaround: boolean;
  profitUpQoQ: boolean;
  topBuyers: boolean;
  breakout: boolean;
  liquid: boolean;
  microCap: boolean;
  pbvDistress: boolean;
  stagnation: boolean;
  freeFloat: boolean;
  insider: boolean;
  volSpike: boolean; // spike dari kondisi "tidur"
  event: boolean; // keyword aksi korporasi
  controlChange: boolean; // "Perubahan Pengendali" / PMTHMETD
  suddenAudit: boolean;
  obvCmf: boolean;
}

/** Skor dasar: +1 per kriteria Track A dan Track B yang terpenuhi, ditambah bonus silang sesuai tabel. */
export function scoreConfluence(s: ConfluenceFlags): { score: number; base: number; bonus: number; aConfirm: boolean } {
  const base = [s.cheap, s.healthy, s.turnaround, s.topBuyers, s.breakout, s.liquid, s.microCap, s.pbvDistress, s.stagnation, s.freeFloat, s.insider, s.volSpike, s.event, s.suddenAudit].filter(Boolean).length;
  const aConfirm = s.turnaround || s.topBuyers || s.breakout || s.healthy;
  const bSignal = s.event || s.suddenAudit || s.volSpike || s.insider;
  let bonus = 0;
  if (s.turnaround && s.suddenAudit) bonus += 3;
  if (s.obvCmf && s.topBuyers) bonus += 2;
  if (s.breakout && s.volSpike) bonus += 2;
  if (s.profitUpQoQ && s.controlChange) bonus += 4; // irisan emas
  if (s.event && s.healthy) bonus += 3;
  if (bSignal && !aConfirm) bonus -= 1;
  return { score: base + bonus, base, bonus, aConfirm };
}

interface Tier {
  label: string;
  pct: number;
  range: string;
}

function tierForScore(score: number): Tier | null {
  if (score >= 12) return { label: "PREMIUM_DOUBLE_SIGNAL", pct: 9, range: "8-10%" };
  if (score >= 8) return { label: "STRONG_HYBRID", pct: 6.25, range: "5-7.5%" };
  if (score >= 5) return { label: "TRACK_ONLY", pct: 3.75, range: "2.5-5%" };
  return null;
}

function orderTypeFor(label: string, turnover: number): OrderType {
  if (label === "PREMIUM_DOUBLE_SIGNAL") return turnover >= MIN_TURNOVER ? "MARKET" : "LIMIT";
  if (label === "STRONG_HYBRID") return turnover < MIN_TURNOVER ? "LIMIT" : "MARKET";
  return turnover < LIQUIDITY_LOCK ? "LIMIT_STAGED" : "MARKET"; // Liquidity Lock
}

/* --------------------------------- EXIT LOGIC ------------------------------ */

const exitSignal = (engine: string, fraction: number, reason: string, tag: string): EngineSignal => ({
  engine,
  action: "SELL",
  confidence: 0.85,
  reason,
  sellFraction: fraction,
  tags: ["EXIT", tag],
});

/**
 * DARURAT (mode "cacing"): rumor batal, suntikan dibatalkan, atau pengumuman pembatalan -> jual SEMUA posisi.
 * Dicek paling awal, tidak bergantung pada data lain (DER, Pasardana, hari bursa), dan tidak bisa diblokir risk guard.
 */
export function emergencyExit(engine: string, input: AnalysisInput): EngineSignal | null {
  const pos = input.position;
  if (!pos) return null;
  const intel = input.intel;
  const ev = parseCorporateAnnouncements(input.announcements ?? [], pos.openedAt);
  const cause = intel?.rumor === "DEBUNKED" ? "rumor terbantahkan" : intel?.injection?.cancelled ? "suntikan dibatalkan" : ev.cancelled ? "pembatalan di keterbukaan informasi" : null;
  if (!cause) return null;
  const candles = cleanCandles(input.candles);
  const lowLiquidity = candles.length >= 20 && averageTurnover(candles) < LIQUIDITY_LOCK;
  return {
    engine,
    action: "SELL",
    confidence: 1,
    reason: `DARURAT (mode cacing): ${cause}, jual seluruh posisi${lowLiquidity ? ". Likuiditas rendah: pecah order, jangan menunggu" : ""}`,
    sellFraction: 1,
    orderType: "MARKET",
    tags: ["EXIT", "EMERGENCY", "CACING", ...(lowLiquidity ? ["LIQUIDITY_WARNING"] : [])],
  };
}

/** Exit valuasi Track A: jual 33% di PBV 0.8, sisanya di PBV >= 1.0, atau saat laba melambat 2 kuartal. */
export function trackAExit(engine: string, input: AnalysisInput): EngineSignal | null {
  const pos = input.position;
  const f = input.fundamentals;
  if (!pos || !f) return null;
  const sold = pos.partialSoldPct ?? 0;
  const q = f.netProfitQuarters ?? [];
  const n = q.length;
  const slowdown = n >= 4 && q[n - 1] - q[n - 2] < q[n - 2] - q[n - 3] && q[n - 2] - q[n - 3] < q[n - 3] - q[n - 4];
  if (f.pbv !== undefined && f.pbv >= 1) return exitSignal(engine, 1, `PBV ${fmt(f.pbv)} >= 1.0, jual seluruh sisa`, "PBV_TARGET");
  if (f.pbv !== undefined && f.pbv >= 0.8 && sold < 0.33) return exitSignal(engine, 0.33, `PBV ${fmt(f.pbv)} >= 0.8, jual 33%`, "PBV_PARTIAL");
  if (slowdown) return exitSignal(engine, 1, "Pertumbuhan laba melambat 2 kuartal", "PROFIT_SLOWDOWN");
  return null;
}

/** Exit event Track B: jual 50% saat pengumuman resmi, sisa dengan trailing stop 15%. */
export function trackBExit(engine: string, input: AnalysisInput, candles: Candle[]): EngineSignal | null {
  const pos = input.position;
  if (!pos || !candles.length) return null;
  const close = candles[candles.length - 1].close;
  const highest = Math.max(pos.highestPrice ?? pos.entryPrice, close);
  if (close < highest * (1 - TRAILING)) return exitSignal(engine, 1, `Trailing stop 15% dari puncak ${fmt(highest)}`, "TRAILING_STOP");
  const ev = parseCorporateAnnouncements(input.announcements ?? [], pos.openedAt);
  if (ev.anyEvent && !pos.eventAnnouncedAt) return exitSignal(engine, 0.5, "Pengumuman resmi terbit: jual 50%, sisa trailing stop 15%", "EVENT_REACTION");
  return null;
}

/** Exit ganda Hybrid (whichever-first). */
export function exitLogic(input: AnalysisInput, candles: Candle[]): EngineSignal {
  const pos = input.position!;
  const inPos = (reason: string, tags: string[] = []): EngineSignal => ({ engine: NAME_V3, action: "HOLD", confidence: 0.3, reason, tags: ["IN_POSITION", ...tags] });

  if (pos.classification === "PREMIUM_DOUBLE_SIGNAL") {
    const ev = parseCorporateAnnouncements(input.announcements ?? [], pos.openedAt);
    const eventDone = !!pos.eventAnnouncedAt || ev.anyEvent;
    if (!eventDone) {
      const q = input.fundamentals?.netProfitQuarters ?? [];
      const turnaroundOn = q.length >= 2 && q[q.length - 1] > q[q.length - 2];
      if (daysBetween(pos.openedAt, input.now) >= PHASE3_DAYS && turnaroundOn) {
        return trackAExit(NAME_V3, input) ?? inPos("Fase 3: event belum resmi, turnaround jalan -> pakai exit valuasi", ["PHASE3"]);
      }
      return inPos("Fase 1: tahan sampai pengumuman event resmi", ["PHASE1"]);
    }
    return trackBExit(NAME_V3, input, candles) ?? inPos("Fase 2: pasca event, pantau trailing stop 15%", ["PHASE2"]);
  }
  const a = pos.track === "B" ? null : trackAExit(NAME_V3, input);
  const b = pos.track === "A" ? null : trackBExit(NAME_V3, input, candles);
  const picks = [a, b].filter((x): x is EngineSignal => x !== null);
  if (!picks.length) return inPos("Belum ada pemicu exit");
  return picks.reduce((m, x) => ((x.sellFraction ?? 0) > (m.sellFraction ?? 0) ? x : m));
}

/* ------------------------------ PERSIAPAN DATA ----------------------------- */

type Prepared = { ok: false; signal: EngineSignal } | { ok: true; candles: Candle[] };

function prepare(input: AnalysisInput, name: string, hasPos: boolean): Prepared {
  if (input.assetClass !== "ID_STOCK") return { ok: false, signal: abstain(name, "Hanya untuk saham Indonesia", ["N/A"]) };
  if (isMarketClosed(input.assetClass, input.now)) return { ok: false, signal: abstain(name, "Bursa tutup (akhir pekan)", ["MARKET_CLOSED"]) };
  const cleaned = cleanCandles(input.candles);
  if (cleaned.length < MIN_CANDLES) {
    return { ok: false, signal: abstain(name, `Data kurang: ${cleaned.length}/${MIN_CANDLES} candle`, ["DATA_INSUFFICIENT"]) };
  }
  const frozenDays = daysBetween(cleaned[cleaned.length - 1].time, input.now);
  if (frozenDays > SUSPENSION_GAP_DAYS) {
    const tags = ["SUSPENSION_FROZEN", ...(frozenDays > 20 ? ["EVALUATE_EXIT"] : [])];
    return { ok: false, signal: { engine: name, action: "HOLD", confidence: 0.3, reason: `Diduga suspensi ${fmt(frozenDays, 0)} hari`, tags } };
  }
  if (!hasPos) {
    // Tanpa data fundamental engine tidak ikut voting (bukan memilih HOLD)
    if (!input.fundamentals) return { ok: false, signal: abstain(name, "Data fundamental tidak tersedia", ["DATA_INSUFFICIENT"]) };
    const pre = universalPrefilter(input);
    if (!pre.passed) return { ok: false, signal: hold(name, `Veto: ${pre.reason}`, ["PREFILTER_VETO"]) };
  }
  return { ok: true, candles: neutralizeSuspensionGaps(cleaned) };
}

/* ----------------------------------- V1 ------------------------------------ */

export const an4V1: Engine = {
  name: NAME_V1,
  analyze(input: AnalysisInput): EngineSignal {
    const hasPos = ownsPosition(input, NAME_V1);
    const p = prepare(input, NAME_V1, hasPos);
    if (!p.ok) return p.signal;
    const f = input.fundamentals;
    if (!f) return abstain(NAME_V1, "Data fundamental tidak tersedia", ["DATA_INSUFFICIENT"]);
    const c = p.candles;
    const close = c[c.length - 1].close;

    if (hasPos) return trackAExit(NAME_V1, input) ?? hold(NAME_V1, "Tahan posisi (belum ada pemicu exit valuasi)", ["IN_POSITION"]);
    if (f.der === undefined || !f.netProfitQuarters || f.netProfitQuarters.length < 3) {
      return abstain(NAME_V1, "Butuh DER dan laba kuartalan (isi di src/data/intel.ts)", ["NEED_FUNDAMENTALS"]);
    }

    const a = screenFundamentalTurnaround(f);
    if (!a.all) {
      const miss = (["cheap", "healthy", "turnaround"] as const).filter((k) => !a[k]).join(", ");
      return hold(NAME_V1, `Belum lolos skrining Track A (kurang: ${miss})`, ["SCREEN_FAIL"]);
    }
    const turnover = averageTurnover(c);
    if (!(turnover >= MIN_TURNOVER)) return hold(NAME_V1, `Likuiditas rendah (Rp${fmt(turnover / 1e9)} M/hari)`, ["LOW_LIQUIDITY"]);

    const acc = analyzeBandarmologiAccumulation(input.brokerSummary, c);
    if (!acc.detected) return hold(NAME_V1, `Akumulasi belum terdeteksi (${acc.source})`, ["NO_ACCUMULATION"]);

    const vb = checkVolumeBreakout(c);
    if (!vb.breakout) return hold(NAME_V1, "Menunggu breakout dari sideways dengan volume >= 2x MA20", ["ACCUMULATION_DETECTED", "WAIT_BREAKOUT"]);

    return {
      engine: NAME_V1,
      action: "BUY",
      confidence: 0.7,
      reason: `Value turnaround + akumulasi (${acc.source}) + breakout volume ${fmt(vb.multiple, 1)}x`,
      entry: close,
      takeProfit: calculateIntrinsicTarget(f, close),
      positionPct: 5, // prompt V1 tidak menetapkan sizing; memakai batas atas "track tunggal" V3
      orderType: "MARKET",
      tags: ["STANDALONE", "ACCUMULATION_DETECTED", "BREAKOUT_STAGE2"],
    };
  },
};

/* ----------------------------------- V2 ------------------------------------ */

export interface AcquisitionAssessment {
  structureOk: boolean;
  structureFails: string[];
  stage: 0 | 1 | 2 | 3; // 0 tidak ada, 1 cicil (rumor/anomali), 2 deal resmi >= Rp1 T, 3 dana/aset nyata >= Rp1 T masuk
  triggers: string[];
  flags: string[]; // tanda bahaya
  injectionRp: number;
  multiple?: number; // nilai suntikan / market cap
  buyerNote?: string;
  valuation: Valuation;
}

export interface Valuation {
  navPerShare?: number;
  ratio?: number; // harga / NAV per saham
  basis: "FAIR_VALUE" | "BOOK" | "UNKNOWN";
  label: "MURAH" | "WAJAR" | "MAHAL" | "UNKNOWN";
}

/**
 * Valuasi wajar: (total aset nilai wajar - kewajiban) / jumlah saham = NAV per saham, dibandingkan dengan harga.
 * Tanpa estimasi nilai wajar dari intel, dipakai nilai buku (harga / PBV).
 */
export function assessValuation(input: AnalysisInput, price: number): Valuation {
  const f = input.fundamentals;
  const v = input.intel?.valuation;
  let nav: number | undefined;
  let basis: Valuation["basis"] = "UNKNOWN";
  if (v?.assetFairValueRp && f?.sharesOutstanding && f.sharesOutstanding > 0) {
    nav = (v.assetFairValueRp - (v.liabilitiesRp ?? 0)) / f.sharesOutstanding;
    basis = "FAIR_VALUE";
  } else if (f?.pbv !== undefined && f.pbv > 0) {
    nav = price / f.pbv;
    basis = "BOOK";
  }
  if (nav === undefined || !(nav > 0)) return { basis: "UNKNOWN", label: "UNKNOWN" };
  const ratio = price / nav;
  const label = ratio <= NAV_CHEAP_MAX ? "MURAH" : ratio <= NAV_FAIR_MAX ? "WAJAR" : "MAHAL";
  return { navPerShare: nav, ratio, basis, label };
}

/** Struktur calon target + tahap bukti suntikan dana. */
export function assessAcquisition(input: AnalysisInput, candles: Candle[]): AcquisitionAssessment {
  const f = input.fundamentals!;
  const intel = input.intel;
  const inj = intel?.injection;
  const der = f.der ?? 0;
  const fails: string[] = [];
  const flags: string[] = [];

  if (f.marketCap === undefined || f.marketCap >= MICRO_CAP) fails.push("market cap tidak di bawah Rp500 M");
  if (der > DER_MAX) fails.push(`DER ${fmt(der)} > ${DER_MAX}`);
  if (f.freeFloatPercent === undefined || f.freeFloatPercent > FREE_FLOAT_MAX) fails.push(`kepemilikan publik > ${FREE_FLOAT_MAX}%`);
  if (f.return1y !== undefined && f.return1y <= CRASH_1Y) fails.push("harga hancur dalam 1 tahun (indikasi gorengan)");

  const triggers: string[] = [];
  const acc = volumeAccumulation(candles, 45, SIDEWAYS_SHORT);
  const ev = parseCorporateAnnouncements(input.announcements ?? [], sinceDays(input.now, 30));
  if (intel?.rumor === "RUMOR" || intel?.rumor === "CREDIBLE") triggers.push("RUMOR");
  if (acc.accumulation) triggers.push("AKUMULASI_SENYAP");
  if (detectVolSpike(candles).spike) triggers.push("VOL_SPIKE");
  if (input.compliance?.voluntaryInterimAudit === true || ev.suddenAudit) triggers.push("LAPORAN_TERTATA");
  if (ev.anyEvent) triggers.push("PENGUMUMAN_AKSI_KORPORASI");

  const planned = inj?.plannedRp ?? 0;
  const received = inj?.receivedRp ?? 0;
  const affiliated = intel?.acquirer?.type === "AFFILIATED";
  const debunked = intel?.rumor === "DEBUNKED" || inj?.cancelled === true;

  let stage: 0 | 1 | 2 | 3 = triggers.length ? 1 : 0;
  if (debunked) {
    stage = 0;
    flags.push("DEBUNKED");
  } else if (received >= INJECTION_MIN_RP) {
    stage = 3;
  } else if (planned >= INJECTION_MIN_RP && inj?.official && !affiliated) {
    stage = 2;
  }
  // Pembeli terafiliasi (milik owner sendiri): hanya dana yang benar-benar masuk yang dianggap bukti
  if (affiliated) flags.push("RED_FLAG_AFFILIATED");
  if (planned >= INJECTION_MIN_RP && !inj?.official && received < INJECTION_MIN_RP) flags.push("RUMOR_BELUM_RESMI");

  const injectionRp = stage === 3 ? received : Math.max(planned, received); // tahap 3: hanya yang benar-benar masuk
  const nw = intel?.acquirer?.netWorthRp;
  return {
    structureOk: fails.length === 0,
    structureFails: fails,
    stage,
    triggers,
    flags,
    injectionRp,
    multiple: f.marketCap && injectionRp > 0 ? injectionRp / f.marketCap : undefined,
    buyerNote: nw && injectionRp > 0 ? `kekayaan pembeli ${fmt(nw / injectionRp, 1)}x nilai suntikan` : undefined,
    valuation: assessValuation(input, candles[candles.length - 1].close),
  };
}

export const an4V2: Engine = {
  name: NAME_V2,
  analyze(input: AnalysisInput): EngineSignal {
    const hasPos = ownsPosition(input, NAME_V2);
    if (hasPos) {
      const emergency = emergencyExit(NAME_V2, input);
      if (emergency) return emergency;
    }
    const p = prepare(input, NAME_V2, hasPos);
    if (!p.ok) return p.signal;
    const f = input.fundamentals;
    if (!f || f.marketCap === undefined || f.freeFloatPercent === undefined) {
      return abstain(NAME_V2, "Butuh market cap dan free float (Pasardana)", ["DATA_INSUFFICIENT"]);
    }
    if (f.der === undefined) return abstain(NAME_V2, "Menunggu data DER (isi di src/data/intel.ts)", ["NEED_DER"]);

    const c = p.candles;
    const close = c[c.length - 1].close;
    const a = assessAcquisition(input, c);
    const pos = input.position;

    // --- Posisi terbuka: keluar bila terbantahkan, trailing stop setelah deal terkonfirmasi ---
    if (hasPos && pos) {
      if (a.stage >= 2) {
        const highest = Math.max(pos.highestPrice ?? pos.entryPrice, close);
        if (close < highest * (1 - TRAILING)) return exitSignal(NAME_V2, 1, `Trailing stop 15% dari puncak ${fmt(highest)}`, "TRAILING_STOP");
      } else if (daysBetween(pos.openedAt, input.now) >= REVIEW_DAYS) {
        return { engine: NAME_V2, action: "HOLD", confidence: 0.3, reason: "Cicil > 6 bulan tanpa konfirmasi, tinjau ulang posisi", tags: ["IN_POSITION", "REVIEW_STAGE1"] };
      }
    }

    if (a.flags.includes("DEBUNKED")) return hold(NAME_V2, "Rumor terbantahkan atau aksi dibatalkan", ["DEBUNKED"]);
    if (!a.structureOk) return hold(NAME_V2, `Struktur belum lolos: ${a.structureFails.join("; ")}`, ["STRUCTURE_FAIL"]);
    if (a.stage === 0) return hold(NAME_V2, "Struktur lolos, belum ada pemicu (rumor, akumulasi senyap, laporan tertata)", ["STRUCTURE_OK", "NO_TRIGGER"]);

    // --- Ukuran: cicil kecil -> deal resmi -> all-in setelah dana/aset nyata masuk ---
    const exposure = pos?.exposurePct ?? 0;
    // Tahap 2/3 mempertimbangkan valuasi wajar: murah = penuh, wajar = setengah, mahal = tetap level cicil, tidak diketahui = maks tahap 2
    let target = a.stage === 1 ? CICIL_MAX_PCT : a.stage === 2 ? PLANNED_TARGET_PCT : ALL_IN_TARGET_PCT;
    if (a.stage >= 2) {
      const lbl = a.valuation.label;
      if (lbl === "WAJAR") target *= 0.5;
      else if (lbl === "MAHAL") target = Math.min(target, CICIL_MAX_PCT);
      else if (lbl === "UNKNOWN") target = Math.min(target, PLANNED_TARGET_PCT);
    }
    const add = a.stage === 1 ? Math.min(CICIL_TRANCHE_PCT, target - exposure) : target - exposure;
    if (add < 0.1) return hold(NAME_V2, `Porsi ${fmt(exposure, 1)}% sudah mencapai target tahap ${a.stage}`, ["AT_TARGET", `STAGE${a.stage}`]);
    if ((input.trackBExposurePct ?? 0) + add > STRATEGY_MAX_EXPOSURE_PCT) {
      return hold(NAME_V2, `Eksposur strategi akan melebihi ${STRATEGY_MAX_EXPOSURE_PCT}%`, ["STRATEGY_CAP"]);
    }

    const turnover = averageTurnover(c);
    const orderType: OrderType = a.stage === 1 || turnover < LIQUIDITY_LOCK ? "LIMIT_STAGED" : "MARKET";
    const label = a.stage === 1 ? "CICIL (rumor/anomali)" : a.stage === 2 ? "DEAL RESMI >= Rp1 T" : "DANA/ASET NYATA >= Rp1 T MASUK (calon naga)";
    const vl = a.valuation;
    const valText = vl.ratio !== undefined ? `harga ${fmt(vl.ratio)}x NAV/saham (${vl.label}, ${vl.basis === "FAIR_VALUE" ? "nilai wajar aset" : "nilai buku"})` : "valuasi tidak diketahui";
    const extra = [a.multiple ? `suntikan ${fmt(a.multiple, 1)}x market cap` : "", a.buyerNote ?? "", a.stage >= 2 ? valText : ""].filter(Boolean).join(", ");
    return {
      engine: NAME_V2,
      action: "BUY",
      confidence: a.stage === 1 ? 0.45 : a.stage === 2 ? 0.65 : 0.85,
      reason: `Tahap ${a.stage} ${label}; pemicu: ${a.triggers.join(", ") || "-"}${extra ? `; ${extra}` : ""}`,
      entry: close,
      stopLoss: a.stage >= 2 ? close * (1 - TRAILING) : undefined,
      positionPct: add, // tambahan porsi pada tahap ini
      orderType,
      tags: ["STANDALONE", `STAGE${a.stage}`, ...a.triggers, ...a.flags, ...(a.stage >= 2 ? [`VALUASI_${vl.label}`] : [])],
    };
  },
};

/* ----------------------------------- V3 ------------------------------------ */

export const an4V3: Engine = {
  name: NAME_V3,
  analyze(input: AnalysisInput): EngineSignal {
    const hasPos = ownsPosition(input, NAME_V3);
    if (hasPos) {
      const emergency = emergencyExit(NAME_V3, input);
      if (emergency) return emergency;
    }
    const p = prepare(input, NAME_V3, hasPos);
    if (!p.ok) return p.signal;
    const f = input.fundamentals;
    if (!f) return abstain(NAME_V3, "Data fundamental tidak tersedia", ["DATA_INSUFFICIENT"]);
    const c = p.candles;
    const close = c[c.length - 1].close;

    if (hasPos) return exitLogic(input, c);
    if (f.der === undefined) return abstain(NAME_V3, "Butuh data DER (isi di src/data/intel.ts)", ["NEED_FUNDAMENTALS"]);

    const cls = classifyTrack(f);
    if (cls === "ELIMINASI") return hold(NAME_V3, "Eliminasi (PBV >= 1 atau tidak masuk Track A/B/Hybrid)", ["ELIMINATED"]);

    const a = screenFundamentalTurnaround(f);
    const s = filterShellCompanies(f);
    const turnover = averageTurnover(c);
    const acc = volumeAccumulation(c, 45, SIDEWAYS_SHORT);
    const obvCmf = acc.obvRising || acc.cmfRising;
    // Prioritas OBV/CMF: broker summary yang bertentangan dengan OBV/CMF diabaikan
    const brokerShare = input.brokerSummary && input.brokerSummary.totalVolume > 0 ? input.brokerSummary.topBuyersVolume / input.brokerSummary.totalVolume : 0;
    const topBuyers = brokerShare > 0.5 && obvCmf;
    const vb = checkVolumeBreakout(c);
    const spike = detectVolSpike(c).spike && acc.sideways;
    const ev = parseCorporateAnnouncements(input.announcements ?? [], sinceDays(input.now, 30));
    const suddenAudit = input.compliance?.voluntaryInterimAudit === true || ev.suddenAudit;

    const sc = scoreConfluence({
      cheap: a.cheap,
      healthy: a.healthy,
      turnaround: a.turnaround,
      profitUpQoQ: a.profitUpQoQ,
      topBuyers,
      breakout: vb.breakout,
      liquid: turnover >= MIN_TURNOVER,
      microCap: s.microCap,
      pbvDistress: s.pbvDistress,
      stagnation: s.stagnation,
      freeFloat: s.freeFloatOk,
      insider: acc.accumulation,
      volSpike: spike,
      event: ev.anyEvent,
      controlChange: ev.controlChange,
      suddenAudit,
      obvCmf,
    });

    const tier = tierForScore(sc.score);
    if (!tier) return hold(NAME_V3, `Skor confluence ${sc.score} < 5: watchlist`, ["WATCHLIST", `TRACK:${cls}`]);

    let pct = tier.pct;
    const pureB = cls === "B" && !sc.aConfirm;
    if (pureB) {
      pct = Math.min(pct, 5);
      if ((input.trackBExposurePct ?? 0) + pct > TRACK_B_PURE_MAX_EXPOSURE_PCT) {
        return hold(NAME_V3, `Eksposur Track B murni akan melebihi ${TRACK_B_PURE_MAX_EXPOSURE_PCT}%`, ["TRACK_B_CAP"]);
      }
    }
    return {
      engine: NAME_V3,
      action: "BUY",
      confidence: Math.min(0.5 + sc.score * 0.03, 0.9),
      reason: `${tier.label} (skor ${sc.score} = ${sc.base} dasar + ${sc.bonus} bonus), track ${cls}, sizing ${tier.range}`,
      entry: close,
      takeProfit: calculateIntrinsicTarget(f, close),
      positionPct: pct,
      orderType: orderTypeFor(tier.label, turnover),
      tags: ["STANDALONE", tier.label, `TRACK:${cls}`, `SCORE:${sc.score}`],
    };
  },
};
