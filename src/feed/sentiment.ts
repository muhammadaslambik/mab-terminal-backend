// Sentimen judul berbasis kamus kata kunci (Indonesia + Inggris). Estimasi kasar, bukan rekomendasi. Tanpa impor.
export type Senti = "positif" | "netral" | "negatif";

const POS = [
  "surg", "rall", "gain", "rise", "rose", "jump", "soar", "rebound", "record high", "all-time high", "beat", "growth", "grow", "upgrad", "profit", "strong", "recover", "boost", "optimis", "rate cut", "cuts rates", "approve", "inflow", "bullish", "expands",
  "naik", "menguat", "melonjak", "laba", "untung", "tumbuh", "surplus", "rekor", "dividen", "positif", "pulih", "optimis", "meningkat", "membaik", "capai", "cetak", "terbang",
];
const NEG = [
  "fall", "fell", "drop", "plunge", "slump", "loss", "lose", "miss", "downgrad", "recession", "war ", "crash", "tumble", "fear", "weak", "cut jobs", "layoff", "default", "bankrupt", "fraud", "hack", "lawsuit", "sanction", "tariff", "outflow", "bleed", "bearish", "slide", "sink", "warn", "crisis", "concern", "debt",
  "turun", "melemah", "anjlok", "rugi", "merosot", "defisit", "tekanan", "denda", "sanksi", "gagal", "krisis", "ambruk", "jatuh", "negatif", "memburuk", "pailit", "korupsi", "bongkar", "tersangka", "waspada", "susut", "koreksi",
];
const MACRO = [
  "inflation", "inflasi", "interest rate", "suku bunga", "bi rate", "gdp", "pdb", "central bank", "bank sentral", "federal reserve", "fed ", "ecb", "imf", "world bank", "earnings", "laba", "laporan keuangan", "kinerja keuangan", "dividen", "dividend", "regulat", "regulasi", "ojk", "treasury", "yield", "tariff", "tarif", "payroll", "unemployment", "pengangguran", "ekspor", "impor", "apbn", "budget", "anggaran", "rupiah", "cadangan devisa", "obligasi", "bond", "recession", "resesi", "rights issue", "buyback", "stock split", "merger", "akuisisi", "ipo",
];

const has = (t: string, list: string[]) => list.reduce((n, k) => (t.includes(k) ? n + 1 : n), 0);

/** score: positif minus negatif; label dari tanda skor. */
export function scoreTitle(title: string): { score: number; senti: Senti } {
  const t = " " + String(title || "").toLowerCase() + " ";
  const score = has(t, POS) - has(t, NEG);
  return { score, senti: score >= 1 ? "positif" : score <= -1 ? "negatif" : "netral" };
}

/** Berita makro/fundamental: layak diarsipkan untuk mode Investasi. */
export function isMacro(title: string): boolean {
  return has(" " + String(title || "").toLowerCase() + " ", MACRO) > 0;
}
