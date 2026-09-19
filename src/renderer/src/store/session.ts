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
import {
  evaluateOrders,
  nextOrderId,
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

export interface ActiveSession extends NewSessionInput {
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
  skipToStart: () => void
  skipToEnd: () => void
  /** Jump to the first candle that opens at or after `timestamp` (Go To) */
  goToTimestamp: (timestamp: number) => void
  setSpeed: (speed: number) => void

  // --- simulated account + orders (Phase 5) ---
  /** Live account balance — starts at the session's starting balance and moves
   *  by realized pnl. */
  balance: number
  /** Default risk per order (% of balance), seeded into the New Order menu. */
  riskPercent: number
  /** Every order submitted this session: pending → filled → closed. */
  orders: Order[]
  /** The position drawing currently picked on the chart (feeds New Order). */
  selectedDrawing: PositionSelection | null
  /** Outcome of the last `submitOrder` call — shown under the New Order button. */
  lastOrderResult: { ok: boolean; message: string } | null
  /** Submit a New Order; it fills/evals from the CURRENT playback candle on. */
  submitOrder: (input: NewOrderInput) => void
  /** Live-drag a pending/filled order's SL or TP level (OrderLevelsOverlay).
   *  Closed orders are read-only; the write is a pure guarded map. */
  updateOrderLevel: (orderId: string, level: OrderLevel, price: number) => void
  setRiskPercent: (pct: number) => void
  /** The chart pushes the currently selected position drawing here (or null). */
  setSelectedDrawing: (selection: PositionSelection | null) => void

  startSession: (input: NewSessionInput) => Promise<void>
  dismissError: () => void
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
function indexAtOrAfter(candles: Candle[], ts: number): number {
  let lo = 0
  let hi = candles.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (candles[mid].timestamp < ts) lo = mid + 1
    else hi = mid
  }
  return lo
}

export const useSessionStore = create<SessionState>((set, get) => ({
  status: 'idle',
  session: null,
  progress: [],
  error: null,
  currentIndex: 0,
  playing: false,
  speed: 30,
  balance: 0,
  riskPercent: 1,
  orders: [],
  selectedDrawing: null,
  lastOrderResult: null,

  dismissError: () => set({ error: null, status: 'idle' }),

  // --- playback controls (Phase 4) ---
  togglePlay: () =>
    set((s) => {
      const total = sessionBaseCandles(s.session).length
      // At the end, play restarts the session from candle 0.
      if (!s.playing && s.currentIndex >= total) {
        return { playing: true, currentIndex: 0 }
      }
      return { playing: !s.playing }
    }),
  pause: () => set({ playing: false }),
  // Forward index moves evaluate open/pending orders over the candles that
  // were just revealed (Phase 5): one candle on a tick, a whole range on a
  // jump. Backward moves never touch the account.
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
      const nextIndex = Math.min(s.currentIndex + 1, total)
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
    set((s) => ({ playing: false, currentIndex: Math.max(s.currentIndex - 1, 0) })),
  skipToStart: () => set({ playing: false, currentIndex: 0 }),
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
    const order: Order = {
      id: nextOrderId(),
      drawingId: input.drawingId,
      symbol: s.session.asset.id,
      orderType: input.orderType,
      direction: input.direction,
      orderPrice: input.orderPrice,
      stopLoss: input.stopLoss,
      takeProfit: input.takeProfit,
      riskPercent: input.riskPercent,
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

  setSelectedDrawing: (selection) =>
    set((s) => {
      if (selection?.drawingId === s.selectedDrawing?.drawingId) return s
      return { selectedDrawing: selection }
    }),

  startSession: async (input) => {
    // One batch call downloads every timeframe for the range (cache-first;
    // progress is scaled across timeframes by the main process).
    const request = {
      symbol: input.asset.id,
      timeframe: input.timeframe,
      timeframes: [...TIMEFRAMES],
      startDate: input.startDate,
      endDate: input.endDate
    }
    set({
      status: 'downloading',
      progress: [],
      error: null,
      session: null,
      currentIndex: 0,
      playing: false,
      balance: input.balance,
      orders: [],
      selectedDrawing: null,
      lastOrderResult: null
    })
    try {
      const raw = await window.api.downloadData(request)
      if (!('timeframes' in raw)) {
        set({ status: 'error', error: raw.message ?? 'Download failed.' })
        return
      }
      const res = raw as DownloadBatchResult
      if (!res.ok) {
        set({ status: 'error', error: res.message ?? 'Download failed.' })
        return
      }

      // downloadData reports counts; read the actual candles back from cache.
      const candlesByTimeframe: Partial<Record<Timeframe, Candle[]>> = {}
      for (const tf of TIMEFRAMES) {
        const data = await window.api.getCachedData({
          symbol: input.asset.id,
          timeframe: tf,
          startDate: input.startDate,
          endDate: input.endDate
        })
        if (data.ok && data.candles.length > 0) candlesByTimeframe[tf] = data.candles
      }
      if (Object.values(candlesByTimeframe).every((c) => !c?.length)) {
        set({
          status: 'error',
          error:
            'Dukascopy returned no candles for that range (weekends and holidays have no data). Try a different asset or date range.'
        })
        return
      }

      const sources: Partial<Record<Timeframe, string>> = {}
      for (const tfRes of res.timeframes) {
        sources[tfRes.timeframe as Timeframe] = tfRes.source
      }

      // --- Run-up: a full 24 hours of context candles before the session ---
      // The run-up = the most recent whole trading days before `startDate`
      // whose candles add up to ≥ 24h of market time (walking days backward
      // spans weekends/holidays and sees through short trading days, e.g. an
      // index session ≈ 6-7h). Days are pulled ONE AT A TIME so we stop as
      // soon as the base timeframe reaches 24h instead of downloading the
      // whole lookback for nothing — and the budget adapts to the network
      // state: a session that just downloaded from Dukascopy gets a generous
      // window (its network is clearly working), a fully-cached session gets a
      // short one (it's usually offline/rate-limited). The run-up can never
      // abort the session: whatever lands is kept, then the session starts.
      const runUpByTimeframe: Partial<Record<Timeframe, Candle[]>> = {}
      const runUpEnd = isoAddDays(input.startDate, -1)
      const windowCandles: Partial<Record<Timeframe, Candle[]>> = {}
      const runUpMs = (tf: Timeframe): number => (windowCandles[tf]?.length ?? 0) * timeframeMs(tf)
      const usedNetwork = res.timeframes.some((tfRes) => tfRes.source !== 'cache')
      const runUpBudgetMs = usedNetwork ? RUNUP_NETWORK_BUDGET_MS : RUNUP_CACHEONLY_BUDGET_MS
      const runUpStartedAt = Date.now()
      for (let back = 1; back <= SESSION_RUNUP_LOOKBACK_DAYS; back++) {
        if (runUpMs(input.timeframe) >= RUNUP_TARGET_MS) break
        const remaining = runUpBudgetMs - (Date.now() - runUpStartedAt)
        if (remaining <= 0) break
        const day = isoAddDays(runUpEnd, -(back - 1))
        const dayFetch = window.api.downloadData({
          symbol: input.asset.id,
          timeframe: input.timeframe,
          timeframes: [...TIMEFRAMES],
          startDate: day,
          endDate: day
        })
        // Usually the `downloadData` above resolves on its own (cache days are
        // instant; a live day takes a few seconds per timeframe), but if the
        // whole budget drains mid-day we proceed without it — the fetch keeps
        // running in the main process and simply fills the cache for the next
        // session. Swallow late settles either way.
        const settled = await Promise.race([
          dayFetch.then(
            () => true,
            () => false // a run-up fetch failure must never fail the session
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
            symbol: input.asset.id,
            timeframe: tf,
            startDate: day,
            endDate: day
          })
          if (!data.ok || data.candles.length === 0) continue
          const prev = windowCandles[tf]
          // Earlier days are fetched after later ones — prepend to keep the
          // window ascending.
          windowCandles[tf] = prev ? data.candles.concat(prev) : data.candles
        }
      }

      // Trim each timeframe's window down to its most recent ≥ 24h of candles.
      for (const tf of Object.keys(candlesByTimeframe) as Timeframe[]) {
        const win = windowCandles[tf]
        if (!win || win.length === 0) continue
        const runUp = runUpTail(win, timeframeMs(tf))
        if (runUp.length > 0) runUpByTimeframe[tf] = runUp
      }

      set({
        status: 'ready',
        session: { ...input, candlesByTimeframe, runUpByTimeframe, sources }
      })
    } catch (err) {
      set({ status: 'error', error: err instanceof Error ? err.message : String(err) })
    }
  }
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
