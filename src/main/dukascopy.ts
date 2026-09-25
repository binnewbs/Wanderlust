/**
 * On-demand market-data fetch.
 *
 * Dukascopy is the primary source. Strategy (ported from the
 * `dukascopy-downloader` project, which the old `dukascopy-node` path could not
 * match):
 *
 *   - Fetch PRE-COMPUTED M1 candle files, one ~11 KiB request per day, instead
 *     of `dukascopy-node`'s tick-based path. 1 request/day vs 24 tick
 *     downloads = the 24x request reduction that keeps us under Dukascopy's
 *     aggressive rate limiter (the old path tripped 429 constantly).
 *   - Send browser-like headers: Dukascopy's datafeed 429/503-blocks
 *     requests without a browser User-Agent + Referer.
 *   - Coarser timeframes (m5..d1) are derived locally from the day's M1
 *     candles, so one file download serves every timeframe.
 *   - Per-day cache skip: days already stored in SQLite are served from the
 *     local cache (no network).
 *   - Exponential backoff + jitter and adaptive pacing between days keep the
 *     limiter happy. A few consecutive failures switch to the HistData
 *     fallback instead of spending minutes on a feed that is clearly down.
 *   - Derived-timeframe seeding: every M1 day that gets downloaded also has
 *     m5/m15/m30/h1/h4/d1 aggregated and written to the cache, so a batch of
 *     timeframes costs ONE request per day instead of one per timeframe.
 *   - Weekends: FX/metals/indices have no Saturday data, so those days are
 *     skipped outright (crypto trades 7 days).
 *
 * A Dukascopy 404 is a real "no data for this period" answer (weekend/holiday),
 * not a transport failure, so it never triggers fallback. Network errors,
 * exhausted throttling retries and empty-but-successful files do.
 *
 * This function reads the cache to skip days, and WRITES derived timeframes
 * for freshly-fetched days (upsert). The caller in `ipc.ts` still persists
 * the requested timeframe's merged result with one final upsert.
 *
 * LZMA decoding (`lzma-native`) is an N-API native module that runs in the
 * Electron main process without rebuild.
 */

import type { Candle, DataSource, SingleTimeframeRequest } from '../shared/ipc'
import { TIMEFRAMES, TIMEFRAME_MS } from '../shared/timeframes'
import { isTradingDay } from '../shared/trading'
import { insertCandles, querySourcedCandlesRange } from './db'
import { fetchHistDataDay, supportsHistData } from './histdata'
import {
  aggregateM1,
  decompressBi5,
  getPointValue,
  normalizeSymbolForUrl,
  parseNativeCandles
} from './bi5'

export type ProgressReporter = (message: string, percent?: number) => void

export interface FetchResult {
  /** Full merged range: cached days + newly fetched days, deduped, time-ordered. */
  candles: Candle[]
  /** Network provider for every returned candle, keyed by timestamp. */
  candleSources: Map<number, DataSource>
  /** Days that had to be fetched from the network. */
  fetchedDays: number
  /** Days served entirely from the local cache. */
  cachedDays: number
  /**
   * Requested trading days (ISO) that NO provider could supply, and which are
   * therefore absent from `candles`. A range that silently skips days is the
   * most confusing failure this app can have, so the caller is told explicitly.
   */
  emptyDays: string[]
}

const DAY_MS = 86_400_000

/** Browser-like identity Dukascopy expects from datafeed clients. */
const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: '*/*',
  'Accept-Language': 'en-US,en;q=0.9',
  Connection: 'keep-alive',
  Referer: 'https://www.dukascopy.com/swiss/english/marketwatch/historical/'
}

const BASE_URL = 'https://www.dukascopy.com/datafeed'

/**
 * Dukascopy gets a short retry window: when every attempt is a network error,
 * a busy response, or an unusable empty file, waiting several more minutes
 * only delays the independent HistData fallback.
 */
const DOWNLOAD_ATTEMPTS = 3
const RETRY_MAX_DELAY_MS = 8_000
const REQUEST_TIMEOUT_MS = 15_000

