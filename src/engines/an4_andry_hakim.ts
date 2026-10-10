/**
 * an4_andry_hakim — Andry Hakim (khusus saham Indonesia / BEI)
 *   an4V1: Deep Value & Turnaround + Bandarmologi
 *   an4V2: "Cacing-Cacing Naga-Naga" (shell stock & event-driven corporate action)
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
}

export function parseCorporateAnnouncements(anns: Announcement[], sinceIso: string): EventScan {
  const since = sinceIso.slice(0, 10);
  const hits = new Set<string>();
  let suddenAudit = false;
  for (const a of anns) {
    if (a.date.slice(0, 10) < since) continue;
    const text = `${a.title} ${a.body ?? ""}`.toLowerCase();
    for (const k of KEYWORDS) if (text.includes(k)) hits.add(k);
    if (text.includes("laporan keuangan interim") && text.includes("audit")) suddenAudit = true;
  }
  const list = [...hits];
  return { hits: list, anyEvent: list.length > 0, controlChange: list.some((k) => CONTROL_KEYWORDS.includes(k)), suddenAudit };
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
  const freeFloatOk = f.freeFloatPercent !== undefined && f.freeFloatPercent >= 7 && f.freeFloatPercent <= 15;
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
      tags: ["ACCUMULATION_DETECTED", "BREAKOUT_STAGE2"],
    };
  },
};

/* ----------------------------------- V2 ------------------------------------ */

export const an4V2: Engine = {
  name: NAME_V2,
  analyze(input: AnalysisInput): EngineSignal {
    const hasPos = ownsPosition(input, NAME_V2);
    const p = prepare(input, NAME_V2, hasPos);
    if (!p.ok) return p.signal;
    const f = input.fundamentals;
    if (!f) return abstain(NAME_V2, "Data fundamental tidak tersedia", ["DATA_INSUFFICIENT"]);
    const c = p.candles;
    const close = c[c.length - 1].close;

    if (hasPos) return trackBExit(NAME_V2, input, c) ?? hold(NAME_V2, "Tahan posisi (trailing stop 15% aktif)", ["IN_POSITION"]);

    const s = filterShellCompanies(f);
    if (!(s.microCap && s.pbvDistress && s.stagnation)) {
      return hold(NAME_V2, "Bukan kandidat cangkang (market cap, PBV, stagnasi harus terpenuhi)", ["NOT_SHELL"]);
    }
    if (!s.freeFloatOk) return hold(NAME_V2, "Free float di luar 7%-15%", ["FREE_FLOAT_FAIL"]);

    const ev = parseCorporateAnnouncements(input.announcements ?? [], sinceDays(input.now, 30));
    const suddenAudit = input.compliance?.voluntaryInterimAudit === true || ev.suddenAudit;
    const insider = volumeAccumulation(c, 45, SIDEWAYS_SHORT).accumulation;
    const spike = detectVolSpike(c).spike;
    const confirmations = [ev.anyEvent, suddenAudit, insider, spike].filter(Boolean).length;
    if (confirmations < 2) return hold(NAME_V2, `Kandidat cangkang, konfirmasi baru ${confirmations}/4`, ["SHELL_CANDIDATE"]);

    const turnover = averageTurnover(c);
    const tags = ["SHELL_CANDIDATE"];
    if (insider) tags.push("INSIDER_ACCUMULATION");
    if (spike) tags.push("VOL_SPIKE_DETECTED");
    if (ev.anyEvent) tags.push(...ev.hits.map((k) => `KEYWORD:${k}`));
    if (suddenAudit) tags.push("SUDDEN_AUDIT");
    return {
      engine: NAME_V2,
      action: "BUY",
      confidence: Math.min(0.4 + 0.1 * confirmations, 0.8),
      reason: `Cangkang + ${confirmations}/4 konfirmasi event/akumulasi`,
      entry: close,
      stopLoss: close * (1 - TRAILING),
      positionPct: confirmations >= 3 ? 5 : 2.5,
      orderType: turnover < LIQUIDITY_LOCK ? "LIMIT_STAGED" : "MARKET",
      tags,
    };
  },
};

/* ----------------------------------- V3 ------------------------------------ */

export const an4V3: Engine = {
  name: NAME_V3,
  analyze(input: AnalysisInput): EngineSignal {
    const hasPos = ownsPosition(input, NAME_V3);
    const p = prepare(input, NAME_V3, hasPos);
    if (!p.ok) return p.signal;
    const f = input.fundamentals;
    if (!f) return abstain(NAME_V3, "Data fundamental tidak tersedia", ["DATA_INSUFFICIENT"]);
    const c = p.candles;
    const close = c[c.length - 1].close;

    if (hasPos) return exitLogic(input, c);

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
      tags: [tier.label, `TRACK:${cls}`, `SCORE:${sc.score}`],
    };
  },
};
