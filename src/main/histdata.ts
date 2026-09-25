/**
 * HistData.com fallback provider.
 *
 * HistData publishes free Generic ASCII M1 archives as one ZIP per symbol and
 * period, and nothing coarser. That is enough for Wanderlust: this provider
 * only ever returns M1, and the normal day pipeline derives m5..d1 locally.
 *
 * The download is a website flow, not a documented public API: a symbol/period
 * page is loaded for its one-time `tk` token, then `get.php` returns the ZIP.
 * The flow lives in this single module so a site change has one obvious failure
 * point. Three verified quirks are handled here:
 *
 *   - MONTH zips only exist for the most recent years. Older history is served
 *     as a whole-YEAR zip (12 months concatenated in one CSV), so every day
 *     falls back to "year zip, filter this month's rows".
 *   - Every failure (bad token, unavailable period, GET instead of POST) is
 *     answered with HTTP 200 and a ZERO-LENGTH body, never a 4xx. Status codes
 *     are therefore not a usable error signal; a missing/empty `tk` and an
 *     empty body are.
 *   - Ticks are New York wall-clock time WITH daylight saving, which contradicts
 *     HistData's own file specification. See the timestamp notes below.
 *
 * Data caveats:
 *   - OHLC values are bid quotes (1-4 pips under mid).
 *   - Timestamps are NEW YORK wall-clock time, daylight saving INCLUDED. The
 *     files disagree with HistData's "EST without DST" spec: FX Fridays end at
 *     16:59 and Sundays restart at 17:00 in that local time all year, and
 *     aligning the tape against an independent 5m feed matches New York local
 *     to ~1 pip while a fixed UTC-05:00 shift is off by ~4 pips in summer. So
 *     the offset is resolved through the `America/New_York` zone below.
 *     Caveat: for roughly three weeks after each DST change HistData emits
 *     stamps an hour off (their generator's glitch), so those days are shifted.
 *   - The series prints through the daily FX close, so a weekday carries ~24h
 *     of minutes and Friday's evening session is missing.
 *   - FX volume is broker-specific and therefore absent; rows carry volume 0.
 */

import { strFromU8, unzipSync } from 'fflate'
import type { Candle } from '../shared/ipc'

const HOST = 'https://www.histdata.com'

/**
 * HistData has used both paths over time. The current download page links to
 * `download-free-forex-data`; the older one is kept as a compatibility retry.
 */
const DOWNLOAD_ROUTES = [
  `${HOST}/download-free-forex-data/?/ascii/1-minute-bar-quotes/`,
  `${HOST}/download-free-forex-historical-data/?/ascii/1-minute-bar-quotes/`
] as const

const DOWNLOAD_ENDPOINT = `${HOST}/get.php`
const REQUEST_TIMEOUT_MS = 60_000
const DOWNLOAD_ATTEMPTS = 3
const RETRY_MAX_DELAY_MS = 8_000

const DAY_MS = 86_400_000

/** HistData stamps are New York wall-clock time (DST included). */
const NY_TIME_ZONE = 'America/New_York'

const nyFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: NY_TIME_ZONE,
  hour12: false,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit'
})

/** New York's UTC offset in ms (negative) at a given instant. */
function nyOffsetMs(utcMs: number): number {
  const parts = nyFormatter.formatToParts(new Date(utcMs))
  const field = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value)
  const asUtc = Date.UTC(
    field('year'),
    field('month') - 1,
    field('day'),
    field('hour') % 24, // some ICU builds render midnight as hour 24
    field('minute'),
    field('second')
  )
  return asUtc - utcMs
}

/**
 * New York's offset for one local calendar day, or null on a DST transition day
 * (two different offsets inside it). Memoized because a year archive holds
 * ~370k rows but only ~365 distinct days, and `Intl` formatting is far too slow
 * to run per row.
 */
const dayOffsets = new Map<number, number | null>()

function offsetForLocalDay(year: number, month: number, day: number): number | null {
  const key = Date.UTC(year, month - 1, day)
  const cached = dayOffsets.get(key)
  if (cached !== undefined) return cached
  const atStart = nyOffsetMs(key)
  const atEnd = nyOffsetMs(key + DAY_MS - 1)
  const offset = atStart === atEnd ? atStart : null
  dayOffsets.set(key, offset)
  return offset
}

/**
 * Converts a HistData New York wall-clock stamp to a UTC timestamp. On the two
 * DST transition days the offset is resolved per row instead of once per day,
 * which is the standard two-pass correction.
 */
