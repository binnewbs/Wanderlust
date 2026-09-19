import type { Order } from '@/store/trading'

/**
 * Phase 6 pure analytics calculations for Wanderlust.
 * All functions are deterministic and operate on the session starting balance
 * and the list of Orders.
 */

export interface KpiMetrics {
  totalTrades: number
  openTrades: number
  closedTrades: number
  winningTrades: number
  losingTrades: number
  breakevenTrades: number
  winRate: number
  lossRate: number
  breakevenRate: number
  grossProfit: number
  grossLoss: number
  netProfit: number
  profitFactor: number
  avgWin: number
  avgLoss: number
  expectancy: number
  averageRR: number
  maxDrawdownPercent: number
  maxDrawdownAmount: number
  currentDrawdownPercent: number
  currentDrawdownAmount: number
  maxConsecutiveWins: number
  maxConsecutiveLosses: number
  currentStreak: { type: 'win' | 'loss' | 'breakeven' | 'none'; count: number }
  avgHoldingTimeMs: number
  bestWin: number
  worstLoss: number
  mostGainDay: { day: string; gain: number } | null
}

export interface DayOfWeekStat {
  dayIndex: number
  dayName: string
  shortName: string
  pnl: number
  tradesCount: number
  winCount: number
  lossCount: number
  winRate: number
}

export interface EquityPoint {
  index: number
  timestamp: number
  label: string
  equity: number
  highWaterMark: number
  drawdown: number
  drawdownPercent: number
  tradePnl: number
  tradeId?: string
}

export interface CalendarDayStat {
  date: string // YYYY-MM-DD
  netPnl: number
  tradeCount: number
  wins: number
  losses: number
  breakevens: number
  winRate: number
}

const BREAKEVEN_THRESHOLD = 0.001

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const SHORT_DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/**
 * Filter and sort closed trades by exit time or closedAtIndex.
 */
export function getClosedTrades(orders: Order[]): Order[] {
  return orders
    .filter((o) => o.status === 'closed' && o.pnl !== undefined)
    .sort((a, b) => {
      const timeA = a.closedAtTime ?? (a.closedAtIndex !== undefined ? a.closedAtIndex * 60000 : 0)
      const timeB = b.closedAtTime ?? (b.closedAtIndex !== undefined ? b.closedAtIndex * 60000 : 0)
      return timeA - timeB
    })
}

/**
 * Computes all top-level KPIs from starting balance and orders.
 */
