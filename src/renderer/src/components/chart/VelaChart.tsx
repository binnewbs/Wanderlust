import { useEffect, useRef } from 'react'
import { VelaWorkspace, type VelaWorkspaceOptions } from '@luxalgo/vela/workspace'
import type { SerializedDrawing, VisibleRange } from '@luxalgo/vela'
import { useSessionStore } from '@/store/session'
import type { PositionSelection } from '@/store/trading'
import {
  SESSION_PROVIDER,
  createSessionDataProvider,
  playbackSlice,
  sessionTicker
} from './sessionProvider'
import { timeframeMs, velaTimeframe, VELA_TIMEFRAMES } from './vela'

/**
 * Right-side margin (in bars) the playback view keeps past the newest revealed
 * candle when following the tape — Vela's own default right offset. Without it
 * the newest candle is glued flush against the right screen edge.
 */
const FOLLOW_RIGHT_OFFSET = 6

/**
 * Minimal structural view of the Vela renderer bits we bridge. The public
 * `chart.getVisibleRange()` clamps to the loaded data, so it cannot see the
 * right-side whitespace a pinned view carries (the margin, or how far the user
 * panned) — and Vela's reload path (`reframeKeepZoom` inside `setBars`) resets
 * every pane's manual PRICE scale. Reading the renderer's coords/panes directly
 * lets the playback push preserve both, without touching any Vela internals.
 */
interface PriceRange {
  min: number
  max: number
}
interface CoordsBridge {
  barCount: number
  widthPx: number
  visibleLogicalRange(): { from: number; to: number } | null
  logicalToTime(logical: number): number
}
interface ScaleHolderBridge {
  manualScale: PriceRange | null
  scale: PriceRange
}
interface RendererBridge {
  coords: CoordsBridge
  scene: {
    panes: Map<string, ScaleHolderBridge>
    indicatorScales?: Map<string, ScaleHolderBridge>
  }
  setManualScale(holder: ScaleHolderBridge, scale: PriceRange): void
}

function hasScene(r: unknown): r is RendererBridge {
  return (
    typeof r === 'object' &&
    r !== null &&
    'scene' in r &&
    'coords' in r &&
    typeof (r as { setManualScale?: unknown }).setManualScale === 'function'
  )
}

/**
 * Resolve the NATIVE renderer from the chart shell. `chart.renderer` is a
 * getter that returns Vela's RendererControl FACADE, not the renderer that owns
 * `scene`/`coords` — the native instance lives one hop deeper
 * (`rendererControl.renderer`, or `orchestrator.renderer` on some builds).
 * Instead of guessing the exact wrapper shape, pick the first candidate that
 * actually has `scene` + `coords` + `setManualScale`.
 */
function rendererOf(chart: unknown): RendererBridge | null {
  const anyChart = chart as {
    renderer?: unknown
    rendererControl?: { renderer?: unknown }
    orchestrator?: { renderer?: unknown }
  } | null
  if (!anyChart) return null
  const candidates = [
    anyChart.rendererControl?.renderer,
    anyChart.renderer,
    anyChart.orchestrator?.renderer
  ]
  for (const c of candidates) if (hasScene(c)) return c
  return null
}

/** The panes/scales the user has manually framed (drag on the price axis). */
function collectManualScales(chart: unknown): Map<ScaleHolderBridge, PriceRange> {
  const renderer = rendererOf(chart)
  const saved = new Map<ScaleHolderBridge, PriceRange>()
  if (!renderer) return saved
  for (const holder of renderer.scene.panes.values()) {
    if (holder.manualScale) saved.set(holder, { min: holder.scale.min, max: holder.scale.max })
  }
  for (const holder of renderer.scene.indicatorScales?.values() ?? []) {
    if (holder.manualScale) saved.set(holder, { min: holder.scale.min, max: holder.scale.max })
  }
  return saved
}

/** Re-freeze the freed scales after the reload — unless the user re-framed meanwhile. */
function restoreManualScales(
  chart: unknown,
  saved: ReadonlyMap<ScaleHolderBridge, PriceRange>
): void {
  const renderer = rendererOf(chart)
  if (!renderer || saved.size === 0) return
  for (const [holder, range] of saved) {
    if (holder.manualScale === null) renderer.setManualScale(holder, range)
  }
}

