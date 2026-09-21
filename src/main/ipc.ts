import { ipcMain, BrowserWindow } from 'electron'
import {
  IpcChannels,
  type CacheStatsResponse,
  type CacheSummaryResponse,
  type CachedDataResponse,
  type DeleteCacheResult,
  type DownloadBatchResult,
  type DownloadProgressEvent,
  type DownloadRequest,
  type DownloadResult,
  type TimeframeDownloadResult,
  type VacuumCacheResult
} from '../shared/ipc'
import { isTimeframe } from '../shared/timeframes'
import {
  countCandles,
  deleteCandles,
  getCacheStats,
  getCacheSummary,
  queryCandles,
  insertCandles,
  vacuumCache
} from './db'
import { fetchFromDukascopy } from './dukascopy'

/** Validates an unknown payload from the renderer into a DownloadRequest. */
function toDownloadRequest(value: unknown): DownloadRequest | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  if (
    typeof v.symbol !== 'string' ||
    typeof v.startDate !== 'string' ||
    typeof v.endDate !== 'string'
  ) {
    return null
  }
  // `timeframes` (batch mode) takes precedence; `timeframe` is then the chart's
  // initial view. Without either, the request is invalid.
  const timeframes = Array.isArray(v.timeframes) ? v.timeframes.filter(isTimeframe) : undefined
  const timeframe =
    typeof v.timeframe === 'string' && !timeframes?.length
      ? v.timeframe.trim().toLowerCase()
      : undefined
  if (timeframe !== undefined && !isTimeframe(timeframe)) return null
  if (!timeframes?.length && !timeframe) return null

  const req: DownloadRequest = {
    symbol: v.symbol.trim().toLowerCase(),
    startDate: v.startDate,
    endDate: v.endDate
  }
  if (timeframe) req.timeframe = timeframe
  if (timeframes?.length) req.timeframes = [...new Set(timeframes)]

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
 * Downloads ONE timeframe for a range (cache-first) and persists what was
 * freshly fetched. `label` prefixes progress messages; `scaledPercent` converts
 * the timeframe's internal 0-100 day progress into the batch's overall scale.
 */
async function downloadTimeframe(
  event: Electron.IpcMainInvokeEvent,
  symbol: string,
  timeframe: string,
  startDate: string,
  endDate: string,
  label: string,
  scaledPercent: (wholeTfPercent: number | undefined) => number | undefined
): Promise<TimeframeDownloadResult> {
  const req = { symbol, timeframe, startDate, endDate }
  sendProgress(event, {
    phase: 'checking-cache',
    timeframe,
    message: `${label}: Checking local cache [${startDate} → ${endDate}]…`,
    percent: scaledPercent(undefined)
  })
  let result
  try {
    result = await fetchFromDukascopy(req, (message, percent) =>
      sendProgress(event, {
        phase: 'downloading',
        timeframe,
        message: `${label}: ${message}`,
        percent: scaledPercent(percent)
      })
    )
  } catch (err) {
    return {
      timeframe,
      candles: 0,
      source: 'none',
      error: err instanceof Error ? err.message : String(err)
    }
  }
  const { candles, fetchedDays, cachedDays } = result

  // Persist the merged range (upsert — idempotent for cached rows).
  if (fetchedDays > 0) {
    sendProgress(event, {
      phase: 'saving',
      timeframe,
      message: `${label}: Saving ${candles.length} candles to local cache…`,
      percent: scaledPercent(undefined)
    })
    insertCandles(symbol, timeframe, candles)
  }

  const source: TimeframeDownloadResult['source'] =
    fetchedDays === 0 ? 'cache' : cachedDays === 0 ? 'dukascopy' : 'mixed'
  const message =
    source === 'cache'
      ? `${label}: ${candles.length} candles loaded from cache.`
      : source === 'dukascopy'
        ? `${label}: ${candles.length} candles downloaded from Dukascopy and cached.`
        : `${label}: ${candles.length} candles merged (${cachedDays} cached day(s) + ${fetchedDays} freshly downloaded) and cached.`
  sendProgress(event, {
    phase: 'ready',
    timeframe,
    message,
    percent: scaledPercent(100)
  })
  return { timeframe, candles: candles.length, source }
}

/**
 * Registers all IPC handlers for the app.
 *
 * - `data:download`          cache-first download of a date range — single
 *                            timeframe (`timeframes` omitted) or a whole batch
 *                            (`timeframes: [...]`, e.g. all session timeframes)
 * - `data:get-cached`        query candles already in the local cache
 * - `data:cache-summary`     what (symbol, timeframe) ranges are stored
 * - `data:cache-stats`       cache totals + real on-disk size (Settings → Storage)
 * - `data:cache-delete`      delete cached candles (whole cache, or one group)
 * - `data:cache-vacuum`      VACUUM the cache database to reclaim disk space
 *
 * Progress events are pushed to the renderer over `data:download-progress`.
 */
