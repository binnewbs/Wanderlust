import type { Candle } from '@shared/ipc'

/**
 * Phase 5 trade domain: order types, position sizing, and the tick-by-tick
 * evaluation engine. Everything here is PURE (no chart, no store) so the
 * simulation stays deterministic and testable.
 *
 * Model: the user submits an ORDER (Market / Limit / Stop) from a "New Order"
 * menu — optionally seeded by a Vela Long/Short Position drawing (the tool
 * fixes SL/TP + direction). Orders stay PENDING until a revealed candle trades
 * through their price, then FILL (sizing from the then-current balance), then
 * CLOSE when a candle's high/low touches stop-loss (checked first, conservative)
 * or take-profit.
 */

export type OrderType = 'market' | 'limit' | 'stop'
export type TradeDirection = 'long' | 'short'
export type OrderStatus = 'pending' | 'filled' | 'closed'
export type ExitReason = 'take_profit' | 'stop_loss' | 'manual'
/** Horizontally draggable strip levels on pending/running orders
 *  (OrderLevelsOverlay): the red stop-loss strip and the green take-profit
 *  strip. Entry strips are display-only. */
export type OrderLevel = 'stopLoss' | 'takeProfit'

/** One simulated order in the active session (pending, filled, or closed). */
export interface Order {
  id: string
  /** The Vela position drawing this order came from, if any. */
  drawingId?: string
  symbol: string
  orderType: OrderType
  direction: TradeDirection
  /** Level price. Limit/stop orders fill when a candle trades through it;
   *  market orders ignore it and fill at the NEXT candle's open. */
  orderPrice: number
  stopLoss: number
  takeProfit: number
  /** % of the account balance risked at fill. */
  riskPercent: number
  /** Position size in units, fixed at submission from the then-current balance
   *  and the entry/SL levels (limit/stop fill exactly at `orderPrice`, market at
   *  the projected latest close). This is the ACTUAL size a pending order fills
   *  with — dragging SL/TP on a pending order must change the trade's risk/PnL,
   *  not silently re-size it. Older orders without `previewSize` fall back to a
   *  fill-time `sizeForRisk` recompute. */
  previewSize?: number
  /** Session index at submission — candles at/before it can never fill this. */
  submissionIndex: number
  status: OrderStatus
  /** Actual entry price once filled (market = bar open, limit/stop = order price). */
  fillPrice?: number
  filledAtTime?: number
  filledAtIndex?: number
  /** Position size in account units, computed at fill from risk × balance. */
  size?: number
  exitPrice?: number
  /** Realized pnl in account currency (0 = breakeven). */
  pnl?: number
  exitReason?: ExitReason
  closedAtTime?: number
  closedAtIndex?: number
}

/** What the New Order menu submits. */
export interface NewOrderInput {
  drawingId?: string
  orderType: OrderType
  direction: TradeDirection
  orderPrice: number
  stopLoss: number
  takeProfit: number
  riskPercent: number
}

/** A position drawing picked on the chart — seeds the New Order menu (SL/TP +
 *  direction come from the tool; only the entry is order-type dependent). */
export interface PositionSelection {
  drawingId: string
  direction: TradeDirection
  entryPrice: number
  stopLoss: number
  takeProfit: number
}

/** Position size in units so that a stop-out loses `riskPercent`% of `balance`. */
export function sizeForRisk(
  entryPrice: number,
  stopLoss: number,
  riskPercent: number,
  balance: number
): number {
  const risk = Math.abs(entryPrice - stopLoss)
  if (!Number.isFinite(risk) || risk <= 0) return 0
  return (balance * Math.max(0, riskPercent)) / 100 / risk
}

let orderSeq = 0
export function nextOrderId(): string {
  orderSeq += 1
  return `order-${Date.now().toString(36)}-${orderSeq}`
}

export interface EvalResult {
  orders: Order[]
  balance: number
  closed: Order[]
}

/** True while any order is FILLED — i.e. the trader is inside a position that
 *  has a live stop-loss / take-profit. Going backward is refused in this state
 *  (a dialog offers to close it first, or you can close it in the Trading
 *  panel). */
export function hasOpenPosition(orders: Order[]): boolean {
  return orders.some((order) => order.status === 'filled')
}

/** Index of the candle where the MOST RECENT stop-loss/take-profit exit
 *  happened, or `undefined` when no auto-closed trade exists yet. The playback
 *  panel uses this as the rewind boundary: going back to (or past) this index
 *  makes the positions the user took disappear, so it warns first. */
export function lastSltpCloseIndex(orders: Order[]): number | undefined {
  let last: number | undefined
  for (const order of orders) {
    if (
      order.status === 'closed' &&
      order.exitReason !== 'manual' &&
      order.closedAtIndex !== undefined &&
      (last === undefined || order.closedAtIndex > last)
    )
      last = order.closedAtIndex
  }
  return last
}