/** Base pause between network requests; widens ×2 per throttle level. */
const PAUSE_BASE_MS = 200
const PAUSE_MAX_MS = 3_200
/** Throttle escalates 0→4 on 429/503 and decays down when requests stay clean. */
let throttleLevel = 0
let cleanStreak = 0

/**
 * How long a Dukascopy failure keeps the primary source switched off. Retrying
 * a feed that is down costs ~45s per day, so once HistData has covered a day the
 * rest of the run goes straight to the fallback. A short window keeps a transient
 * blip from pushing Dukascopy out of rotation for long.
 */
const PRIMARY_COOLDOWN_MS = 5 * 60_000
let primaryDownUntil = 0

function currentPauseMs(): number {
  return Math.min(PAUSE_BASE_MS * 2 ** throttleLevel, PAUSE_MAX_MS)
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

/** Describe any thrown value for user-facing errors. */
export function describeError(err: unknown): string {
  if (err instanceof Error) return err.message
  if (err && typeof err === 'object') {
    try {
      return JSON.stringify(err)
    } catch {
      return String(err)
    }
  }
  return String(err)
}

/** Validates symbol/timeframe against what the datafeed actually supports. */
function assertSupported(symbol: string, timeframe: string): void {
  if (!/^[a-z0-9]+$/.test(symbol)) {
    throw new Error(
      `"${symbol}" is not a supported Dukascopy symbol. Example ids: eurusd, gbpusd, usdjpy, xauusd.`
    )
  }
  if (!(TIMEFRAMES as readonly string[]).includes(timeframe)) {
    throw new Error(`"${timeframe}" is not a supported timeframe (${TIMEFRAMES.join(', ')}).`)
  }
}

/** Native M1 candle file URL for one UTC day. Month is 0-indexed (00 = Jan). */
function candleUrl(symbol: string, dayStartMs: number): string {
  const d = new Date(dayStartMs)
  const year = d.getUTCFullYear()
  const month0 = String(d.getUTCMonth()).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${BASE_URL}/${normalizeSymbolForUrl(symbol)}/${year}/${month0}/${day}/BID_candles_min_1.bi5`
}

/**
 * Fetch one day's native M1 candle file with exponential backoff + jitter.
 *
 * @returns parsed M1 candles for that day and whether the absence of data was
 *   an authoritative 404 (quiet day) rather than a transport/decode failure.
 */
async function fetchDayM1(
  symbol: string,
  dayStartMs: number,
  onProgress: ProgressReporter,
  dayLabel: string
): Promise<{ candles: Candle[]; throttled: boolean; noData: boolean }> {
  const url = candleUrl(symbol, dayStartMs)
  const point = getPointValue(symbol)
  let throttled = false

  const wait = (attempt: number, base: number): number =>
    Math.min(base * 2 ** attempt + 500 + Math.random() * 1500, RETRY_MAX_DELAY_MS)

  for (let attempt = 0; attempt < DOWNLOAD_ATTEMPTS; attempt++) {
    try {
      const resp = await fetch(url, {
        headers: HEADERS,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      })

      if (resp.status === 200) {
        const raw = Buffer.from(await resp.arrayBuffer())
        const decompressed = await decompressBi5(raw)
        const candles = parseNativeCandles(decompressed, point, dayStartMs)
        if (candles.length === 0) {
          throw new Error('Dukascopy returned an empty M1 candle file')
        }
        return { candles, throttled, noData: false }
      }

      if (resp.status === 404) {
        // Authoritative: no data for this period (closed day / unsupported symbol).
        return { candles: [], throttled, noData: true }
      }

      throttled = throttled || resp.status === 429 || resp.status === 503
      // 429 (rate limit) / 503 (server busy) / other — back off and retry.
      if (attempt < DOWNLOAD_ATTEMPTS - 1) {
        const retryAfter = Number(resp.headers.get('retry-after'))
        const delay = retryAfter > 0 ? retryAfter * 1000 : wait(attempt, throttled ? 1000 : 500)
        onProgress(
          `Dukascopy busy (HTTP ${resp.status}) — retry ${attempt + 1}/${DOWNLOAD_ATTEMPTS} (${dayLabel})…`
        )
        await sleep(Math.min(delay, RETRY_MAX_DELAY_MS))
        continue
      }
      throw new Error(`HTTP ${resp.status} after ${DOWNLOAD_ATTEMPTS} attempts`)
    } catch (err) {
      if (attempt < DOWNLOAD_ATTEMPTS - 1) {
        if (err instanceof Error && err.name === 'TimeoutError') {
          onProgress(
            `Dukascopy request timed out — retry ${attempt + 1}/${DOWNLOAD_ATTEMPTS} (${dayLabel})…`
          )
        }
        await sleep(wait(attempt, 1000))
        continue
      }
      throw err
    }
  }

  throw new Error(`Dukascopy fetch failed for ${symbol} on ${dayLabel}`)
}

interface DayFetchResult {
  candles: Candle[]
  source: DataSource
  noData: boolean
  throttled: boolean
}

/**
 * Fetches one trading day from the primary source, falling back to HistData
 * only for transport/provider failures. A Dukascopy 404 is returned as a
 * successful quiet day and never reaches the fallback.
 *
 * Once a Dukascopy failure has been covered by HistData the primary is skipped
 * for the next {@link PRIMARY_COOLDOWN_MS}, so a download spanning many days does
 * not pay the retry window on every single one. Instruments HistData does not
 * cover always try Dukascopy, so the cooldown can never strand them.
 */
async function fetchDayWithFallback(
  symbol: string,
  dayStartMs: number,
  onProgress: ProgressReporter,
  dayLabel: string
): Promise<DayFetchResult> {
  const histAvailable = supportsHistData(symbol)
  let dukascopyError: unknown = null

  if (histAvailable && Date.now() < primaryDownUntil) {
    onProgress(`Dukascopy unavailable (${dayLabel}) — using HistData fallback…`)
  } else {
    try {
      const result = await fetchDayM1(symbol, dayStartMs, onProgress, dayLabel)
      if (!result.noData) return { ...result, source: 'dukascopy' }

      // Dukascopy answered 404. That USED to be treated as proof of a quiet day,
      // but it is not: under rate limiting the datafeed also answers 404 to days
      // it does have (measured — a day with 1400+ candles 404s while a holiday
      // serves 200). So on a weekday a second provider gets to disagree before
      // the day is written off. Weekends and uncovered instruments keep the
      // 404-is-authoritative behaviour, where nothing could contradict it.
      if (!histAvailable || !isTradingDay(dayStartMs, symbol)) {
        return { ...result, source: 'dukascopy' }
      }
      onProgress(
        `Dukascopy reports no file for ${dayLabel} — checking HistData before treating it as a quiet day…`
      )
      try {
        const candles = await fetchHistDataDay(symbol, dayStartMs, (message) => onProgress(message))
        if (candles.length > 0) {
          return { candles, source: 'histdata', noData: false, throttled: false }
        }
      } catch (err) {
        // The cross-check is best-effort: never fail a download over it.
        onProgress(
          `HistData cross-check unavailable for ${dayLabel} (${describeError(err)}) — treating the 404 as a quiet day.`
        )
      }
      return { ...result, source: 'dukascopy' }
    } catch (err) {
      dukascopyError = err
      if (!histAvailable) {
        throw new Error(
          `Dukascopy fetch failed for ${symbol} on ${dayLabel}: ${describeError(err)}. ` +
            `HistData fallback does not cover this instrument.`
        )
      }
      onProgress(`Dukascopy unavailable (${dayLabel}) — trying HistData fallback…`)
    }
  }

  try {
    const candles = await fetchHistDataDay(symbol, dayStartMs, (message) => onProgress(message))
    // The primary really is down (it failed, not that the day was quiet), so hold
    // the cooldown for the rest of this run.
    primaryDownUntil = Date.now() + PRIMARY_COOLDOWN_MS
    return { candles, source: 'histdata', noData: candles.length === 0, throttled: false }
  } catch (histDataError) {
    // HistData could not cover the day either: give Dukascopy another chance from
    // the next day onwards rather than sitting out the cooldown.
    primaryDownUntil = 0
    throw new Error(
      `All market-data providers failed for ${symbol} on ${dayLabel}. ` +
        `Dukascopy: ${describeError(dukascopyError ?? 'skipped during a recent outage')}. ` +
        `HistData: ${describeError(histDataError)}.`
    )
  }
}

/**
 * Fetches candles for the full requested range, day by day.
 *
 * Cache-first per day: any day already present in the SQLite cache is reused
 * instead of re-downloaded, so re-requests and partially-cached ranges are
 * cheap. Progress is reported per day with a 0-100 percent.
 *
 * @throws on unsupported symbol/timeframe, or when every eligible provider
 *   fails the requested day.
 */
export async function fetchMarketData(
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

  // Enumerate whole UTC trading days in the inclusive range (weekends skipped
  // for non-crypto symbols — they have no data file anyway).
  const days: number[] = []
  for (let t = firstDay; t <= lastDay; t += DAY_MS) {
    if (isTradingDay(t, symbol)) days.push(t)
  }
  const total = days.length
  if (total === 0) {
    // Weekend/holiday range for a non-crypto symbol: nothing to fetch, not an
    // error — batch/run-up lookups treat it as a silent empty range.
    return { candles: [], candleSources: new Map(), fetchedDays: 0, cachedDays: 0, emptyDays: [] }
  }

  const merged: Candle[] = []
  const candleSources = new Map<number, DataSource>()
  const emptyDays: string[] = []
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

    // 1. Cache skip: if this day is already stored, reuse it (and its source).
    const cached = querySourcedCandlesRange(symbol, timeframe, dayStart, dayEnd)
    if (cached.length > 0) {
      for (const candle of cached) {
        merged.push(candle)
        candleSources.set(candle.timestamp, candle.source)
      }
      cachedDays++
      continue
    }

    // 2. Fetch the missing day's M1 file, derive + cache every timeframe.
    //    fetchDayWithFallback already reports every provider failure in context.
    const {
      candles: m1,
      source,
      throttled
    } = await fetchDayWithFallback(symbol, dayStart, onProgress, dayLabel)

    // Adaptive pacing: escalate on throttling, decay after clean stretches.
    if (throttled) {
      throttleLevel = Math.min(throttleLevel + 1, 4)
      cleanStreak = 0
    } else {
      cleanStreak++
      if (cleanStreak >= 3 && throttleLevel > 0) {
        throttleLevel--
        cleanStreak = 0
      }
    }

    // Derive every timeframe from this day's M1 and cache it, so the rest of
    // a batch (or later re-downloads) is served without extra requests.
    const derived = new Map<string, Candle[]>()
    for (const tf of TIMEFRAMES) {
      const candles = aggregateM1(m1, TIMEFRAME_MS[tf], dayStart, dayEnd)
      derived.set(tf, candles)
      if (candles.length > 0) insertCandles(symbol, tf, candles, source)
    }
    const dayCandles =
      derived.get(timeframe) ??
      aggregateM1(m1, TIMEFRAME_MS[timeframe as keyof typeof TIMEFRAME_MS], dayStart, dayEnd)

    if (dayCandles.length > 0) {
      onProgress(
        `${dayLabel}: ${m1.length} M1 candles from ${source} — derived + cached all timeframes`
      )
    } else {
      // Every provider came back empty. Record the day so the caller can say so
      // out loud instead of quietly returning a short range.
      emptyDays.push(dayLabel)
      onProgress(`${dayLabel}: no data from ${source} — this day is missing from the range.`)
    }

    for (const candle of dayCandles) {
      merged.push(candle)
      candleSources.set(candle.timestamp, source)
    }
    fetchedDays++

    // 3. Be kind to Dukascopy's rate limiter between provider-days. HistData
    // fallback days are already served from an in-memory archive.
    if (i < total - 1 && source === 'dukascopy') await sleep(currentPauseMs())
  }

  // Defensive dedupe by timestamp (days can't normally collide, but cheap to guard).
  const seen = new Set<number>()
  const candles: Candle[] = []
  const dedupedSources = new Map<number, DataSource>()
  for (const c of merged) {
    if (seen.has(c.timestamp)) continue
    seen.add(c.timestamp)
    candles.push(c)
    dedupedSources.set(c.timestamp, candleSources.get(c.timestamp) ?? 'dukascopy')
  }

  return { candles, candleSources: dedupedSources, fetchedDays, cachedDays, emptyDays }
}
