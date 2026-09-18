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
 * - `data:download`          cache-first download of a date range (Dukascopy fetch)
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

      // 1. Cache-first: fetchFromDukascopy serves already-cached days from
      //    SQLite without touching the network and fills any gaps, so the
      //    cache-hit path is still instant for fully-cached ranges.
      sendProgress(event, {
        phase: 'checking-cache',
        message: `Checking local cache for ${req.symbol} ${req.timeframe} [${req.startDate} → ${req.endDate}]…`
      })
      try {
        const result = await fetchFromDukascopy(req, (message, percent) =>
          sendProgress(event, { phase: 'downloading', message, percent })
        )
        const { candles, fetchedDays, cachedDays } = result

        // 2. Persist the merged range (upsert — idempotent for cached rows).
        if (fetchedDays > 0) {
          sendProgress(event, {
            phase: 'saving',
            message: `Saving ${candles.length} candles to local cache…`
          })
          insertCandles(req.symbol, req.timeframe, candles)
        }

        // 3. Report what actually happened.
        const source: DownloadResult['source'] =
          fetchedDays === 0 ? 'cache' : cachedDays === 0 ? 'dukascopy' : 'mixed'
        const message =
          source === 'cache'
            ? `${candles.length} candles loaded from cache.`
            : source === 'dukascopy'
              ? `${candles.length} candles downloaded from Dukascopy and cached.`
              : `${candles.length} candles merged (${cachedDays} cached day(s) + ${fetchedDays} freshly downloaded) and cached.`
        sendProgress(event, { phase: 'ready', message, percent: 100 })
        return {
          ok: true,
          symbol: req.symbol,
          timeframe: req.timeframe,
          candles: candles.length,
          source
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
