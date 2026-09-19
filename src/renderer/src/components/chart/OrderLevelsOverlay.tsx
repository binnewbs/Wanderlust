import { useEffect, useMemo, useReducer, useRef } from 'react'
import { useSessionStore } from '@/store/session'
import {
  PRICE_PANE_ID,
  onRendererCanvasGesture,
  onRendererViewport,
  positionAnchorsOf,
  rendererOf,
  setPositionAnchorPrice,
  velaChartRef,
  type CoordsBridge,
  type PaneBounds,
  type PositionAnchors,
  type PriceRange,
  type RendererBridge
} from './chartBridge'

/**
 * OrderLevelsOverlay — the SAFE draggable TP/SL "order-level" lines.
 *
 * Renders purely in React as an absolutely-positioned sibling ABOVE the Vela
 * canvas (no Vela changes). It draws one horizontal strip per level on
 * PENDING + RUNNING (filled, not closed) orders:
 *   - entry   — gray, display-only
 *   - stop    — red, draggable   → reprices the order's stopLoss live
 *   - target  — green, draggable → reprices the order's takeProfit live
 *
 * PRICE SOURCE: an order created FROM a Long/Short Position drawing carries
 * `drawingId`, and its strips are priced from the drawing's LIVE anchors
 * [entry, stop, target] — the "actual tp/sl/entry price from the chart".
 * Moving the tool moves the lines (drawing:edited re-resolves them), dragging
 * a strip reprices BOTH the order and the tool's anchor, and a market fill
 * never yanks the entry line off the tool (it stays on the drawn entry).
 * Manual orders (no drawing) fall back to the stored fields
 * (entry = fillPrice ?? orderPrice).
 *
 * Placement is driven by THREE synchronized sources, so the strips are glued to
 * the price axis through EVERY repaint path (not just eased ones):
 *   1. Vela's post-paint viewport callback — fires at the END of every animated
 *      frame (wheel-zoom glide, fling, autoscale glide), after `paintData()`.
 *   2. A same-frame post-paint hook on the DATA canvas (the element Vela's
 *      input controller binds to): gesture listeners registered AFTER Vela's
 *      own handlers schedule placement on the next rAF, which the browser runs
 *      AFTER the scheduler's repaint rAF — so drag-pan, time-axis zoom drag and
 *      price-axis scale drags never leave the strips one frame behind the
 *      canvas-painted candles/drawing tool.
 *   3. A continuous rAF fallback for everything else (playback pushes, resize).
 * Every placement re-resolves the native renderer from `velaChartRef` and maps
 * each price through `coords.priceToY(price, pane.scale, pane.bounds)` — the
 * exact math Vela's candle painter AND the Long/Short Position tool use — so
 * the strips coincide with the drawing tool's lines at the same price. Drag
 * goes the other way: `yToPrice` → a pure, guarded store action
 * (`updateOrderLevel`), picked up by the next evaluate.
 *
 * Black-screen safety: every native access is null-guarded and try/caught; on
 * ANY failure the loop keeps the last known positions (never throws, never
 * unmounts React). The renderer is never cached — it is re-resolved fresh each
 * frame, so a mid-reload reseed can't leave a stale reference behind.
 */

type LevelKind = 'entry' | 'stopLoss' | 'takeProfit'

/** Drawing lifecycle events that can move a position tool's anchors. */
const DRAWING_EVENTS = [
  'drawing:created',
  'drawing:edited',
  'drawing:removed',
  'drawing:selected'
] as const

interface StripSpec {
  key: string
  orderId: string
  drawingId?: string | null
  level: LevelKind
  price: number
}

/** Half the strip hit-area height (px). The visible line sits in the middle. */
const STRIP_HALF = 6

/** Small tail-safe price formatter (forex 5dp, indices 2dp, trimmed zeros). */
function formatPrice(p: number): string {
  const s = p.toFixed(5)
  return s.replace(/0+$/, '').replace(/\.$/, '')
}

