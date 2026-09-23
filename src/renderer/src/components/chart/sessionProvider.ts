/**
 * The "wanderlust" Vela data provider: serves the ACTIVE backtest session's
 * candles for whatever symbol/timeframe the chart asks for.
 *
 * The workspace registers this provider (via `VelaShellOptions.providers`) and
 * addresses the chart with the session's ticker. The topbar's timeframe chips
 * and any price-scale depth request flow through the feed → `getBars`, which
 * looks up the corresponding candles in the session store (every timeframe was
 * downloaded when the session started) — so switching timeframe on the chart
 * actually swaps datasets instead of going blank.
 *
 * Since Phase 4, `getBars` (and the exported `playbackSlice` the host chart
 * uses) reveal only the candles up to the session's playback position — the
 * chart is "blacked out" ahead of `currentIndex`, exactly like a replay. A
 * topbar timeframe switch mid-session lands on the correct revealed window,
 * never the full dataset.
 *
 * A fresh provider is created per workspace (per session), but it reads the
 * store live, so it always answers with the current session's data.
 */
import type {
  DataProvider,
  OHLCV,
  ProviderCapabilities,
  ProviderInfo,
  SymbolDescriptor
} from '@luxalgo/vela'
import { TIMEFRAME_MS, type Timeframe } from '@shared/timeframes'
import type { ActiveSession } from '@/store/session'
import { useSessionStore } from '@/store/session'
import { candlesToOhlcv, dukascopyTimeframe, VELA_TIMEFRAMES } from './vela'

export const SESSION_PROVIDER = 'wanderlust'

/** The ticker the chart addresses the session by (uppercase dukascopy id). */
export function sessionTicker(ticker?: string): string {
  return (ticker ?? '').toUpperCase()
}

/**
 * How many candles the playback view keeps visible ahead of the latest revealed
 * bar. The replay window slides as playback advances (a fixed TIME window is
 * derived from the active timeframe's bar length).
 */
export const PLAYBACK_WINDOW_BARS = 120

// Convert each session's candle arrays to OHLCV ONCE and reuse across ticks —
// slicing the converted array is a shallow copy, so a 30k-bar session at 20
// ticks/s stays cheap (no per-tick object mapping / GC churn). The run-up day
// (pre-session context) is converted separately and stays its own array so
// per-tick reveals only ever prepend its POINTERS, never re-copy its bars.
const ohlcvBySession = new WeakMap<
  ActiveSession,
  { session: Partial<Record<string, OHLCV[]>>; runUp: Partial<Record<string, OHLCV[]>> }
>()

function bucketFor(session: ActiveSession): {
  session: Partial<Record<string, OHLCV[]>>
  runUp: Partial<Record<string, OHLCV[]>>
} {
  let bucket = ohlcvBySession.get(session)
  if (!bucket) {
    bucket = { session: {}, runUp: {} }
    ohlcvBySession.set(session, bucket)
  }
  return bucket
}

function ohlcvFor(session: ActiveSession, dukaTf: string): OHLCV[] {
  const bucket = bucketFor(session)
  if (!bucket.session[dukaTf]) {
    bucket.session[dukaTf] = candlesToOhlcv(session.candlesByTimeframe[dukaTf] ?? [])
  }
  return bucket.session[dukaTf]
}

function runUpOhlcvFor(session: ActiveSession, dukaTf: string): OHLCV[] {
  const bucket = bucketFor(session)
  if (!bucket.runUp[dukaTf]) {
    bucket.runUp[dukaTf] = candlesToOhlcv(session.runUpByTimeframe[dukaTf] ?? [])
  }
  return bucket.runUp[dukaTf]
}

// Sequential-reveal slice cache. The base-timeframe playback slice grows by
// exactly ONE bar per tick, so re-slicing the whole dataset + re-concatenating
// the run-up every tick (up to 20×/s on long sessions) is pure churn. When the
// previous call was exactly one index behind, grow that slice with `concat` —
// which yields a NEW array, so the one previously handed to Vela is never
// mutated underneath an in-flight load. Any jump, rewind, or timeframe switch
// falls back to the full build and re-seeds the cache. (Entries are keyed by
// the session object: a new session gets a fresh bucket via the WeakMap.)
const sliceCache = new WeakMap<
  ActiveSession,
  Partial<Record<string, { lastIndex: number; last: OHLCV[] }>>
