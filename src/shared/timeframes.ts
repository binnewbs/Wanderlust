/**
 * Canonical Dukascopy timeframe list shared by main (download validation),
 * the renderer store (session downloads), and the Vela adapter (mapping).
 *
 * A backtest session downloads EVERY timeframe in this list, so the chart can
 * switch freely (finest → coarsest).
 */

import type { Candle } from './ipc'

/** All supported Dukascopy candle timeframes, ordered finest → coarsest. */
export const TIMEFRAMES = ['m1', 'm5', 'm15', 'm30', 'h1', 'h4', 'd1'] as const

export type Timeframe = (typeof TIMEFRAMES)[number]

export const TIMEFRAME_LABELS: Record<Timeframe, string> = {
  m1: '1 minute',
  m5: '5 minutes',
  m15: '15 minutes',
  m30: '30 minutes',
  h1: '1 hour',
  h4: '4 hours',
  d1: '1 day'
}

export function isTimeframe(value: unknown): value is Timeframe {
  return typeof value === 'string' && (TIMEFRAMES as readonly string[]).includes(value)
}

/** Candle length (ms) per timeframe — PERFECT for deriving 24h-of-bars math. */
export const TIMEFRAME_MS: Record<Timeframe, number> = {
  m1: 60_000,
  m5: 300_000,
  m15: 900_000,
  m30: 1_800_000,
  h1: 3_600_000,
  h4: 14_400_000,
  d1: 86_400_000
}

export function timeframeMs(tf: Timeframe): number {
  return TIMEFRAME_MS[tf]
}

/**
 * THE CLOCK. A session tracks "now" in M1 and nothing else — every coarser
 * timeframe is aggregated from these minutes, so there is exactly one time
 * basis in the app (one reveal index, one order-evaluation cadence, one
 * notion of what the chart's right edge means).
 */
export const CLOCK_TIMEFRAME = 'm1' as const
export const CLOCK_MS = TIMEFRAME_MS.m1

/**
 * Start of the aggregation bucket a candle opening at `ts` belongs to.
 * UTC-aligned (minute/hour/day), matching the main process's `aggregateM1`
 * so renderer-built bars are byte-identical to the cached ones.
 */
export function bucketStart(ts: number, tfMs: number): number {
  return Math.floor(ts / tfMs) * tfMs
}

/** Close time of a bar that opens at `openMs`. "Now" is always a bar CLOSE. */
export function barCloseMs(openMs: number, tfMs: number): number {
  return openMs + tfMs
}

/**
 * The first bucket boundary STRICTLY after `now`. Stepping forward on a
 * coarser view reveals minutes until the clock reaches exactly this instant —
 * so a 15m chart at 10:04 steps to 10:15, and one already sitting exactly on
 * a boundary steps to the FOLLOWING one (one visible bar per press).
 */
export function nextBoundaryMs(now: number, tfMs: number): number {
  return (Math.floor(now / tfMs) + 1) * tfMs
}

/** The bucket boundary at or before `now` — where a coarser view steps back to. */
export function prevBoundaryMs(now: number, tfMs: number): number {
  return Math.floor(now / tfMs) * tfMs
}

/**
 * How many candles are revealed once the clock has fast-forwarded to
 * `boundaryMs`: every candle whose bar CLOSES at or before it. This is the
 * count a boundary-aligned step lands on, so the step stops at exactly the
 * requested instant (and short of it when the data has a gap there).
 * Returns 0 when the boundary precedes the first candle, `candles.length`
 * when it is at or past the last one.
 */
export function indexClosingAtOrBefore(
  candles: Candle[],
  boundaryMs: number,
  barMs: number = CLOCK_MS
): number {
  let lo = 0
  let hi = candles.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (candles[mid].timestamp + barMs <= boundaryMs) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** How much market time the session's run-up context must cover. */
export const RUNUP_TARGET_MS = 24 * 60 * 60 * 1000

const DAY_MS = 86_400_000

/**
 * The run-up for a session: the most recent WHOLE trading days of `candles`
 * (ascending, all of one timeframe) whose bars add up to at least `targetMs`
 * of market time (count × bar length). Days are UTC-aligned and taken whole —
 * a partial holiday day counts as a full day — and gaps between days
 * (weekends) don't consume the target. So "24 hours of candles" means 24h of
 * actual trading data before the session, not a wall-clock window, and it
 * works for any asset: one full FX day, ~4 index sessions, one daily candle.
 *
 * Returns `[]` for no candles or the whole array when the data is shorter
 * than the target (best-effort context either way).
 */
export function runUpTail(candles: Candle[], barMs: number, targetMs = RUNUP_TARGET_MS): Candle[] {
  if (candles.length === 0) return []
  let acc = 0
  let from = candles.length // first index included in the tail
  for (let i = candles.length - 1; i >= 0 && acc < targetMs;) {
    const dayStart = Math.floor(candles[i].timestamp / DAY_MS) * DAY_MS
    let j = i
    while (j >= 0 && candles[j].timestamp >= dayStart) j--
    from = j + 1
    acc += (i - j) * barMs
    i = j
  }
  return from >= candles.length ? [] : candles.slice(from)
}
