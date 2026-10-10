/**
 * an3_remora — Hengky Adinata (Remora Trader)
 * Scalping intraday saham Indonesia berbasis order book Level 2 + time & sales.
 * Pilar 1: filter saham aktif (top gainer/value, ATR > 4%, nilai transaksi di atas rata-rata 20 hari)
 * Pilar 2: bid/offer ratio, deteksi fake bid/offer (laju pencabutan antrean), Haka/Haki micro-burst
 * Pilar 3: looping cepat, TP tipis, stop loss 2 tick, porsi dana kecil
 * Data real-time (WebSocket) diambil di luar engine, lalu dikirim lewat input.orderBook & input.trades.
 */
import type { AnalysisInput, Engine, EngineSignal, OrderBookLevel, OrderBookSnapshot, Trade } from "./types";
import { abstain, fmt, hold, ownsPosition } from "./common";
import { atr, cleanCandles, lastNum, mean } from "../utils/indicators";

const NAME = "an3_remora";
const LEVELS = 10; // kedalaman antrean yang dibaca
const BURST_WINDOW_MS = 5_000;
const BASELINE_MS = 60_000;
const BURST_MULT = 3; // haka window >= 3x rata-rata window sebelumnya
const HAKA_RATIO_MIN = 2; // haka : haki minimal 2 : 1
const FAKE_CANCEL_RATE = 0.5; // >50% antrean tercabut tanpa transaksi = fake / bantalan hilang
const MAX_DATA_AGE_MS = 3_000; // data lebih tua dari ini dianggap basi (latency)
const SL_TICKS = 2;
const TP_MIN_TICKS = 3;
const TP_PCT = 0.01;
const POSITION_PCT = 5; // % dari modal day trading (aturan: 5-10%)
const ATR_MIN_PCT = 4;

/** Fraksi harga BEI. */
export function idxTickSize(price: number): number {
  if (price < 200) return 1;
  if (price < 500) return 2;
  if (price < 2000) return 5;
  if (price < 5000) return 10;
  return 25;
}

const roundToTick = (price: number, up: boolean): number => {
  const t = idxTickSize(price);
  return (up ? Math.ceil(price / t) : Math.floor(price / t)) * t;
};

/* ----------------------------- PILAR 1: FILTER ---------------------------- */

export interface ActiveTickerResult {
  pass: boolean;
  atrPct: number;
  valueRatio: number;
  reason: string;
}

export function filterActiveTickers(input: AnalysisInput): ActiveTickerResult {
  const c = cleanCandles(input.candles);
  if (c.length < 22) return { pass: false, atrPct: NaN, valueRatio: NaN, reason: "Data harian kurang" };
  const last = c[c.length - 1];
  const atrPct = (lastNum(atr(c, 14)) / last.close) * 100;
  const avg20 = mean(c.slice(-21, -1).map((x) => x.close * x.volume));
  const valueRatio = avg20 > 0 ? (last.close * last.volume) / avg20 : 0;
  const ranked = !!(input.marketRank?.topGainer || input.marketRank?.topValue);
  const pass = ranked && atrPct > ATR_MIN_PCT && valueRatio > 1;
  return {
    pass,
    atrPct,
    valueRatio,
    reason: `rank=${ranked}, ATR=${fmt(atrPct, 1)}%, nilai/avg20=${fmt(valueRatio)}x`,
  };
}

/* --------------------------- PILAR 2: ORDER BOOK -------------------------- */

export interface BookStats {
  bestBid: number;
  bestOffer: number;
  bidVol: number;
  offerVol: number;
  ratio: number; // bid : offer
  bidCancelRate: number;
  offerCancelRate: number;
  fakeBid: boolean;
  fakeOffer: boolean;
}

