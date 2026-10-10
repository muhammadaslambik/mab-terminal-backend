import type { AnalysisInput, AssetClass, EngineSignal } from "./types";

/** Engine tidak ikut voting (data kurang / aset tidak sesuai / pasar tutup). */
export const abstain = (engine: string, reason: string, tags: string[] = []): EngineSignal => ({
  engine,
  action: "HOLD",
  confidence: 0,
  reason,
  tags,
});

/** Engine sudah menganalisa, tetapi belum ada sinyal. */
export const hold = (engine: string, reason: string, tags: string[] = []): EngineSignal => ({
  engine,
  action: "HOLD",
  confidence: 0.3,
  reason,
  tags,
});

export const isStock = (a: AssetClass): boolean => a === "ID_STOCK" || a === "US_STOCK";

/** True jika ada posisi terbuka milik engine ini (atau belum ditandai pemiliknya). */
export const ownsPosition = (input: AnalysisInput, engine: string): boolean =>
  !!input.position && (!input.position.engine || input.position.engine === engine);

export const fmt = (n: number, d = 2): string => (Number.isFinite(n) ? n.toFixed(d) : "n/a");