/**
 * Rewind the simulated account to `targetIndex` (a possible backward move's
 * destination). Every order is restored to its exact state at that point of
 * the playback timeline:
 *  - a pending (never-filled) order not yet submitted at the target is
 *    REMOVED — it didn't exist back then; one already on the books stays;
 *  - a trade the user took — whether still open or already closed, exit at
 *    stop-loss, take-profit, or manual — whose entry or exit lands at/after
 *    the target is REMOVED ENTIRELY: no ghost pending order is left behind,
 *    going backward past a position never re-enters it, never refills it on
 *    forward replay — the positions they took are simply gone;
 *  - a trade already closed before the target keeps its realized PnL.
 * Balance is recomputed as `startBalance` plus the PnL of every trade closed
 * before the target, so realized PnL from positions taken later in the
 * timeline "disappears" — the account is exactly what it was back then.
 * Pure and deterministic: the recorded `submissionIndex` / `filledAtIndex` /
 * `closedAtIndex` stamps make this exact without re-running the whole
 * evaluation.
 */
export function restoreOrdersAt(
  orders: Order[],
  startBalance: number,
  targetIndex: number
): { orders: Order[]; balance: number } {
  let balance = startBalance
  const next: Order[] = []
  for (const order of orders) {
    const filledAtIndex = order.filledAtIndex ?? Number.POSITIVE_INFINITY
    const closedAtIndex = order.closedAtIndex ?? Number.POSITIVE_INFINITY

    // Never taken yet at the target — the user hadn't submitted it (or the
    // taken position is being unwound): drop it instead of leaving a pending
    // ghost order behind.
    if (order.status === 'pending') {
      if (targetIndex >= order.submissionIndex) next.push(order)
      continue
    }
    if (filledAtIndex >= targetIndex || closedAtIndex >= targetIndex) continue

    // An open position whose entry predates the target: it was through the
    // entry before the rewind point, so it stays open. (The playback panel
    // never rewinds INTO an open position — gate + dialog — but the pure
    // function stays exact for any caller.)
    if (order.status === 'filled') {
      next.push(order)
      continue
    }

    // Already realized before `targetIndex` — its PnL stays in the account.
    if (order.pnl !== undefined) balance += order.pnl
    next.push(order)
  }
  return { orders: next, balance }
}

/**
 * Evaluate every unconsumed order against the candles newly revealed between
 * `fromIndex` (EXCLUSIVE) and `toIndex` (inclusive) of the session's base
 * timeframe. Runs inside the playback store actions (advance / step / jump),
 * so one candle at a time on a playing session, or a whole range on a jump.
 *
 * Per candle, per order:
 *  - pending orders try to FILL first: market fills at the candle's open (the
 *    candle right after submission); a buy-limit on `low ≤ price` / sell-limit
 *    on `high ≥ price`; a buy-stop on `high ≥ price` / sell-stop on
 *    `low ≤ price`. Sizing is decided at SUBMISSION (`previewSize`, from the
 *    then-current balance and entry/SL); the fill reuses that size so a dragged
 *    SL/TP on a pending order changes the filled trade's risk instead of being
 *    re-sized away. Orders without a captured size (legacy saves) are sized at
 *    fill from the then-current balance.
 *  - filled trades then evaluate STOP-LOSS BEFORE TAKE-PROFIT on the same
 *    candle (conservative, per plan.md). Long: `low ≤ SL` stops, else
 *    `high ≥ TP` profits. Short mirrored.
 *
 * Pure: status changes produce NEW order objects; when nothing changes the
 * input array is returned unchanged, so subscriber render loops are spared.
 */
