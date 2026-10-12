/**
 * Daftar saham Indonesia yang dipantau (kode tanpa ".JK").
 * Ini contoh saham yang umumnya likuid, BUKAN daftar resmi LQ45 (keanggotaan indeks berubah tiap semester).
 * Edit sesuka hati. Maksimal ~35 kode, karena paket gratis Cloudflare membatasi 50 request per eksekusi.
 */
export const IDX_UNIVERSE: string[] = [
  "BBCA", "BBRI", "BMRI", "BBNI", "BRIS", "TLKM", "ASII", "UNVR", "ICBP", "INDF",
  "KLBF", "CPIN", "ADRO", "PTBA", "ITMG", "ANTM", "MDKA", "INCO", "MEDC", "PGAS",
  "AKRA", "SMGR", "INTP", "MAPI", "ACES", "EXCL", "ISAT", "TOWR", "JSMR", "BSDE",
  "CTRA", "PWON", "GOTO", "ARTO", "BUKA",
];