export function calculateKpiMetrics(startBalance: number, orders: Order[]): KpiMetrics {
  const closed = getClosedTrades(orders)
  const openTrades = orders.filter((o) => o.status === 'filled').length
  const totalTrades = closed.length

  if (totalTrades === 0) {
    return {
      totalTrades: 0,
      openTrades,
      closedTrades: 0,
      winningTrades: 0,
      losingTrades: 0,
      breakevenTrades: 0,
      winRate: 0,
      lossRate: 0,
      breakevenRate: 0,
      grossProfit: 0,
      grossLoss: 0,
      netProfit: 0,
      profitFactor: 0,
      avgWin: 0,
      avgLoss: 0,
      expectancy: 0,
      averageRR: 0,
      maxDrawdownPercent: 0,
      maxDrawdownAmount: 0,
      currentDrawdownPercent: 0,
      currentDrawdownAmount: 0,
      maxConsecutiveWins: 0,
      maxConsecutiveLosses: 0,
      currentStreak: { type: 'none', count: 0 },
      avgHoldingTimeMs: 0,
      bestWin: 0,
      worstLoss: 0,
      mostGainDay: null
    }
  }

  let grossProfit = 0
  let grossLoss = 0
  let netProfit = 0
  let winningTrades = 0
  let losingTrades = 0
  let breakevenTrades = 0
  let bestWin = 0
  let worstLoss = 0

  let totalHoldingTimeMs = 0
  let validHoldingCount = 0

  // Streaks
  let maxConsecutiveWins = 0
  let maxConsecutiveLosses = 0
  let curWinStreak = 0
  let curLossStreak = 0
  let lastOutcome: 'win' | 'loss' | 'breakeven' = 'breakeven'

  for (const trade of closed) {
    const pnl = trade.pnl ?? 0
    netProfit += pnl

    if (pnl > BREAKEVEN_THRESHOLD) {
      winningTrades += 1
      grossProfit += pnl
      bestWin = Math.max(bestWin, pnl)

      curWinStreak += 1
      curLossStreak = 0
      maxConsecutiveWins = Math.max(maxConsecutiveWins, curWinStreak)
      lastOutcome = 'win'
    } else if (pnl < -BREAKEVEN_THRESHOLD) {
      losingTrades += 1
      const absLoss = Math.abs(pnl)
      grossLoss += absLoss
      worstLoss = Math.min(worstLoss, pnl)

      curLossStreak += 1
      curWinStreak = 0
      maxConsecutiveLosses = Math.max(maxConsecutiveLosses, curLossStreak)
      lastOutcome = 'loss'
    } else {
      breakevenTrades += 1
      curWinStreak = 0
      curLossStreak = 0
      lastOutcome = 'breakeven'
    }

    if (trade.filledAtTime && trade.closedAtTime && trade.closedAtTime >= trade.filledAtTime) {
      totalHoldingTimeMs += trade.closedAtTime - trade.filledAtTime
      validHoldingCount += 1
    }
  }

  const winRate = (winningTrades / totalTrades) * 100
  const lossRate = (losingTrades / totalTrades) * 100
  const breakevenRate = (breakevenTrades / totalTrades) * 100

  const avgWin = winningTrades > 0 ? grossProfit / winningTrades : 0
  const avgLoss = losingTrades > 0 ? grossLoss / losingTrades : 0

  // Profit Factor: grossProfit / grossLoss. If grossLoss is 0, Infinity when grossProfit > 0, else 0
  const profitFactor =
    grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Number.POSITIVE_INFINITY : 0

  // Expectancy = (Win Rate decimal * Avg Win) - (Loss Rate decimal * Avg Loss)
  const expectancy = (winningTrades / totalTrades) * avgWin - (losingTrades / totalTrades) * avgLoss

  // Realized RR = Avg Win / Avg Loss
  const averageRR = avgLoss > 0 ? avgWin / avgLoss : avgWin > 0 ? Number.POSITIVE_INFINITY : 0

  // Drawdown tracking
  let peak = Math.max(startBalance, 1)
  let equity = startBalance
  let maxDrawdownAmount = 0
  let maxDrawdownPercent = 0

  for (const trade of closed) {
    equity += trade.pnl ?? 0
    if (equity > peak) {
      peak = equity
    }
    const ddAmount = peak - equity
    const ddPercent = peak > 0 ? (ddAmount / peak) * 100 : 0

    if (ddAmount > maxDrawdownAmount) maxDrawdownAmount = ddAmount
    if (ddPercent > maxDrawdownPercent) maxDrawdownPercent = ddPercent
  }

  const currentDrawdownAmount = Math.max(0, peak - equity)
  const currentDrawdownPercent = peak > 0 ? (currentDrawdownAmount / peak) * 100 : 0

  const avgHoldingTimeMs = validHoldingCount > 0 ? totalHoldingTimeMs / validHoldingCount : 0

  // Current streak
  let currentStreak: { type: 'win' | 'loss' | 'breakeven' | 'none'; count: number } = {
    type: 'none',
    count: 0
  }
  if (lastOutcome === 'win') {
    currentStreak = { type: 'win', count: curWinStreak }
  } else if (lastOutcome === 'loss') {
    currentStreak = { type: 'loss', count: curLossStreak }
  } else if (lastOutcome === 'breakeven') {
    currentStreak = { type: 'breakeven', count: 1 }
  }

  // Day of week analysis
  const dayStats = calculateDayOfWeekStats(orders)
  let mostGainDay: { day: string; gain: number } | null = null
  let maxGain = Number.NEGATIVE_INFINITY

  for (const stat of dayStats) {
    if (stat.tradesCount > 0 && stat.pnl > maxGain) {
      maxGain = stat.pnl
      mostGainDay = { day: stat.dayName, gain: stat.pnl }
    }
  }

  return {
    totalTrades,
    openTrades,
    closedTrades: totalTrades,
    winningTrades,
    losingTrades,
    breakevenTrades,
    winRate,
    lossRate,
    breakevenRate,
    grossProfit,
    grossLoss,
    netProfit,
    profitFactor,
    avgWin,
    avgLoss,
    expectancy,
    averageRR,
    maxDrawdownPercent,
    maxDrawdownAmount,
    currentDrawdownPercent,
    currentDrawdownAmount,
    maxConsecutiveWins,
    maxConsecutiveLosses,
    currentStreak,
    avgHoldingTimeMs,
    bestWin,
    worstLoss,
    mostGainDay
  }
}

/**
 * Builds equity curve points for Recharts including High Water Mark.
 */
export function buildEquityCurve(startBalance: number, orders: Order[]): EquityPoint[] {
  const closed = getClosedTrades(orders)
  const points: EquityPoint[] = []

  // Seed with point 0 (Initial balance)
  let equity = startBalance
  let highWaterMark = startBalance

  const initialTime = closed.length > 0 ? (closed[0].filledAtTime ?? Date.now()) : Date.now()

  points.push({
    index: 0,
    timestamp: initialTime,
    label: 'Start',
    equity,
    highWaterMark,
    drawdown: 0,
    drawdownPercent: 0,
    tradePnl: 0
  })

  for (let i = 0; i < closed.length; i++) {
    const trade = closed[i]
    const pnl = trade.pnl ?? 0
    equity += pnl
    if (equity > highWaterMark) {
      highWaterMark = equity
    }
    const drawdown = highWaterMark - equity
    const drawdownPercent = highWaterMark > 0 ? (drawdown / highWaterMark) * 100 : 0

    const t = trade.closedAtTime ?? initialTime + (i + 1) * 3600000
    const d = new Date(t)
    const label = `${d.getMonth() + 1}/${d.getDate()} #${i + 1}`

    points.push({
      index: i + 1,
      timestamp: t,
      label,
      equity,
      highWaterMark,
      drawdown,
      drawdownPercent,
      tradePnl: pnl,
      tradeId: trade.id
    })
  }

  return points
}

