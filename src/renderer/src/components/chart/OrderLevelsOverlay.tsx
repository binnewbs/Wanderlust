import { useEffect, useMemo, useRef } from 'react'
import { useSessionStore } from '@/store/session'
import {
  PRICE_PANE_ID,
  onRendererCanvasGesture,
  onRendererViewport,
  rendererOf,
  velaChartRef,
  type CoordsBridge,
  type PaneBounds,
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

interface StripSpec {
  key: string
  orderId: string
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
  const strips = useMemo((): StripSpec[] => {
    const out: StripSpec[] = []
    if (!session) return out
    for (const o of orders) {
      if (o.symbol !== session.asset.id) continue
      if (o.status !== 'pending' && o.status !== 'filled') continue
      const entry = o.fillPrice ?? o.orderPrice
      if (Number.isFinite(entry) && entry > 0) {
        out.push({ key: `${o.id}:entry`, orderId: o.id, level: 'entry', price: entry })
      }
      if (Number.isFinite(o.stopLoss) && o.stopLoss > 0) {
        out.push({
          key: `${o.id}:stopLoss`,
          orderId: o.id,
          level: 'stopLoss',
          price: o.stopLoss
        })
      }
      if (Number.isFinite(o.takeProfit) && o.takeProfit > 0) {
        out.push({
          key: `${o.id}:takeProfit`,
          orderId: o.id,
          level: 'takeProfit',
          price: o.takeProfit
        })
      }
    }
    return out
  }, [orders, session])
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
    let attachedRenderer: RendererBridge | null = null
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
          const specs: { level: string; price: number }[] = []
          for (const spec of stripsRef.current) {
            const level = spec.level
            if (!specs.some((s) => s.level === level)) {
              specs.push({ level, price: spec.price })
            }
          }
          dbg.specs = specs
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
