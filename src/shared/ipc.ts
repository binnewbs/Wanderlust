/**
 * Shared IPC contract between the Electron main process, the preload bridge,
 * and the React renderer. Import this file from all three sides so channel
 * names and payload shapes stay in sync.
 */

export const IpcChannels = {
  /** main <- renderer: cache-first market-data download (Dukascopy → HistData) */
  DownloadData: 'data:download',
  /** main <- renderer: query candles already stored in the local SQLite cache */
  GetCachedData: 'data:get-cached',
  /** main <- renderer: list what is currently stored in the cache (for the UI) */
  GetCacheSummary: 'data:cache-summary',
  /** main <- renderer: cache totals + on-disk size (Settings → Storage) */
  GetCacheStats: 'data:cache-stats',
  /** main <- renderer: delete cached candles — all of them, or one symbol/timeframe */
  DeleteCacheData: 'data:cache-delete',
  /** main <- renderer: VACUUM the cache database to reclaim disk space */
  VacuumCache: 'data:cache-vacuum',
  /** main -> renderer: progress events emitted while a download is running */
  DownloadProgress: 'data:download-progress'
} as const

export type IpcChannel = (typeof IpcChannels)[keyof typeof IpcChannels]

/** Network data provider a candle came from. `cache` is not a provider. */
export type DataSource = 'dukascopy' | 'histdata'

/**
 * How one download was satisfied. `cache` means every day was already
 * stored; `mixed` means cache days were combined with one or more network
 * providers (or the range itself mixes providers). The `sources` field on the
 * result lists the actual providers either way.
 */
export type DownloadSource = 'cache' | DataSource | 'mixed' | 'none'

/** A user-facing request for market data. Instrument ids stay Dukascopy-style. */
export interface DownloadRequest {
  /** Dukascopy instrument id, lowercase (e.g. 'eurusd', 'gbpusd', 'xauusd', 'btcusd') */
  symbol: string
  /**
   * Base timeframe of the candles to fetch (e.g. 'm1', 'm5', 'h1', 'd1').
   * Used together with `timeframes` OR alone for a single-timeframe download
   * (the default app session sends BOTH: `timeframes` lists every timeframe,
   * `timeframe` names the chart's initial view).
   */
  timeframe?: string
  /**
   * When present (non-empty), download every listed timeframe in one batch.
   * The handler loops them cache-first (existing day-level logic per
   * timeframe), streams progress scaled across the whole batch, and returns a
   * `DownloadBatchResult`. Omit to keep the original single-timeframe flow.
   */
  timeframes?: string[]
  /** ISO date string, inclusive start (e.g. '2024-01-01') */
  startDate: string
  /** ISO date string, inclusive end (e.g. '2024-01-31') */
  endDate: string
}

/** One OHLCV candle. timestamp is UTC epoch milliseconds. */
export interface Candle {
  timestamp: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export type DownloadPhase = 'checking-cache' | 'downloading' | 'saving' | 'ready' | 'error'

/** Progress payload pushed from the main process to the renderer. */
export interface DownloadProgressEvent {
  phase: DownloadPhase
  message: string
  /** 0-100 when known (scaled across the whole batch when `timeframes` was sent) */
  percent?: number
  /** The timeframe this event belongs to (batch downloads only) */
  timeframe?: string
}

export interface DownloadResult {
  ok: boolean
  symbol: string
  timeframe: string
  /** Number of candles delivered by this call */
  candles: number
  /** How the range was satisfied (cache/network/mixed) */
  source: DownloadSource
  /** Actual network providers represented in the returned range */
  sources: DataSource[]
  /**
   * Requested trading days (ISO) that no provider could supply and which are
   * therefore MISSING from this range. Non-empty means the result is a partial
   * range — typically because the most recent day is not published yet.
   */
  missingDays: string[]
  message?: string
}

/**
 * A request narrowed to exactly ONE timeframe — what the fetcher, cache
 * writers, and cache queries operate on (batch requests fan out into these).
 */
export type SingleTimeframeRequest = Omit<DownloadRequest, 'timeframes'> & {
  timeframe: string
}

/** Per-timeframe outcome inside a {@link DownloadBatchResult}. */
export interface TimeframeDownloadResult {
  timeframe: string
  /** Number of candles delivered for this timeframe */
  candles: number
  /** How the range was satisfied (cache/network/mixed) */
  source: DownloadSource
  /** Actual network providers represented in the returned range */
  sources: DataSource[]
  /** Requested trading days (ISO) no provider could supply — see DownloadResult */
  missingDays: string[]
  /** Set when this timeframe failed (the batch continues with the rest) */
  error?: string
}

/** Result of a multi-timeframe session download (`request.timeframes`). */
export interface DownloadBatchResult {
  ok: boolean
  symbol: string
  timeframes: TimeframeDownloadResult[]
  /** Sum of candles across every timeframe */
  totalCandles: number
  message?: string
}

/** Shape returned by the GetCacheSummary handler. */
export interface CacheEntry {
  symbol: string
  timeframe: string
  candles: number
  /** Network providers represented in this (symbol, timeframe) group. */
  sources: DataSource[]
  /** Earliest cached UTC timestamp (ms) */
  first: number | null
  /** Latest cached UTC timestamp (ms) */
  last: number | null
}

export interface CachedDataResponse {
  ok: boolean
  candles: Candle[]
  count: number
  error?: string
}

export interface CacheSummaryResponse {
  ok: boolean
  entries: CacheEntry[]
  error?: string
}

/** A {@link CacheEntry} with an estimated on-disk footprint, for the storage UI. */
export interface CacheStatsEntry extends CacheEntry {
  /** Approximate bytes this (symbol, timeframe) group occupies (candles × row estimate) */
  sizeBytes: number
}

/** Everything the Settings → Storage screen needs to show and explain cache usage. */
export interface CacheStats {
  entries: CacheStatsEntry[]
  /** Sum of candles across every group */
  totalCandles: number
  /** Sum of the per-group estimates (approximate) */
  totalEntryBytes: number
  /** Real on-disk size of the SQLite database file */
  dbSizeBytes: number
  /** Real on-disk size of the write-ahead log file (0 when absent) */
  walSizeBytes: number
  /** Real on-disk size of the shared-memory file (0 when absent) */
  shmSizeBytes: number
  /** db + wal + shm — what the cache actually occupies on disk right now */
  totalSizeBytes: number
}

export interface CacheStatsResponse {
  ok: boolean
  stats: CacheStats | null
  error?: string
}

/**
 * Deletes cached market data. Omit both fields to delete the ENTIRE cache;
 * pass `symbol` and/or `timeframe` to narrow the delete.
 */
export interface DeleteCacheRequest {
  symbol?: string
  timeframe?: string
}

export interface DeleteCacheResult {
  ok: boolean
  /** Number of candle rows removed */
  deleted: number
  error?: string
}

export interface VacuumCacheResult {
  ok: boolean
  /** Total on-disk size (db + wal + shm) after vacuuming */
  totalSizeBytes: number
  error?: string
}