/**
 * React wrapper around `@luxalgo/vela/workspace` (single-chart mode).
 *
 * The workspace is created lazily per session and addresses the chart with the
 * `wanderlust` provider. Since Phase 4 the chart is REPLAY-driven: it only ever
 * shows the candles revealed up to the store's `currentIndex`. The view keeps
 * the user's zoom/pan: pinned to the newest revealed bar it slides along at the
 * same width; panned away it stays put.
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
      // Vela emits `drawing:selected` with an EMPTY selection on chart-UI churn —
      // its floating drawing toolbar being dismissed by an outside press (e.g.
      // clicking our New Order button), a tool being armed/cleared, a marquee
      // sweep. Those must NOT drop the drawing currently backing the New Order
      // menu — only a real pick (non-empty ids), a removal (drawing:removed) or
      // an explicit store clear changes the trading selection.
      if (e.ids.length === 0) return
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
    // PRESERVING the user's viewport across reveals. Reads state live, so it
    // never goes stale no matter what changed.
    //
    // IDEMPOTENCY GUARD: `chart.setMarket({ data })` itself fires
    // `market:changed` ("offline data changed"), and the topbar's timeframe
    // switch re-enters here too — without a guard, push → setMarket →
    // market:changed → push → … loops forever on the renderer main thread and
    // freezes the whole screen. Keying on (timeframe, index, slice length)
    // makes every re-entrant push a no-op, so the loop always converges after
    // one redundant setMarket at most.
    let lastPushKey = ''
    // Time of the newest revealed bar on the LAST push — lets the next push
    // know how far the tape advanced and whether the view is pinned to it.
    let lastPushLastTime: number | null = null
    // The range WE last applied — the stand-in viewport while the chart is
    // mid-reload, because `setMarket`'s full switch clears the bars first and
    // `getVisibleRange()` returns null for a barCount of 0. Sliding the last
    // known range (instead of the renderer's live view) keeps the zoom steady
    // even when pushes overlap the load — under fast playback they do.
    let lastRange: VisibleRange | null = null
    // Manual price frames (the user's "free view" from dragging the price
    // axis). Vela's reload path resets every pane's manual scale to autoscale,
    // so they're captured before each push and re-frozen once the new data has
    // painted (market:changed).
    let pendingPriceScales: Map<ScaleHolderBridge, PriceRange> = new Map()
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
      // `setMarket({ data })` treats ANY new data array as a full market switch
      // and nulls the viewport — so passing a hard-coded frame here would reset
      // the chart on every play/step (the 24h→120-bar jump when playback
      // starts, and the user's zoom/pan being discarded each tick). Re-assert
      // the least surprising range for the new data ourselves:
      //   - index 0 (initial reveal): frame ALL of the run-up context, plus a
      //     right margin, so the full 24h of pre-session candles are visible on
      //     load without the newest glued to the screen edge.
      //   - otherwise: keep the CURRENT view. Pinned to the newest revealed
      //     bar → slide it along by the reveal delta at the SAME zoom, keeping
      //     the right offset (the tape plays in place, margin intact).
      //     Panned/zoomed away → leave the range exactly as the user set it —
      //     nothing behind moves, fresh bars belong off-view.
      // If the viewport is unreadable (mid-switch clear), reuse the last
      // applied range slid forward — never a hard 120-bar frame, which is what
      // snapped the playback zoomed-in on the newest candle.
      let visibleRange: VisibleRange | undefined
      if (last === undefined) {
        visibleRange = undefined
      } else if (st.currentIndex === 0 || lastPushLastTime === null) {
        visibleRange = { from: first, to: last + barMs * FOLLOW_RIGHT_OFFSET }
      } else {
        const prevLast = lastPushLastTime
        const cur = chart.getVisibleRange()
        // Read the ACTUAL view, not the public data-clamped range. The
        // renderer's visible logical range includes the right-side whitespace
        // the public getVisibleRange() clamps away, so a pinned view keeps its
        // right offset (the margin, or how far the user scrolled) instead of
        // being flushed against the screen edge on every reveal.
        const coords = rendererOf(chart)?.coords
        let view: VisibleRange | null = null
        if (coords && coords.barCount > 0 && coords.widthPx > 0) {
          const vr = coords.visibleLogicalRange?.()
          if (vr && Number.isFinite(vr.from) && Number.isFinite(vr.to) && vr.to >= vr.from) {
            view = { from: coords.logicalToTime(vr.from), to: coords.logicalToTime(vr.to) }
          }
        }
        const base = view ?? lastRange ?? cur
        if (base && base.to >= prevLast - barMs) {
          const delta = last - prevLast
          visibleRange = { from: base.from + delta, to: base.to + delta }
        } else {
          visibleRange = base ?? undefined
        }
      }
      lastPushLastTime = last ?? lastPushLastTime
      if (visibleRange) lastRange = { from: visibleRange.from, to: visibleRange.to }
      // Capture the user's manual price frames BEFORE the reload nulls them
      // (reframeKeepZoom inside setBars). While a reload is in flight the scale
      // may read as freed already — keep the last known capture then, and only
      // trust an empty capture when the chart is idle (an explicit user reset).
      const captured = collectManualScales(chart)
      const switching = (chart as unknown as { switchingMarket?: boolean }).switchingMarket === true
      pendingPriceScales = captured.size > 0 || !switching ? captured : pendingPriceScales
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
    // Also the moment the new data has painted — restore the manual price
    // frames the reload wiped.
    const unsubMarket = chart.on('market:changed', () => {
      restoreManualScales(chart, pendingPriceScales)
      pushSlice()
    })
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
