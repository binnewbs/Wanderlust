import { create } from 'zustand'
import type { Asset } from '@shared/assets'
import type { Candle, DownloadBatchResult, DownloadProgressEvent } from '@shared/ipc'
import {
  CLOCK_MS,
  CLOCK_TIMEFRAME,
  RUNUP_TARGET_MS,
  indexClosingAtOrBefore,
  nextBoundaryMs,
  prevBoundaryMs,
  runUpTail,
  timeframeMs,
  type Timeframe
} from '@shared/timeframes'
import { isTradingDay } from '@shared/trading'
import {
  canRepriceLevel,
  evaluateOrders,
  hasOpenPosition,
  nextOrderId,
  restoreOrdersAt,
  sizeForRisk,
  validateOrderTypePrice,
  type NewOrderInput,
  type Order,
  type OrderLevel,
  type PositionSelection
} from './trading'

/**
 * The backtest session's state machine.
 *
 * ONE CLOCK, IN M1. A session downloads only the M1 candles for the chosen
 * range in ONE batch IPC call, streams progress into the UI, and stores them as
 * the session's `clockCandles`. Coarser timeframes are never loaded into the
 * renderer: the chart AGGREGATES the revealed minutes into whatever timeframe
 * is on screen (see chart/sessionProvider), so `currentIndex`, the chart's
 * right edge and the order engine all speak ONE time basis and cannot drift
 * apart.
 */

export type SessionStatus = 'idle' | 'downloading' | 'ready' | 'error'

/** What a `updateOrderLevel` drag write did: the level moved ('applied'), the
 *  drag was refused by `canRepriceLevel` ('rejected'), or nothing needed to
 *  happen ('noop' — closed/unknown order, identical price, non-finite input). */
export type LevelRepriceResult = 'applied' | 'rejected' | 'noop'

export interface NewSessionInput {
  name?: string
  asset: Asset
  /** Dukascopy timeframe id ('m1' | 'm5' | 'm15' | 'm30' | 'h1' | 'h4' | 'd1')
   *  — the chart's INITIAL VIEW. It is NOT the clock: the clock is always M1
   *  whatever this says, and this value only decides which timeframe the chart
   *  opens on (and how the session is named). */
  timeframe: Timeframe
  /** ISO date, inclusive start (e.g. '2024-01-02') */
  startDate: string
  /** ISO date, inclusive end (e.g. '2024-01-31') */
  endDate: string
  /** Simulated starting balance in account currency */
  balance: number
}

export interface SavedSession {
  id: string
  name: string
  asset: Asset
  timeframe: Timeframe
  startDate: string
  endDate: string
  startBalance: number
  balance: number
  orders: Order[]
  currentIndex: number
  playbackTimeframe: Timeframe
  /** Which timeframe `currentIndex` and the orders' index stamps count. Always
   *  'm1' now; sessions saved before the single-clock change LACK this field
   *  and are migrated onto the M1 clock by timestamp on resume. */
  clockTimeframe?: Timeframe
  createdAt: number
  updatedAt: number
  /** Pinned sessions are hoisted above the rest in the main menu. */
  pinned?: boolean
}

export interface ActiveSession extends NewSessionInput {
  id: string
  name: string
  /** M1 candles of the session range — the session's ONLY dataset. */
  clockCandles: Candle[]
  /** M1 candles of the day(s) before the session, shown BEFORE any session
   *  minute is revealed so a session never starts on a blank chart. */
  clockRunUp: Candle[]
  /** Where the clock candles came from ('cache' | 'dukascopy' | 'mixed'). */
  source: string
}

export interface SessionState {
  status: SessionStatus
  session: ActiveSession | null
  /** Progress events streamed from the main process during a download */
  progress: DownloadProgressEvent[]
  error: string | null
  /** One-shot message surfaced as a toast when a saved session had to be
   *  migrated onto the M1 clock (cleared by `dismissMigrationNotice`). */
  migrationNotice: string | null
  dismissMigrationNotice: () => void
  // --- playback state (the single M1 clock) ---
  /** How many M1 candles of the session are revealed. The clock's "now" is the
   *  CLOSE of candle `currentIndex - 1`; the chart aggregates those minutes
   *  into whichever timeframe is on screen. */
  currentIndex: number
  /** Timeframe the chart is currently showing; a step/play tick advances the
   *  M1 clock to the next boundary of THIS bar length (one visible bar). */
  playbackTimeframe: Timeframe
  playing: boolean
  /** 1..120 — the speed slider; maps to the playback interval delay */
  speed: number

  // --- playback controls ---
  /** Play/pause; pressing play after the end restarts from minute 0 */
  togglePlay: () => void
  pause: () => void
  /** Advance to the next boundary of the viewed timeframe WITHOUT changing
   *  play state (the loop's per-tick op) */
  advance: () => void
  stepForward: () => void
  stepBackward: () => void
  setPlaybackTimeframe: (timeframe: Timeframe) => void
  skipToStart: () => void
  skipToEnd: () => void
  /** Reveal every minute that closes at or before `timestamp` (Go To) */
  goToTimestamp: (timestamp: number) => void
  /** Transient "pan the chart view to this timestamp" request (Go To → Custom
   *  Date → "Just view the chart"). VelaChart consumes it and clears it back
   *  to null — the playback position, orders and balance are NOT touched, so
   *  no data re-slice happens and Vela keeps every drawing. Seq makes repeated
   *  requests to the same timestamp observable. */
  viewRequest: { ts: number; seq: number } | null
  requestViewAt: (timestamp: number) => void
  clearViewRequest: () => void
  /** Full rewind to `timestamp`: restore the account to its state at that
   *  point, erasing the positions (and PnL) taken since then (Go To → Custom
   *  Date → "Rewind & reset"). Unlike `goToTimestamp` this does NOT refuse to
   *  move while a position is open — the rewind wipes it. */
  rewindToTimestamp: (timestamp: number) => void
  setSpeed: (speed: number) => void

