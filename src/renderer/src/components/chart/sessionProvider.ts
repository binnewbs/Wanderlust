/**
 * The "wanderlust" Vela data provider: serves the ACTIVE backtest session's
 * clock for whatever symbol/timeframe the chart asks for.
 *
 * The workspace registers this provider (via `VelaShellOptions.providers`) and
 * addresses the chart with the session's ticker. The session holds ONE dataset
 * — the M1 clock — and this provider AGGREGATES the revealed minutes into the
 * timeframe the chart asked for, so switching timeframe is a regrouping of the
 * same tape rather than a dataset swap (and never a blank pane).
 *
 * Since Phase 4, `getBars` (and the exported `playbackSlice` the host chart
 * uses) reveal only the candles up to the session's playback position — the
 * chart is "blacked out" ahead of `currentIndex`, exactly like a replay. The
 * bar the clock currently sits in is left FORMING: at 10:04 a 15m chart's 10:00
 * bar is built from the four revealed minutes 10:00-10:04, and its close IS the
 * current price — the chart and the clock can never disagree.
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
import { CLOCK_MS, TIMEFRAME_MS, bucketStart, type Timeframe } from '@shared/timeframes'
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

// The M1 clock converted to OHLCV ONCE per session and reused across ticks.
// Slicing the converted array is a shallow copy, so a 40k-minute session at 20
// ticks/s stays cheap (no per-tick object mapping / GC churn). The run-up is
// converted separately and stays its own array so per-tick reveals only ever
// prepend its POINTERS, never re-copy its bars.
const m1BySession = new WeakMap<ActiveSession, { clock: OHLCV[]; runUp: OHLCV[] }>()

function m1OhlcvFor(session: ActiveSession): { clock: OHLCV[]; runUp: OHLCV[] } {
  let bucket = m1BySession.get(session)
  if (!bucket) {
    bucket = {
      clock: candlesToOhlcv(session.clockCandles),
      runUp: candlesToOhlcv(session.clockRunUp)
    }
    m1BySession.set(session, bucket)
  }
  return bucket
}

/**
 * Append `minutes` to the aggregated `bars`, folding them into the open (last)
 * bucket. Buckets are UTC-aligned exactly like the main process's
 * `aggregateM1`, so a grouped bar is byte-identical to the cached one.
 *
 * The open bucket is re-created here and a NEW array is returned, so the series
 * handed to Vela on the previous push is never mutated underneath an
 * in-flight reload.
 */
function foldMinutes(bars: OHLCV[], minutes: OHLCV[], tfMs: number): OHLCV[] {
  if (minutes.length === 0) return bars
  // Drop the previous open bucket: it is rebuilt below (detached), so the array
  // Vela may still be reading is left untouched.
  const out = bars.length > 0 ? bars.slice(0, -1) : []
  let open: OHLCV | null = bars.length > 0 ? { ...bars[bars.length - 1] } : null
  for (const m of minutes) {
    const start = bucketStart(m.time, tfMs)
    if (open && open.time === start) {
      if (m.high > open.high) open.high = m.high
      if (m.low < open.low) open.low = m.low
      open.close = m.close
      open.volume = (open.volume ?? 0) + (m.volume ?? 0)
      continue
    }
    if (open) out.push(open)
    open = {
      time: start,
      open: m.open,
      high: m.high,
      low: m.low,
      close: m.close,
      volume: m.volume ?? 0
    }
  }
  if (open) out.push(open)
  return out
}

interface AggEntry {
  /** Clock position this aggregation was built for. */
  clockIndex: number
  runUpBars: OHLCV[]
  tailBars: OHLCV[]
}

/** Reveals wider than this fall back to a full rebuild instead of folding. */
const MAX_FOLD_MINUTES = 512

// Per-session aggregation cache, keyed by bar length. A forward reveal only
// ever changes the OPEN bucket, so advancing the clock folds the newly revealed
// minutes into the previous result; a rewind/jump/timeframe switch rebuilds.
// (Keyed by the session object, so a new session gets a fresh cache.)
const aggregationCache = new WeakMap<ActiveSession, Partial<Record<number, AggEntry>>>()

function aggregateRevealed(session: ActiveSession, tfMs: number, currentIndex: number): AggEntry {
  let cache = aggregationCache.get(session)
  if (!cache) {
    cache = {}
    aggregationCache.set(session, cache)
  }
  const prev = cache[tfMs]
  const { clock } = m1OhlcvFor(session)
  if (
    prev &&
    currentIndex >= prev.clockIndex &&
    currentIndex - prev.clockIndex <= MAX_FOLD_MINUTES
  ) {
    const tailBars = foldMinutes(prev.tailBars, clock.slice(prev.clockIndex, currentIndex), tfMs)
    const next: AggEntry = { clockIndex: currentIndex, runUpBars: prev.runUpBars, tailBars }
    cache[tfMs] = next
    return next
  }
  const { runUp } = m1OhlcvFor(session)
  const next: AggEntry = {
    clockIndex: currentIndex,
    runUpBars: foldMinutes([], runUp, tfMs),
    tailBars: foldMinutes([], clock.slice(0, currentIndex), tfMs)
  }
  cache[tfMs] = next
  return next
}

/**
 * The visible playback slice for a given chart timeframe: the run-up context
 * plus the session's revealed minutes, GROUPED into `activeVelaTf` bars.
 *
 * At `currentIndex === 0` that is the run-up alone (a session never opens on a
 * blank chart). From there the newest bar is the one the clock currently sits
 * in — a forming bar built only from revealed minutes — so its close is the
 * current price on every timeframe.
 */
export function playbackSlice(
  session: ActiveSession,
  activeVelaTf: string,
  currentIndex: number
): OHLCV[] {
  const tf = dukascopyTimeframe(activeVelaTf)
  const tfMs = TIMEFRAME_MS[tf as Timeframe]
  const { clock, runUp } = m1OhlcvFor(session)
  if (tfMs <= CLOCK_MS) {
    // 1m view: the clock IS the data — no grouping needed.
    if (currentIndex <= 0) return runUp
    const tail = clock.slice(0, currentIndex)
    return runUp.length === 0 ? tail : runUp.concat(tail)
  }
  const { runUpBars, tailBars } = aggregateRevealed(session, tfMs, currentIndex)
  if (tailBars.length === 0) return runUpBars
  if (runUpBars.length === 0) return tailBars
  return runUpBars.concat(tailBars)
}

export function createSessionDataProvider(): DataProvider {
  const capabilities: ProviderCapabilities = {
    enumerate: true, // listSymbols implemented → bare-symbol resolution + picker
    stream: false, // static history; no live ticks (backtest data)
    symbolInfo: true
  }

  return {
    /**
     * The only required provider method. Returns the session's revealed minutes
     * GROUPED for Vela's `timeframe` (only what the playback position has
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
