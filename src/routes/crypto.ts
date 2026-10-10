import { binanceTickers } from "../feed/binance";

const SYMBOLS = ["BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "PAXGUSDT"];

export async function handleCrypto(url: URL, env: Env) {
  const tickers = await binanceTickers(SYMBOLS, env);
  return {
    ts: Date.now(),
    tickers: tickers.map((t: any) => ({
      symbol: t.symbol,
      price: parseFloat(t.lastPrice),
      changePct: parseFloat(t.priceChangePercent),
      volume: parseFloat(t.quoteVolume),
      high: parseFloat(t.highPrice),
      low: parseFloat(t.lowPrice),
    })),
    // TODO fase 6: AN-3 Remora state (orderbook delta, HAKA/HAKI dari aggTrade)
  };
}
