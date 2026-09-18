import { join } from 'path'
import { app } from 'electron'
import Database from 'better-sqlite3'
import type { Candle, CacheEntry, DownloadRequest } from '../shared/ipc'

/**
 * SQLite cache for downloaded candles.
 *
 * The database is a pure cache: nothing here fetches data, it only stores and
 * retrieves candles so repeated downloads of the same range are instant.
 * Phase 2 implements the download side; this module is the storage foundation.
 */

// NOTE: `timeframe` is part of the primary key in addition to `symbol` and
// `timestamp`. The plan's schema only keyed on (symbol, timestamp), but two
// timeframes of the same symbol can share a timestamp (e.g. the h1 candle at
// 10:00 and the m1 candle at 10:00) and would overwrite each other.
export const CACHE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS cached_candles (
    symbol    TEXT    NOT NULL,
    timeframe TEXT    NOT NULL,
    timestamp INTEGER NOT NULL,
    open      REAL    NOT NULL,
    high      REAL    NOT NULL,
    low       REAL    NOT NULL,
    close     REAL    NOT NULL,
    volume    REAL    NOT NULL,
    PRIMARY KEY (symbol, timeframe, timestamp)
  )
`

let db: Database.Database | null = null
let dbFilePath: string | null = null

/** Returns a lazily-initialized handle to the SQLite cache database. */
export function getDb(): Database.Database {
  if (!db) {
    dbFilePath ??= join(app.getPath('userData'), 'wanderlust-cache.db')
    db = new Database(dbFilePath)
    db.pragma('journal_mode = WAL')
    db.exec(CACHE_SCHEMA)
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_cached_lookup ON cached_candles (symbol, timeframe, timestamp)'
    )
  }
  return db
}

/** Closes the database handle (called on app quit). Safe to call multiple times. */
export function closeDb(): void {
  if (db) {
    db.close()
    db = null
  }
}

/** Converts an ISO date string into [startUtcMs, endUtcMs], inclusive of both days. */
export function dateRangeToMs(startDate: string, endDate: string): [number, number] {
  const start = new Date(`${startDate}T00:00:00.000Z`).getTime()
  const end = new Date(`${endDate}T00:00:00.000Z`).getTime() + 86_400_000 - 1
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    throw new Error(`Invalid date range: ${startDate} -> ${endDate}`)
  }
  return [start, end]
}

/** Reads candles between two UTC milliseconds (inclusive), ordered by time. */
export function queryCandlesRange(
  symbol: string,
  timeframe: string,
  fromMs: number,
  toMs: number
): Candle[] {
  const rows = getDb()
    .prepare(
      `SELECT timestamp, open, high, low, close, volume
         FROM cached_candles
        WHERE symbol = ? AND timeframe = ? AND timestamp BETWEEN ? AND ?
        ORDER BY timestamp ASC`
    )
    .all(symbol.toLowerCase(), timeframe, fromMs, toMs) as Candle[]
  return rows
}

/** Number of cached candles between two UTC milliseconds (inclusive). */
export function countCandlesRange(
  symbol: string,
  timeframe: string,
  fromMs: number,
  toMs: number
): number {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS n
         FROM cached_candles
        WHERE symbol = ? AND timeframe = ? AND timestamp BETWEEN ? AND ?`
    )
    .get(symbol.toLowerCase(), timeframe, fromMs, toMs) as { n: number }
  return row.n
}

/** Reads candles for a request's date range from the cache, ordered by time. */
export function queryCandles(request: DownloadRequest): Candle[] {
  const [from, to] = dateRangeToMs(request.startDate, request.endDate)
  return queryCandlesRange(request.symbol, request.timeframe, from, to)
}

/** Number of cached candles for a request's date range (for cache-hit checks). */
export function countCandles(request: DownloadRequest): number {
  const [from, to] = dateRangeToMs(request.startDate, request.endDate)
  return countCandlesRange(request.symbol, request.timeframe, from, to)
}

/**
 * Bulk upserts candles into the cache. Returns the number of rows written.
 * (Used by Phase 2's download pipeline; exposed now so the storage layer is
 * complete and testable.)
 */
export function insertCandles(symbol: string, timeframe: string, candles: Candle[]): number {
  if (candles.length === 0) return 0
  const stmt = getDb().prepare(
    `INSERT OR REPLACE INTO cached_candles
       (symbol, timeframe, timestamp, open, high, low, close, volume)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
  const insertAll = getDb().transaction((rows: Candle[]) => {
    for (const c of rows) {
      stmt.run(
        symbol.toLowerCase(),
        timeframe,
        c.timestamp,
        c.open,
        c.high,
        c.low,
        c.close,
        c.volume
      )
    }
  })
  insertAll(candles)
  return candles.length
}

/** Summarizes every (symbol, timeframe) group currently held in the cache. */
export function getCacheSummary(): CacheEntry[] {
  const rows = getDb()
    .prepare(
      `SELECT symbol,
              timeframe,
              COUNT(*)              AS candles,
              MIN(timestamp)        AS first,
              MAX(timestamp)        AS last
         FROM cached_candles
        GROUP BY symbol, timeframe
        ORDER BY symbol ASC, timeframe ASC`
    )
    .all() as Array<{
    symbol: string
    timeframe: string
    candles: number
    first: number
    last: number
  }>
  return rows.map((r) => ({ ...r }))
}
