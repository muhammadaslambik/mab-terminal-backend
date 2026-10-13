import type { Fundamentals, Intel } from "../engines/types";

/**
 * Data riset manual per emiten (kode tanpa ".JK"). Edit file ini lalu deploy ulang.
 * Pasardana mengisi market cap, free float, PBV, PER, dan return 1 tahun secara otomatis.
 * Yang TIDAK ada di sumber otomatis dan harus kamu isi di sini: hutang (DER), laba/arus kas kuartalan,
 * rumor, nilai suntikan dana/aset, dan data pembeli.
 */
export interface IntelEntry extends Intel {
  der?: number; // Debt to Equity Ratio (0 = tanpa hutang)
  netProfitQuarters?: number[]; // laba bersih per kuartal, lama -> baru
  ocfQuarters?: number[]; // arus kas operasional per kuartal, lama -> baru
  voluntaryInterimAudit?: boolean; // laporan keuangan interim mendadak diaudit / tiba-tiba tertata
  asOf?: string; // tanggal data diambil (YYYY-MM-DD)
}

export const INTEL: Record<string, IntelEntry> = {
  // CONTOH (hapus tanda komentar dan ganti dengan data nyata):
  // XXXX: {
  //   der: 0.02,
  //   rumor: "RUMOR", // "NONE" | "RUMOR" | "CREDIBLE" | "DEBUNKED"
  //   injection: { kind: "ASSET", plannedRp: 1.5e12, receivedRp: 0, official: false },
  //   acquirer: { name: "Grup Contoh", type: "CONGLOMERATE_ID", netWorthRp: 5e13 },
  //   valuation: { assetFairValueRp: 4e12, liabilitiesRp: 1e10 }, // aset pada nilai wajar (mis. tanah dinilai harga pasar), untuk NAV per saham
  //   asOf: "2026-10-13",
  // },
};

export const getIntel = (code: string): IntelEntry | undefined => INTEL[code.toUpperCase().replace(/\.JK$/, "")];
