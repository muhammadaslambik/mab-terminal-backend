import type { AssetClass, Candle } from "../engines/types";

const nanArray = (n: number): number[] => new Array<number>(n).fill(NaN);

/** Nilai ke-(n - offset) dari belakang; NaN jika tidak ada. */
export const lastNum = (a: number[], offset = 0): number => {
  const v = a[a.length - 1 - offset];
  return v === undefined ? NaN : v;
};

export const mean = (a: number[]): number => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);

export function sma(v: number[], p: number): number[] {
  const out = nanArray(v.length);
  for (let i = p - 1; i < v.length; i++) {
    let s = 0;
    let ok = true;
    for (let j = i - p + 1; j <= i; j++) {
      if (!Number.isFinite(v[j])) {
        ok = false;
        break;
      }
      s += v[j];
    }
    out[i] = ok ? s / p : NaN;
  }
  return out;
}

export function ema(v: number[], p: number): number[] {
  const out = nanArray(v.length);
  if (v.length < p) return out;
  const k = 2 / (p + 1);
  let prev = 0;
  for (let i = 0; i < p; i++) prev += v[i];
  prev /= p;
  out[p - 1] = prev;
  for (let i = p; i < v.length; i++) {
    prev = v[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** RSI Wilder. */
export function rsi(closes: number[], p = 14): number[] {
  const out = nanArray(closes.length);
  if (closes.length <= p) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= p; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  let avgG = gain / p;
  let avgL = loss / p;
  out[p] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
  for (let i = p + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgG = (avgG * (p - 1) + Math.max(d, 0)) / p;
    avgL = (avgL * (p - 1) + Math.max(-d, 0)) / p;
    out[i] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
  }
  return out;
}

/** Stochastic (14,3,3): %K diperhalus 3, %D = SMA 3 dari %K. */
export function stochastic(c: Candle[], kPeriod = 14, dPeriod = 3, smooth = 3): { k: number[]; d: number[] } {
  const raw = nanArray(c.length);
  for (let i = kPeriod - 1; i < c.length; i++) {
    let hh = -Infinity;
    let ll = Infinity;
    for (let j = i - kPeriod + 1; j <= i; j++) {
      hh = Math.max(hh, c[j].high);
      ll = Math.min(ll, c[j].low);
    }
    raw[i] = hh === ll ? 50 : ((c[i].close - ll) / (hh - ll)) * 100;
  }
  const k = sma(raw, smooth);
  return { k, d: sma(k, dPeriod) };
}

/** Average True Range (Wilder). */
export function atr(c: Candle[], p = 14): number[] {
  const out = nanArray(c.length);
  if (c.length <= p) return out;
  const tr = nanArray(c.length);
  for (let i = 1; i < c.length; i++) {
    tr[i] = Math.max(c[i].high - c[i].low, Math.abs(c[i].high - c[i - 1].close), Math.abs(c[i].low - c[i - 1].close));
  }
  let prev = 0;
  for (let i = 1; i <= p; i++) prev += tr[i];
  prev /= p;
  out[p] = prev;
  for (let i = p + 1; i < c.length; i++) {
    prev = (prev * (p - 1) + tr[i]) / p;
    out[i] = prev;
  }
  return out;
}

/** On-Balance Volume. */
export function obv(c: Candle[]): number[] {
  const out = nanArray(c.length);
  if (!c.length) return out;
  let acc = 0;
  out[0] = 0;
  for (let i = 1; i < c.length; i++) {
    if (c[i].close > c[i - 1].close) acc += c[i].volume;
    else if (c[i].close < c[i - 1].close) acc -= c[i].volume;
    out[i] = acc;
  }
  return out;
}

/** Chaikin Money Flow. */
export function cmf(c: Candle[], p = 20): number[] {
  const out = nanArray(c.length);
  const mfv = c.map((x) => {
    const r = x.high - x.low;
    return r === 0 ? 0 : (((x.close - x.low) - (x.high - x.close)) / r) * x.volume;
  });
  for (let i = p - 1; i < c.length; i++) {
    let m = 0;
    let v = 0;
    for (let j = i - p + 1; j <= i; j++) {
      m += mfv[j];
      v += c[j].volume;
    }
    out[i] = v === 0 ? 0 : m / v;
  }
  return out;
}

/** Kemiringan garis regresi linear (positif = naik). */
export function slope(v: number[]): number {
  const y = v.filter(Number.isFinite);
  const n = y.length;
  if (n < 2) return 0;
  const xm = (n - 1) / 2;
  const ym = mean(y);
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - xm) * (y[i] - ym);
    den += (i - xm) ** 2;
  }
  return den === 0 ? 0 : num / den;
}

export function highestIndex(c: Candle[], from: number, to: number): number {
  let idx = from;
  for (let i = from; i <= to; i++) if (c[i].high > c[idx].high) idx = i;
  return idx;
}

export function lowestIndex(c: Candle[], from: number, to: number): number {
  let idx = from;
  for (let i = from; i <= to; i++) if (c[i].low < c[idx].low) idx = i;
  return idx;
}

/** Indeks swing high (pivot) yang sudah terkonfirmasi. */
export function pivotHighs(c: Candle[], left = 3, right = 3): number[] {
  const out: number[] = [];
  for (let i = left; i < c.length - right; i++) {
    let ok = true;
    for (let j = 1; j <= left && ok; j++) if (c[i - j].high >= c[i].high) ok = false;
    for (let j = 1; j <= right && ok; j++) if (c[i + j].high > c[i].high) ok = false;
    if (ok) out.push(i);
  }
  return out;
}

/** Indeks swing low (pivot) yang sudah terkonfirmasi. */
export function pivotLows(c: Candle[], left = 3, right = 3): number[] {
  const out: number[] = [];
  for (let i = left; i < c.length - right; i++) {
    let ok = true;
    for (let j = 1; j <= left && ok; j++) if (c[i - j].low <= c[i].low) ok = false;
    for (let j = 1; j <= right && ok; j++) if (c[i + j].low < c[i].low) ok = false;
    if (ok) out.push(i);
  }
  return out;
}

/**
 * Bersihkan data candle: buang baris NaN/kosong (mis. bursa libur),
 * urutkan berdasarkan waktu, dan hapus duplikat.
 */
export function cleanCandles(candles: Candle[]): Candle[] {
  const valid = candles
    .filter((c) => [c.open, c.high, c.low, c.close].every(Number.isFinite) && !!c.time)
    .map((c) => ({ ...c, volume: Number.isFinite(c.volume) ? c.volume : 0 }));
  valid.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
  return valid.filter((c, i) => i === 0 || c.time !== valid[i - 1].time);
}

export const isWeekend = (iso: string): boolean => {
  const d = new Date(iso).getUTCDay();
  return d === 0 || d === 6;
};

/** Kripto buka 24/7; XAUUSD dan saham tutup di akhir pekan. */
export const isMarketClosed = (assetClass: AssetClass, nowIso: string): boolean =>
  assetClass !== "CRYPTO" && isWeekend(nowIso);

export const daysBetween = (aIso: string, bIso: string): number =>
  (Date.parse(bIso) - Date.parse(aIso)) / 86_400_000;