export function histStampToUtcMs(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number
): number {
  const asUtc = Date.UTC(year, month - 1, day, hour, minute, second)
  const dayOffset = offsetForLocalDay(year, month, day)
  if (dayOffset !== null) return asUtc - dayOffset
  const guess = asUtc - nyOffsetMs(asUtc)
  return asUtc - nyOffsetMs(guess)
}

/** Browser-like identity: HistData's download form is built for browsers. */
const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
  Accept: '*/*'
} as const

/**
 * Explicit instrument map: only pairs HistData genuinely publishes under a
 * matching quote currency are listed. Near-matches (e.g. USA500 vs SPX, or
 * DAX in EUR vs GRX/EUR) are deliberately absent — substituting a different
 * instrument would silently corrupt a backtest.
 */
export const HISTDATA_SYMBOLS: Readonly<Record<string, string>> = {
  eurusd: 'EURUSD',
  gbpusd: 'GBPUSD',
  usdjpy: 'USDJPY',
  usdcad: 'USDCAD',
  audusd: 'AUDUSD',
  nzdusd: 'NZDUSD',
  usdchf: 'USDCHF',
  eurjpy: 'EURJPY',
  eurgbp: 'EURGBP',
  eurchf: 'EURCHF',
  gbpjpy: 'GBPJPY',
  gbpchf: 'GBPCHF',
  audjpy: 'AUDJPY',
  euraud: 'EURAUD',
  eurcad: 'EURCAD',
  eurnzd: 'EURNZD',
  gbpaud: 'GBPAUD',
  nzdjpy: 'NZDJPY',
  cadchf: 'CADCHF',
  usdhkd: 'USDHKD',
  usdsgd: 'USDSGD',
  xauusd: 'XAUUSD',
  xagusd: 'XAGUSD'
}

/** Whether this app symbol can fall back to HistData. */
export function supportsHistData(symbol: string): boolean {
  return HISTDATA_SYMBOLS[symbol.toLowerCase()] !== undefined
}

