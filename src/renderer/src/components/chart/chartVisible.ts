/**
 * Chart-view visibility signal.
 *
 * App keeps the chart pane MOUNTED while the Analytics tab is showing (so the
 * Vela workspace, drawings, indicators and user settings survive tab switches),
 * hiding it with CSS `visibility: hidden`. Vela's renderer keeps painting and
 * the OrderLevelsOverlay keeps placing strips at 60 fps even when the pane is
 * `invisible` — so playback while reading Analytics burns full CPU/GPU for
 * pixels nobody sees.
 *
 * This module is the single source of truth for "is the chart pane actually on
 * screen right now". The chart-side hot paths (slice pushes, overlay
 * placement) consult it and skip ALL native work while hidden; the store
 * (playback index, orders, balance) keeps advancing untouched. A single-slot
 * listener lets the mounted chart flush the LATEST reveal the moment the pane
 * becomes visible again, so returning from Analytics never shows a stale tape.
 */

let chartViewVisible = true
let flushListener: (() => void) | null = null

/** App calls this whenever the visible tab changes. */
export function setChartViewVisible(visible: boolean): void {
  const becameVisible = visible && !chartViewVisible
  chartViewVisible = visible
  // Only fire when the pane TRANSITIONED hidden → visible; repeated
  // visible→visible calls (session changes) must not spuriously re-push.
  if (becameVisible) flushListener?.()
}

/** True while the chart pane is the visible tab. */
export function isChartViewVisible(): boolean {
  return chartViewVisible
}

/**
 * Register a callback fired when the chart pane BECOMES visible again after
 * being hidden — the mounted chart uses this to flush its latest reveal (the
 * index moved while hidden, so its keyed push would otherwise never run).
 * Single-slot: exactly one chart is mounted at a time, so only its callback is
 * retained. Returns an unsubscribe.
 */
export function onChartViewVisible(fn: () => void): () => void {
  flushListener = fn
  return () => {
    if (flushListener === fn) flushListener = null
  }
}
