import { ElectronAPI } from '@electron-toolkit/preload'
import type {
  CacheSummaryResponse,
  CachedDataResponse,
  DownloadProgressEvent,
  DownloadRequest,
  DownloadResult
} from '../shared/ipc'

export interface WanderlustApi {
  /** Triggers a cache-first download of a date range (Dukascopy fetch in Phase 2). */
  downloadData: (request: DownloadRequest) => Promise<DownloadResult>
  /** Reads candles already stored in the local SQLite cache for a range. */
  getCachedData: (request: DownloadRequest) => Promise<CachedDataResponse>
  /** Lists every (symbol, timeframe) range stored in the cache. */
  getCacheSummary: () => Promise<CacheSummaryResponse>
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