  // --- simulated account + orders (Phase 5) ---
  /** Live account balance — starts at the session's starting balance and moves
   *  by realized pnl. */
  balance: number
  /** The session's seed balance — the base `restoreOrdersAt` rewinds backward
   *  moves to, so PnL from positions taken later in the timeline vanishes. */
  startBalance: number
  /** Default risk per order (% of balance), seeded into the New Order menu. */
  riskPercent: number
  /** Every order submitted this session: pending → filled → closed. */
  orders: Order[]
  /** When true the "positions will be gone" rewind-warning dialog stays quiet
   *  for the rest of this session (set by its "don't show again" checkbox). */
  rewindWarningDismissed: boolean
  /** The position drawing currently picked on the chart (feeds New Order). */
  selectedDrawing: PositionSelection | null
  /** Outcome of the last `submitOrder` call — shown under the New Order button. */
  lastOrderResult: { ok: boolean; message: string } | null
  /** Submit a New Order; it fills/evals from the CURRENT playback candle on. */
  submitOrder: (input: NewOrderInput) => void
  /** Live-drag a pending/filled order's SL or TP level (OrderLevelsOverlay).
   *  Closed orders are read-only; the write is a pure guarded map. Returns
   *  what happened so the chart can toast the drag it refused. */
  updateOrderLevel: (orderId: string, level: OrderLevel, price: number) => LevelRepriceResult
  /** Cancel a pending order, or close a filled position at the latest market close. */
  closeOrder: (orderId: string) => void
  /** Close EVERY open position at the latest market close in one shot — the
   *  "Close Now" path of the go-back dialog. */
  flattenPositions: () => void
  /** Suppress the rewind-warning dialog for the rest of this session. */
  dismissRewindWarning: () => void
  setRiskPercent: (pct: number) => void
  /** The chart pushes the currently selected position drawing here (or null). */
  setSelectedDrawing: (selection: PositionSelection | null) => void

  startSession: (input: NewSessionInput) => Promise<void>
  dismissError: () => void

  // --- saved sessions management ---
  savedSessions: SavedSession[]
  exitToMainMenu: () => void
  resumeSavedSession: (id: string) => Promise<void>
  deleteSavedSession: (id: string) => void
  saveCurrentSessionState: () => void
  /** Pin/unpin a session. Pinning hoists it to the top of the list; unpinning
   *  drops it to the top of the unpinned group. */
  toggleSavedSessionPin: (id: string) => void
  /** Replace the manual order of saved sessions (drag-to-rearrange). Ids that
   *  are missing are appended, pinned sessions are re-hoisted. */
  setSavedSessionsOrder: (ids: string[]) => void

  // --- chart-state persistence (Phase 7) ---
  /** Stash a Vela workspace snapshot (drawings + adjusted chart settings) for
   *  a session. Saved continuously as the user edits, and persisted so a
   *  reopened session resumes the chart where it left off. */
  saveChartState: (id: string, state: unknown) => void
  /** The workspace snapshot stashed for `id`, or undefined. */
  chartStateFor: (id: string) => unknown | undefined
  /** Remember which position drawing was selected when the user left the
   *  session, so a resume re-asserts the New Order affordance. */
  saveChartSelection: (id: string, drawingId: string) => void
  /** The selection saved for `id`, or undefined. */
  chartSelectionFor: (id: string) => string | undefined
}

/** The session's M1 candles — the clock, and the playback panel's counter. */
export function sessionClockCandles(session: ActiveSession | null): Candle[] {
  if (!session) return []
  return session.clockCandles
}

/** M1 candles of the run-up day(s) — context shown before the first reveal. */
export function sessionClockRunUp(session: ActiveSession | null): Candle[] {
  if (!session) return []
  return session.clockRunUp
}

/**
 * "Now" on the clock: the CLOSE of the last revealed M1 candle (at index 0,
 * the run-up's last minute's close). This is the single notion of time the
 * whole app runs on — the chart's right edge, the step targets, the playback
 * readout and the order engine all resolve to it.
 */
export function clockNowMs(
  session: ActiveSession | null,
  currentIndex: number
): number | undefined {
  const clock = sessionClockCandles(session)
  if (currentIndex > 0) {
    const last = clock[currentIndex - 1]
    if (last) return last.timestamp + CLOCK_MS
  }
  const runUp = sessionClockRunUp(session)
  const lastRunUp = runUp[runUp.length - 1]
  return lastRunUp ? lastRunUp.timestamp + CLOCK_MS : undefined
}

/** Latest revealed market close — the last revealed minute's close, or the
 *  run-up's last close at index 0. What orders fill/exit against right now. */
export function latestRevealedClose(
  session: ActiveSession | null,
  currentIndex: number
): number | undefined {
  const clock = sessionClockCandles(session)
  if (currentIndex > 0) return clock[currentIndex - 1]?.close
  const runUp = sessionClockRunUp(session)
  return runUp.length > 0 ? runUp[runUp.length - 1]?.close : undefined
}

/** How many calendar days back the run-up may reach when assembling a full
 *  24h of context (whole days back from the session start). */
export const SESSION_RUNUP_LOOKBACK_DAYS = 7
/** Total budget for the run-up phase when the session itself just downloaded
 *  from Dukascopy — its network is clearly working, so a fresh 24h of context
 *  (usually one FX day across all timeframes) can genuinely finish. */
export const RUNUP_NETWORK_BUDGET_MS = 90_000
/** Budget when the session was fully cache-served (typically offline or
 *  rate-limited): only skip around in the cache / fail fast, never stall. */
export const RUNUP_CACHEONLY_BUDGET_MS = 15_000

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** ISO date shifted by whole UTC days, e.g. ('2024-01-02', -1) -> '2024-01-01'. */
function isoAddDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10)
}

/** First index whose candle opens at or after `ts` (binary search, ascending). */
export function indexAtOrAfter(candles: Candle[], ts: number): number {
  let lo = 0
  let hi = candles.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (candles[mid].timestamp < ts) lo = mid + 1
    else hi = mid
  }
  return lo
}

/**
 * The reveal index one boundary-aligned step away on a view showing `tf`.
 *
 * The clock is always M1; this only decides HOW MANY MINUTES a step reveals.
 * On a 1m view that is one minute. On a coarser view the step reveals exactly
 * the minutes up to the next (or previous) bar boundary, so it always lands ON
 * a bar CLOSE — a 15m chart at 10:04 steps to 10:15 and back to 10:00 — and the
 * chart and the clock can never disagree about what "now" is.
 *
 * Gaps (weekends, session end) stop at the last minute that closed at or before
 * the boundary; if that would be no progress at all, one minute is revealed
 * anyway so the control is never a dead press.
 */
