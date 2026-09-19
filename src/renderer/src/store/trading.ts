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
  /** Estimated units at submission, used solely for pending-order PnL previews.
   * Actual `size` is still calculated from balance when the order fills. */
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
 *    `low ≤ price`. Sizing happens at fill from the then-current balance.
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
        size: sizeForRisk(fillPrice, order.stopLoss, order.riskPercent, bal)
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
