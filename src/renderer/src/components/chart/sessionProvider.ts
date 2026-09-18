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
// ticks/s stays cheap (no per-tick object mapping / GC churn).
const ohlcvBySession = new WeakMap<ActiveSession, Partial<Record<string, OHLCV[]>>>()

function ohlcvFor(session: ActiveSession, dukaTf: string): OHLCV[] {
  let map = ohlcvBySession.get(session)
  if (!map) {
    map = {}
    ohlcvBySession.set(session, map)
  }
  if (!map[dukaTf]) {
    map[dukaTf] = candlesToOhlcv(session.candlesByTimeframe[dukaTf] ?? [])
  }
  return map[dukaTf]
}

/**
 * The visible playback slice for a given chart timeframe: the candles revealed
 * up to `currentIndex`.
 *
 * - Base timeframe: `candles.slice(0, currentIndex)` (the master array).
 * - Any other timeframe: candles whose open time is at/before the base candle
 *   currently revealed (`currentIndex - 1`), so switching timeframe mid-session
 *   still shows only what "has happened" so far.
 */
export function playbackSlice(
  session: ActiveSession,
  activeVelaTf: string,
  currentIndex: number
): OHLCV[] {
  const tf = dukascopyTimeframe(activeVelaTf)
  const bars = ohlcvFor(session, tf)
  const base = ohlcvFor(session, session.timeframe)
  if (tf === session.timeframe) return bars.slice(0, currentIndex)
  const cutoff =
    currentIndex > 0
      ? base[Math.min(currentIndex - 1, base.length - 1)].time
      : Number.NEGATIVE_INFINITY
  let first = 0
  while (first < bars.length && bars[first].time <= cutoff) first++
  return first === bars.length ? bars : bars.slice(0, first)
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
