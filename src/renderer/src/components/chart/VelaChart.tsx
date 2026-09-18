import { useEffect, useRef } from 'react'
import { VelaWorkspace, type VelaWorkspaceOptions } from '@luxalgo/vela/workspace'
import type { VisibleRange } from '@luxalgo/vela'
import { useSessionStore } from '@/store/session'
import {
  PLAYBACK_WINDOW_BARS,
  SESSION_PROVIDER,
  createSessionDataProvider,
  playbackSlice,
  sessionTicker
} from './sessionProvider'
import { timeframeMs, velaTimeframe, VELA_TIMEFRAMES } from './vela'

/** Bars kept visible in the playback window (matches the provider's reveal). */
const WINDOW_BARS = PLAYBACK_WINDOW_BARS

/**
 * React wrapper around `@luxalgo/vela/workspace` (single-chart mode).
 *
 * The workspace is created lazily per session and addresses the chart with the
 * `wanderlust` provider. Since Phase 4 the chart is REPLAY-driven: it only ever
 * shows the candles revealed up to the store's `currentIndex`, and the view
 * slides a fixed bar window with the latest revealed bar.
 *
 * Slicing is pushed imperatively so the playback loop never re-renders React:
 * - a store `currentIndex` change → `chart.setMarket({ data: slice })`
 * - a topbar timeframe switch (`market:changed`) → same, for the new timeframe
 *
 * Both paths call `setMarket` IN PLACE (the chart instance, panes, drawings and
 * event subscriptions survive); calling it faster than it resolves is safe
 * (older calls are superseded silently). Passing `data` makes the market
 * offline — a subsequent same-identity `setMarket` does NOT re-fire
 * `market:changed`, so there is no echo loop.
 *
 * Destroying the workspace on unmount keeps the DOM and the workspace's global
 * registries clean (StrictMode mounts effects twice in dev). Per-session
 * remounts (App keys this component by market identity) give each session a
 * fresh workspace + provider.
 */

export interface VelaChartProps {
  /** Dukascopy instrument id, lowercase (e.g. 'eurusd') — the session's asset */
  symbol: string
  /** Dukascopy timeframe id (e.g. 'm1') — the chart's INITIAL view */
  timeframe: string
}

export default function VelaChart({ symbol, timeframe }: VelaChartProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const options: VelaWorkspaceOptions = {
      layout: false, // single chart, no layout picker
      live: false, // static history; no forming candle
      theme: 'dark',
      persist: false, // don't restore stale markets/drawings across sessions
      symbol: symbol.toUpperCase(),
      timeframe: velaTimeframe(timeframe),
      providers: { [SESSION_PROVIDER]: () => createSessionDataProvider() },
      volume: true,
      timezone: 'Etc/UTC',
      timeframes: VELA_TIMEFRAMES
    }

    const workspace = new VelaWorkspace(el, options)
    const chart = workspace.chart

    // Push the session's revealed slice for the chart's CURRENT timeframe,
    // framed by a sliding playback window around the newest revealed bar.
    // Reads state live, so it never goes stale no matter what changed.
    //
    // IDEMPOTENCY GUARD: `chart.setMarket({ data })` itself fires
    // `market:changed` ("offline data changed"), and the topbar's timeframe
    // switch re-enters here too — without a guard, push → setMarket →
    // market:changed → push → … loops forever on the renderer main thread and
    // freezes the whole screen. Keying on (timeframe, index, slice length)
    // makes every re-entrant push a no-op, so the loop always converges after
    // one redundant setMarket at most.
    let lastPushKey = ''
    const pushSlice = (): void => {
      const st = useSessionStore.getState()
      const session = st.session
      if (!session) return
      const activeTf = chart.market.timeframe ?? velaTimeframe(timeframe)
      const slice = playbackSlice(session, activeTf, st.currentIndex)
      const key = `${activeTf}:${st.currentIndex}:${slice.length}`
      if (key === lastPushKey) return
      lastPushKey = key
      const last = slice[slice.length - 1]?.time
      const barMs = timeframeMs(activeTf)
      const visibleRange: VisibleRange | undefined =
        last === undefined ? undefined : { from: last - barMs * WINDOW_BARS, to: last + barMs }
      void chart.setMarket({
        symbol: sessionTicker(session.asset.id),
        timeframe: activeTf,
        data: slice,
        visibleRange
      })
    }

    // Playback advance: the store index moves (interval in PlaybackPanel) →
    // re-apply the slice, without a React re-render of this component.
    const unsubIndex = useSessionStore.subscribe((state, prev) => {
      if (state.currentIndex !== prev.currentIndex) pushSlice()
    })
    // Topbar timeframe switch: Vela switches in place (provider serves the new
    // timeframe's reveal) — repin the same reveal as offline data. Re-entrant
    // `market:changed` echoes (from our own setMarket) hit the guard and no-op.
    const unsubMarket = chart.on('market:changed', () => pushSlice())
    // Frame the initial reveal (index 0 → blank replay surface).
    pushSlice()

    return () => {
      unsubIndex()
      unsubMarket()
      workspace.destroy()
    }
  }, [symbol, timeframe])

  return <div ref={containerRef} className="h-full w-full" />
}