export function clockStepIndex(
  session: ActiveSession | null,
  currentIndex: number,
  tf: Timeframe,
  dir: 1 | -1
): number {
  const clock = sessionClockCandles(session)
  if (clock.length === 0) return 0
  const tfMs = timeframeMs(tf)
  if (tfMs <= CLOCK_MS) {
    return dir > 0 ? Math.min(clock.length, currentIndex + 1) : Math.max(0, currentIndex - 1)
  }
  const now = clockNowMs(session, currentIndex) ?? clock[0].timestamp
  if (dir > 0) {
    const atBoundary = indexClosingAtOrBefore(clock, nextBoundaryMs(now, tfMs), CLOCK_MS)
    if (atBoundary > currentIndex) return atBoundary
    return Math.min(clock.length, currentIndex + 1)
  }
  // Backward: land on a bar close at or before now. Sitting EXACTLY on a
  // boundary means the current bar is already complete, so the press goes back
  // one further bar (10:15 → 10:00) — `prevBoundaryMs` alone would hand back
  // the same boundary and turn the press into a no-op.
  const boundary = prevBoundaryMs(now, tfMs)
  const target = indexClosingAtOrBefore(
    clock,
    now === boundary ? boundary - tfMs : boundary,
    CLOCK_MS
  )
  return Math.max(0, Math.min(target, currentIndex))
}

const SESSIONS_STORAGE_KEY = 'wanderlust_saved_sessions'
const CHART_STATES_STORAGE_KEY = 'wanderlust_chart_states'
const activeSessionsCache = new Map<string, ActiveSession>()

/** The localStorage document for chart-state persistence: workspace snapshots
 *  plus the last-selected position drawing, both keyed by session id. */
interface ChartStatesDocument {
  states?: Record<string, unknown>
  selections?: Record<string, string>
}

function loadChartStatesFromStorage(): {
  states: Map<string, unknown>
  selections: Map<string, string>
} {
  const states = new Map<string, unknown>()
  const selections = new Map<string, string>()
  if (typeof window === 'undefined' || !window.localStorage) return { states, selections }
  try {
    const doc = JSON.parse(
      window.localStorage.getItem(CHART_STATES_STORAGE_KEY) ?? 'null'
    ) as ChartStatesDocument | null
    for (const [id, state] of Object.entries(doc?.states ?? {})) {
      if (state && typeof state === 'object') states.set(id, state)
    }
    for (const [id, sel] of Object.entries(doc?.selections ?? {})) {
      if (typeof sel === 'string' && sel.length > 0) selections.set(id, sel)
    }
  } catch {
    // corrupt payload — start fresh
  }
  return { states, selections }
}

// Vela workspace snapshots (drawings + adjusted chart settings), keyed by
// session id. Survive the round trip through the main menu AND a full app
// restart (they are persisted to localStorage) — a reopened session resumes
// the chart exactly where it left off.
const { states: savedChartStates, selections: savedChartSelections } = loadChartStatesFromStorage()

function persistChartStatesToStorage(): void {
  if (typeof window === 'undefined' || !window.localStorage) return
  try {
    const states: Record<string, unknown> = {}
    for (const [id, state] of savedChartStates) states[id] = state
    const selections: Record<string, string> = {}
    for (const [id, sel] of savedChartSelections) selections[id] = sel
    const doc: ChartStatesDocument = { states, selections }
    window.localStorage.setItem(CHART_STATES_STORAGE_KEY, JSON.stringify(doc))
  } catch {
    // quota / serialization failure — the in-memory copies still serve this
    // app instance
  }
}