>()

function cachedBaseSlice(
  session: ActiveSession,
  tf: string,
  bars: OHLCV[],
  runUp: OHLCV[],
  currentIndex: number
): OHLCV[] {
  let bucket = sliceCache.get(session)
  if (!bucket) {
    bucket = {}
    sliceCache.set(session, bucket)
  }
  const prev = bucket[tf]
  // Only the exact sequential advance-by-one on the same arrays can reuse the
  // previous slice — any other access (rewind, jump, first call, timeout) falls
  // through to a full build below.
  if (
    prev &&
    prev.lastIndex === currentIndex - 1 &&
    prev.last.length === runUp.length + currentIndex - 1
  ) {
    const nextBar = bars[currentIndex - 1]
    if (nextBar) {
      const last = prev.last.concat([nextBar])
      bucket[tf] = { lastIndex: currentIndex, last }
      return last
    }
  }
  const tail = bars.slice(0, currentIndex)
  const last = runUp.length === 0 ? tail : runUp.concat(tail)
  bucket[tf] = { lastIndex: currentIndex, last }
  return last
}

/**
 * The visible playback slice for a given chart timeframe: the day(s) of
 * run-up context followed by the session candles revealed up to `currentIndex`
 * (run-up is empty when it couldn't be fetched, so the slice degrades to the
 * plain Phase-4 reveal).
 *
 * - Base timeframe: `runUp ++ candles.slice(0, currentIndex)` (the master
 *   array plus its prelude).
 * - Any other timeframe: `runUp ++ bars` complete up to the SAME horizon the
 *   base view reveals (the end of the last complete base candle), with a
 *   forming bar reconstructed from revealed base candles when the active
 *   timeframe is coarser — so the right-edge price never runs ahead of (or
 *   behind) the base timeframe's current price.
 */
export function playbackSlice(
  session: ActiveSession,
  activeVelaTf: string,
  currentIndex: number
): OHLCV[] {
  const tf = dukascopyTimeframe(activeVelaTf)
  const bars = ohlcvFor(session, tf)
  const runUp = runUpOhlcvFor(session, tf)
  if (tf === session.timeframe) {
    // Base timeframe (the master array + its run-up prelude): sequential
    // advances reuse the previous slice (see cachedBaseSlice); everything else
    // rebuilds. Equivalent to `runUp ++ bars.slice(0, currentIndex)`.
    return cachedBaseSlice(session, tf, bars, runUp, currentIndex)
  }
  // Any other timeframe. The base view reveals ONE COMPLETE candle per index,
  // so its "now" is the close of the last complete base candle. Other
  // timeframes must reveal up to the SAME horizon or they leak future prices:
  // a stored m5 bar's close is the price from the END of its 5-minute bucket,
  // so including every bucket whose OPEN is <= the base cutoff embeds minutes
  // the base view has not revealed yet (m5 "shows the price in advance").
  if (currentIndex <= 0 || session.candlesByTimeframe[session.timeframe]?.length === 0) {
    // Nothing revealed on the base view yet — run-up context only.
    return runUp
  }
  const base = ohlcvFor(session, session.timeframe)
  const baseMs = TIMEFRAME_MS[session.timeframe as Timeframe]
  const tfMs = TIMEFRAME_MS[tf as Timeframe]
  // End of the last complete base candle's interval — the playback horizon.
  const lastBase = base[Math.min(currentIndex - 1, base.length - 1)]
  const horizon = lastBase.time + baseMs

  let tail: OHLCV[]
  if (tfMs <= baseMs) {
    // Same-or-finer cadence: every COMPLETE bar whose interval [t, t + tfMs)
    // ends on or before the horizon.
    let end = 0
    while (end < bars.length && bars[end].time + tfMs <= horizon) end++
    tail = end === bars.length ? bars : bars.slice(0, end)
  } else {
    // Coarser cadence: every complete bucket ending on or before the horizon,
    // plus a synthetic forming bar for the bucket currently being played
    // (rebuilt from revealed base candles only), so the right-edge close — the
    // current price — matches the base timeframe exactly.
    let end = 0
    while (end < bars.length && bars[end].time + tfMs <= horizon) end++
    const complete = end === bars.length ? bars : bars.slice(0, end)
    const bucket = Math.floor(lastBase.time / tfMs) * tfMs
    if (bucket + tfMs > horizon) {
      const forming = buildFormingBar(base, currentIndex, bucket)
      tail = forming ? complete.concat([forming]) : complete
    } else {
      tail = complete
    }
  }
  if (runUp.length === 0) return tail
  if (tail.length === 0) return runUp
  return runUp.concat(tail)
}

