import { useEffect, useRef } from 'react'
import { VelaWorkspace, type VelaWorkspaceOptions } from '@luxalgo/vela/workspace'
import { SESSION_PROVIDER, createSessionDataProvider } from './sessionProvider'
import { velaTimeframe, VELA_TIMEFRAMES } from './vela'

/**
 * React wrapper around `@luxalgo/vela/workspace` (single-chart mode).
 *
 * The workspace is created lazily per session and addresses the chart with the
 * `wanderlust` provider, which serves the session's downloaded candles for ANY
 * timeframe from the session store — so the topbar's timeframe chips switch
 * datasets live (every timeframe was downloaded when the session started).
 *
 * Destroying the workspace on unmount keeps the DOM and the workspace's global
 * registries clean (StrictMode mounts effects twice in dev). Per-session
 * remounts (App keys this component by market identity) give each session a
 * fresh workspace + provider.
 *
 * Phase 4's playback loop will drive the chart through the same provider seam
 * (`chart.setMarket({ timeframe, data: slice })` or a live bar stream).
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
    return () => workspace.destroy()
  }, [symbol, timeframe])

  return <div ref={containerRef} className="h-full w-full" />
}
