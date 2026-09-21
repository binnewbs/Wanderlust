import { join } from 'path'
import { statSync } from 'fs'
import { app } from 'electron'
import Database from 'better-sqlite3'
import type { Candle, CacheEntry, CacheStats, SingleTimeframeRequest } from '../shared/ipc'

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

/**
 * Estimated on-disk bytes one cached candle occupies. A row stores a short
 * symbol/timeframe plus an integer timestamp and five reals (~60 bytes), and
 * the lookup index roughly doubles that. Deliberately a constant: SQLite has no
 * portable per-table byte counter, and the storage UI labels the figure
 * "approx." while the totals use the real file sizes.
 */
const CACHE_BYTES_PER_CANDLE = 112

/** Resolves (and caches) the cache database's path without opening it. */
function resolveDbFilePath(): string {
  dbFilePath ??= join(app.getPath('userData'), 'wanderlust-cache.db')
  return dbFilePath
}

/** Returns a lazily-initialized handle to the SQLite cache database. */
export function getDb(): Database.Database {
  if (!db) {
    db = new Database(resolveDbFilePath())
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
export function queryCandles(request: SingleTimeframeRequest): Candle[] {
  const [from, to] = dateRangeToMs(request.startDate, request.endDate)
  return queryCandlesRange(request.symbol, request.timeframe, from, to)
}

/** Number of cached candles for a request's date range (for cache-hit checks). */
export function countCandles(request: SingleTimeframeRequest): number {
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

/** On-disk sizes of the cache database and its WAL sidecar files. */
function getCacheFileSizes(): {
  dbSizeBytes: number
  walSizeBytes: number
  shmSizeBytes: number
  totalSizeBytes: number
} {
  const base = resolveDbFilePath()
  const sizeOf = (path: string): number => {
    try {
      return statSync(path).size
    } catch {
      return 0 // not created yet (e.g. no WAL after a clean checkpoint)
    }
  }
  const dbSizeBytes = sizeOf(base)
  const walSizeBytes = sizeOf(`${base}-wal`)
  const shmSizeBytes = sizeOf(`${base}-shm`)
  return {
    dbSizeBytes,
    walSizeBytes,
    shmSizeBytes,
    totalSizeBytes: dbSizeBytes + walSizeBytes + shmSizeBytes
  }
}

/**
 * Cache totals for the Settings → Storage screen: per-group estimates plus the
 * database's real on-disk footprint. Group sizes are approximate; the totals
 * come straight from the filesystem.
 */
export function getCacheStats(): CacheStats {
  const entries = getCacheSummary().map((entry) => ({
    ...entry,
    sizeBytes: entry.candles * CACHE_BYTES_PER_CANDLE
  }))
  const totalCandles = entries.reduce((sum, e) => sum + e.candles, 0)
  const totalEntryBytes = entries.reduce((sum, e) => sum + e.sizeBytes, 0)
  return {
    entries,
    totalCandles,
    totalEntryBytes,
    ...getCacheFileSizes()
  }
}

/**
 * Deletes cached candles. With no arguments the whole cache is cleared; pass a
 * `symbol` and/or `timeframe` to remove only the matching groups. Returns the
 * number of rows removed.
 */
export function deleteCandles(symbol?: string, timeframe?: string): number {
  const clauses: string[] = []
  const params: string[] = []
  if (symbol) {
    clauses.push('symbol = ?')
    params.push(symbol.toLowerCase())
  }
  if (timeframe) {
    clauses.push('timeframe = ?')
    params.push(timeframe)
  }
  const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : ''
  const info = getDb()
    .prepare(`DELETE FROM cached_candles${where}`)
    .run(...params)
  return info.changes
}

/**
 * Reclaims disk space freed by {@link deleteCandles}. SQLite keeps deleted
 * pages (and the WAL) around, so a checkpoint + VACUUM is what actually shrinks
 * the file the user sees. Returns the on-disk sizes after vacuuming.
 */
export function vacuumCache(): { totalSizeBytes: number } {
  const handle = getDb()
  handle.pragma('wal_checkpoint(TRUNCATE)')
  handle.exec('VACUUM')
  handle.pragma('wal_checkpoint(TRUNCATE)')
  return getCacheFileSizes()
}