const sumVol = (lv: OrderBookLevel[]): number => lv.reduce((s, l) => s + l.volume, 0);
const topLevels = (lv: OrderBookLevel[], desc: boolean): OrderBookLevel[] =>
  [...lv].sort((a, b) => (desc ? b.price - a.price : a.price - b.price)).slice(0, LEVELS);

/** Volume antrean yang hilang tanpa dieksekusi = dicabut (cancel). */
function cancelRate(prev: OrderBookLevel[], cur: OrderBookLevel[], tradedVol: number): number {
  const curMap = new Map(cur.map((l) => [l.price, l.volume]));
  let removed = 0;
  for (const l of prev) removed += Math.max(l.volume - (curMap.get(l.price) ?? 0), 0);
  const prevTotal = sumVol(prev);
  return prevTotal > 0 ? Math.max(removed - tradedVol, 0) / prevTotal : 0;
}

export function analyzeOrderBookDynamics(snaps: OrderBookSnapshot[], trades: Trade[]): BookStats | null {
  const cur = snaps[snaps.length - 1];
  if (!cur) return null;
  const bids = topLevels(cur.bids, true);
  const offers = topLevels(cur.offers, false);
  if (!bids.length || !offers.length) return null;

  let bidCancel = 0;
  let offerCancel = 0;
  const prev = snaps.length > 1 ? snaps[snaps.length - 2] : undefined;
  if (prev) {
    const between = trades.filter((t) => t.time > prev.time && t.time <= cur.time);
    const haki = between.filter((t) => t.side === "HAKI").reduce((s, t) => s + t.volume, 0);
    const haka = between.filter((t) => t.side === "HAKA").reduce((s, t) => s + t.volume, 0);
    bidCancel = cancelRate(topLevels(prev.bids, true), cur.bids, haki);
    offerCancel = cancelRate(topLevels(prev.offers, false), cur.offers, haka);
  }
  const bidVol = sumVol(bids);
  const offerVol = sumVol(offers);
  return {
    bestBid: bids[0].price,
    bestOffer: offers[0].price,
    bidVol,
    offerVol,
    ratio: offerVol > 0 ? bidVol / offerVol : Infinity,
    bidCancelRate: bidCancel,
    offerCancelRate: offerCancel,
    fakeBid: bidCancel >= FAKE_CANCEL_RATE,
    fakeOffer: offerCancel >= FAKE_CANCEL_RATE,
  };
}

export interface HakaStats {
  hakaWindow: number;
  hakiWindow: number;
  ratio: number;
  burst: boolean;
}

/** Haka/Haki tracker: lonjakan Haka dalam beberapa detik dibanding baseline 1 menit sebelumnya. */
export function trackHakaHakiVolume(trades: Trade[], nowMs: number): HakaStats {
  const wStart = nowMs - BURST_WINDOW_MS;
  const bStart = nowMs - BASELINE_MS;
  let hakaWindow = 0;
  let hakiWindow = 0;
  let hakaBase = 0;
  for (const t of trades) {
    if (t.time >= wStart && t.time <= nowMs) {
      if (t.side === "HAKA") hakaWindow += t.volume;
      else hakiWindow += t.volume;
    } else if (t.time >= bStart && t.time < wStart && t.side === "HAKA") {
      hakaBase += t.volume;
    }
  }
  const baselinePerWindow = hakaBase / ((BASELINE_MS - BURST_WINDOW_MS) / BURST_WINDOW_MS);
  const ratio = hakaWindow / Math.max(hakiWindow, 1);
  const burst = hakaWindow > 0 && hakaWindow >= BURST_MULT * Math.max(baselinePerWindow, 1) && ratio >= HAKA_RATIO_MIN;
  return { hakaWindow, hakiWindow, ratio, burst };
}

/* --------------------------- PILAR 3: LOOPING ----------------------------- */

