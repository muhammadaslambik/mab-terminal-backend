export interface FibonacciLevels {
  fib50: number;
  fib618: number;
}

export interface PositionSizeResult {
  allowed: boolean;
  allocationPercent: number;
  maxEquityAllocation: number;
  message: string;
  suggestedLayers?: number;
  stopLossPrice?: number;
}

export class AstronacciEngine {
  
  /**
   * PILAR 1: TIME ENGINE (Astronacci Time Cycle Classifier)
   * Mengecek apakah tanggal evaluasi berada dalam jendela pembalikan (Turning Point Windows)
   * Jendela waktu didefinisikan sebagai 3 hari sebelum dan sesudah target tanggal.
   */
  public checkTimeZone(evaluationDateStr: string, targetDates: string[]): boolean {
    if (!evaluationDateStr || !targetDates || targetDates.length === 0) return false;
    
    try {
      const evalDate = new Date(evaluationDateStr);
      if (isNaN(evalDate.getTime())) return false;

      // Konversi ke timestamp hari demi kemudahan kalkulasi selisih
      const evalTime = evalDate.setHours(0, 0, 0, 0);
      const MS_PER_DAY = 24 * 60 * 60 * 1000;

      for (const targetStr of targetDates) {
        const targetDate = new Date(targetStr);
        if (isNaN(targetDate.getTime())) continue;
        
        const targetTime = targetDate.setHours(0, 0, 0, 0);
        const dayDifference = Math.abs(evalTime - targetTime) / MS_PER_DAY;

        // Aturan Prof Gema: Jendela waktu +- 3 hari dari Turning Point
        if (dayDifference <= 3) {
          return true;
        }
      }
    } catch (error) {
      // Fallback handling data kosong/corrupt
      return false;
    }
    
    return false;
  }

  /**
   * PILAR 2: PRICE ENGINE (Fibonacci Retracement & Trend Filter)
   * Mencari level Golden Ratio Buy Zone (50.0% & 61.8%) dari harga ekstrim
   */
  public calculateFibonacci(high: number, low: number): FibonacciLevels {
    if (high <= low || isNaN(high) || isNaN(low)) {
      return { fib50: 0, fib618: 0 };
    }
    
    const diff = high - low;
    const fib50 = high - (diff * 0.50);
    const fib618 = high - (diff * 0.618);

    return { fib50, fib618 };
  }

  /**
   * PILAR 2: HOOK PATTERN TRIGGER (Kepala Cangkul)
   * Mengonfirmasi pola Beli berdasarkan tren EMA, area Fibonacci, dan Stochastic Cross
   */
  public detectHookPattern(
    currentPrice: number,
    ema50: number,
    ema200: number,
    fib50: number,
    fib618: number,
    stochK: number,
    stochD: number
  ): boolean {
    // Fallback/Safety Check untuk bursa akhir pekan/data NaN
    if ([currentPrice, ema50, ema200, fib50, fib618, stochK, stochD].some(val => isNaN(val) || val === undefined)) {
      return false;
    }

    // 1. Deteksi Tren: Harga wajib berada di atas EMA 50 dan EMA 200 (Uptrend)
    const isUptrend = currentPrice > ema50 && currentPrice > ema200;

    // 2. Area Diskon: Harga berada di dalam Golden Ratio Buy Zone (koreksi sehat)
    const isInBuyZone = currentPrice <= fib50 && currentPrice >= fib618;

    // 3. Stochastic Confirmation: Oversold (< 20) dan terjadi Golden Cross (K memotong ke atas D)
    const isOversold = stochK < 20 || stochD < 20;
    const isGoldenCross = stochK > stochD;

    // Mengembalikan True jika semua kondisi "Kepala Cangkul" terpenuhi
    return isUptrend && isInBuyZone && isOversold && isGoldenCross;
  }

  /**
   * PILAR 3: RISK MANAGEMENT & ASSET FILTER ENGINE
   * Kalkulator otomatis manajemen modal multi-aset terkomputerisasi
   */
  public calculatePositionSize(
    assetClass: 'CRYPTO' | 'XAUUSD' | 'SAHAM_ID' | 'SAHAM_US',
    equity: number,
    currentPrice: number,
    isTimeZone: boolean,
    swingLow?: number
  ): PositionSizeResult {
    if (equity <= 0 || currentPrice <= 0 || isNaN(equity) || isNaN(currentPrice)) {
      return { allowed: false, allocationPercent: 0, maxEquityAllocation: 0, message: "Invalid parameters" };
    }

    switch (assetClass) {
      case 'CRYPTO':
        // Swing Positioning - Alokasi maks 15% - DCA Otomatis jika Time Zone Aktif
        return {
          allowed: true,
          allocationPercent: 15,
          maxEquityAllocation: equity * 0.15,
          message: isTimeZone 
            ? "TIME ZONE MATCH: Eksekusi akumulasi DCA otomatis diizinkan (No Leverage)."
            : "Di luar Jendela Waktu Siklus. Akumulasi DCA ditangguhkan."
        };

      case 'XAUUSD':
        // Leverage Margin Trading - Alokasi maks 10% - Maks 3 Layer - Resiko 2% per layer
        const maxGoldAllocation = equity * 0.10;
        let stopLossPrice = swingLow ? swingLow - 3 : currentPrice * 0.98; // Fallback SL 3 poin di bawah swing low

        return {
          allowed: true,
          allocationPercent: 10,
          maxEquityAllocation: maxGoldAllocation,
          suggestedLayers: 3,
          stopLossPrice: stopLossPrice,
          message: "Mode Trading Margin Aktif. Maksimal alokasi dibagi 3 posisi layer terpisah. Wajib pasang Stop Loss."
        };

      case 'SAHAM_ID':
        // Swing Saham Lokal - Alokasi maks 40% - Cicil maks 3 kali transaksi - Max SL 5%
        return {
          allowed: true,
          allocationPercent: 40,
          maxEquityAllocation: equity * 0.40,
          stopLossPrice: currentPrice * 0.95,
          message: "Swing Trading Saham ID (LQ45). Alokasi maksimal 40% modal global. Cicil beli maksimal 3 kali."
        };

      case 'SAHAM_US':
        // Swing Saham US - Alokasi maks 35% - Cicil maks 3 kali transaksi - Max SL 5%
        return {
          allowed: true,
          allocationPercent: 35,
          maxEquityAllocation: equity * 0.35,
          stopLossPrice: currentPrice * 0.95,
          message: "Swing Trading Saham US (S&P 500). Alokasi maksimal 35% modal global. Cicil beli maksimal 3 kali."
        };

      default:
        return { allowed: false, allocationPercent: 0, maxEquityAllocation: 0, message: "Aset tidak terdaftar." };
    }
  }
}
