/**
 * Shared IPC contract between the Electron main process, the preload bridge,
 * and the React renderer. Import this file from all three sides so channel
 * names and payload shapes stay in sync.
 */

export const IpcChannels = {
  /** main <- renderer: request a Dukascopy download (cache-first, then fetch) */
  DownloadData: 'data:download',
  /** main <- renderer: query candles already stored in the local SQLite cache */
  GetCachedData: 'data:get-cached',
  /** main <- renderer: list what is currently stored in the cache (for the UI) */
  GetCacheSummary: 'data:cache-summary',
  /** main -> renderer: progress events emitted while a download is running */
  DownloadProgress: 'data:download-progress'
} as const

export type IpcChannel = (typeof IpcChannels)[keyof typeof IpcChannels]

/** A user-facing request for market data, echoing the dukascopy-node options. */
export interface DownloadRequest {
  /** Dukascopy instrument id, lowercase (e.g. 'eurusd', 'gbpusd', 'xauusd', 'btcusd') */
  symbol: string
  /** Base timeframe of the candles to fetch (e.g. 'm1', 'm5', 'h1', 'd1') */
  timeframe: string
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
  /** 0-100 when known */
  percent?: number
}

export interface DownloadResult {
  ok: boolean
  symbol: string
  timeframe: string
  /** Number of candles delivered by this call */
  candles: number
  /** Where the candles came from this time */
  source: 'cache' | 'dukascopy' | 'mixed' | 'none'
  message?: string
}

/** Shape returned by the GetCacheSummary handler. */
export interface CacheEntry {
  symbol: string
  timeframe: string
  candles: number
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