export function registerIpcHandlers(): void {
  ipcMain.handle(IpcChannels.GetCachedData, (_event, request: unknown): CachedDataResponse => {
    try {
      const req = toDownloadRequest(request)
      if (!req?.timeframe) {
        return { ok: false, candles: [], count: 0, error: 'Invalid download request.' }
      }
      // Cache queries are single-timeframe; narrow the validated request.
      const candles = queryCandles({
        symbol: req.symbol,
        timeframe: req.timeframe,
        startDate: req.startDate,
        endDate: req.endDate
      })
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

  ipcMain.handle(IpcChannels.GetCacheStats, (): CacheStatsResponse => {
    try {
      return { ok: true, stats: getCacheStats() }
    } catch (err) {
      return {
        ok: false,
        stats: null,
        error: err instanceof Error ? err.message : String(err)
      }
    }
  })

  ipcMain.handle(IpcChannels.DeleteCacheData, (_event, request: unknown): DeleteCacheResult => {
    try {
      const v =
        typeof request === 'object' && request !== null ? (request as Record<string, unknown>) : {}
      const symbol =
        typeof v.symbol === 'string' && v.symbol.trim() ? v.symbol.trim().toLowerCase() : undefined
      const timeframe =
        typeof v.timeframe === 'string' && v.timeframe.trim()
          ? v.timeframe.trim().toLowerCase()
          : undefined
      return { ok: true, deleted: deleteCandles(symbol, timeframe) }
    } catch (err) {
      return {
        ok: false,
        deleted: 0,
        error: err instanceof Error ? err.message : String(err)
      }
    }
  })

  ipcMain.handle(IpcChannels.VacuumCache, (): VacuumCacheResult => {
    try {
      const { totalSizeBytes } = vacuumCache()
      return { ok: true, totalSizeBytes }
    } catch (err) {
      return {
        ok: false,
        totalSizeBytes: 0,
        error: err instanceof Error ? err.message : String(err)
      }
    }
  })

  ipcMain.handle(
    IpcChannels.DownloadData,
    async (event, request: unknown): Promise<DownloadResult | DownloadBatchResult> => {
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

      const { symbol, startDate, endDate } = req
      const timeframes = req.timeframes ?? (req.timeframe ? [req.timeframe] : [])
      const batch = (req.timeframes?.length ?? 0) > 1

      if (!batch) {
        // ---- single-timeframe mode (charts, E2E, one-off fetches) ----
        const result = await downloadTimeframe(
          event,
          symbol,
          timeframes[0],
          startDate,
          endDate,
          timeframes[0],
          (percent) => percent
        )
        if (result.error) {
          sendProgress(event, { phase: 'error', message: result.error })
          return {
            ok: false,
            symbol,
            timeframe: result.timeframe,
            candles: countCandles({ symbol, timeframe: result.timeframe, startDate, endDate }),
            source: 'none',
            message: result.error
          }
        }
        return {
          ok: true,
          symbol,
          timeframe: result.timeframe,
          candles: result.candles,
          source: result.source
        }
      }

      // ---- batch mode: every session timeframe, one call ----
      const n = timeframes.length
      sendProgress(event, {
        phase: 'checking-cache',
        message: `Checking local cache for ${symbol} — ${n} timeframes [${startDate} → ${endDate}]…`,
        percent: 0
      })
      const results: TimeframeDownloadResult[] = []
      for (let i = 0; i < n; i++) {
        const tf = timeframes[i]
        const label = `[${i + 1}/${n}] ${tf}`
        // Scale this timeframe's internal day-progress into the batch's 0-100.
        const scaled = (wholeTfPercent: number | undefined): number | undefined => {
          const tfSpan = 1 / n
          const base = (i / n) * 100
          if (wholeTfPercent === undefined) return Math.round(base)
          return Math.round(base + (wholeTfPercent / 100) * tfSpan * 100)
        }
        // Small gap between timeframes so the limiter doesn't see a burst when
        // one timeframe's last day flows straight into the next one's first.
        if (i > 0) await new Promise((r) => setTimeout(r, 250))
        results.push(await downloadTimeframe(event, symbol, tf, startDate, endDate, label, scaled))
      }

      const failed = results.filter((r) => r.error)
      const totalCandles = results.reduce((sum, r) => sum + r.candles, 0)
      if (failed.length > 0) {
        const message = `Failed to download: ${failed.map((f) => `${f.timeframe} (${f.error})`).join(', ')}`
        sendProgress(event, { phase: 'error', message })
        return {
          ok: false,
          symbol,
          timeframes: results,
          totalCandles,
          message
        }
      }
      const message = `Downloaded ${symbol}: ${results
        .map((r) => `${r.timeframe}=${r.candles} (${r.source})`)
        .join(', ')}.`
      sendProgress(event, { phase: 'ready', message, percent: 100 })
      return { ok: true, symbol, timeframes: results, totalCandles, message }
    }
  )
}
