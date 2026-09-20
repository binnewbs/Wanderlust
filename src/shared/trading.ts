/**
 * Trading-day rules shared between the main-process fetcher and the renderer
 * (run-up lookback). Dukascopy publishes no data files for Saturday for
 * FX/metals/indices — only crypto trades 7 days.
 */

/** 24/7 symbols — every other asset has no Saturday data on the datafeed. */
export const CRYPTO_SYMBOLS = new Set([
  'btcusd', 'ethusd', 'btceur', 'etheur', 'dshusd', 'ltcusd', 'adausd'
])

/** Saturday has no data for FX/metals/indices — not a trading day for them. */
export function isTradingDay(dayStartMs: number, symbol: string): boolean {
  if (CRYPTO_SYMBOLS.has(symbol)) return true
  return new Date(dayStartMs).getUTCDay() !== 6 // 6 = Saturday
}