/**
 * Computes performance grouped by Day of the Week (Monday - Friday).
 */
export function calculateDayOfWeekStats(orders: Order[]): DayOfWeekStat[] {
  const closed = getClosedTrades(orders)

  // Map for days 1..5 (Mon..Fri) plus 0 and 6 if trades happened on weekend
  const map: Record<number, { pnl: number; count: number; wins: number; losses: number }> = {
    1: { pnl: 0, count: 0, wins: 0, losses: 0 },
    2: { pnl: 0, count: 0, wins: 0, losses: 0 },
    3: { pnl: 0, count: 0, wins: 0, losses: 0 },
    4: { pnl: 0, count: 0, wins: 0, losses: 0 },
    5: { pnl: 0, count: 0, wins: 0, losses: 0 }
  }

  for (const trade of closed) {
    const time = trade.filledAtTime ?? trade.closedAtTime
    if (!time) continue
    const date = new Date(time)
    const day = date.getDay() // 0 = Sun, 1 = Mon ... 6 = Sat

    if (!map[day]) {
      map[day] = { pnl: 0, count: 0, wins: 0, losses: 0 }
    }

    const pnl = trade.pnl ?? 0
    map[day].pnl += pnl
    map[day].count += 1
    if (pnl > BREAKEVEN_THRESHOLD) {
      map[day].wins += 1
    } else if (pnl < -BREAKEVEN_THRESHOLD) {
      map[day].losses += 1
    }
  }

  // Return standard trading days Monday to Friday
  return [1, 2, 3, 4, 5].map((dayIndex) => {
    const data = map[dayIndex]
    const winRate = data.count > 0 ? (data.wins / data.count) * 100 : 0
    return {
      dayIndex,
      dayName: DAY_NAMES[dayIndex],
      shortName: SHORT_DAY_NAMES[dayIndex],
      pnl: data.pnl,
      tradesCount: data.count,
      winCount: data.wins,
      lossCount: data.losses,
      winRate
    }
  })
}

/**
 * Aggregates closed trades by calendar date (YYYY-MM-DD).
 */
export function calculateCalendarPnl(orders: Order[]): Map<string, CalendarDayStat> {
  const closed = getClosedTrades(orders)
  const map = new Map<string, CalendarDayStat>()

  for (const trade of closed) {
    const time = trade.closedAtTime ?? trade.filledAtTime
    if (!time) continue
    const d = new Date(time)
    const yyyy = d.getFullYear()
    const mm = String(d.getMonth() + 1).padStart(2, '0')
    const dd = String(d.getDate()).padStart(2, '0')
    const key = `${yyyy}-${mm}-${dd}`

    const existing = map.get(key) ?? {
      date: key,
      netPnl: 0,
      tradeCount: 0,
      wins: 0,
      losses: 0,
      breakevens: 0,
      winRate: 0
    }

    const pnl = trade.pnl ?? 0
    existing.netPnl += pnl
    existing.tradeCount += 1
    if (pnl > BREAKEVEN_THRESHOLD) {
      existing.wins += 1
    } else if (pnl < -BREAKEVEN_THRESHOLD) {
      existing.losses += 1
    } else {
      existing.breakevens += 1
    }

    existing.winRate = existing.tradeCount > 0 ? (existing.wins / existing.tradeCount) * 100 : 0
    map.set(key, existing)
  }

  return map
}

/**
 * Format duration ms into human readable string: "2d 4h", "1h 35m", "< 1m".
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—'
  const seconds = Math.floor(ms / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)

  if (days > 0) {
    const remHours = hours % 24
    return remHours > 0 ? `${days}d ${remHours}h` : `${days}d`
  }
  if (hours > 0) {
    const remMinutes = minutes % 60
    return remMinutes > 0 ? `${hours}h ${remMinutes}m` : `${hours}h`
  }
  if (minutes > 0) {
    return `${minutes}m`
  }
  return '< 1m'
}

/**
 * Format currency with explicit sign and commas: +$1,240.50 or -$320.00.
 */
export function formatCurrency(amount: number | undefined): string {
  if (amount === undefined || !Number.isFinite(amount)) return '$0.00'
  const sign = amount > BREAKEVEN_THRESHOLD ? '+' : amount < -BREAKEVEN_THRESHOLD ? '−' : ''
  const abs = Math.abs(amount)
  return `${sign}$${abs.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`
}

/**
 * Format plain balance (unsigned): $104,250.00.
 */
export function formatPlainBalance(amount: number): string {
  return `$${amount.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`
}

/**
 * Format ratio nicely: 2.15 or ∞ or —.
 */
export function formatRatio(value: number): string {
  if (!Number.isFinite(value)) {
    return value > 0 ? '∞' : '—'
  }
  return value.toFixed(2)
}
