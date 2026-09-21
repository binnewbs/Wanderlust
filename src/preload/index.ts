import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import {
  IpcChannels,
  type CacheStatsResponse,
  type CacheSummaryResponse,
  type CachedDataResponse,
  type DeleteCacheRequest,
  type DeleteCacheResult,
  type DownloadProgressEvent,
  type DownloadRequest,
  type DownloadResult,
  type VacuumCacheResult
} from '../shared/ipc'

// Custom APIs for renderer
// Exposed as `window.api.*` so the React app never touches ipcRenderer directly.
const api = {
  /**
   * Triggers a cache-first download of a date range. Resolves with a result
   * describing the outcome; progress is streamed via `onDownloadProgress`.
   */
  downloadData: (request: DownloadRequest): Promise<DownloadResult> =>
    ipcRenderer.invoke(IpcChannels.DownloadData, request),

  /** Reads candles already stored in the local SQLite cache for a range. */
  getCachedData: (request: DownloadRequest): Promise<CachedDataResponse> =>
    ipcRenderer.invoke(IpcChannels.GetCachedData, request),

  /** Lists every (symbol, timeframe) range stored in the cache. */
  getCacheSummary: (): Promise<CacheSummaryResponse> =>
    ipcRenderer.invoke(IpcChannels.GetCacheSummary),

  /** Cache totals, per-group estimates and the database's on-disk size. */
  getCacheStats: (): Promise<CacheStatsResponse> => ipcRenderer.invoke(IpcChannels.GetCacheStats),

  /** Deletes cached candles — all of them, or only the given symbol/timeframe. */
  deleteCacheData: (request: DeleteCacheRequest = {}): Promise<DeleteCacheResult> =>
    ipcRenderer.invoke(IpcChannels.DeleteCacheData, request),

  /** Reclaims disk space freed by deletes; resolves with the new on-disk size. */
  vacuumCache: (): Promise<VacuumCacheResult> => ipcRenderer.invoke(IpcChannels.VacuumCache),

  /**
   * Subscribes to download progress events pushed from the main process.
   * Returns an unsubscribe function.
   */
  onDownloadProgress: (callback: (event: DownloadProgressEvent) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: DownloadProgressEvent): void => {
      callback(payload)
    }
    ipcRenderer.on(IpcChannels.DownloadProgress, listener)
    return () => {
      ipcRenderer.removeListener(IpcChannels.DownloadProgress, listener)
    }
  }
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}

export type WanderlustApi = typeof api
