/**
 * On-demand Dukascopy fetch (Phase 2).
 *
 * Strategy (ported from the `dukascopy-downloader` project, which the old
 * `dukascopy-node` path could not match):
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
 *   - Exponential backoff + jitter on retries (10 attempts, cap 30s) and a
 *     small pause between days keep the limiter happy.
 *
 * This function only *reads* the cache (to skip days) and returns the merged
 * candle list; the caller in `ipc.ts` persists the result with one upsert.
 *
 * LZMA decoding (`lzma-native`) is an N-API native module that runs in the
 * Electron main process without rebuild.
 */

import type { Candle, SingleTimeframeRequest } from '../shared/ipc'
import { TIMEFRAMES, TIMEFRAME_MS } from '../shared/timeframes'
import { queryCandlesRange } from './db'
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
  /** Days that had to be fetched from the network. */
  fetchedDays: number
  /** Days served entirely from the local cache. */
  cachedDays: number
}

const DAY_MS = 86_400_000

/** Browser-like identity Dukascopy expects from datafeed clients. */
const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: '*/*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Connection': 'keep-alive',
  Referer: 'https://www.dukascopy.com/swiss/english/marketwatch/historical/'
}

const BASE_URL = 'https://www.dukascopy.com/datafeed'

const DOWNLOAD_ATTEMPTS = 10
const RETRY_MAX_DELAY_MS = 30_000
const REQUEST_TIMEOUT_MS = 30_000

/** Polite pause between network requests (Dukascopy rate-limits aggressively). */
const PAUSE_BETWEEN_DAYS_MS = 300

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
    throw new Error(
      `"${timeframe}" is not a supported timeframe (${TIMEFRAMES.join(', ')}).`
    )
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
 * @returns parsed M1 candles for that day ([] when the file is missing).
 */
async function fetchDayM1(symbol: string, dayStartMs: number, onProgress: ProgressReporter, dayLabel: string): Promise<Candle[]> {
  const url = candleUrl(symbol, dayStartMs)
  const point = getPointValue(symbol)

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
        return parseNativeCandles(decompressed, point, dayStartMs)
      }

      if (resp.status === 404) {
        return [] // No data for this period (unsupported symbol / closed day).
      }

      // 429 (rate limit) / 503 (server busy) / other — back off and retry.
      if (attempt < DOWNLOAD_ATTEMPTS - 1) {
        const retryAfter = Number(resp.headers.get('retry-after'))
        const delay = retryAfter > 0
          ? retryAfter * 1000
          : wait(attempt, resp.status === 429 || resp.status === 503 ? 1000 : 500)
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
          onProgress(`Dukascopy request timed out — retry ${attempt + 1}/${DOWNLOAD_ATTEMPTS} (${dayLabel})…`)
        }
        await sleep(wait(attempt, 1000))
        continue
      }
      throw err
    }
  }

  throw new Error(`Dukascopy fetch failed for ${symbol} on ${dayLabel}`)
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

    // 2. Fetch the missing day's M1 file, derive the requested timeframe.
    let dayCandles: Candle[]
    try {
      const m1 = await fetchDayM1(symbol, dayStart, onProgress, dayLabel)
      dayCandles = aggregateM1(m1, TIMEFRAME_MS[timeframe as keyof typeof TIMEFRAME_MS], dayStart, dayEnd)
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