function loadSavedSessionsFromStorage(): SavedSession[] {
  if (typeof window === 'undefined' || !window.localStorage) return []
  try {
    const raw = window.localStorage.getItem(SESSIONS_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.map((s, idx) => ({
      ...s,
      id: s.id || `session-${idx}-${Date.now().toString(36)}`,
      name: s.name || `${s.asset?.label ?? 'EUR/USD'} Replay`,
      pinned: Boolean(s.pinned)
    }))
  } catch {
    return []
  }
}

function persistSavedSessionsToStorage(sessions: SavedSession[]): void {
  if (typeof window === 'undefined' || !window.localStorage) return
  try {
    window.localStorage.setItem(SESSIONS_STORAGE_KEY, JSON.stringify(sessions))
  } catch {
    // ignore
  }
}

/** Stable partition: pinned sessions first, everything else after. The stored
 *  array order IS the display order, so every mutation funnels through here. */
function hoistPinned(sessions: SavedSession[]): SavedSession[] {
  if (!sessions.some((s) => s.pinned)) return sessions
  return [...sessions.filter((s) => s.pinned), ...sessions.filter((s) => !s.pinned)]
}

/**
 * Walk whole trading days back from the day before `startDate` until the M1
 * window covers RUNUP_TARGET_MS of market time, then keep the tail.
 * `fetchDay(day, remainingMs)` prepares one day in the cache and reports
 * whether it settled in time: the fresh-download path fires a bounded batch
 * request, the cache-only resume path just reads what is already there.
 */
async function collectRunUp(
  asset: Asset,
  startDate: string,
  budgetMs: number,
  fetchDay: (day: string, remainingMs: number) => Promise<boolean>
): Promise<Candle[]> {
  const runUpEnd = isoAddDays(startDate, -1)
  let windowCandles: Candle[] = []
  const startedAt = Date.now()
  for (let back = 1; back <= SESSION_RUNUP_LOOKBACK_DAYS; back++) {
    if (windowCandles.length * CLOCK_MS >= RUNUP_TARGET_MS) break
    const day = isoAddDays(runUpEnd, -(back - 1))
    // Skip non-trading days (weekends for non-crypto): nothing to download,
    // and it avoids firing batch requests that would come back empty.
    if (!isTradingDay(Date.parse(`${day}T00:00:00Z`), asset.id)) continue
    const remaining = budgetMs - (Date.now() - startedAt)
    if (remaining <= 0) break
    if (!(await fetchDay(day, remaining))) break
    const data = await window.api.getCachedData({
      symbol: asset.id,
      timeframe: CLOCK_TIMEFRAME,
      startDate: day,
      endDate: day
    })
    if (!data.ok || data.candles.length === 0) continue
    windowCandles = windowCandles.length === 0 ? data.candles : data.candles.concat(windowCandles)
  }
  return runUpTail(windowCandles, CLOCK_MS)
}

/** Fire one day's batch download without letting a stalled request hang the
 *  session: it must settle inside the remaining run-up budget. */
async function fetchRunUpDay(asset: Asset, day: string, remainingMs: number): Promise<boolean> {
  const dayFetch = window.api.downloadData({
    symbol: asset.id,
    timeframe: CLOCK_TIMEFRAME,
    timeframes: [CLOCK_TIMEFRAME],
    startDate: day,
    endDate: day
  })
  const settled = await Promise.race([
    dayFetch.then(
      () => true,
      () => false
    ),
    sleep(remainingMs).then(() => false)
  ])
  void dayFetch.then(
    () => undefined,
    () => undefined
  )
  return settled
}

/**
 * Download the session's M1 clock plus its run-up context. This is the ONLY
 * data a session loads: every coarser timeframe the chart can show is
 * aggregated from these minutes at render time.
 */
async function loadClockAndRunUp(
  asset: Asset,
  startDate: string,
  endDate: string
): Promise<{ candles: Candle[]; runUp: Candle[]; source: string }> {
  const request = {
    symbol: asset.id,
    timeframe: CLOCK_TIMEFRAME,
    timeframes: [CLOCK_TIMEFRAME],
    startDate,
    endDate
  }
  const raw = await window.api.downloadData(request)
  if (!('timeframes' in raw)) {
    throw new Error(raw.message ?? 'Download failed.')
  }
  const res = raw as DownloadBatchResult
  if (!res.ok) {
    throw new Error(res.message ?? 'Download failed.')
  }

  const data = await window.api.getCachedData({
    symbol: asset.id,
    timeframe: CLOCK_TIMEFRAME,
    startDate,
    endDate
  })
  if (!data.ok || data.candles.length === 0) {
    throw new Error(
      'Dukascopy returned no candles for that range (weekends and holidays have no data). Try a different asset or date range.'
    )
  }

  const usedNetwork = res.timeframes.some((tfRes) => tfRes.source !== 'cache')
  const runUp = await collectRunUp(
    asset,
    startDate,
    usedNetwork ? RUNUP_NETWORK_BUDGET_MS : RUNUP_CACHEONLY_BUDGET_MS,
    (day, remaining) => fetchRunUpDay(asset, day, remaining)
  )
  return { candles: data.candles, runUp, source: res.timeframes[0]?.source ?? 'cache' }
}

export const useSessionStore = create<SessionState>((set, get) => ({
  status: 'idle',
  session: null,
  progress: [],
  error: null,
  migrationNotice: null,
  currentIndex: 0,
  playbackTimeframe: CLOCK_TIMEFRAME,
  playing: false,
  speed: 30,
  balance: 0,
  startBalance: 0,
  riskPercent: 1,
  orders: [],
  rewindWarningDismissed: false,
  selectedDrawing: null,
  lastOrderResult: null,
  savedSessions: loadSavedSessionsFromStorage(),

  dismissError: () => set({ error: null, status: 'idle' }),
  dismissMigrationNotice: () => set({ migrationNotice: null }),

  // --- playback controls (the single M1 clock) ---
  togglePlay: () =>
    set((s) => {
      const total = sessionClockCandles(s.session).length
      // At the end, play restarts the session from minute 0 — but never rewind
      // while a position is still open (close it in the Trading panel first).
      if (!s.playing && s.currentIndex >= total) {
        if (hasOpenPosition(s.orders)) return s
        const rewound = restoreOrdersAt(s.orders, s.startBalance, 0)
        return { playing: true, currentIndex: 0, orders: rewound.orders, balance: rewound.balance }
      }
      return { playing: !s.playing }
    }),
  pause: () => set({ playing: false }),
  // Forward index moves evaluate open/pending orders over every minute that
  // was just revealed: one minute on an m1 view, a whole bar's worth on a
  // coarser one (the engine walks the range candle by candle, so fills and
  // stops stay M1-precise even across a 15-minute jump). Backward moves are
  // gated while a position is open (you must close it first) and otherwise
  // REWIND the account with restoreOrdersAt — realized PnL from trades taken
  // later in the timeline is un-done.
  advance: () =>
    set((s) => {
      const nextIndex = clockStepIndex(s.session, s.currentIndex, s.playbackTimeframe, 1)
      // Nothing left to reveal (end of session) — stop the loop on this tick.
      if (nextIndex <= s.currentIndex) return { playing: false }
      const ev = evaluateOrders(
        s.orders,
        s.balance,
        sessionClockCandles(s.session),
        s.currentIndex,
        nextIndex
      )
      return { currentIndex: nextIndex, orders: ev.orders, balance: ev.balance }
    }),
  stepForward: () =>
    set((s) => {
      const nextIndex = clockStepIndex(s.session, s.currentIndex, s.playbackTimeframe, 1)
      const ev = evaluateOrders(
        s.orders,
        s.balance,
        sessionClockCandles(s.session),
        s.currentIndex,
        nextIndex
      )
      return { playing: false, currentIndex: nextIndex, orders: ev.orders, balance: ev.balance }
    }),
  stepBackward: () =>
    set((s) => {
      // No going backward inside a live position — close it first.
      if (hasOpenPosition(s.orders)) return s
      const nextIndex = clockStepIndex(s.session, s.currentIndex, s.playbackTimeframe, -1)
      const rewound = restoreOrdersAt(s.orders, s.startBalance, nextIndex)
      return {
        playing: false,
        currentIndex: nextIndex,
        orders: rewound.orders,
        balance: rewound.balance
      }
    }),
  setPlaybackTimeframe: (playbackTimeframe) =>
    set((s) => (s.playbackTimeframe === playbackTimeframe ? s : { playbackTimeframe })),
  skipToStart: () =>
    set((s) => {
      if (hasOpenPosition(s.orders)) return s
      const rewound = restoreOrdersAt(s.orders, s.startBalance, 0)
      return { playing: false, currentIndex: 0, orders: rewound.orders, balance: rewound.balance }
    }),
  skipToEnd: () =>
    set((s) => {
      const total = sessionClockCandles(s.session).length
      const ev = evaluateOrders(
        s.orders,
        s.balance,
        sessionClockCandles(s.session),
        s.currentIndex,
        total
      )
      return { playing: false, currentIndex: total, orders: ev.orders, balance: ev.balance }
    }),
  goToTimestamp: (ts) =>
    set((s) => {
      // Land ON the requested instant: reveal every minute that closes at or
      // before it, so the clock reads exactly the date/time the user picked.
      const nextIndex = indexClosingAtOrBefore(sessionClockCandles(s.session), ts, CLOCK_MS)
      const goingBack = nextIndex < s.currentIndex
      // A backward jump into a live position is refused: close it first.
      if (goingBack && hasOpenPosition(s.orders)) return s
      if (goingBack) {
        const rewound = restoreOrdersAt(s.orders, s.startBalance, nextIndex)
        return {
          playing: false,
          currentIndex: nextIndex,
          orders: rewound.orders,
          balance: rewound.balance
        }
      }
      const ev = evaluateOrders(
        s.orders,
        s.balance,
        sessionClockCandles(s.session),
        s.currentIndex,
        nextIndex
      )
      return { playing: false, currentIndex: nextIndex, orders: ev.orders, balance: ev.balance }
    }),
  // View-only "Just view" command: the chart pans its viewport to the target
  // date WITHOUT touching currentIndex/orders/balance — no re-slice, so every
  // Vela drawing (position tools, trend lines, …) survives. VelaChart consumes
  // the request and clears it back to null.
  viewRequest: null,
  requestViewAt: (ts) => set((s) => ({ viewRequest: { ts, seq: (s.viewRequest?.seq ?? 0) + 1 } })),
  clearViewRequest: () => set({ viewRequest: null }),
  // Explicit full rewind for the Custom Date "Rewind & reset" choice: the user
  // has already confirmed wiping the period, so no open-position gate applies
  // — restoreOrdersAt drops anything filled/closed at or after the target.
  rewindToTimestamp: (ts) =>
    set((s) => {
      const nextIndex = indexClosingAtOrBefore(sessionClockCandles(s.session), ts, CLOCK_MS)
      const rewound = restoreOrdersAt(s.orders, s.startBalance, nextIndex)
      return {
        playing: false,
        currentIndex: nextIndex,
        orders: rewound.orders,
        balance: rewound.balance
      }
    }),
  setSpeed: (speed) => set((s) => (s.speed === speed ? s : { speed })),

  // --- simulated account + orders (Phase 5) ---
  submitOrder: (input) => {
    const s = get()
    if (!s.session || s.status !== 'ready') {
      set({ lastOrderResult: { ok: false, message: 'Start a session first.' } })
      return
    }
    const fin = (v: number): boolean => Number.isFinite(v) && v > 0
    if (!fin(input.stopLoss) || !fin(input.takeProfit) || input.riskPercent <= 0) {
      set({
        lastOrderResult: { ok: false, message: 'Stop-loss, take-profit and risk must be set.' }
      })
      return
    }
    if (input.stopLoss === input.takeProfit) {
      set({ lastOrderResult: { ok: false, message: 'Stop-loss and take-profit must differ.' } })
      return
    }
    // Level sanity, per direction. Market orders fill at the next candle's open
    // (entry price unknown ahead of time) — only the SL/TP pair must bracket a
    // plausible entry. Limit/stop orders fill AT their order price, so the
    // A market order does not execute at the position tool's projected entry:
    // it fills on the next candle. Until that fill arrives, anchor its pending
    // entry display/risk preview to the latest known market close instead.
    const latestClose = latestRevealedClose(s.session, s.currentIndex)

    // Level sanity, per direction. Market orders fill at the next candle's open
    // (entry price unknown ahead of time) — only the SL/TP pair must bracket a
    // plausible entry. Limit/stop orders fill AT their order price, so the
    // levels must bracket THAT price.
    if (input.orderType !== 'market') {
      if (!fin(input.orderPrice)) {
        set({ lastOrderResult: { ok: false, message: 'Entry price must be set.' } })
        return
      }
      const okLevels =
        input.direction === 'long'
          ? input.stopLoss < input.orderPrice && input.orderPrice < input.takeProfit
          : input.takeProfit < input.orderPrice && input.orderPrice < input.stopLoss
      if (!okLevels) {
        set({
          lastOrderResult: {
            ok: false,
            message:
              input.direction === 'long'
                ? 'For a long: stop-loss < entry < take-profit.'
                : 'For a short: take-profit < entry < stop-loss.'
          }
        })
        return
      }

      // Order type logic rules:
      // Buy Limit: Order Price < Current Price
      // Sell Limit: Order Price > Current Price
      // Buy Stop: Order Price > Current Price
      // Sell Stop: Order Price < Current Price
      if (latestClose !== undefined && Number.isFinite(latestClose)) {
        const check = validateOrderTypePrice(
          input.orderType,
          input.direction,
          input.orderPrice,
          latestClose
        )
        if (!check.valid) {
          set({
            lastOrderResult: {
              ok: false,
              message: check.message ?? 'Invalid order price for selected order type.'
            }
          })
          return
        }
      }
    } else {
      const okLevels =
        input.direction === 'long'
          ? input.stopLoss < input.takeProfit
          : input.takeProfit < input.stopLoss
      if (!okLevels) {
        set({
          lastOrderResult: {
            ok: false,
            message:
              input.direction === 'long'
                ? 'For a long: stop-loss must sit below take-profit.'
                : 'For a short: take-profit must sit below stop-loss.'
          }
        })
        return
      }
    }

    const orderPrice =
      input.orderType === 'market' && latestClose !== undefined && Number.isFinite(latestClose)
        ? latestClose
        : input.orderPrice
    const previewSize = sizeForRisk(orderPrice, input.stopLoss, input.riskPercent, s.balance)
    const order: Order = {
      id: nextOrderId(),
      drawingId: input.drawingId,
      symbol: s.session.asset.id,
      orderType: input.orderType,
      direction: input.direction,
      orderPrice,
      stopLoss: input.stopLoss,
      takeProfit: input.takeProfit,
      riskPercent: input.riskPercent,
      previewSize,
      // Snapshot of the dollars risked at submission — the R-multiple base for
      // analytics. Sliding SL/TP after submission changes the trade's PnL but
      // must not change what its R is measured against.
      initialRisk: Math.abs(orderPrice - input.stopLoss) * previewSize,
      submissionIndex: s.currentIndex,
      // The clock instant, not the cursor: a saved session can always be
      // re-based onto the M1 clock from this even if the index unit changes.
      submissionTime: clockNowMs(s.session, s.currentIndex) ?? Date.now(),
      status: 'pending'
    }
    set({
      orders: [...s.orders, order],
      lastOrderResult: {
        ok: true,
        message: `${input.orderType === 'market' ? 'Market' : input.orderType === 'limit' ? 'Limit' : 'Stop'} ${input.direction} order placed (pending).`
      }
    })
  },
  setRiskPercent: (pct) =>
    set((s) => {
      const clamped = Math.min(100, Math.max(0, pct))
      return s.riskPercent === clamped ? s : { riskPercent: clamped }
    }),
  /** Reprice an order's stop-loss/take-profit by live drag on the chart's
   *  horizontal level strips (Phase 6 — OrderLevelsOverlay). Pending/running
   *  orders reprice; closed orders are read-only. A dragged level that would
   *  cross the market (filled) or the projected entry (pending) is refused —
   *  otherwise the next candle exits the position there instantly ("drag the TP
   *  below the price and the order auto-stops"). Pure map; never throws. */
  updateOrderLevel: (orderId, level, price) => {
    if (!Number.isFinite(price) || price <= 0) return 'noop'
    const s = get()
    const market = latestRevealedClose(s.session, s.currentIndex)
    const target = s.orders.find((o) => o.id === orderId && o.status !== 'closed')
    if (!target) return 'noop'
    if (
      (level === 'stopLoss' && target.stopLoss === price) ||
      (level === 'takeProfit' && target.takeProfit === price)
    ) {
      return 'noop'
    }
    if (!canRepriceLevel(target, level, price, market)) return 'rejected'
    set({
      orders: s.orders.map((o) =>
        o.id === orderId && o.status !== 'closed' && o[level] !== price
          ? level === 'stopLoss'
            ? { ...o, stopLoss: price }
            : { ...o, takeProfit: price }
          : o
      )
    })
    return 'applied'
  },

  closeOrder: (orderId) =>
    set((s) => {
      const order = s.orders.find((candidate) => candidate.id === orderId)
      if (!order || order.status === 'closed') return s
      // A pending order has never entered the market: remove it rather than
      // creating a zero-PnL closed trade or changing the account balance.
      if (order.status === 'pending') {
        return {
          orders: s.orders.filter((candidate) => candidate.id !== orderId),
          lastOrderResult: { ok: true, message: 'Pending order cancelled.' }
        }
      }
      const clock = sessionClockCandles(s.session)
      const runUp = sessionClockRunUp(s.session)
      const candle =
        s.currentIndex > 0
          ? clock[s.currentIndex - 1]
          : runUp.length > 0
            ? runUp[runUp.length - 1]
            : undefined
      const exitPrice = candle?.close
      if (exitPrice === undefined || !Number.isFinite(exitPrice) || exitPrice <= 0 || !candle)
        return s
      const fillPrice = order?.fillPrice
      if (
        !order ||
        order.status !== 'filled' ||
        fillPrice === undefined ||
        !Number.isFinite(fillPrice)
      )
        return s
      const pnl =
        (exitPrice - fillPrice) * (order.size ?? 0) * (order.direction === 'long' ? 1 : -1)
      return {
        orders: s.orders.map((candidate) =>
          candidate.id === orderId
            ? {
                ...candidate,
                status: 'closed',
                exitPrice,
                pnl,
                exitReason: 'manual',
                closedAtTime: candle.timestamp,
                closedAtIndex: Math.max(0, s.currentIndex - 1)
              }
            : candidate
        ),
        balance: s.balance + pnl,
        lastOrderResult: { ok: true, message: 'Position closed at the current market price.' }
      }
    }),

  flattenPositions: () =>
    set((s) => {
      const clock = sessionClockCandles(s.session)
      const runUp = sessionClockRunUp(s.session)
      const candle =
        s.currentIndex > 0
          ? clock[s.currentIndex - 1]
          : runUp.length > 0
            ? runUp[runUp.length - 1]
            : undefined
      const exitPrice = candle?.close
      if (!candle || exitPrice === undefined || !Number.isFinite(exitPrice) || exitPrice <= 0)
        return s
      let pnl = 0
      let changed = false
      const next = s.orders.map((order): Order => {
        if (
          order.status !== 'filled' ||
          order.fillPrice === undefined ||
          !Number.isFinite(order.fillPrice)
        )
          return order
        changed = true
        const p =
          (exitPrice - order.fillPrice) * (order.size ?? 0) * (order.direction === 'long' ? 1 : -1)
        pnl += p
        return {
          ...order,
          status: 'closed',
          exitPrice,
          pnl: p,
          exitReason: 'manual',
          closedAtTime: candle.timestamp,
          closedAtIndex: Math.max(0, s.currentIndex - 1)
        }
      })
      if (!changed) return s
      return {
        orders: next,
        balance: s.balance + pnl,
        lastOrderResult: { ok: true, message: 'Positions closed at the current market price.' }
      }
    }),
  dismissRewindWarning: () => set({ rewindWarningDismissed: true }),
  setSelectedDrawing: (selection) =>
    set((s) => {
      // The same drawing id can carry new anchors after the user drags the
      // position tool. Keep the selection snapshot fresh so New Order seeds
      // from its adjusted entry/SL/TP, not the values from the first click.
      const previous = s.selectedDrawing
      if (
        selection?.drawingId === previous?.drawingId &&
        selection?.direction === previous?.direction &&
        selection?.entryPrice === previous?.entryPrice &&
        selection?.stopLoss === previous?.stopLoss &&
        selection?.takeProfit === previous?.takeProfit
      )
        return s
      return { selectedDrawing: selection }
    }),

  startSession: async (input) => {
    const sessionId = `session-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
    const sessionName =
      input.name?.trim() || `${input.asset.label} ${input.timeframe.toUpperCase()} Replay`

    set({
      status: 'downloading',
      progress: [],
      error: null,
      session: null,
      currentIndex: 0,
      playbackTimeframe: input.timeframe,
      playing: false,
      balance: input.balance,
      startBalance: input.balance,
      orders: [],
      rewindWarningDismissed: false,
      selectedDrawing: null,
      lastOrderResult: null,
      viewRequest: null
    })

    try {
      const { candles, runUp, source } = await loadClockAndRunUp(
        input.asset,
        input.startDate,
        input.endDate
      )

      const active: ActiveSession = {
        ...input,
        id: sessionId,
        name: sessionName,
        clockCandles: candles,
        clockRunUp: runUp,
        source
      }

      const saved: SavedSession = {
        id: sessionId,
        name: sessionName,
        asset: input.asset,
        timeframe: input.timeframe,
        startDate: input.startDate,
        endDate: input.endDate,
        startBalance: input.balance,
        balance: input.balance,
        orders: [],
        currentIndex: 0,
        playbackTimeframe: input.timeframe,
        clockTimeframe: CLOCK_TIMEFRAME,
        createdAt: Date.now(),
        updatedAt: Date.now()
      }

      const updated = hoistPinned([saved, ...get().savedSessions.filter((s) => s.id !== sessionId)])
      persistSavedSessionsToStorage(updated)

      activeSessionsCache.set(sessionId, active)

      set({
        status: 'ready',
        session: active,
        savedSessions: updated
      })
    } catch (err) {
      set({ status: 'error', error: err instanceof Error ? err.message : String(err) })
    }
  },

  resumeSavedSession: async (id: string) => {
    const target = get().savedSessions.find((s) => s.id === id)
    if (!target) return
    if (get().session?.id === id) {
      set({ playing: false })
      return
    }

    // 1. Fast in-memory cache check: if session was active in this app instance
    const cachedActive = activeSessionsCache.get(id)
    if (cachedActive) {
      set({
        status: 'ready',
        session: cachedActive,
        balance: target.balance,
        startBalance: target.startBalance,
        orders: target.orders,
        currentIndex: target.currentIndex,
        playbackTimeframe: target.playbackTimeframe,
        playing: false,
        selectedDrawing: null,
        lastOrderResult: null,
        viewRequest: null
      })
      return
    }

    set({
      status: 'downloading',
      progress: [],
      error: null,
      session: null,
      playing: false
    })

    try {
      // 2. Load the M1 clock from the SQLite cache first.
      const cached = await window.api.getCachedData({
        symbol: target.asset.id,
        timeframe: CLOCK_TIMEFRAME,
        startDate: target.startDate,
        endDate: target.endDate
      })
      let clockCandles: Candle[] = cached.ok ? cached.candles : []
      let clockRunUp: Candle[] = []
      let source = 'cache'

      if (clockCandles.length > 0) {
        // Cache-only run-up: walk back whole trading days (cache reads cost
        // nothing) until 24h of M1 market time is covered. A Monday-start
        // session thus reaches Friday + Sunday, not just Sunday's stub. Mirrors
        // the fresh-download walk without any network.
        clockRunUp = await collectRunUp(
          target.asset,
          target.startDate,
          RUNUP_CACHEONLY_BUDGET_MS,
          async () => true
        )
      } else {
        const loaded = await loadClockAndRunUp(target.asset, target.startDate, target.endDate)
        clockCandles = loaded.candles
        clockRunUp = loaded.runUp
        source = loaded.source
      }

      // 3. A session saved BEFORE the single M1 clock counted BARS of its own
      // initial timeframe in `currentIndex` and the orders' index stamps. Re-base
      // it onto the clock BY TIMESTAMP — the fact both formats record — so the
      // session resumes at the same wall-clock instant, revealed to the minute.
      let currentIndex = target.currentIndex
      let orders = target.orders
      let migrationNotice: string | null = null
      let savedSessions = get().savedSessions
      if (target.clockTimeframe !== CLOCK_TIMEFRAME) {
        // The legacy position: the last revealed bar covered [t, t + barMs), so
        // the equivalent M1 position reveals every minute up to its CLOSE.
        currentIndex = 0
        if (target.currentIndex > 0) {
          const legacy = await window.api.getCachedData({
            symbol: target.asset.id,
            timeframe: target.timeframe,
            startDate: target.startDate,
            endDate: target.endDate
          })
          const bar = legacy.ok ? legacy.candles[target.currentIndex - 1] : undefined
          currentIndex = bar
            ? indexClosingAtOrBefore(
                clockCandles,
                bar.timestamp + timeframeMs(target.timeframe),
                CLOCK_MS
              )
            : 0
        }
        // Filled/closed orders carry their fill/exit TIMESTAMPS, so their
        // indices are exactly re-derivable. Legacy PENDING orders have no
        // submission timestamp — there is nothing to re-base them from — so
        // they are dropped rather than silently placed in the wrong minute.
        let droppedPending = 0
        orders = target.orders.flatMap((order): Order[] => {
          if (order.status === 'pending') {
            droppedPending++
            return []
          }
          return [
            {
              ...order,
              filledAtIndex:
                order.filledAtTime !== undefined
                  ? indexAtOrAfter(clockCandles, order.filledAtTime)
                  : order.filledAtIndex,
              closedAtIndex:
                order.closedAtTime !== undefined
                  ? indexAtOrAfter(clockCandles, order.closedAtTime)
                  : order.closedAtIndex
            }
          ]
        })
        migrationNotice = droppedPending
          ? `Session moved to the 1-minute clock. ${droppedPending} pending order${
              droppedPending === 1 ? '' : 's'
            } could not be placed in time and ${droppedPending === 1 ? 'was' : 'were'} dropped.`
          : 'Session moved to the 1-minute clock.'
        // Write the migrated shape through BOTH the in-memory list and storage
        // so the next resume is a plain M1 session (this one-time pass never
        // runs twice) and no later save can resurrect the stale indices.
        savedSessions = get().savedSessions.map((s) =>
          s.id === target.id
            ? {
                ...s,
                currentIndex,
                orders,
                clockTimeframe: CLOCK_TIMEFRAME,
                updatedAt: Date.now()
              }
            : s
        )
        persistSavedSessionsToStorage(savedSessions)
      }

      const active: ActiveSession = {
        id: target.id,
        name: target.name,
        asset: target.asset,
        timeframe: target.timeframe,
        startDate: target.startDate,
        endDate: target.endDate,
        balance: target.startBalance,
        clockCandles,
        clockRunUp,
        source
      }

      activeSessionsCache.set(target.id, active)

      set({
        status: 'ready',
        session: active,
        balance: target.balance,
        startBalance: target.startBalance,
        orders,
        currentIndex,
        playbackTimeframe: target.playbackTimeframe,
        migrationNotice,
        savedSessions,
        playing: false,
        selectedDrawing: null,
        lastOrderResult: null,
        viewRequest: null
      })
    } catch (err) {
      set({ status: 'error', error: err instanceof Error ? err.message : String(err) })
    }
  },

  deleteSavedSession: (id: string) => {
    activeSessionsCache.delete(id)
    savedChartStates.delete(id)
    savedChartSelections.delete(id)
    persistChartStatesToStorage()
    const updated = get().savedSessions.filter((s) => s.id !== id)
    persistSavedSessionsToStorage(updated)
    if (get().session?.id === id) {
      set({ session: null, savedSessions: updated, playing: false })
    } else {
      set({ savedSessions: updated })
    }
  },

  toggleSavedSessionPin: (id) => {
    const sessions = get().savedSessions
    const target = sessions.find((s) => s.id === id)
    if (!target) return
    const rest = sessions.filter((s) => s.id !== id)
    let updated: SavedSession[]
    if (target.pinned) {
      // Unpin: drop it just below the remaining pinned group.
      const unpinned = { ...target, pinned: false }
      const lastPinned = rest.reduce((acc, s, idx) => (s.pinned ? idx : acc), -1)
      updated = [...rest.slice(0, lastPinned + 1), unpinned, ...rest.slice(lastPinned + 1)]
    } else {
      // Pin: hoist it to the very top.
      updated = [{ ...target, pinned: true }, ...rest]
    }
    persistSavedSessionsToStorage(updated)
    set({ savedSessions: updated })
  },

  setSavedSessionsOrder: (ids) => {
    const sessions = get().savedSessions
    const byId = new Map(sessions.map((s) => [s.id, s]))
    const seen = new Set<string>()
    const ordered: SavedSession[] = []
    for (const id of ids) {
      const s = byId.get(id)
      if (s && !seen.has(id)) {
        ordered.push(s)
        seen.add(id)
      }
    }
    // Anything the caller omitted keeps its previous slot at the end.
    for (const s of sessions) if (!seen.has(s.id)) ordered.push(s)
    const updated = hoistPinned(ordered)
    persistSavedSessionsToStorage(updated)
    set({ savedSessions: updated })
  },

  exitToMainMenu: () => {
    const {
      session,
      orders,
      balance,
      startBalance,
      currentIndex,
      playbackTimeframe,
      savedSessions
    } = get()
    if (session) {
      activeSessionsCache.set(session.id, session)
      const updated = savedSessions.map((s) => {
        if (s.id === session.id) {
          return {
            ...s,
            balance,
            startBalance,
            orders,
            currentIndex,
            playbackTimeframe,
            updatedAt: Date.now()
          }
        }
        return s
      })
      persistSavedSessionsToStorage(updated)
      set({
        playing: false,
        session: null,
        savedSessions: updated,
        selectedDrawing: null,
        viewRequest: null
      })
    } else {
      set({ playing: false, session: null, viewRequest: null })
    }
  },

  saveCurrentSessionState: () => {
    const {
      session,
      orders,
      balance,
      startBalance,
      currentIndex,
      playbackTimeframe,
      savedSessions
    } = get()
    if (!session) return
    const updated = savedSessions.map((s) => {
      if (s.id === session.id) {
        return {
          ...s,
          balance,
          startBalance,
          orders,
          currentIndex,
          playbackTimeframe,
          updatedAt: Date.now()
        }
      }
      return s
    })
    persistSavedSessionsToStorage(updated)
    set({ savedSessions: updated })
  },

  saveChartState: (id, state) => {
    savedChartStates.set(id, state)
    persistChartStatesToStorage()
  },
  chartStateFor: (id) => savedChartStates.get(id),
  saveChartSelection: (id, drawingId) => {
    savedChartSelections.set(id, drawingId)
    persistChartStatesToStorage()
  },
  chartSelectionFor: (id) => savedChartSelections.get(id)
}))

// Drop chart-state snapshots for sessions that no longer exist (deleted
// sessions, or leftovers from an older build) — the persisted document stays
// honest and localStorage stays small.
{
  const valid = new Set(useSessionStore.getState().savedSessions.map((s) => s.id))
  let changed = false
  for (const id of [...savedChartStates.keys()]) {
    if (!valid.has(id)) {
      savedChartStates.delete(id)
      changed = true
    }
  }
  for (const id of [...savedChartSelections.keys()]) {
    if (!valid.has(id)) {
      savedChartSelections.delete(id)
      changed = true
    }
  }
  if (changed) persistChartStatesToStorage()
}

// Stream main-process download progress into the store while a download runs.
// Module scope (not a React effect) so StrictMode's double-mount never
// double-subscribes; HMR re-imports are guarded by the existing handle.
//
// The feed is bounded to a trailing window: the modal renders every event, so
// an unbounded log would mean unbounded DOM + memory on very long batches
// (7 timeframes × many days → hundreds of events). A 50-event tail keeps the
// whole download visible while capping growth.
const PROGRESS_LOG_LIMIT = 50
let progressUnsub: (() => void) | null = null
if (!progressUnsub && typeof window !== 'undefined' && window.api) {
  progressUnsub = window.api.onDownloadProgress((event) => {
    const { status } = useSessionStore.getState()
    if (status === 'downloading') {
      useSessionStore.setState((s) => ({
        progress: [...s.progress, event].slice(-PROGRESS_LOG_LIMIT)
      }))
    }
  })
}