/** Keputusan keluar: stop loss ketat, bantalan bid hilang, atau take profit tipis (lalu siap looping lagi). */
export function executeLoopingStrategy(input: AnalysisInput, book: BookStats): EngineSignal {
  const pos = input.position!;
  const tick = idxTickSize(pos.entryPrice);
  const stop = pos.entryPrice - SL_TICKS * tick;
  const tp = roundToTick(pos.entryPrice + Math.max(TP_MIN_TICKS * tick, pos.entryPrice * TP_PCT), true);
  const exit = (reason: string, tag: string): EngineSignal => ({
    engine: NAME,
    action: "SELL",
    confidence: 0.95,
    reason,
    sellFraction: 1,
    orderType: "MARKET",
    tags: ["EXIT", tag],
  });
  if (book.bestBid <= stop) return exit(`Stop loss: bid ${book.bestBid} <= ${stop}`, "STOP_LOSS");
  if (book.fakeBid) return exit("Bantalan bid dicabut, keluar segera", "BID_PULLED");
  if (book.bestBid >= tp) return exit(`Take profit ${tp} tercapai, modal diputar kembali`, "TAKE_PROFIT");
  return { engine: NAME, action: "HOLD", confidence: 0.3, reason: `Tahan posisi (SL ${stop}, TP ${tp})`, tags: ["IN_POSITION"] };
}

/* --------------------------------- ENGINE -------------------------------- */

export const an3Remora: Engine = {
  name: NAME,
  analyze(input: AnalysisInput): EngineSignal {
    if (input.assetClass !== "ID_STOCK") return abstain(NAME, "Hanya untuk saham Indonesia", ["N/A"]);
    const hasPos = ownsPosition(input, NAME);
    const nowMs = Date.parse(input.now);
    const snaps = input.orderBook ?? [];
    const latest = snaps[snaps.length - 1];

    // Mitigasi latency: data basi/tidak ada -> jangan buka posisi; posisi terbuka ditutup defensif
    if (!latest || nowMs - latest.time > MAX_DATA_AGE_MS) {
      if (hasPos) {
        return {
          engine: NAME,
          action: "SELL",
          confidence: 0.9,
          reason: "Data order book basi/terputus, keluar defensif agar stop loss tidak terlewat",
          sellFraction: 1,
          orderType: "MARKET",
          tags: ["EXIT", "STALE_DATA"],
        };
      }
      return abstain(NAME, "Data order book tidak segar", ["STALE_DATA"]);
    }

    const book = analyzeOrderBookDynamics(snaps, input.trades ?? []);
    if (!book) return abstain(NAME, "Order book kosong", ["NO_BOOK"]);
    if (hasPos) return executeLoopingStrategy(input, book);

    const active = filterActiveTickers(input);
    if (!active.pass) return hold(NAME, `Saham belum memenuhi filter aktif (${active.reason})`, ["FILTER_FAIL"]);

    const haka = trackHakaHakiVolume(input.trades ?? [], nowMs);
    if (!haka.burst) return hold(NAME, "Belum ada lonjakan Haka", ["NO_BURST"]);
    if (book.ratio < 1 || book.fakeBid) {
      return hold(NAME, `Antrean tidak mendukung (bid:offer ${fmt(book.ratio)}, fakeBid=${book.fakeBid})`, ["BOOK_WEAK"]);
    }

    const entry = book.bestOffer; // beli di offer (Haka)
    const tick = idxTickSize(entry);
    const stopLoss = entry - SL_TICKS * tick;
    const takeProfit = [roundToTick(entry + Math.max(TP_MIN_TICKS * tick, entry * TP_PCT), true)];
    return {
      engine: NAME,
      action: "BUY",
      confidence: 0.7,
      reason: `SMART_MONEY_INFLOW: haka ${haka.hakaWindow} vs haki ${haka.hakiWindow}, bid:offer ${fmt(book.ratio)}`,
      entry,
      stopLoss,
      takeProfit,
      positionPct: POSITION_PCT,
      orderType: "MARKET",
      tags: ["SMART_MONEY_INFLOW"],
    };
  },
};
