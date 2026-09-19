/**
 * Minimal structural view of the NATIVE Vela renderer bits Wanderlust bridges.
 *
 * This module is the single place that knows Vela's internal shapes. Reading
 * the renderer's coords/panes directly lets:
 *  - the playback push (VelaChart) preserve the user's manual price scale, and
 *  - the OrderLevelsOverlay place its TP/SL strips ON the candle price axis,
 * without touching any Vela internals.
 *
 * Safety rules (the black-screen guard):
 *  - Every access through these bridges must be null-guarded + try/caught by
 *    the caller; a failing bridge must NEVER throw out of a React render/effect.
 *  - Bridges must be RE-RESOLVED fresh from `velaChartRef.current` each use —
 *    never stored across reloads, because Vela's reload path wipes the renderer
 *    between frames.
 */

export interface PriceRange {
  min: number
  max: number
}

/** A pane's painted rectangle on screen, in px from the chart container origin. */
export interface PaneBounds {
  top: number
  height: number
}

export interface CoordsBridge {
  barCount: number
  widthPx: number
  visibleLogicalRange(): { from: number; to: number } | null
  logicalToTime(logical: number): number
  /** Price → CSS px from the chart container origin (includes pane bounds.top). */
  priceToY(price: number, scale: PriceRange, bounds: PaneBounds): number
  /** CSS px from the chart container origin → price. */
  yToPrice(y: number, scale: PriceRange, bounds: PaneBounds): number
}

export interface ScaleHolderBridge {
  manualScale: PriceRange | null
  scale: PriceRange
  bounds: PaneBounds
}

export interface RendererBridge {
  coords: CoordsBridge
  scene: {
    panes: Map<string, ScaleHolderBridge>
    indicatorScales?: Map<string, ScaleHolderBridge>
  }
  setManualScale(holder: ScaleHolderBridge, scale: PriceRange): void
  /** The canvas Vela's input controller listens on (data area + axes). */
  dataCanvas?: {
    addEventListener(type: string, fn: (e: Event) => void): unknown
    removeEventListener(type: string, fn: (e: Event) => void): unknown
    /** Native plot canvas position in viewport CSS pixels. */
    getBoundingClientRect(): DOMRect
  } | null
  /** Optional native hook: fires at the END of every painted frame (post-paint). */
  onViewportChange?(cb: () => void): (() => void) | null | undefined
}

/**
 * Subscribe to the renderer's POST-PAINT viewport callback. Vela fires it at
 * the end of every animated frame (`animTick`: scale eased → `paintData` →
 * emit) as well as on immediate viewport applies, so the overlay's placement
 * runs AFTER the candles are painted each frame and reads scales that are
 * guaranteed current — eliminating the one-frame lag that made level lines
 * drift behind the candles while zooming.
 *
 * Returns an unsubscribe function, or null when the hook is unavailable. The
 * bridge never throws; callers keep their rAF loop as a fallback in that case.
 */
export function onRendererViewport(
  renderer: RendererBridge,
  cb: () => void,
  onError?: (reason: string) => void
): (() => void) | null {
  try {
    const onVp = renderer.onViewportChange
    if (typeof onVp !== 'function') {
      onError?.('no-method')
      return null
    }
    // MUST call as a method of `renderer`: the native method reads `this.viewportCbs`,
    // and a bare `onVp(cb)` would run with `this === undefined`.
    const un = onVp.call(renderer, cb)
    if (typeof un === 'function') return un
    onError?.(`un-${typeof un}`)
    return null
  } catch (err) {
    onError?.(`throw:${String(err)}`)
    return null
  }
}

/**
 * Gesture types that can make the native renderer repaint with a NEW price
 * scale (drag-pan, time-axis zoom drag, price-axis scale drag, wheel zoom/pan):
 * Vela binds ALL of them to the DATA canvas (`input.attach(dataCanvas)`).
 */
const GESTURE_TYPES = ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'wheel'] as const

/**
 * Hook the same canvas Vela's input controller uses, so the overlay can re-place
 * its strips AFTER a gesture-driven repaint IN THE SAME FRAME.
 *
 * Why this is needed: the scheduler repaints on its own lazily-registered rAF
 * (invalidate → `flush()` → `renderFrame` → `computeScales` + `paintData`).
 * The overlay's continuous rAF loop fires in registration order, which is
 * normally BEFORE that flush rAF — so it reads the PRE-paint scale while the
 * canvas just painted with a fresh one, and `onViewportChange` from
 * `applyViewport` also fires BEFORE the repaint. During continuous drags
 * (pan / time-axis zoom / price-axis scale) that one-frame lag makes the
 * strips visibly drift behind the candles and the canvas-painted drawing tool.
 *
 * Because these listeners are added AFTER Vela's own handlers on the same
 * element, `requestAnimationFrame(cb)` registered from them runs AFTER the
 * scheduler's flush in the same frame's rAF phase — a post-paint placement with
 * a guaranteed-current scale. Idempotent re-place: safe to fire multiple times.
 *
 * Returns an unsubscribe function, or null when the canvas is unavailable. The
 * bridge never throws.
 */