function histDataSymbol(symbol: string): string {
  const histSymbol = HISTDATA_SYMBOLS[symbol.toLowerCase()]
  if (!histSymbol) {
    throw new Error(`HistData fallback does not cover "${symbol}" (Dukascopy-only instrument).`)
  }
  return histSymbol
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/**
 * Extracts the one-time form token from HistData's download page. An input
 * with an EMPTY value is the site's way of saying "this file is not available",
 * so it is reported as no token at all rather than being POSTed.
 */
function extractToken(html: string): string | null {
  const input = html.match(/<input\b[^>]*\bid=(["'])tk\1[^>]*>/i)
  if (!input) return null
  const value = input[0].match(/\bvalue=(["'])(.*?)\1/i)
  if (!value?.[2]) return null
  return value[2].replace(/&amp;/g, '&').trim() || null
}

/** True for a local-file ZIP header ("PK"). Rejects HTML error pages. */
function isZip(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b
}

/** Decompresses a HistData ZIP and returns the M1 CSV text it contains. */
function csvFromZip(bytes: Uint8Array): string {
  let entries: Record<string, Uint8Array>
  try {
    entries = unzipSync(bytes)
  } catch (err) {
    throw new Error(`invalid HistData ZIP: ${err instanceof Error ? err.message : String(err)}`)
  }
  const csvName = Object.keys(entries).find((name) => name.toLowerCase().endsWith('.csv'))
  if (!csvName) {
    throw new Error('HistData ZIP contains no M1 CSV file')
  }
  return strFromU8(entries[csvName])
}

const STAMP = /^(\d{4})(\d{2})(\d{2}) (\d{2})(\d{2})(\d{2})$/

/**
 * Parses HistData Generic ASCII M1 rows into Wanderlust candles.
 *
 * Row format: `YYYYMMDD HHMMSS;open;high;low;close;volume`, no header. Input
 * may be a whole month or a whole year. Malformed rows are ignored; duplicate
 * timestamps keep the last row. Output is ascending, in UTC, with New York's
 * offset (DST included) already applied.
 */
export function parseHistDataM1(csv: string): Candle[] {
  const byTimestamp = new Map<number, Candle>()

  for (const rawLine of csv.split(/\r?\n/)) {
    const line = rawLine.replace(/^\uFEFF/, '').trim()
    if (!line) continue
    const fields = line.split(';')
    if (fields.length < 5) continue

    const stamp = STAMP.exec(fields[0].trim())
    if (!stamp) continue
    const timestamp = histStampToUtcMs(
      Number(stamp[1]),
      Number(stamp[2]),
      Number(stamp[3]),
      Number(stamp[4]),
      Number(stamp[5]),
      Number(stamp[6])
    )

    const open = Number(fields[1])
    const high = Number(fields[2])
    const low = Number(fields[3])
    const close = Number(fields[4])
    const parsedVolume = fields.length > 5 ? Number(fields[5]) : 0
    const volume = Number.isFinite(parsedVolume) ? parsedVolume : 0

    if (
      ![timestamp, open, high, low, close].every(Number.isFinite) ||
      open <= 0 ||
      high <= 0 ||
      low <= 0 ||
      close <= 0 ||
      high < low ||
      high < Math.max(open, close) ||
      low > Math.min(open, close)
    ) {
      continue
    }

    byTimestamp.set(timestamp, { timestamp, open, high, low, close, volume })
  }

  return [...byTimestamp.values()].sort((a, b) => a.timestamp - b.timestamp)
}

/** A period HistData actually offers: one month, or a whole year of months. */
interface Archive {
  /** Period the archive really covers, e.g. `2024-03` or `2024`. */
  label: string
  candles: Candle[]
}

/**
 * A period HistData has no file for. Deterministic, so the download loop
 * rethrows it instead of burning retries on a 404-in-disguise.
 */
class PeriodUnavailableError extends Error {}

/** One candidate period page, in the order HistData should be asked. */
interface PeriodCandidate {
  label: string
  datemonth: string
  /** Path appended to a download route, e.g. `EURUSD/2024/3`. */
  path: string
}

function periodCandidates(histSymbol: string, year: number, month: number): PeriodCandidate[] {
  // Month zip first, in both URL spellings HistData has used, then the year zip.
  return [
    {
      label: `${year}-${pad2(month)}`,
      datemonth: `${year}${pad2(month)}`,
      path: `${histSymbol}/${year}/${month}`
    },
    {
      label: `${year}-${pad2(month)}`,
      datemonth: `${year}${pad2(month)}`,
      path: `${histSymbol}/${year}/${pad2(month)}`
    },
    { label: `${year}`, datemonth: `${year}`, path: `${histSymbol}/${year}` }
  ]
}

/** Finds a downloadable token for one period page, or null if there is none. */
async function loadPeriodPage(
  histSymbol: string,
  candidate: PeriodCandidate
): Promise<{ token: string; referer: string } | null> {
  let lastError: unknown = null

  for (const route of DOWNLOAD_ROUTES) {
    const referer = `${route}${candidate.path}`
    try {
      const resp = await fetch(referer, {
        headers: { ...HEADERS, Referer: `${HOST}/download-free-forex-data/` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      })
      if (resp.status !== 200) {
        lastError = new Error(`HTTP ${resp.status}`)
        continue
      }
      const token = extractToken(await resp.text())
      if (token) return { token, referer }
      // 200 without a token: the page rendered but offered no file here.
      return null
    } catch (err) {
      lastError = err
    }
  }

  throw new Error(
    `HistData period page failed for ${histSymbol} ${candidate.path}: ` +
      `${lastError instanceof Error ? lastError.message : String(lastError)}`
  )
}

/** Downloads and parses the first available archive for a symbol/period. */
async function downloadArchive(histSymbol: string, year: number, month: number): Promise<Archive> {
  const monthLabel = `${year}-${pad2(month)}`
  const wait = (attempt: number): number =>
    Math.min(1000 * 2 ** attempt + Math.random() * 750, RETRY_MAX_DELAY_MS)
  let lastError: unknown = null

  for (let attempt = 0; attempt < DOWNLOAD_ATTEMPTS; attempt++) {
    try {
      const candidates = periodCandidates(histSymbol, year, month)
      let page: { token: string; referer: string } | null = null
      let candidate = candidates[0]
      for (const option of candidates) {
        const found = await loadPeriodPage(histSymbol, option)
        if (found) {
          page = found
          candidate = option
          break
        }
      }
      if (!page) {
        throw new PeriodUnavailableError(
          `HistData has no M1 archive for ${histSymbol} ${monthLabel} ` +
            '(month and year pages both returned no download)'
        )
      }

      const resp = await fetch(DOWNLOAD_ENDPOINT, {
        method: 'POST',
        headers: {
          ...HEADERS,
          Origin: HOST,
          // Required: without a Referer the server silently answers 0 bytes.
          Referer: page.referer,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({
          tk: page.token,
          date: String(year),
          datemonth: candidate.datemonth,
          platform: 'ASCII',
          timeframe: 'M1',
          fxpair: histSymbol
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      })
      if (resp.status !== 200) {
        throw new Error(`HistData download returned HTTP ${resp.status}`)
      }
      const bytes = new Uint8Array(await resp.arrayBuffer())
      if (bytes.length === 0) {
        // HistData's universal failure response: 200 with an empty body.
        throw new Error('HistData returned an empty body (token rejected or file unavailable)')
      }
      if (!isZip(bytes)) {
        throw new Error('HistData download did not return a ZIP archive')
      }
      const candles = parseHistDataM1(csvFromZip(bytes))
      if (candles.length === 0) {
        throw new Error(`HistData archive ${histSymbol} ${candidate.label} had no M1 candles`)
      }
      return { label: candidate.label, candles }
    } catch (err) {
      if (err instanceof PeriodUnavailableError) throw err
      lastError = err
      if (attempt < DOWNLOAD_ATTEMPTS - 1) await sleep(wait(attempt))
    }
  }

  throw new Error(
    `HistData download failed for ${histSymbol} ${monthLabel}: ` +
      `${lastError instanceof Error ? lastError.message : String(lastError)}`
  )
}

/**
 * Archives held only for this app run, keyed by symbol and the period label
 * that was actually downloaded. SQLite is the durable cache, so nothing needs
 * to persist here; a failed download is evicted so later days can retry.
 */
const archiveCache = new Map<string, Promise<Archive>>()

/**
 * Loads (and memoizes) the archive covering one month of New York time. A month
 * page is tried first; older months fall back to the whole-year zip, which is
 * then registered under the year key so its eleven sibling months are free.
 */
function loadArchive(histSymbol: string, year: number, month: number): Promise<Archive> {
  const monthLabel = `${year}-${pad2(month)}`
  const monthKey = `${histSymbol}:${monthLabel}`
  const yearKey = `${histSymbol}:${year}`

  const cached = archiveCache.get(monthKey) ?? archiveCache.get(yearKey)
  if (cached) return cached

  const download = downloadArchive(histSymbol, year, month)
  archiveCache.set(monthKey, download)
  void download.then(
    (archive) => {
      const key = `${histSymbol}:${archive.label}`
      if (!archiveCache.has(key)) archiveCache.set(key, download)
    },
    () => archiveCache.delete(monthKey)
  )
  return download
}

/**
 * Returns one UTC day's M1 candles from HistData. Archives are downloaded
 * lazily and shared by every day they cover in this run (a year archive serves
 * all twelve months); the caller persists only the requested day, so Dukascopy
 * remains the primary source.
 */
export async function fetchHistDataDay(
  symbol: string,
  dayStartMs: number,
  onProgress: (message: string) => void
): Promise<Candle[]> {
  const histSymbol = histDataSymbol(symbol)
  const date = new Date(dayStartMs)
  const year = date.getUTCFullYear()
  const month = date.getUTCMonth() + 1
  const monthLabel = `${year}-${pad2(month)}`

  // A UTC day runs from 04:00/05:00 New York time to 04:00/05:00 the next New
  // York day, so on the last day of a month the tail hour lives in the next
  // month's archive. Load that one too rather than returning a short day.
  const periods: Array<[number, number]> = [[year, month]]
  if (date.getUTCDate() === daysInMonth(year, month)) {
    periods.push(month === 12 ? [year + 1, 1] : [year, month + 1])
  }

  onProgress(`HistData: loading ${histSymbol} ${monthLabel} M1 data…`)
  const archives = await Promise.all(
    periods.map(([periodYear, periodMonth]) => loadArchive(histSymbol, periodYear, periodMonth))
  )

  const dayEnd = dayStartMs + DAY_MS - 1
  const dayCandles: Candle[] = []
  for (const archive of archives) {
    for (const candle of archive.candles) {
      if (candle.timestamp >= dayStartMs && candle.timestamp <= dayEnd) dayCandles.push(candle)
    }
  }
  dayCandles.sort((a, b) => a.timestamp - b.timestamp)

  const label = archives.map((archive) => archive.label).join(' + ')
  onProgress(
    `HistData: ${dayCandles.length} M1 candles for ${new Date(dayStartMs)
      .toISOString()
      .slice(0, 10)} (${label} archive)`
  )
  return dayCandles
}