export function evaluateOrders(
  orders: Order[],
  balance: number,
  candles: Candle[],
  fromIndex: number,
  toIndex: number
): EvalResult {
  if (candles.length === 0 || toIndex <= fromIndex) return { orders, balance, closed: [] }
  if (!orders.some((o) => o.status !== 'closed')) return { orders, balance, closed: [] }

  const next = orders.slice()
  const pos = new Map(next.map((o, j) => [o.id, j]))
  let bal = balance
  const closed: Order[] = []
  const start = Math.max(fromIndex + 1, 1)
  const end = Math.min(toIndex, candles.length)

  for (let i = start; i <= end; i++) {
    const candle = candles[i - 1]
    if (!candle) continue
    const idx = i - 1

    // 1) Fills for pending orders on this candle.
    for (const order of next) {
      if (order.status !== 'pending') continue
      // An order submitted while currentIndex === s must not react to candles
      // already revealed (idx < s); the candle right after submission — idx s —
      // is the first one it can fill on ("next candle's open").
      if (idx < order.submissionIndex) continue
      let fillPrice: number | undefined
      if (order.orderType === 'market') {
        fillPrice = candle.open
      } else if (order.orderType === 'limit') {
        const touched =
          order.direction === 'long'
            ? candle.low <= order.orderPrice
            : candle.high >= order.orderPrice
        if (touched) fillPrice = order.orderPrice
      } else {
        const touched =
          order.direction === 'long'
            ? candle.high >= order.orderPrice
            : candle.low <= order.orderPrice
        if (touched) fillPrice = order.orderPrice
      }
      if (fillPrice === undefined) continue
      const filled: Order = {
        ...order,
        status: 'filled',
        fillPrice,
        filledAtTime: candle.timestamp,
        filledAtIndex: idx,
        // Size is fixed at submission (`previewSize`): dragging the SL/TP on a
        // pending order must change the filled trade's risk/PnL, not be re-sized
        // back to the initial risk per trade. Only fall back to a fill-time
        // risk-size for orders that predate `previewSize` (legacy saves).
        size: order.previewSize ?? sizeForRisk(fillPrice, order.stopLoss, order.riskPercent, bal)
      }
      next[pos.get(order.id)!] = filled
    }

    // 2) Stop-loss / take-profit for filled trades (stop first).
    for (const order of next) {
      if (order.status !== 'filled' || order.fillPrice === undefined) continue
      const long = order.direction === 'long'
      let exitPrice: number | undefined
      let exitReason: ExitReason | undefined
      if (long) {
        if (candle.low <= order.stopLoss) {
          exitPrice = order.stopLoss
          exitReason = 'stop_loss'
        } else if (candle.high >= order.takeProfit) {
          exitPrice = order.takeProfit
          exitReason = 'take_profit'
        }
      } else {
        if (candle.high >= order.stopLoss) {
          exitPrice = order.stopLoss
          exitReason = 'stop_loss'
        } else if (candle.low <= order.takeProfit) {
          exitPrice = order.takeProfit
          exitReason = 'take_profit'
        }
      }
      if (exitPrice === undefined || exitReason === undefined) continue
      const pnl = (exitPrice - order.fillPrice) * (order.size ?? 0) * (long ? 1 : -1)
      const done: Order = {
        ...order,
        status: 'closed',
        exitPrice,
        pnl,
        exitReason,
        closedAtTime: candle.timestamp,
        closedAtIndex: idx
      }
      next[pos.get(order.id)!] = done
      closed.push(done)
      bal += pnl
    }
  }
  return { orders: next, balance: bal, closed }
}

/**
 * Validates order price relative to current market price based on order type rules:
 * - Buy Limit: Order Price < Current Price (Buying at a lower/better price)
 * - Sell Limit: Order Price > Current Price (Selling at a higher/better price)
 * - Buy Stop: Order Price > Current Price (Buying a breakout above current price)
 * - Sell Stop: Order Price < Current Price (Selling a breakdown below current price)
 */
export function validateOrderTypePrice(
  orderType: OrderType,
  direction: TradeDirection,
  orderPrice: number,
  currentPrice: number
): { valid: boolean; message?: string } {
  if (orderType === 'market') return { valid: true }

  if (direction === 'long' && orderType === 'limit') {
    if (orderPrice >= currentPrice) {
      return {
        valid: false,
        message: `Buy Limit: Order price (${orderPrice}) must be less than current price (${currentPrice}).`
      }
    }
  } else if (direction === 'short' && orderType === 'limit') {
    if (orderPrice <= currentPrice) {
      return {
        valid: false,
        message: `Sell Limit: Order price (${orderPrice}) must be greater than current price (${currentPrice}).`
      }
    }
  } else if (direction === 'long' && orderType === 'stop') {
    if (orderPrice <= currentPrice) {
      return {
        valid: false,
        message: `Buy Stop: Order price (${orderPrice}) must be greater than current price (${currentPrice}).`
      }
    }
  } else if (direction === 'short' && orderType === 'stop') {
    if (orderPrice >= currentPrice) {
      return {
        valid: false,
        message: `Sell Stop: Order price (${orderPrice}) must be less than current price (${currentPrice}).`
      }
    }
  }

  return { valid: true }
}

/**
 * Returns a user-facing rule description / hint for the selected order type and direction.
 */
export function getOrderTypeRuleHint(
  orderType: OrderType,
  direction: TradeDirection,
  currentPrice?: number
): string {
  if (orderType === 'market') return 'Fills on the next candle open'
  const cur =
    currentPrice !== undefined && Number.isFinite(currentPrice) ? ` (Current: ${currentPrice})` : ''
  if (direction === 'long' && orderType === 'limit') {
    return `Buy Limit: Order Price < Current Price${cur}`
  }
  if (direction === 'short' && orderType === 'limit') {
    return `Sell Limit: Order Price > Current Price${cur}`
  }
  if (direction === 'long' && orderType === 'stop') {
    return `Buy Stop: Order Price > Current Price${cur}`
  }
  if (direction === 'short' && orderType === 'stop') {
    return `Sell Stop: Order Price < Current Price${cur}`
  }
  return ''
}