/**
 * The forming bar of a coarser timeframe at the playback position: the bucket
 * containing the last revealed base candle, synthesized from ONLY the revealed
 * base candles. The fully-stored bucket is unusable here — its close/high/low
 * embed prices from minutes the base view has not played yet. Returns
 * `undefined` when no revealed base candle falls inside the bucket.
 */
function buildFormingBar(
  base: OHLCV[],
  currentIndex: number,
  bucketStart: number
): OHLCV | undefined {
  const end = Math.min(currentIndex, base.length)
  let open: number | undefined
  let high = Number.NEGATIVE_INFINITY
  let low = Number.POSITIVE_INFINITY
  let close = 0
  let volume = 0
  for (let i = 0; i < end; i++) {
    const b = base[i]
    // All revealed base candles at or after the bucket open belong to this
    // bucket: the bucket contains `lastBase.time`, and no revealed candle is
    // after it (they ascend, all complete).
    if (b.time < bucketStart) continue
    if (open === undefined) open = b.open
    if (b.high > high) high = b.high
    if (b.low < low) low = b.low
    close = b.close
    volume += b.volume ?? 0
  }
  if (open === undefined) return undefined
  return { time: bucketStart, open, high, low, close, volume }
}

export function createSessionDataProvider(): DataProvider {
  const capabilities: ProviderCapabilities = {
    enumerate: true, // listSymbols implemented → bare-symbol resolution + picker
    stream: false, // static history; no live ticks (backtest data)
    symbolInfo: true
  }

  return {
    /**
     * The only required provider method. Returns the session's revealed bars for
     * Vela's `timeframe` (slice-aware: only what the playback position has
     * reached). Range is otherwise ignored: the chart frames its requests around
     * "now" while a session is a fixed historical window, so we answer with the
     * whole reveal and let Vela frame it. An empty reveal resolves to `[]`
     * (blank pane) rather than a parked load.
     */
    async getBars(ticker, timeframe) {
      const st = useSessionStore.getState()
      const session = st.session
      if (!session) return []
      if (sessionTicker(ticker) !== sessionTicker(session.asset.id)) return []
      return playbackSlice(session, timeframe, st.currentIndex)
    },

    /** Only the session's own asset is pickable, so switching symbols can't
     *  strand the chart on un-downloaded data. */
    async listSymbols(): Promise<SymbolDescriptor[]> {
      const session = useSessionStore.getState().session
      if (!session) return []
      return [
        {
          ticker: sessionTicker(session.asset.id),
          description: session.asset.label,
          type: session.asset.category
        }
      ]
    },

    async getSymbolInfo(ticker) {
      const session = useSessionStore.getState().session
      if (!session || sessionTicker(ticker) !== sessionTicker(session.asset.id)) return undefined
      return {
        ticker: sessionTicker(session.asset.id),
        description: session.asset.label,
        type: session.asset.category
      }
    },

    info(): ProviderInfo {
      return {
        name: SESSION_PROVIDER,
        displayName: 'Wanderlust session',
        supportedTimeframes: VELA_TIMEFRAMES,
        capabilities
      }
    }
  }
}
