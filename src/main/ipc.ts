import { ipcMain, BrowserWindow } from 'electron'
import {
  IpcChannels,
  type CacheSummaryResponse,
  type CachedDataResponse,
  type DownloadProgressEvent,
  type DownloadRequest,
  type DownloadResult
} from '../shared/ipc'
import { countCandles, getCacheSummary, queryCandles, insertCandles } from './db'
import { fetchFromDukascopy } from './dukascopy'

/** Validates an unknown payload from the renderer into a DownloadRequest. */
function toDownloadRequest(value: unknown): DownloadRequest | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  if (
    typeof v.symbol !== 'string' ||
    typeof v.timeframe !== 'string' ||
    typeof v.startDate !== 'string' ||
    typeof v.endDate !== 'string'
  ) {
    return null
  }
  const req: DownloadRequest = {
    symbol: v.symbol.trim().toLowerCase(),
    timeframe: v.timeframe.trim().toLowerCase(),
    startDate: v.startDate,
    endDate: v.endDate
  }
  // Reject nonsense dates up-front so errors surface in the UI rather than in SQL.
  const s = Date.parse(`${req.startDate}T00:00:00Z`)
  const e = Date.parse(`${req.endDate}T00:00:00Z`)
  if (!Number.isFinite(s) || !Number.isFinite(e) || e < s) return null
  return req
}

/** Pushes a progress event back to the renderer that made the request. */
function sendProgress(event: Electron.IpcMainInvokeEvent, payload: DownloadProgressEvent): void {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (win && !win.isDestroyed()) {
    win.webContents.send(IpcChannels.DownloadProgress, payload)
  }
}

/**
 * Registers all IPC handlers for the app.
 *
 * - `data:download`          cache-first download of a date range (Dukascopy fetch in Phase 2)
 * - `data:get-cached`        query candles already in the local cache
 * - `data:cache-summary`     what (symbol, timeframe) ranges are stored
 *
 * Progress events are pushed to the renderer over `data:download-progress`.
 */
export function registerIpcHandlers(): void {
  ipcMain.handle(IpcChannels.GetCachedData, (_event, request: unknown): CachedDataResponse => {
    try {
      const req = toDownloadRequest(request)
      if (!req) return { ok: false, candles: [], count: 0, error: 'Invalid download request.' }
      const candles = queryCandles(req)
      return { ok: true, candles, count: candles.length }
    } catch (err) {
      return {
        ok: false,
        candles: [],
        count: 0,
        error: err instanceof Error ? err.message : String(err)
      }
    }
  })

  ipcMain.handle(IpcChannels.GetCacheSummary, (): CacheSummaryResponse => {
    try {
      return { ok: true, entries: getCacheSummary() }
    } catch (err) {
      return {
        ok: false,
        entries: [],
        error: err instanceof Error ? err.message : String(err)
      }
    }
  })

  ipcMain.handle(
    IpcChannels.DownloadData,
    async (event, request: unknown): Promise<DownloadResult> => {
      const req = toDownloadRequest(request)
      if (!req) {
        return {
          ok: false,
          symbol: '?',
          timeframe: '?',
          candles: 0,
          source: 'none',
          message: 'Invalid download request.'
        }
      }

      // 1. Cache-first: if this exact range is already stored, return it instantly.
      sendProgress(event, {
        phase: 'checking-cache',
        message: `Checking local cache for ${req.symbol} ${req.timeframe} [${req.startDate} → ${req.endDate}]…`
      })
      const cached = queryCandles(req)
      if (cached.length > 0) {
        sendProgress(event, {
          phase: 'ready',
          message: `${cached.length} candles loaded from cache.`,
          percent: 100
        })
        return {
          ok: true,
          symbol: req.symbol,
          timeframe: req.timeframe,
          candles: cached.length,
          source: 'cache'
        }
      }

      // 2. Nothing cached for that range — fetch from Dukascopy (Phase 2).
      sendProgress(event, {
        phase: 'downloading',
        message: `Requesting ${req.symbol} from Dukascopy…`,
        percent: 0
      })
      try {
        const data = await fetchFromDukascopy(req, (message, percent) =>
          sendProgress(event, { phase: 'downloading', message, percent })
        )
        sendProgress(event, {
          phase: 'saving',
          message: `Saving ${data.length} candles to local cache…`
        })
        insertCandles(req.symbol, req.timeframe, data)
        sendProgress(event, {
          phase: 'ready',
          message: `${data.length} candles downloaded and cached.`,
          percent: 100
        })
        return {
          ok: true,
          symbol: req.symbol,
          timeframe: req.timeframe,
          candles: data.length,
          source: 'dukascopy'
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        sendProgress(event, { phase: 'error', message })
        return {
          ok: false,
          symbol: req.symbol,
          timeframe: req.timeframe,
          candles: countCandles(req),
          source: 'none',
          message
        }
      }
    }
  )
}