const STRIP_STYLES: Record<LevelKind, { line: string; label: string }> = {
  entry: { line: 'bg-zinc-400/50', label: 'bg-zinc-700/90 text-zinc-100' },
  stopLoss: { line: 'bg-red-500', label: 'bg-red-600/95 text-white' },
  takeProfit: { line: 'bg-emerald-500', label: 'bg-emerald-600/95 text-white' }
}

export default function OrderLevelsOverlay(): React.JSX.Element {
  const orders = useSessionStore((s) => s.orders)
  const session = useSessionStore((s) => s.session)
  // Bumped on Vela drawing create/edit/remove/select events (and chart swaps)
  // so the strip list re-resolves LIVE tool anchors — moving the Long/Short
  // Position tool moves the lines, exactly as the user asked ("the visual lines
  // must follow the actual tp/sl/entry price from the chart").
  const [drawTick, rerender] = useReducer((c: number) => c + 1, 0)

  const rootRef = useRef<HTMLDivElement>(null)
  const stripEls = useRef(new Map<string, HTMLDivElement>())
  const stripsRef = useRef<StripSpec[]>([])
  const frameRef = useRef<{ coords: CoordsBridge; scale: PriceRange; bounds: PaneBounds } | null>(
    null
  )
  const dragRef = useRef<{ orderId: string; level: 'stopLoss' | 'takeProfit' } | null>(null)

  // Build the strip list from the CURRENT orders and mirror it into a ref the
  // rAF loop can read without re-subscribing to every pointer move. Memoizing
  // keeps the array identity stable between order/session changes.
  //
  // PRICE SOURCE — an order created FROM a drawing carries `drawingId`, and its
  // strips show the drawing's LIVE anchors [entry, stop, target] (re-resolved
  // on every drawing event). That is the "actual price from the chart": after a
  // market fill the entry line stays ON the tool's entry (it doesn't jump to
  // the fill's open), and editing the tool moves the lines. Manual orders (no
  // drawing) fall back to the stored order fields — entry = fillPrice ?? orderPrice.
  const strips = useMemo((): StripSpec[] => {
    void drawTick // drawing events re-run this memo to re-resolve live anchors
    const out: StripSpec[] = []
    if (!session) return out
    const pushLevel = (o, level: LevelKind, price: number, drawingId?: string | null): void => {
      if (!Number.isFinite(price) || price <= 0) return
      out.push({ key: `${o.id}:${level}`, orderId: o.id, drawingId, level, price })
    }
    for (const o of orders) {
      if (o.symbol !== session.asset.id) continue
      if (o.status !== 'pending' && o.status !== 'filled') continue
      const anchors: PositionAnchors | null = o.drawingId
        ? positionAnchorsOf(velaChartRef.current, o.drawingId)
        : null
      if (anchors) {
        pushLevel(o, 'entry', anchors.entry, o.drawingId)
        pushLevel(o, 'stopLoss', anchors.stop, o.drawingId)
        pushLevel(o, 'takeProfit', anchors.target, o.drawingId)
      } else {
        pushLevel(o, 'entry', o.fillPrice ?? o.orderPrice, o.drawingId)
        pushLevel(o, 'stopLoss', o.stopLoss, o.drawingId)
        pushLevel(o, 'takeProfit', o.takeProfit, o.drawingId)
      }
    }
    return out
  }, [orders, session, drawTick])
  useEffect(() => {
    stripsRef.current = strips
  }, [strips])

  // Placement — re-resolves the native renderer on EVERY call (never cached),
  // keeps the last positions on any failure, and keeps Vela's post-paint
  // viewport hook + the same-frame canvas-gesture hook attached to the CURRENT
  // renderer. Vela fires the viewport hook at the END of every animated frame
  // (post-`paintData`), and the canvas hook schedules placement after a
  // gesture-driven repaint IN THE SAME FRAME (its rAF runs after the
  // scheduler's flush, because these listeners are registered after Vela's own
  // on the same element) — so strips re-glue the moment the candles are painted
  // on every path, instead of lagging one frame behind them during
  // drag-pan/time-axis-zoom/price-axis-scale (which a bare rAF loop does: the
  // overlay's rAF runs BEFORE Vela's scheduler flush in the same frame). The
  // rAF loop stays as a continuous fallback: whichever source writes last in a
  // frame, the per-frame result is always the post-paint scale, so strips are
  // frame-exact.
  useEffect(() => {
    let alive = true
    let raf = 0
    let unsubViewport: (() => void) | null = null
    let unsubCanvas: (() => void) | null = null
    let unsubDrawings: (() => void) | null = null
    let attachedRenderer: RendererBridge | null = null
    let attachedChart: unknown = null
    let attachedCanvas: { addEventListener(type: string, fn: (e: Event) => void): unknown } | null =
      null
    const placeRef: { current: (() => void) | null } = { current: null }
    // Hash-gated debug counters (E2E only; inert for normal users).
    interface LevelDbg extends Record<string, unknown> {
      place: number
      vp: number
      canvasEv: number
      wroteEntry: number
      wroteSL: number
      wroteTP: number
      missEntry: number
      missSL: number
      missTP: number
      eNoRenderer: number
      eNoPane: number
      eNoBounds: number
      eBadScale: number
      eNoCoords: number
      eOk: number
      nonFiniteY: number
      ySnap?: unknown
    }
    let dbg: LevelDbg | null = null
    try {
      if (typeof window !== 'undefined' && `${window.location.hash}`.includes('e2e')) {
        const w = window as unknown as { __wanderlustLevels?: LevelDbg }
        w.__wanderlustLevels ??= {
          place: 0,
          vp: 0,
          canvasEv: 0,
          wroteEntry: 0,
          wroteSL: 0,
          wroteTP: 0,
          missEntry: 0,
          missSL: 0,
          missTP: 0,
          eNoRenderer: 0,
          eNoPane: 0,
          eNoBounds: 0,
          eBadScale: 0,
          eNoCoords: 0,
          eOk: 0,
          nonFiniteY: 0
        }
        dbg = w.__wanderlustLevels
      }
    } catch {
      dbg = null
    }

    const place = (): void => {
      if (!alive) return
      if (dbg) dbg.place += 1
      try {
        const renderer = rendererOf(velaChartRef.current)
        if (!renderer) {
          if (dbg) dbg.eNoRenderer += 1
          return // mid-reload / not mounted: keep last positions
        }
        if (dbg) {
          dbg.rendererObj = renderer
          dbg.attachKind =
            typeof unsubViewport === 'function' ? 'ok' : unsubViewport === null ? 'null' : 'none'
        }
        // Re-attach the post-paint hooks whenever the renderer is replaced
        // (Vela's reload path swaps the native renderer between frames) or the
        // data canvas is recreated (rare WebGL2→canvas2d fallback).
        if (attachedRenderer !== renderer) {
          unsubViewport?.()
          unsubCanvas?.()
          unsubViewport = null
          unsubCanvas = null
          attachedRenderer = renderer
          unsubViewport = onRendererViewport(
            renderer,
            () => {
              if (dbg) dbg.vp += 1
              placeRef.current?.()
            },
            (reason) => {
              if (dbg) dbg.attachError = reason
            }
          )
          if (dbg)
            dbg.attachKind =
              typeof unsubViewport === 'function' ? 'ok' : unsubViewport === null ? 'null' : 'none'
        }
        const canvas = renderer.dataCanvas ?? null
        if (attachedCanvas !== canvas) {
          unsubCanvas?.()
          unsubCanvas = null
          attachedCanvas = canvas
          if (canvas) {
            unsubCanvas = onRendererCanvasGesture(
              renderer,
              () => {
                if (dbg) dbg.canvasEv += 1
                placeRef.current?.()
              },
              (reason) => {
                if (dbg) dbg.canvasAttachError = reason
              }
            )
          }
          if (dbg)
            dbg.canvasAttach =
              typeof unsubCanvas === 'function' ? 'ok' : unsubCanvas === null ? 'none' : 'missing'
        }
        // THE LIVE-ANCHOR SOURCE: re-subscribe to the chart's drawing events
        // whenever the chart identity changes (VelaChart keys per session), so
        // moving/creating/removing the Long/Short Position tool re-resolves the
        // strip prices from the tool's CURRENT anchors the next render.
        const chart = velaChartRef.current
        if (attachedChart !== chart) {
          unsubDrawings?.()
          unsubDrawings = null
          attachedChart = chart
          const chartApi = chart as {
            on?(event: string, fn: () => void): (() => void) | void
          } | null
          if (chartApi && typeof chartApi.on === 'function') {
            const unsubs: Array<() => void> = []
            for (const ev of DRAWING_EVENTS) {
              try {
                const un = chartApi.on(ev, () => {
                  // Tool anchors changed → strips must follow. The dispatch is
                  // stable across the component's life, safe inside rAF.
                  rerender()
                })
                if (typeof un === 'function') unsubs.push(un)
              } catch {
                // keep the rest of the subscriptions — never throw
              }
            }
            if (unsubs.length > 0) {
              unsubDrawings = () => {
                for (const un of unsubs) {
                  try {
                    un()
                  } catch {
                    // already torn down — ignore
                  }
                }
              }
            }
          }
          if (dbg)
            dbg.drawAttach = unsubDrawings
              ? typeof unsubDrawings === 'function'
                ? 'ok'
                : 'none'
              : 'none'
        }
        const pane = renderer.scene?.panes?.get(PRICE_PANE_ID)
        if (!pane) {
          if (dbg) dbg.eNoPane += 1
          return
        }
        const { scale, bounds } = pane
        if (!bounds || !bounds.height || bounds.height <= 0) {
          if (dbg) dbg.eNoBounds += 1
          return
        }
        if (
          !scale ||
          !Number.isFinite(scale.min) ||
          !Number.isFinite(scale.max) ||
          scale.min === scale.max
        ) {
          if (dbg) dbg.eBadScale += 1
          return
        }
        const coords = renderer.coords
        if (!coords || typeof coords.priceToY !== 'function') {
          if (dbg) dbg.eNoCoords += 1
          return
        }
        frameRef.current = { coords, scale, bounds }
        if (dbg) {
          dbg.eOk += 1
          dbg.paneScaleMin = scale.min
          dbg.paneScaleMax = scale.max
          // True (unrounded) prices the strips are placed at — lets the E2E
          // compare against the exact stored price instead of the 5dp label.
          // ALL specs (one per strip, incl. duplicates across orders), with the
          // order + drawing ids, so multi-order sessions are unambiguous.
          dbg.specs = stripsRef.current.map((spec) => ({
            level: spec.level,
            price: spec.price,
            orderId: spec.orderId,
            drawingId: spec.drawingId ?? null
          }))
        }
        for (const spec of stripsRef.current) {
          const el = stripEls.current.get(spec.key)
          if (!el) {
            if (dbg && spec.level === 'entry') dbg.missEntry += 1
            if (dbg && spec.level === 'stopLoss') dbg.missSL += 1
            if (dbg && spec.level === 'takeProfit') dbg.missTP += 1
            continue
          }
          const y = coords.priceToY(spec.price, scale, bounds)
          if (!Number.isFinite(y)) {
            if (dbg && spec.level === 'stopLoss') {
              dbg.nonFiniteY += 1
              dbg.ySnap = {
                y,
                bTop: bounds.top,
                bH: bounds.height,
                log: (scale as { log?: unknown }).log ?? null,
                min: scale.min,
                max: scale.max,
                price: spec.price
              }
            }
            continue
          }
          el.style.transform = `translateY(${y - STRIP_HALF}px)`
          el.style.opacity = '1'
          if (dbg && spec.level === 'entry') dbg.wroteEntry += 1
          if (dbg && spec.level === 'stopLoss') dbg.wroteSL += 1
          if (dbg && spec.level === 'takeProfit') dbg.wroteTP += 1
        }
      } catch {
        // Any native hiccup: keep last known positions, never throw.
      }
    }
    placeRef.current = place

    const loop = (): void => {
      if (!alive) return
      raf = requestAnimationFrame(loop)
      place()
    }
    raf = requestAnimationFrame(loop)
    return () => {
      alive = false
      cancelAnimationFrame(raf)
      unsubViewport?.()
      unsubCanvas?.()
      unsubDrawings?.()
    }
  }, [])

  const setStripRef =
    (key: string) =>
    (el: HTMLDivElement | null): void => {
      if (el) stripEls.current.set(key, el)
      else stripEls.current.delete(key)
    }

  const onDragDown = (e: React.PointerEvent<HTMLDivElement>, spec: StripSpec): void => {
    if (spec.level === 'entry') return
    e.preventDefault()
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      // Synthetic/dispatched events carry no live pointer — capture is a
      // best-effort nicety, never required for the drag math.
    }
    dragRef.current = { orderId: spec.orderId, level: spec.level }
  }

  const onDragMove = (e: React.PointerEvent<HTMLDivElement>, spec: StripSpec): void => {
    const drag = dragRef.current
    if (!drag || drag.orderId !== spec.orderId || drag.level !== spec.level) return
    const ctx = frameRef.current
    const root = rootRef.current
    if (!ctx || !root) return
    try {
      const rect = root.getBoundingClientRect()
      const rawY = e.clientY - rect.top
      const y = Math.min(ctx.bounds.top + ctx.bounds.height, Math.max(ctx.bounds.top, rawY))
      const price = ctx.coords.yToPrice(y, ctx.scale, ctx.bounds)
      if (Number.isFinite(price) && price > 0) {
        // Follow the pointer instantly, then let the store round-trip confirm.
        const el = stripEls.current.get(spec.key)
        if (el) el.style.transform = `translateY(${y - STRIP_HALF}px)`
        useSessionStore.getState().updateOrderLevel(spec.orderId, spec.level, price)
        // The strip shows the tool's anchor for linked orders — reprice the
        // drawing's matching anchor too, so the canvas line follows the drag
        // and the tool stays the source of truth (fires drawing:edited, which
        // re-syncs the order idempotently).
        if (spec.drawingId) {
          setPositionAnchorPrice(
            velaChartRef.current,
            spec.drawingId,
            spec.level === 'stopLoss' ? 1 : 2,
            price
          )
        }
      }
    } catch {
      // ignore: keep the level where it was
    }
  }

  const onDragUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!dragRef.current) return
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      // pointer may already be released — ignore
    }
    dragRef.current = null
  }

  return (
    <div ref={rootRef} className="pointer-events-none absolute inset-0 z-10" aria-hidden="true">
      {strips.map((spec) => {
        const draggable = spec.level !== 'entry'
        const s = STRIP_STYLES[spec.level]
        return (
          <div
            key={spec.key}
            ref={setStripRef(spec.key)}
            data-testid={`order-level-${spec.level}`}
            data-order-id={spec.orderId}
            className={`absolute left-0 right-0 opacity-0 ${
              draggable ? 'pointer-events-auto cursor-ns-resize' : ''
            }`}
            style={{ height: STRIP_HALF * 2, touchAction: draggable ? 'none' : undefined }}
            onPointerDown={draggable ? (e) => onDragDown(e, spec) : undefined}
            onPointerMove={draggable ? (e) => onDragMove(e, spec) : undefined}
            onPointerUp={draggable ? onDragUp : undefined}
            onPointerCancel={draggable ? onDragUp : undefined}
          >
            {/* The horizontal level line, centered in the hit area. */}
            <div
              className={`pointer-events-none absolute left-0 right-0 ${s.line}`}
              style={{ top: STRIP_HALF - 0.5, height: 1 }}
            />
            {/* Draggable handle — a slightly wider, subtle pill on the right. */}
            <div
              className={`pointer-events-none absolute rounded-sm ${s.label}`}
              style={{
                top: 2,
                right: 4,
                padding: '0 5px',
                height: 9,
                lineHeight: '9px',
                fontSize: 9
              }}
            >
              {spec.level === 'entry' ? 'E' : spec.level === 'stopLoss' ? 'SL' : 'TP'}
            </div>
            {/* Price label on the left of the strip. */}
            <div
              data-testid={`order-level-${spec.level}-price`}
              className={`pointer-events-none absolute rounded-sm ${s.label}`}
              style={{
                top: 2,
                left: 4,
                padding: '0 5px',
                height: 9,
                lineHeight: '9px',
                fontSize: 9
              }}
            >
              {formatPrice(spec.price)}
            </div>
          </div>
        )
      })}
    </div>
  )
}
