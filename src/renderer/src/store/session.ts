import { create } from 'zustand'
import type { Asset } from '@shared/assets'
import type { Candle, DownloadBatchResult, DownloadProgressEvent } from '@shared/ipc'
import {
  RUNUP_TARGET_MS,
  TIMEFRAMES,
  runUpTail,
  timeframeMs,
  type Timeframe
} from '@shared/timeframes'
import { isTradingDay } from '@shared/trading'
import {
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
 * A session downloads EVERY timeframe (m1…d1) for the chosen range in ONE batch
 * IPC call, streams progress into the UI, and stores the candles per timeframe
 * (`candlesByTimeframe`) — the per-timeframe `masterCandleArray`s the playback
 * loop slices in Phase 4. Fields marked "Phase 4" are seeded now so the store
 * shape stays stable when the playback loop lands.
 */

export type SessionStatus = 'idle' | 'downloading' | 'ready' | 'error'

export interface NewSessionInput {
  name?: string
  asset: Asset
  /** Dukascopy timeframe id ('m1' | 'm5' | 'm15' | 'm30' | 'h1' | 'h4' | 'd1')
   *  — the chart's INITIAL timeframe; every timeframe is downloaded regardless. */
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
  createdAt: number
  updatedAt: number
}

export interface ActiveSession extends NewSessionInput {
  id: string
  name: string
  /** Candles for every downloaded timeframe, keyed by dukascopy timeframe id. */
  candlesByTimeframe: Partial<Record<Timeframe, Candle[]>>
  /** Candles of the day(s) downloaded as run-up context, keyed by dukascopy
   *  timeframe id — what the chart shows BEFORE any session candle is revealed,
   *  so a session never starts on a blank chart. */
  runUpByTimeframe: Partial<Record<Timeframe, Candle[]>>
  /** Where each timeframe's data came from ('cache' | 'dukascopy' | 'mixed') */
  sources: Partial<Record<Timeframe, string>>
}

export interface SessionState {
  status: SessionStatus
  session: ActiveSession | null
  /** Progress events streamed from the main process during a download */
  progress: DownloadProgressEvent[]
  error: string | null
  // --- playback state (Phase 4) ---
  /** Index into the session's base-timeframe candles — how much of the session
   *  is "revealed". The chart shows `masterCandleArray.slice(0, currentIndex)`. */
  currentIndex: number
  /** Timeframe currently displayed by the chart; stepping follows this bar cadence. */
  playbackTimeframe: Timeframe
  playing: boolean
  /** 1..120 — the speed slider; maps to the playback interval delay */
  speed: number

  // --- playback controls (Phase 4) ---
  /** Play/pause; pressing play after the end restarts from candle 0 */
  togglePlay: () => void
  pause: () => void
  /** Advance one candle WITHOUT changing play state (the loop's per-tick op) */
  advance: () => void
  stepForward: () => void
  stepBackward: () => void
  setPlaybackTimeframe: (timeframe: Timeframe) => void
  skipToStart: () => void
  skipToEnd: () => void
  /** Jump to the first candle that opens at or after `timestamp` (Go To) */
  goToTimestamp: (timestamp: number) => void
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
   *  Closed orders are read-only; the write is a pure guarded map. */
  updateOrderLevel: (orderId: string, level: OrderLevel, price: number) => void
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

  // --- chart-state persistence (Phase 7) ---
  /** Stash a Vela workspace snapshot (drawings + adjusted chart settings) for
   *  a session, taken just before its workspace is destroyed. */
  saveChartState: (id: string, state: unknown) => void
  /** The workspace snapshot stashed for `id`, or undefined. */
  chartStateFor: (id: string) => unknown | undefined
  /** Remember which position drawing was selected when the user left the
   *  session, so a resume re-asserts the New Order affordance. */
  saveChartSelection: (id: string, drawingId: string) => void
  /** The selection saved for `id`, or undefined. */
  chartSelectionFor: (id: string) => string | undefined
}

/** Candles of the session's initial timeframe — the playback panel's counter. */
export function sessionBaseCandles(session: ActiveSession | null): Candle[] {
  if (!session) return []
  return session.candlesByTimeframe[session.timeframe] ?? []
}

/** Candles of the run-up day(s) for the session's initial timeframe. */
export function sessionBaseRunUp(session: ActiveSession | null): Candle[] {
  if (!session) return []
  return session.runUpByTimeframe[session.timeframe] ?? []
}

/** Timestamp of the LAST revealed candle (run-up included): at index 0 the
 *  run-up's last candle, otherwise the revealed session candle — what the
 *  chart's right edge is pointing at right now. */
export function revealedTime(
  session: ActiveSession | null,
  currentIndex: number
): number | undefined {
  if (!session) return undefined
  const base = sessionBaseCandles(session)
  if (currentIndex > 0) return base[currentIndex - 1]?.timestamp
  const runUp = sessionBaseRunUp(session)
  return runUp.length > 0 ? runUp[runUp.length - 1].timestamp : undefined
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

/** Reveal index that adds/removes exactly one bar on the currently viewed timeframe. */
export function stepIndexForTimeframe(
  session: ActiveSession | null,
  currentIndex: number,
  tf: Timeframe,
  dir: 1 | -1
): number {
  if (!session) return 0
  const base = sessionBaseCandles(session)
  const active = session.candlesByTimeframe[tf] ?? base
  const runUp = sessionBaseRunUp(session)
  const cutoff =
    currentIndex > 0 ? base[currentIndex - 1]?.timestamp : runUp[runUp.length - 1]?.timestamp
  if (cutoff === undefined) return dir > 0 ? Math.min(1, base.length) : 0
  let visible = 0
  while (visible < active.length && active[visible].timestamp <= cutoff) visible += 1
  if (dir > 0) {
    const next = active[visible]
    return next ? Math.min(base.length, indexAtOrAfter(base, next.timestamp) + 1) : base.length
  }
  const current = active[visible - 1]
  return current ? indexAtOrAfter(base, current.timestamp) : 0
}

const SESSIONS_STORAGE_KEY = 'wanderlust_saved_sessions'
const activeSessionsCache = new Map<string, ActiveSession>()
// Per-instance Vela workspace snapshots (drawings + adjusted chart settings),
// keyed by session id — they survive the round trip through the main menu and
// die with the app instance, exactly like the active-session candle cache.
const savedChartStates = new Map<string, unknown>()
// The position drawing that was selected when the user left the session, so a
// resume can re-assert it on the restored chart.
const savedChartSelections = new Map<string, string>()

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
      name: s.name || `${s.asset?.label ?? 'EUR/USD'} Replay`
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

async function loadCandlesAndRunUp(
  asset: Asset,
  initialTimeframe: Timeframe,
  startDate: string,
  endDate: string
): Promise<{
  candlesByTimeframe: Partial<Record<Timeframe, Candle[]>>
  runUpByTimeframe: Partial<Record<Timeframe, Candle[]>>
  sources: Partial<Record<Timeframe, string>>
}> {
  const request = {
    symbol: asset.id,
    timeframe: initialTimeframe,
    timeframes: [...TIMEFRAMES],
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

  const candlesByTimeframe: Partial<Record<Timeframe, Candle[]>> = {}
  for (const tf of TIMEFRAMES) {
    const data = await window.api.getCachedData({
      symbol: asset.id,
      timeframe: tf,
      startDate,
      endDate
    })
    if (data.ok && data.candles.length > 0) candlesByTimeframe[tf] = data.candles
  }
  if (Object.values(candlesByTimeframe).every((c) => !c?.length)) {
    throw new Error(
      'Dukascopy returned no candles for that range (weekends and holidays have no data). Try a different asset or date range.'
    )
  }

  const sources: Partial<Record<Timeframe, string>> = {}
  for (const tfRes of res.timeframes) {
    sources[tfRes.timeframe as Timeframe] = tfRes.source
  }

  const runUpByTimeframe: Partial<Record<Timeframe, Candle[]>> = {}
  const runUpEnd = isoAddDays(startDate, -1)
  const windowCandles: Partial<Record<Timeframe, Candle[]>> = {}
  const runUpMs = (tf: Timeframe): number => (windowCandles[tf]?.length ?? 0) * timeframeMs(tf)
  const usedNetwork = res.timeframes.some((tfRes) => tfRes.source !== 'cache')
  const runUpBudgetMs = usedNetwork ? RUNUP_NETWORK_BUDGET_MS : RUNUP_CACHEONLY_BUDGET_MS
  const runUpStartedAt = Date.now()
  for (let back = 1; back <= SESSION_RUNUP_LOOKBACK_DAYS; back++) {
    if (runUpMs(initialTimeframe) >= RUNUP_TARGET_MS) break
    const day = isoAddDays(runUpEnd, -(back - 1))
    // Skip non-trading days (weekends for non-crypto): nothing to download,
    // and it avoids firing batch requests that would come back empty.
    if (!isTradingDay(Date.parse(`${day}T00:00:00Z`), asset.id)) continue
    const remaining = runUpBudgetMs - (Date.now() - runUpStartedAt)
    if (remaining <= 0) break
    const dayFetch = window.api.downloadData({
      symbol: asset.id,
      timeframe: initialTimeframe,
      timeframes: [...TIMEFRAMES],
      startDate: day,
      endDate: day
    })
    const settled = await Promise.race([
      dayFetch.then(
        () => true,
        () => false
      ),
      sleep(remaining).then(() => false)
    ])
    void dayFetch.then(
      () => undefined,
      () => undefined
    )
    if (!settled) break
    for (const tf of Object.keys(candlesByTimeframe) as Timeframe[]) {
      const data = await window.api.getCachedData({
        symbol: asset.id,
        timeframe: tf,
        startDate: day,
        endDate: day
      })
      if (!data.ok || data.candles.length === 0) continue
      const prev = windowCandles[tf]
      windowCandles[tf] = prev ? data.candles.concat(prev) : data.candles
    }
  }

  for (const tf of Object.keys(candlesByTimeframe) as Timeframe[]) {
    const win = windowCandles[tf]
    if (!win || win.length === 0) continue
    const runUp = runUpTail(win, timeframeMs(tf))
    if (runUp.length > 0) runUpByTimeframe[tf] = runUp
  }

  return { candlesByTimeframe, runUpByTimeframe, sources }
}

export const useSessionStore = create<SessionState>((set, get) => ({
  status: 'idle',
  session: null,
  progress: [],
  error: null,
  currentIndex: 0,
  playbackTimeframe: 'm1',
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

  // --- playback controls (Phase 4) ---
  togglePlay: () =>
    set((s) => {
      const total = sessionBaseCandles(s.session).length
      // At the end, play restarts the session from candle 0 — but never rewind
      // while a position is still open (close it in the Trading panel first).
      if (!s.playing && s.currentIndex >= total) {
        if (hasOpenPosition(s.orders)) return s
        const rewound = restoreOrdersAt(s.orders, s.startBalance, 0)
        return { playing: true, currentIndex: 0, orders: rewound.orders, balance: rewound.balance }
      }
      return { playing: !s.playing }
    }),
  pause: () => set({ playing: false }),
  // Forward index moves evaluate open/pending orders over the candles that
  // were just revealed (Phase 5): one candle on a tick, a whole range on a
  // jump. Backward moves are gated while a position is open (you must close
  // it first) and otherwise REWIND the account with restoreOrdersAt — realized
  // PnL from trades taken later in the timeline is un-done, orders revert to
  // their state at the destination index.
  advance: () =>
    set((s) => {
      const total = sessionBaseCandles(s.session).length
      const nextIndex = Math.min(s.currentIndex + 1, total)
      if (nextIndex <= s.currentIndex) return { currentIndex: nextIndex }
      const ev = evaluateOrders(
        s.orders,
        s.balance,
        sessionBaseCandles(s.session),
        s.currentIndex,
        nextIndex
      )
      return { currentIndex: nextIndex, orders: ev.orders, balance: ev.balance }
    }),
  stepForward: () =>
    set((s) => {
      const total = sessionBaseCandles(s.session).length
      const nextIndex = Math.min(
        stepIndexForTimeframe(s.session, s.currentIndex, s.playbackTimeframe, 1),
        total
      )
      const ev = evaluateOrders(
        s.orders,
        s.balance,
        sessionBaseCandles(s.session),
        s.currentIndex,
        nextIndex
      )
      return { playing: false, currentIndex: nextIndex, orders: ev.orders, balance: ev.balance }
    }),
  stepBackward: () =>
    set((s) => {
      // No going backward inside a live position — close it first.
      if (hasOpenPosition(s.orders)) return s
      const nextIndex = stepIndexForTimeframe(s.session, s.currentIndex, s.playbackTimeframe, -1)
      const rewound = restoreOrdersAt(s.orders, s.startBalance, nextIndex)
      return {
        playing: false,
        currentIndex: nextIndex,
        orders: rewound.orders,
        balance: rewound.balance
      }
    }),
  setPlaybackTimeframe: (playbackTimeframe) => set({ playbackTimeframe }),
  skipToStart: () =>
    set((s) => {
      if (hasOpenPosition(s.orders)) return s
      const rewound = restoreOrdersAt(s.orders, s.startBalance, 0)
      return { playing: false, currentIndex: 0, orders: rewound.orders, balance: rewound.balance }
    }),
  skipToEnd: () =>
    set((s) => {
      const total = sessionBaseCandles(s.session).length
      const ev = evaluateOrders(
        s.orders,
        s.balance,
        sessionBaseCandles(s.session),
        s.currentIndex,
        total
      )
      return { playing: false, currentIndex: total, orders: ev.orders, balance: ev.balance }
    }),
  goToTimestamp: (ts) =>
    set((s) => {
      const nextIndex = indexAtOrAfter(sessionBaseCandles(s.session), ts)
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
        sessionBaseCandles(s.session),
        s.currentIndex,
        nextIndex
      )
      return { playing: false, currentIndex: nextIndex, orders: ev.orders, balance: ev.balance }
    }),
  setSpeed: (speed) => set({ speed }),

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
    const base = sessionBaseCandles(s.session)
    const runUp = sessionBaseRunUp(s.session)
    const latestClose =
      s.currentIndex > 0
        ? base[s.currentIndex - 1]?.close
        : runUp.length > 0
          ? runUp[runUp.length - 1]?.close
          : undefined

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
      previewSize: sizeForRisk(orderPrice, input.stopLoss, input.riskPercent, s.balance),
      submissionIndex: s.currentIndex,
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
  setRiskPercent: (pct) => set({ riskPercent: Math.min(100, Math.max(0, pct)) }),
  /** Reprice an order's stop-loss/take-profit by live drag on the chart's
   *  horizontal level strips (Phase 6 — OrderLevelsOverlay). Pending/running
   *  orders reprice; closed orders are read-only. Pure map; never throws. */
  updateOrderLevel: (orderId, level, price) =>
    set((s) => {
      if (!Number.isFinite(price) || price <= 0) return s
      const next = s.orders.map((o) => {
        if (o.id !== orderId || o.status === 'closed') return o
        if (level === 'stopLoss' && o.stopLoss === price) return o
        if (level === 'takeProfit' && o.takeProfit === price) return o
        return level === 'stopLoss' ? { ...o, stopLoss: price } : { ...o, takeProfit: price }
      })
      return { orders: next }
    }),

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
      const base = sessionBaseCandles(s.session)
      const runUp = sessionBaseRunUp(s.session)
      const candle =
        s.currentIndex > 0
          ? base[s.currentIndex - 1]
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
      const base = sessionBaseCandles(s.session)
      const runUp = sessionBaseRunUp(s.session)
      const candle =
        s.currentIndex > 0
          ? base[s.currentIndex - 1]
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
      lastOrderResult: null
    })

    try {
      const { candlesByTimeframe, runUpByTimeframe, sources } = await loadCandlesAndRunUp(
        input.asset,
        input.timeframe,
        input.startDate,
        input.endDate
      )

      const active: ActiveSession = {
        ...input,
        id: sessionId,
        name: sessionName,
        candlesByTimeframe,
        runUpByTimeframe,
        sources
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
        createdAt: Date.now(),
        updatedAt: Date.now()
      }

      const updated = [saved, ...get().savedSessions.filter((s) => s.id !== sessionId)]
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
        lastOrderResult: null
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
      // 2. Try loading candles from SQLite cache first
      const candlesByTimeframe: Partial<Record<Timeframe, Candle[]>> = {}
      for (const tf of TIMEFRAMES) {
        const data = await window.api.getCachedData({
          symbol: target.asset.id,
          timeframe: tf,
          startDate: target.startDate,
          endDate: target.endDate
        })
        if (data.ok && data.candles.length > 0) candlesByTimeframe[tf] = data.candles
      }

      let runUpByTimeframe: Partial<Record<Timeframe, Candle[]>> = {}
      let sources: Partial<Record<Timeframe, string>> = {}

      const hasCachedCandles = Object.values(candlesByTimeframe).some((c) => c && c.length > 0)

      if (hasCachedCandles) {
        // Cache-only run-up: walk back whole trading days (cache reads cost
        // nothing) until 24h of market time is covered. A Monday-start session
        // thus reaches Friday + Sunday, not just Sunday's stub. Mirrors the
        // fresh-download walk (loadCandlesAndRunUp) without any network.
        const runUpEnd = isoAddDays(target.startDate, -1)
        const windowCandles: Partial<Record<Timeframe, Candle[]>> = {}
        const runUpMs = (tf: Timeframe): number =>
          (windowCandles[tf]?.length ?? 0) * timeframeMs(tf)
        for (const tf of TIMEFRAMES) sources[tf] = 'cache'

        let back = 1
        while (back <= SESSION_RUNUP_LOOKBACK_DAYS && runUpMs(target.timeframe) < RUNUP_TARGET_MS) {
          const day = isoAddDays(runUpEnd, -(back - 1))
          if (!isTradingDay(Date.parse(`${day}T00:00:00Z`), target.asset.id)) {
            back++
            continue
          }
          for (const tf of Object.keys(candlesByTimeframe) as Timeframe[]) {
            const data = await window.api.getCachedData({
              symbol: target.asset.id,
              timeframe: tf,
              startDate: day,
              endDate: day
            })
            if (!data.ok || data.candles.length === 0) continue
            const prev = windowCandles[tf]
            windowCandles[tf] = prev ? data.candles.concat(prev) : data.candles
          }
          back++
        }

        for (const tf of Object.keys(candlesByTimeframe) as Timeframe[]) {
          const win = windowCandles[tf]
          if (!win || win.length === 0) continue
          const runUp = runUpTail(win, timeframeMs(tf))
          if (runUp.length > 0) runUpByTimeframe[tf] = runUp
        }
      } else {
        const loaded = await loadCandlesAndRunUp(
          target.asset,
          target.timeframe,
          target.startDate,
          target.endDate
        )
        Object.assign(candlesByTimeframe, loaded.candlesByTimeframe)
        runUpByTimeframe = loaded.runUpByTimeframe
        sources = loaded.sources
      }

      const active: ActiveSession = {
        id: target.id,
        name: target.name,
        asset: target.asset,
        timeframe: target.timeframe,
        startDate: target.startDate,
        endDate: target.endDate,
        balance: target.startBalance,
        candlesByTimeframe,
        runUpByTimeframe,
        sources
      }

      activeSessionsCache.set(target.id, active)

      set({
        status: 'ready',
        session: active,
        balance: target.balance,
        startBalance: target.startBalance,
        orders: target.orders,
        currentIndex: target.currentIndex,
        playbackTimeframe: target.playbackTimeframe,
        playing: false,
        selectedDrawing: null,
        lastOrderResult: null
      })
    } catch (err) {
      set({ status: 'error', error: err instanceof Error ? err.message : String(err) })
    }
  },

  deleteSavedSession: (id: string) => {
    activeSessionsCache.delete(id)
    savedChartStates.delete(id)
    savedChartSelections.delete(id)
    const updated = get().savedSessions.filter((s) => s.id !== id)
    persistSavedSessionsToStorage(updated)
    if (get().session?.id === id) {
      set({ session: null, savedSessions: updated, playing: false })
    } else {
      set({ savedSessions: updated })
    }
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
        selectedDrawing: null
      })
    } else {
      set({ playing: false, session: null })
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
  },
  chartStateFor: (id) => savedChartStates.get(id),
  saveChartSelection: (id, drawingId) => {
    savedChartSelections.set(id, drawingId)
  },
  chartSelectionFor: (id) => savedChartSelections.get(id)
}))

// Stream main-process download progress into the store while a download runs.
// Module scope (not a React effect) so StrictMode's double-mount never
// double-subscribes; HMR re-imports are guarded by the existing handle.
let progressUnsub: (() => void) | null = null
if (!progressUnsub && typeof window !== 'undefined' && window.api) {
  progressUnsub = window.api.onDownloadProgress((event) => {
    const { status } = useSessionStore.getState()
    if (status === 'downloading') {
      useSessionStore.setState((s) => ({ progress: [...s.progress, event] }))
    }
  })
}
