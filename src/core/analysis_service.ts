import type { AnalysisInput, Announcement, Fundamentals, RiskMetrics, TradeDecision } from "../engines/types";
import { BinanceFeed } from "../feed/binance";
import { YahooFeed } from "../feed/yahoo";
import { PasardanaFeed, type IdxStock } from "../feed/pasardana";
import { getIntel } from "../data/intel";
import { loadIdxIntel, type IdxIntelView } from "../data/intel_kv";
import { MarketOrchestrator } from "./orchestrator";

// Sementara: belum ada pelacakan portofolio, jadi risk guard memakai nilai netral.
const NO_RISK: RiskMetrics = { currentDrawdownPercent: 0, isKillSwitchTriggered: false, safeModeActive: false };

/**
 * Judul pengumuman IDX BUKAN konfirmasi (emiten bisa justru pembeli, contoh FOLK). Kata kunci engine Andry Hakim
 * ("akuisisi", "private placement") akan menjadikannya pemicu BUY tahap 1, jadi secara bawaan tidak diumpankan.
 * Ubah ke true hanya bila Anda ingin judul ikut memicu cicil.
 */
export const FEED_ANNOUNCEMENTS_TO_ENGINE = false;

export interface IdxIntelSummary {
  source: string;
  fsDate: string | null;
  receivedAt: string | null;
  derUsed: number | null;
  derFrom: "manual" | "IDX" | null;
  floatUsedPct: number | null;
  floatFrom: "IDX (saham beredar)" | "Pasardana" | null;
  ownerPct: number | null;
  treasuryPct: number | null;
  marketCapFrom: "TradingView" | "Pasardana" | null;
  announcementsFedToEngine: boolean;
  announcements: Array<{ date: string; level: string; title: string; pdf: string | null }>;
  note: string;
}

/**
 * Analisa satu aset kripto: ambil candle (harian untuk engine, 4 jam untuk konfirmasi momentum,
 * mingguan untuk DCA), jalankan semua engine lewat orchestrator.
 */
export async function analyzeCrypto(symbol: string, equity = 10_000, risk: RiskMetrics = NO_RISK): Promise<TradeDecision> {
  const binance = new BinanceFeed();
  const [candles, candlesLow, candlesHigh] = await Promise.all([
    binance.getCandles(symbol, "1d", 300),
    binance.getCandles(symbol, "4h", 100),
    binance.getCandles(symbol, "1w", 60),
  ]);
  if (candles.length === 0) throw new Error(`Data candle ${symbol} kosong (Binance tidak merespons)`);

  const input: AnalysisInput = {
    symbol: `${symbol.toUpperCase()}USDT`,
    assetClass: "CRYPTO",
    now: new Date().toISOString(),
    equity,
    candles,
    candlesLow,
    candlesHigh,
  };
  return new MarketOrchestrator().orchestrateAssetAnalysis(input, risk);
}

/** Data satu saham dari Pasardana (market cap, free float, PBV, PER, return 1 tahun); undefined jika gagal. */
async function lookupPasardana(code: string): Promise<IdxStock | undefined> {
  try {
    const rows = await new PasardanaFeed().getStocks({ search: code, perPage: 10 });
    return rows.find((r) => r.code === code);
  } catch {
    return undefined;
  }
}

function summarizeIdxIntel(kv: IdxIntelView, manualDer: number | undefined, floatUsed: number | undefined, capFromTv: boolean): IdxIntelSummary {
  return {
    source: "idx.co.id via kolektor (KV INTEL_IDX)",
    fsDate: kv.fsDate,
    receivedAt: kv.receivedAt,
    derUsed: manualDer ?? kv.der ?? null,
    derFrom: manualDer !== undefined ? "manual" : kv.der !== undefined ? "IDX" : null,
    floatUsedPct: floatUsed ?? null,
    floatFrom: kv.publicPct !== undefined ? "IDX (saham beredar)" : floatUsed !== undefined ? "Pasardana" : null,
    ownerPct: kv.ownerPct ?? null,
    treasuryPct: kv.treasuryPct ?? null,
    marketCapFrom: capFromTv ? "TradingView" : null,
    announcementsFedToEngine: FEED_ANNOUNCEMENTS_TO_ENGINE,
    announcements: kv.announcements,
    note: "Judul pengumuman bukan konfirmasi (arah transaksi, nilai, dan dana masuk dibaca manual dari PDF). rumor/injection/acquirer tetap hanya dari src/data/intel.ts.",
  };
}

/**
 * Analisa satu saham Indonesia: candle harian Yahoo (kode tanpa ".JK"), data Pasardana, intel IDX dari KV
 * (bila `env` diberikan dan emiten ada di INTEL_IDX), dan riset manual di src/data/intel.ts (rumor, suntikan, pembeli;
 * DER manual menang atas DER IDX). Tanpa DER, engine Andry Hakim abstain. Remora butuh order book, jadi abstain.
 */
export async function analyzeIdx(
  code: string,
  marketRank?: { topGainer?: boolean; topValue?: boolean },
  equity = 100_000_000,
  risk: RiskMetrics = NO_RISK,
  env?: any
): Promise<TradeDecision & { idxIntel?: IdxIntelSummary }> {
  const symbol = code.toUpperCase().replace(/\.JK$/, "");
  const candles = await new YahooFeed().getCandles(`${symbol}.JK`, "2y", "1d");
  if (candles.length === 0) throw new Error(`Data candle ${symbol}.JK kosong (Yahoo tidak merespons)`);

  const stock = await lookupPasardana(symbol);
  const entry = getIntel(symbol);
  let kv: IdxIntelView | null = null;
  try {
    kv = await loadIdxIntel(env, symbol);
  } catch {
    kv = null; // KV bermasalah tidak boleh menggagalkan analisa
  }

  const floatUsed = kv?.publicPct ?? stock?.freeFloatPct;
  const fundamentals: Fundamentals | undefined =
    stock || entry || kv
      ? {
          marketCap: kv?.marketCapRp ?? stock?.marketCap,
          pbv: stock?.pbv,
          pe: stock?.per,
          freeFloatPercent: floatUsed,
          return1y: stock?.oneYear,
          sharesOutstanding: stock?.marketCap && stock.last && stock.last > 0 ? stock.marketCap / stock.last : undefined,
          der: entry?.der ?? kv?.der,
          netProfitQuarters: entry?.netProfitQuarters,
          ocfQuarters: entry?.ocfQuarters,
        }
      : undefined;

  const announcements: Announcement[] | undefined =
    FEED_ANNOUNCEMENTS_TO_ENGINE && kv && kv.announcements.length > 0 ? kv.announcements.map((a) => ({ date: a.date, title: a.title })) : undefined;

  const input: AnalysisInput = {
    symbol,
    assetClass: "ID_STOCK",
    now: new Date().toISOString(),
    equity,
    candles,
    marketRank,
    fundamentals,
    announcements,
    compliance: entry?.voluntaryInterimAudit !== undefined ? { voluntaryInterimAudit: entry.voluntaryInterimAudit } : undefined,
    intel: entry ? { rumor: entry.rumor, injection: entry.injection, acquirer: entry.acquirer, valuation: entry.valuation, notes: entry.notes } : undefined,
  };
  const decision = await new MarketOrchestrator().orchestrateAssetAnalysis(input, risk);
  return kv ? Object.assign(decision, { idxIntel: summarizeIdxIntel(kv, entry?.der, floatUsed, kv.marketCapRp !== undefined) }) : decision;
}
