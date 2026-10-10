/**
 * Tipe data bersama untuk semua engine analisa MAB-Terminal.
 * Semua engine bersifat "pure": menerima AnalysisInput, mengembalikan EngineSignal.
 * Pengambilan data (API, database) dilakukan di luar engine (cron / feed).
 */

export type AssetClass = "CRYPTO" | "XAUUSD" | "ID_STOCK" | "US_STOCK";
export type Action = "BUY" | "SELL" | "HOLD";
export type OrderType = "MARKET" | "LIMIT" | "LIMIT_STAGED";

export interface Candle {
  time: string; // ISO, urut dari lama ke baru
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Fundamentals {
  marketCap?: number; // Rupiah
  pbv?: number;
  avgPbv5y?: number;
  pe?: number;
  industryPe?: number;
  der?: number;
  operatingCashFlow?: number;
  netProfitQuarters?: number[]; // laba bersih per kuartal, lama -> baru
  ocfQuarters?: number[]; // arus kas operasional per kuartal, lama -> baru
  freeFloatPercent?: number;
  macroCatalyst?: boolean; // katalis makro / relaksasi regulasi
}

export interface Compliance {
  sanctionActive?: boolean; // sanksi OJK/BEI aktif atau blacklist
  auditOpinion?: string; // "UNQUALIFIED" = Wajar Tanpa Pengecualian
  delistingWarning?: boolean;
  missingQuarters?: number; // kuartal berturut-turut tanpa data keuangan
  voluntaryInterimAudit?: boolean; // laporan interim audited di Q1-Q3
}

export interface BrokerSummary {
  topBuyersVolume: number; // volume 3-5 broker pembeli teratas (20 hari)
  totalVolume: number; // total volume (20 hari)
}

export interface Announcement {
  date: string;
  title: string;
  body?: string;
}

export interface OrderBookLevel {
  price: number;
  volume: number;
}

export interface OrderBookSnapshot {
  time: number; // epoch ms
  bids: OrderBookLevel[];
  offers: OrderBookLevel[];
}

export interface Trade {
  time: number; // epoch ms
  price: number;
  volume: number;
  side: "HAKA" | "HAKI"; // HAKA = beli di offer, HAKI = jual di bid
}

export interface OpenPosition {
  engine?: string; // nama engine pemilik posisi
  entryPrice: number;
  size: number;
  openedAt: string;
  highestPrice?: number; // harga tertinggi sejak entry
  track?: "A" | "B" | "HYBRID";
  classification?: string; // mis. PREMIUM_DOUBLE_SIGNAL
  partialSoldPct?: number; // 0..1, porsi yang sudah dijual
  eventAnnouncedAt?: string;
}

export interface AnalysisInput {
  symbol: string;
  assetClass: AssetClass;
  now: string; // ISO
  equity: number;
  candles: Candle[]; // time frame utama
  candlesLow?: Candle[]; // time frame lebih rendah (konfirmasi momentum)
  candlesHigh?: Candle[]; // mingguan / bulanan
  tier?: "CORE" | "SPECULATIVE";
  fearGreedIndex?: number;
  targetDates?: string[]; // tanggal target pembalikan (YYYY-MM-DD)
  fundamentals?: Fundamentals;
  compliance?: Compliance;
  brokerSummary?: BrokerSummary;
  announcements?: Announcement[];
  marketRank?: { topGainer?: boolean; topValue?: boolean };
  orderBook?: OrderBookSnapshot[]; // lama -> baru
  trades?: Trade[];
  trackBExposurePct?: number; // eksposur Track B murni saat ini (% portofolio)
  position?: OpenPosition;
}

export interface RiskMetrics {
  currentDrawdownPercent: number;
  isKillSwitchTriggered: boolean;
  safeModeActive: boolean;
}

export interface JournalEntry {
  symbol: string;
  entry: number;
  stopLoss: number;
  takeProfit: number[];
  reasons: string[];
  fearGreedIndex?: number;
  createdAt: string;
}

export interface EngineSignal {
  engine: string;
  action: Action;
  confidence: number; // 0 = tidak ikut voting
  reason: string;
  entry?: number;
  stopLoss?: number;
  takeProfit?: number[];
  positionPct?: number; // % dari ekuitas
  riskPct?: number; // % ekuitas yang dipertaruhkan
  orderType?: OrderType;
  sellFraction?: number; // untuk SELL: porsi dari posisi tersisa (0..1)
  tags?: string[]; // tag "EXIT" = sinyal keluar prioritas
  journal?: JournalEntry;
}

export interface Engine {
  name: string;
  analyze(input: AnalysisInput): EngineSignal;
}

export interface TradeDecision {
  symbol: string;
  action: Action;
  confidence: number;
  reason: string;
  targetDates: string[];
  signals: EngineSignal[];
  lead?: EngineSignal;
}
