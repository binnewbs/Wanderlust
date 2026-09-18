import { getDb, insertCandles, queryCandles, getCacheSummary, closeDb } from './db'
import type { Candle, SingleTimeframeRequest } from '../shared/ipc'

/**
 * Dev-only self test, invoked from the main process when
 * WANDERLUST_SMOKE=1. Verifies the SQLite cache layer against the real
 * Electron runtime: open schema, write, read back, summarize, then clean up
 * so the cache is left untouched.
 */
export async function runDbSmokeTest(): Promise<string> {
  const symbol = 'smoketest'
  const timeframe = 'm1'
  const candles: Candle[] = [
    { timestamp: 1704153600000, open: 1.1, high: 1.12, low: 1.09, close: 1.11, volume: 100 },
    { timestamp: 1704153660000, open: 1.11, high: 1.13, low: 1.1, close: 1.12, volume: 150 },
    { timestamp: 1704153720000, open: 1.12, high: 1.14, low: 1.11, close: 1.13, volume: 120 }
  ]

  const inserted = insertCandles(symbol, timeframe, candles)

  const req: SingleTimeframeRequest = {
    symbol,
    timeframe,
    startDate: '2024-01-02',
    endDate: '2024-01-02'
  }
  const queried = queryCandles(req)
  const summary = getCacheSummary().find((e) => e.symbol === symbol)

  const ok =
    inserted === 3 && queried.length === 3 && queried[0].close === 1.11 && summary?.candles === 3

  // Clean up so smoke data never lands in the real cache.
  getDb().prepare('DELETE FROM cached_candles WHERE symbol = ?').run(symbol)

  const result = {
    ok,
    inserted,
    queried: queried.length,
    firstClose: queried[0]?.close ?? null,
    summarizedAs: summary ? `${summary.symbol}:${summary.timeframe}=${summary.candles}` : null
  }

  closeDb()
  return JSON.stringify(result)
}
