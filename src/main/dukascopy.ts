import { getHistoricalRates, Instrument, Timeframe } from 'dukascopy-node'
import type { InstrumentType, JsonItem, TimeframeType } from 'dukascopy-node'
import type { Candle, SingleTimeframeRequest } from '../shared/ipc'
import { queryCandlesRange } from './db'

/**
 * On-demand Dukascopy fetch (Phase 2).
 *
 * Strategy: instead of handing the whole date range to `dukascopy-node` in one
 * shot (which batches internally but gives us no visibility), we iterate
 * day-by-day ourselves:
 *
 *   - per-day cache skip: days already stored in SQLite are served from the
 *     local cache (no network), which fills gaps in partially-cached ranges;
 *   - per-day progress events stream back to the renderer (`onProgress`);
 *   - small pause between network calls keeps Dukascopy's rate limiter happy.
 *
 * This function only *reads* the cache (to skip days) and returns the merged
 * candle list; the caller in `ipc.ts` persists the result with one upsert.
 *
 * `dukascopy-node` runs in the Electron main process only — the renderer
 * cannot reach Dukascopy directly (CORS + Node-only deps).
 */

export type ProgressReporter = (message: string, percent?: number) => void

export interface FetchResult {
  /** Full merged range: cached days + newly fetched days, deduped, time-ordered. */
  candles: Candle[]
  /** Days that had to be fetched from the network. */
  fetchedDays: number
  /** Days served entirely from the local cache. */
  cachedDays: number
}

const DAY_MS = 86_400_000

/** Polite pause between network requests (Dukascopy rate-limits aggressively). */
const PAUSE_BETWEEN_DAYS_MS = 200

/** Retry/backoff handed to dukascopy-node for transient 429/network failures. */
const RETRY = {
  retryCount: 3,
  retryOnEmpty: false, // treat empty trading days (weekends/holidays) as "no data", not errors
  failAfterRetryCount: true,
  pauseBetweenRetriesMs: 750
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** UTC midnight (ms) of an ISO date string, e.g. '2024-01-02' -> 1704153600000. */
function dayMs(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number)
  if (y === undefined || m === undefined || d === undefined || !m || m > 12 || !d || d > 31) {
    throw new Error(`Invalid date "${iso}" — expected an ISO date like 2024-01-02.`)
  }
  return Date.UTC(y, m - 1, d)
}

/** ISO date string (UTC) of a day timestamp. */
function isoFromDayMs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

/** dukascopy-node shapes failures as Error *or* a bare { validationErrors } object. */
export function describeError(err: unknown): string {
  if (err instanceof Error) return err.message
  if (err && typeof err === 'object') {
    const ve = (err as { validationErrors?: Array<{ message?: string }> }).validationErrors
    if (Array.isArray(ve) && ve.length > 0) return ve.map((e) => e.message ?? '').join('; ')
    try {
      return JSON.stringify(err)
    } catch {
      return String(err)
    }
  }
  return String(err)
}

/** Validates a symbol/timeframe against dukascopy-node's own enums up-front. */
function assertSupported(symbol: string, timeframe: string): void {
  if (!(symbol.toLowerCase() in Instrument)) {
    throw new Error(
      `"${symbol}" is not a Dukascopy instrument id. Example ids: eurusd, gbpusd, usdjpy, xauusd, btcusd.`
    )
  }
  if (!(timeframe in Timeframe)) {
    throw new Error(
      `"${timeframe}" is not a supported timeframe (tick, s1, m1, m5, m15, m30, h1, h4, d1, mn1).`
    )
  }
}

/** Map a dukascopy-node JSON candle onto our Candle shape (volume may be omitted). */
function toCandle(item: JsonItem): Candle {
  return {
    timestamp: item.timestamp, // milliseconds since epoch (JSON output), matching our schema
    open: item.open,
    high: item.high,
    low: item.low,
    close: item.close,
    volume: item.volume ?? 0
  }
}

/**
 * Fetches candles for the full requested range, day by day.
 *
 * Cache-first per day: any day already present in the SQLite cache is reused
 * instead of re-downloaded, so re-requests and partially-cached ranges are
 * cheap. Progress is reported per day with a 0-100 percent.
 *
 * @throws on unsupported symbol/timeframe, or if Dukascopy is unreachable.
 */
export async function fetchFromDukascopy(
  request: SingleTimeframeRequest,
  onProgress: ProgressReporter
): Promise<FetchResult> {
  const { symbol, timeframe } = request
  assertSupported(symbol, timeframe)

  const firstDay = dayMs(request.startDate)
  const lastDay = dayMs(request.endDate)
  if (firstDay > lastDay) {
    throw new Error(`Invalid date range: ${request.startDate} → ${request.endDate}`)
  }

  // Enumerate whole UTC days in the inclusive range.
  const days: number[] = []
  for (let t = firstDay; t <= lastDay; t += DAY_MS) days.push(t)
  const total = days.length

  const merged: Candle[] = []
  let fetchedDays = 0
  let cachedDays = 0

  for (let i = 0; i < total; i++) {
    const dayStart = days[i]
    const dayEnd = dayStart + DAY_MS - 1
    const dayLabel = isoFromDayMs(dayStart)
    onProgress(
      `Downloading ${symbol} ${timeframe} — day ${i + 1}/${total} (${dayLabel})…`,
      Math.round((i / total) * 100)
    )

    // 1. Cache skip: if this day is already stored, reuse it.
    const cached = queryCandlesRange(symbol, timeframe, dayStart, dayEnd)
    if (cached.length > 0) {
      merged.push(...cached)
      cachedDays++
      continue
    }

    // 2. Fetch the missing day from Dukascopy.
    //    `to` is exclusive in dukascopy-node (`>= from && < to`), so a day's
    //    range is [dayStart, nextDayStart). utcOffset 0 keeps everything UTC.
    let dayCandles: Candle[]
    try {
      const items = await getHistoricalRates({
        instrument: symbol as InstrumentType,
        dates: { from: new Date(dayStart), to: new Date(dayStart + DAY_MS) },
        timeframe: timeframe as TimeframeType,
        format: 'json',
        priceType: 'bid',
        utcOffset: 0,
        volumes: true,
        volumeUnits: 'units', // raw traded units, not the lib's "millions" shorthand
        ignoreFlats: true, // skip non-trading periods (weekends etc.)
        ...RETRY
      })
      // Belt-and-suspenders: keep only candles inside this UTC day, time-ordered.
      dayCandles = (items as JsonItem[])
        .map(toCandle)
        .filter((c) => c.timestamp >= dayStart && c.timestamp <= dayEnd)
        .sort((a, b) => a.timestamp - b.timestamp)
    } catch (err) {
      throw new Error(
        `Dukascopy fetch failed for ${symbol} ${timeframe} on ${dayLabel}: ${describeError(err)}`
      )
    }

    merged.push(...dayCandles)
    fetchedDays++

    // 3. Be kind to Dukascopy's rate limiter between days.
    if (i < total - 1) await sleep(PAUSE_BETWEEN_DAYS_MS)
  }

  // Defensive dedupe by timestamp (days can't normally collide, but cheap to guard).
  const seen = new Set<number>()
  const candles: Candle[] = []
  for (const c of merged) {
    if (seen.has(c.timestamp)) continue
    seen.add(c.timestamp)
    candles.push(c)
  }

  return { candles, fetchedDays, cachedDays }
}
