import {
  getDb,
  insertCandles,
  queryCandles,
  querySourcedCandlesRange,
  getCacheSummary,
  closeDb
} from './db'
import { histStampToUtcMs, parseHistDataM1, supportsHistData } from './histdata'
import { isBatchRequest } from './ipc'
import type { Candle, SingleTimeframeRequest } from '../shared/ipc'

/**
 * Dev-only self test, invoked from the main process when
 * WANDERLUST_SMOKE=1. Verifies the SQLite cache layer against the real
 * Electron runtime: open schema, write, read back, summarize, then clean up
 * so the cache is left untouched. Also checks the HistData parser's New York
 * timestamp conversion, which is the one piece of the fallback that silently
 * corrupts data if it regresses.
 */
export async function runDbSmokeTest(): Promise<string> {
  const symbol = 'smoketest'
  const timeframe = 'm1'
  const candles: Candle[] = [
    { timestamp: 1704153600000, open: 1.1, high: 1.12, low: 1.09, close: 1.11, volume: 100 },
    { timestamp: 1704153660000, open: 1.11, high: 1.13, low: 1.1, close: 1.12, volume: 150 },
    { timestamp: 1704153720000, open: 1.12, high: 1.14, low: 1.11, close: 1.13, volume: 120 }
  ]

  const inserted = insertCandles(symbol, timeframe, candles, 'dukascopy')
  const fallbackInserted = insertCandles(
    symbol,
    timeframe,
    [
      {
        timestamp: 1704153720000 + 60_000,
        open: 1.13,
        high: 1.14,
        low: 1.12,
        close: 1.13,
        volume: 0
      }
    ],
    'histdata'
  )

  const req: SingleTimeframeRequest = {
    symbol,
    timeframe,
    startDate: '2024-01-02',
    endDate: '2024-01-02'
  }
  const queried = queryCandles(req)
  const sourced = querySourcedCandlesRange(symbol, timeframe, 1704153600000, 1704240000000)
  const summary = getCacheSummary().find((e) => e.symbol === symbol)

  // New York wall-clock -> UTC, DST included. 17:00 in January is 22:00Z, the
  // same wall clock in July is 21:00Z, and the 2026 spring-forward day switches
  // from UTC-5 to UTC-4 at 02:00 local.
  const parsed = parseHistDataM1(
    [
      '20240102 170000;1.10427;1.10429;1.10425;1.10429;0',
      '20240703 170000;1.10427;1.10429;1.10425;1.10429;0',
      '20260308 010000;1.10000;1.10010;1.09990;1.10000;0',
      '20260308 030000;1.10000;1.10010;1.09990;1.10000;0',
      'not a row'
    ].join('\n')
  )
  const stamps = [
    parsed[0]?.timestamp,
    parsed[1]?.timestamp,
    histStampToUtcMs(2026, 3, 8, 1, 0, 0),
    histStampToUtcMs(2026, 3, 8, 3, 0, 0)
  ]
  const timezonesOk =
    parsed.length === 4 &&
    new Date(stamps[0]).toISOString() === '2024-01-02T22:00:00.000Z' &&
    new Date(stamps[1]).toISOString() === '2024-07-03T21:00:00.000Z' &&
    new Date(stamps[2]).toISOString() === '2026-03-08T06:00:00.000Z' &&
    new Date(stamps[3]).toISOString() === '2026-03-08T07:00:00.000Z' &&
    supportsHistData('eurusd') &&
    !supportsHistData('btcusd')

  // The session store sends `timeframes: ['m1']` and reads a BATCH result back.
  // Collapsing a one-entry array into single-timeframe mode made it throw a
  // bare "Download failed." — with no reason in it, for every failed download.
  const batchShapeOk =
    isBatchRequest({
      symbol: 'eurusd',
      startDate: '2026-01-01',
      endDate: '2026-01-02',
      timeframes: ['m1']
    }) &&
    isBatchRequest({
      symbol: 'eurusd',
      startDate: '2026-01-01',
      endDate: '2026-01-02',
      timeframes: ['m1', 'h1']
    }) &&
    !isBatchRequest({
      symbol: 'eurusd',
      startDate: '2026-01-01',
      endDate: '2026-01-02',
      timeframe: 'm1'
    })

  const ok =
    inserted === 3 &&
    fallbackInserted === 1 &&
    queried.length === 4 &&
    queried[0].close === 1.11 &&
    sourced.filter((c) => c.source === 'histdata').length === 1 &&
    summary?.candles === 4 &&
    summary.sources.includes('histdata') &&
    timezonesOk &&
    batchShapeOk

  // Clean up so smoke data never lands in the real cache.
  getDb().prepare('DELETE FROM cached_candles WHERE symbol = ?').run(symbol)

  const result = {
    ok,
    inserted,
    queried: queried.length,
    firstClose: queried[0]?.close ?? null,
    summarizedAs: summary ? `${summary.symbol}:${summary.timeframe}=${summary.candles}` : null,
    sources: summary?.sources ?? [],
    timezonesOk,
    batchShapeOk,
    firstHistStamp: stamps[0] ? new Date(stamps[0]).toISOString() : null
  }

  closeDb()
  return JSON.stringify(result)
}