export function onRendererCanvasGesture(
  renderer: RendererBridge,
  cb: () => void,
  onError?: (reason: string) => void
): (() => void) | null {
  const canvas = renderer.dataCanvas
  if (!canvas || typeof canvas.addEventListener !== 'function') {
    onError?.('no-canvas')
    return null
  }
  let pending = false
  let raf = 0
  const schedule = (): void => {
    if (pending) return
    pending = true
    raf = requestAnimationFrame(() => {
      pending = false
      try {
        cb()
      } catch {
        // keep the last positions — never throw
      }
    })
  }
  try {
    for (const type of GESTURE_TYPES) canvas.addEventListener(type, schedule)
  } catch (err) {
    onError?.(`throw:${String(err)}`)
    return null
  }
  return () => {
    cancelAnimationFrame(raf)
    for (const type of GESTURE_TYPES) {
      try {
        canvas.removeEventListener(type, schedule)
      } catch {
        // nothing to remove — ignore
      }
    }
  }
}

/** The three live anchor prices of a Long/Short Position drawing. */
export interface PositionAnchors {
  entry: number
  stop: number
  target: number
}

/** Minimal view of the chart's drawings collection used by the bridges below. */
interface DrawingsBridge {
  all(): Array<{ id: string; anchors?: Array<{ time: number; price: number }> }>
  update(id: string, patch: { anchors: Array<{ time: number; price: number }> }): unknown
}

function drawingsOf(chart: unknown): DrawingsBridge | null {
  try {
    if (typeof chart !== 'object' || chart === null) return null
    const drawings = (chart as { drawings?: unknown }).drawings
    if (!drawings || typeof (drawings as { all?: unknown }).all !== 'function') return null
    return drawings as DrawingsBridge
  } catch {
    return null
  }
}

/**
 * The LIVE anchor prices of a 'position' drawing (`chart.drawings`), or null
 * when the drawing is gone / not a position tool / the chart is unreachable.
 *
 * This is the single source of truth the OrderLevelsOverlay renders against:
 * an order created FROM a drawing keeps its strips glued to the tool's
 * anchors — moving the tool moves the lines, and a re-run of playback cannot
 * leave the visual lines behind the drawing. Bridge never throws.
 */
export function positionAnchorsOf(
  chart: unknown,
  drawingId: string | null | undefined
): PositionAnchors | null {
  const drawings = drawingsOf(chart)
  if (!drawings || !drawingId) return null
  try {
    const d = drawings.all().find((x) => x.id === drawingId)
    const anchors = d?.anchors
    if (!d || !anchors || anchors.length < 3) return null
    const [a, b, c] = anchors
    if (
      !a ||
      !b ||
      !c ||
      !Number.isFinite(a.price) ||
      !Number.isFinite(b.price) ||
      !Number.isFinite(c.price) ||
      a.price <= 0 ||
      b.price <= 0 ||
      c.price <= 0
    )
      return null
    return { entry: a.price, stop: b.price, target: c.price }
  } catch {
    return null
  }
}

/**
 * Reprice ONE anchor of a linked position drawing (the strip-drag direction:
 * dragging a SL/TP strip on the overlay also moves the tool's line on the
 * canvas, so the chart, the order and the visual line all agree). index is the
 * position-tool layout: 0 = entry, 1 = stop, 2 = target. Uses Vela's own
 * `drawings.update`, so a real `drawing:edited` event fires. Returns whether an
 * update was attempted. Bridge never throws.
 */
export function setPositionAnchorPrice(
  chart: unknown,
  drawingId: string | null | undefined,
  index: 0 | 1 | 2,
  price: number
): boolean {
  const drawings = drawingsOf(chart)
  if (!drawings || !drawingId || !Number.isFinite(price) || price <= 0) return false
  try {
    const d = drawings.all().find((x) => x.id === drawingId)
    const anchors = d?.anchors
    if (!d || !anchors || anchors.length < 3) return false
    const next = anchors.map((anchor, i) => (i === index ? { time: anchor.time, price } : anchor))
    drawings.update(drawingId, { anchors: next })
    return true
  } catch {
    return false
  }
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
export function rendererOf(chart: unknown): RendererBridge | null {
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

/**
 * Live handle to the CURRENT native chart shell (workspace.chart). Set by
 * VelaChart's workspace effect and cleared on unmount, so sibling overlays
 * re-resolve `rendererOf()` fresh per frame and never hold a stale renderer
 * across reloads.
 */
export const velaChartRef: { current: unknown } = { current: null }

/** Id of the main chart price pane inside `scene.panes` (Vela's PRICE_PANE_ID). */
export const PRICE_PANE_ID = 'price'
