import { ElectronAPI } from '@electron-toolkit/preload'
import type {
  CacheStatsResponse,
  CacheSummaryResponse,
  CachedDataResponse,
  DeleteCacheRequest,
  DeleteCacheResult,
  DownloadBatchResult,
  DownloadProgressEvent,
  DownloadRequest,
  DownloadResult,
  VacuumCacheResult
} from '../shared/ipc'

export interface WanderlustApi {
  /**
   * Triggers a cache-first download of a date range (Dukascopy primary,
   * HistData fallback). Sends a `DownloadBatchResult` when `request.timeframes`
   * lists more than one timeframe; a plain `DownloadResult` otherwise.
   */
  downloadData: (request: DownloadRequest) => Promise<DownloadResult | DownloadBatchResult>
  /** Reads candles already stored in the local SQLite cache for a range. */
  getCachedData: (request: DownloadRequest) => Promise<CachedDataResponse>
  /** Lists every (symbol, timeframe) range stored in the cache. */
  getCacheSummary: () => Promise<CacheSummaryResponse>
  /** Cache totals, per-group estimates and the database's on-disk size. */
  getCacheStats: () => Promise<CacheStatsResponse>
  /** Deletes cached candles — all of them, or only the given symbol/timeframe. */
  deleteCacheData: (request?: DeleteCacheRequest) => Promise<DeleteCacheResult>
  /** Reclaims disk space freed by deletes; resolves with the new on-disk size. */
  vacuumCache: () => Promise<VacuumCacheResult>
  /** Subscribes to download progress events; returns an unsubscribe function. */
  onDownloadProgress: (callback: (event: DownloadProgressEvent) => void) => () => void
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: WanderlustApi
  }
}

export {}
