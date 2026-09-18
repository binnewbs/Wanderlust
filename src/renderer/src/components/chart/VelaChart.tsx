import { useEffect, useRef } from 'react'
import { VelaWorkspace, type VelaWorkspaceOptions } from '@luxalgo/vela/workspace'
import type { SerializedDrawing, VisibleRange } from '@luxalgo/vela'
import { useSessionStore } from '@/store/session'
import type { PositionSelection } from '@/store/trading'
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
 * Since Phase 5 the component also bridges Vela's drawings to the trading
 * store: it forwards the currently SELECTED position drawing (Vela's
 * Long/Short Position tool — anchors [entry, stop, target], direction from
 * geometry) into `store.selectedDrawing`, which seeds the New Order menu.
 * Selection is re-asserted after every slice push because `setMarket` can drop
 * it, so the affordance survives playback.
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

/** Shape of Vela's drawing:selected event payload. */
interface SelectionPayload {
  id: string | null
  ids: string[]
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

    // --- Vela position drawing → store selection (Phase 5) ---
    // A Long/Short Position tool keeps its levels as anchors [entry, stop,
    // target]; direction is geometric (target above entry → long). This is the
    // plain serialized form, so extraction works on any chart state.
    const positionSelection = (d: SerializedDrawing): PositionSelection | null => {
      if (d.type !== 'position') return null
      const [entry, stop, target] = d.anchors
      if (!entry || !stop || !target) return null
      if (
        !Number.isFinite(entry.price) ||
        !Number.isFinite(stop.price) ||
        !Number.isFinite(target.price)
      )
        return null
      return {
        drawingId: d.id,
        direction: target.price >= entry.price ? 'long' : 'short',
        entryPrice: entry.price,
        stopLoss: stop.price,
        takeProfit: target.price
      }
    }

    const selectionById = (id: string | null | undefined): PositionSelection | null => {
      if (!id) return null
      const drawing = chart.drawings.all().find((d) => d.id === id)
      return drawing ? positionSelection(drawing) : null
    }

    const onSelected = (e: SelectionPayload): void => {
      // Prefer the LAST selected position drawing (e.ids is selection order).
      let found: PositionSelection | null = null
      for (const id of e.ids) {
        const sel = selectionById(id)
        if (sel) found = sel
      }
      useSessionStore.getState().setSelectedDrawing(found)
    }
    const onEdited = (e: { id: string }): void => {
      if (useSessionStore.getState().selectedDrawing?.drawingId !== e.id) return
      useSessionStore.getState().setSelectedDrawing(selectionById(e.id))
    }
    const onRemoved = (e: { id: string }): void => {
      if (useSessionStore.getState().selectedDrawing?.drawingId === e.id) {
        useSessionStore.getState().setSelectedDrawing(null)
      }
    }

    const unsubSelected = chart.on('drawing:selected', onSelected)
    const unsubEdited = chart.on('drawing:edited', onEdited)
    const unsubRemoved = chart.on('drawing:removed', onRemoved)

    // --- Playback slicing (Phase 4) ---
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
      const first = slice[0]?.time
      const barMs = timeframeMs(activeTf)
      // At index 0 the reveal is the run-up context — frame ALL of it so the
      // full 24h of pre-session candles are visible on load (not just the last
      // 120 bars). Once playback starts the usual 120-bar window slides in.
      const visibleRange: VisibleRange | undefined =
        last === undefined
          ? undefined
          : st.currentIndex === 0
            ? { from: first, to: last + barMs }
            : { from: last - barMs * WINDOW_BARS, to: last + barMs }
      void chart.setMarket({
        symbol: sessionTicker(session.asset.id),
        timeframe: activeTf,
        data: slice,
        visibleRange
      })
      // `setMarket` can drop the drawing selection — re-assert it so the New
      // Order affordance keeps working across slice pushes.
      const selected = useSessionStore.getState().selectedDrawing
      if (selected) void chart.drawings.select(selected.drawingId)
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

    // --- Hash-gated E2E handle: lets the E2E inject a position drawing and
    // select it exactly as the toolbar would. Inert (untyped) to normal users.
    const w = window as unknown as { __wanderlust?: Record<string, unknown> }
    if (`${window.location.hash}`.includes('e2e')) {
      w.__wanderlust = {
        chart,
        addPosition: (levels: {
          entry: number
          stop: number
          target: number
          time: number
        }): string | null => {
          const anchors = [
            { time: levels.time, price: levels.entry },
            { time: levels.time, price: levels.stop },
            { time: levels.time, price: levels.target }
          ]
          const drawing = chart.drawings.add('position', { anchors })
          return drawing?.id ?? null
        }
      }
    }

    return () => {
      unsubSelected()
      unsubEdited()
      unsubRemoved()
      unsubIndex()
      unsubMarket()
      if (w.__wanderlust) delete w.__wanderlust
      useSessionStore.getState().setSelectedDrawing(null)
      workspace.destroy()
    }
  }, [symbol, timeframe])

  return <div ref={containerRef} className="h-full w-full" />
}
