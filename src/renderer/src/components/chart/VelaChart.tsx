import { useEffect, useRef } from 'react'
import { VelaWorkspace, type VelaWorkspaceOptions } from '@luxalgo/vela/workspace'
import type { Candle } from '@shared/ipc'
import { candlesToOhlcv, velaTimeframe } from './vela'

/**
 * React wrapper around `@luxalgo/vela/workspace` (single-chart mode).
 *
 * The workspace is created lazily per session with the session's candles as
 * offline bars (`MarketConfig.data` — no provider, no network). Destroying the
 * workspace on unmount keeps the DOM and the workspace's global registries
 * clean (StrictMode mounts effects twice in dev).
 *
 * Phase 4's playback loop will drive the chart with the same offline `data`
 * seam via `chart.setMarket({ symbol, timeframe, data: slice })` or
 * `renderer.updateBar(...)`; per-session mounts are correct for Phase 3.
 */

export interface VelaChartProps {
  /** Dukascopy instrument id, lowercase (e.g. 'eurusd') */
  symbol: string
  /** Dukascopy timeframe id (e.g. 'm1') */
  timeframe: string
  /** Time-ordered session candles */
  candles: Candle[]
}

export default function VelaChart({
  symbol,
  timeframe,
  candles
}: VelaChartProps): React.JSX.Element {
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
      data: candlesToOhlcv(candles), // offline bars — no provider, no network
      volume: true,
      timezone: 'Etc/UTC',
      timeframes: ['1', '5', '15', '30', '60', '240', 'D']
    }

    const workspace = new VelaWorkspace(el, options)
    return () => workspace.destroy()
  }, [symbol, timeframe, candles])

  return <div ref={containerRef} className="h-full w-full" />
}
