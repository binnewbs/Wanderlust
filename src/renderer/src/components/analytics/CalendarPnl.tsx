import React, { useState, useMemo } from 'react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { ChevronLeft, ChevronRight, Calendar as CalendarIcon } from 'lucide-react'
import {
  breakevenThreshold,
  closeBalancesById,
  formatCurrency,
  getClosedTrades,
  type CalendarDayStat
} from '@/lib/analytics'
import type { Order } from '@/store/trading'

interface CalendarPnlProps {
  orders: Order[]
  defaultDate?: string // ISO date e.g. '2024-01-15'
  /** Seed for the balance-at-close reconstruction that sizes each trade's
   *  breakeven band (±0.05% of the balance at that trade's close). */
  startBalance: number
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export default function CalendarPnl({
  orders,
  defaultDate,
  startBalance
}: CalendarPnlProps): React.JSX.Element {
  // Determine initial month from defaultDate or first closed trade or today
  const initialDate = useMemo(() => {
    if (defaultDate) {
      const d = new Date(defaultDate)
      if (!isNaN(d.getTime())) return d
    }
    const closed = orders.filter((o) => o.status === 'closed' && (o.closedAtTime || o.filledAtTime))
    if (closed.length > 0) {
      const t = closed[0].closedAtTime ?? closed[0].filledAtTime!
      return new Date(t)
    }
    return new Date()
  }, [defaultDate, orders])

  const [currentMonth, setCurrentMonth] = useState<Date>(
    new Date(initialDate.getFullYear(), initialDate.getMonth(), 1)
  )
  const [selectedDate, setSelectedDate] = useState<string | null>(null)

  // Map of YYYY-MM-DD -> CalendarDayStat, plus the account balance at the END
  // of each trading day (the last close's post-PnL balance) — the reference the
  // day itself is graded against as green/red/breakeven.
  const { map: statsMap, dayEndBalance } = useMemo(() => {
    const map = new Map<string, CalendarDayStat>()
    const dayEndBalance = new Map<string, number>()
    const balances = closeBalancesById(startBalance, orders)
    // Chronological exit order — repeated assignment below leaves the LAST
    // close's balance in dayEndBalance.
    const closed = getClosedTrades(orders)

    for (const trade of closed) {
      const time = trade.closedAtTime ?? trade.filledAtTime
      if (!time) continue
      const d = new Date(time)
      const yyyy = d.getFullYear()
      const mm = String(d.getMonth() + 1).padStart(2, '0')
      const dd = String(d.getDate()).padStart(2, '0')
      const key = `${yyyy}-${mm}-${dd}`

      const stat = map.get(key) ?? {
        date: key,
        netPnl: 0,
        tradeCount: 0,
        wins: 0,
        losses: 0,
        breakevens: 0,
        winRate: 0
      }

      const pnl = trade.pnl ?? 0
      stat.netPnl += pnl
      stat.tradeCount += 1
      // Per-trade outcome: ±0.05% of the balance at THIS trade's close.
      const band = breakevenThreshold(balances.get(trade.id) ?? startBalance)
      if (pnl > band) {
        stat.wins += 1
      } else if (pnl < -band) {
        stat.losses += 1
      } else {
        stat.breakevens += 1
      }

      stat.winRate = stat.tradeCount > 0 ? (stat.wins / stat.tradeCount) * 100 : 0
      map.set(key, stat)
      dayEndBalance.set(key, (balances.get(trade.id) ?? startBalance) + pnl)
    }
    return { map, dayEndBalance }
  }, [orders, startBalance])

  const year = currentMonth.getFullYear()
  const month = currentMonth.getMonth()

  // First day of current month and days count
  const firstDayIndex = new Date(year, month, 1).getDay()
  const daysInMonth = new Date(year, month + 1, 0).getDate()

  // Previous month fill
  const prevMonthDays = new Date(year, month, 0).getDate()

  // Navigation handlers
  const handlePrevMonth = (): void => {
    setCurrentMonth(new Date(year, month - 1, 1))
  }

  const handleNextMonth = (): void => {
    setCurrentMonth(new Date(year, month + 1, 1))
  }

  const selectedDayOrders = useMemo(() => {
    if (!selectedDate) return []
    return orders.filter((o) => {
      if (o.status !== 'closed' || (!o.closedAtTime && !o.filledAtTime)) return false
      const t = o.closedAtTime ?? o.filledAtTime!
      const d = new Date(t)
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
        d.getDate()
      ).padStart(2, '0')}`
      return key === selectedDate
    })
  }, [orders, selectedDate])

  const selectedDayStat = selectedDate ? statsMap.get(selectedDate) : null

  // Month-level totals
  const monthStats = useMemo(() => {
    let netPnl = 0
    let totalTrades = 0
    let greenDays = 0
    let redDays = 0
    let breakevenDays = 0
    let bestDay: { date: string; pnl: number } | null = null
    let worstDay: { date: string; pnl: number } | null = null

    for (let day = 1; day <= daysInMonth; day++) {
      const mm = String(month + 1).padStart(2, '0')
      const dd = String(day).padStart(2, '0')
      const key = `${year}-${mm}-${dd}`
      const stat = statsMap.get(key)
      if (stat && stat.tradeCount > 0) {
        netPnl += stat.netPnl
        totalTrades += stat.tradeCount
        // The day is green/red/breakeven against ±0.05% of the balance it ends with.
        const dayBand = breakevenThreshold(dayEndBalance.get(key) ?? startBalance)
        if (stat.netPnl > dayBand) {
          greenDays += 1
        } else if (stat.netPnl < -dayBand) {
          redDays += 1
        } else {
          breakevenDays += 1
        }

        if (!bestDay || stat.netPnl > bestDay.pnl) {
          bestDay = { date: key, pnl: stat.netPnl }
        }
        if (!worstDay || stat.netPnl < worstDay.pnl) {
          worstDay = { date: key, pnl: stat.netPnl }
        }
      }
    }
    const winRate = greenDays + redDays > 0 ? (greenDays / (greenDays + redDays)) * 100 : 0
    return { netPnl, totalTrades, greenDays, redDays, breakevenDays, winRate, bestDay, worstDay }
  }, [year, month, daysInMonth, statsMap, dayEndBalance, startBalance])

  const monthName = currentMonth.toLocaleString('en-US', { month: 'long', year: 'numeric' })

  // Grid items: leading days + current days + trailing days to fill full grid
  const cells: Array<{
    dayNumber: number
    isCurrentMonth: boolean
    dateKey: string
    stat?: CalendarDayStat
  }> = []

  // Leading days from previous month
  for (let i = firstDayIndex - 1; i >= 0; i--) {
    const dayNumber = prevMonthDays - i
    const prevMonth = month === 0 ? 11 : month - 1
    const prevYear = month === 0 ? year - 1 : year
    const mm = String(prevMonth + 1).padStart(2, '0')
    const dd = String(dayNumber).padStart(2, '0')
    const key = `${prevYear}-${mm}-${dd}`
    cells.push({
      dayNumber,
      isCurrentMonth: false,
      dateKey: key,
      stat: statsMap.get(key)
    })
  }

  // Current month days
  for (let day = 1; day <= daysInMonth; day++) {
    const mm = String(month + 1).padStart(2, '0')
    const dd = String(day).padStart(2, '0')
    const key = `${year}-${mm}-${dd}`
    cells.push({
      dayNumber: day,
      isCurrentMonth: true,
      dateKey: key,
      stat: statsMap.get(key)
    })
  }

  // Trailing days from next month to complete row of 7
  const remainder = cells.length % 7
  if (remainder > 0) {
    const nextDaysNeeded = 7 - remainder
    const nextMonth = month === 11 ? 0 : month + 1
    const nextYear = month === 11 ? year + 1 : year
    for (let day = 1; day <= nextDaysNeeded; day++) {
      const mm = String(nextMonth + 1).padStart(2, '0')
      const dd = String(day).padStart(2, '0')
      const key = `${nextYear}-${mm}-${dd}`
      cells.push({
        dayNumber: day,
        isCurrentMonth: false,
        dateKey: key,
        stat: statsMap.get(key)
      })
    }
  }

  return (
    <Card className="w-full bg-card/70 backdrop-blur-xs">
      <CardHeader className="border-b border-border/50 pb-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <CardTitle className="flex items-center gap-2 text-base font-semibold">
              <CalendarIcon className="size-4 text-primary" />
              Calendar PnL
            </CardTitle>
            <CardDescription className="text-xs">
              Daily net performance and trade outcomes. Click any day to inspect executed orders.
            </CardDescription>
          </div>

          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2 font-mono text-xs">
              <span className="text-muted-foreground">Month Net:</span>
              <span
                className={`font-semibold ${
                  monthStats.netPnl >= 0 ? 'text-chart-2' : 'text-destructive'
                }`}
              >
                {formatCurrency(monthStats.netPnl)}
              </span>
              <span className="text-muted-foreground">
                ({monthStats.greenDays}G / {monthStats.redDays}R)
              </span>
            </div>

            <div className="flex items-center gap-1">
              <Button
                variant="outline"
                size="icon-xs"
                onClick={handlePrevMonth}
                aria-label="Previous month"
              >
                <ChevronLeft className="size-3.5" />
              </Button>
              <span className="w-32 text-center text-xs font-semibold">{monthName}</span>
              <Button
                variant="outline"
                size="icon-xs"
                onClick={handleNextMonth}
                aria-label="Next month"
              >
                <ChevronRight className="size-3.5" />
              </Button>
            </div>
          </div>
        </div>
      </CardHeader>

      <CardContent className="p-4 sm:p-6">
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-12">
          {/* Calendar Grid: spans 8 columns on large screens to keep square days at optimal size */}
          <div className="xl:col-span-8">
            {/* Days of week header */}
            <div className="mb-2 grid grid-cols-7 gap-1.5 text-center text-xs font-medium text-muted-foreground sm:gap-2">
              {WEEKDAYS.map((day) => (
                <div key={day} className="py-1">
                  {day}
                </div>
              ))}
            </div>

            {/* Days grid */}
            <div className="grid grid-cols-7 gap-1.5 sm:gap-2">
              {cells.map((cell) => {
                const hasTrades = cell.stat && cell.stat.tradeCount > 0
                const stat = cell.stat
                const isSelected = selectedDate === cell.dateKey

                if (!cell.isCurrentMonth) {
                  return (
                    <div
                      key={cell.dateKey}
                      className="flex aspect-square flex-col justify-between rounded-lg border border-transparent p-2 opacity-25"
                    >
                      <span className="text-xs text-muted-foreground">{cell.dayNumber}</span>
                    </div>
                  )
                }

                if (!hasTrades || !stat) {
                  return (
                    <div
                      key={cell.dateKey}
                      onClick={() => setSelectedDate(isSelected ? null : cell.dateKey)}
                      className={`flex aspect-square cursor-pointer flex-col justify-between rounded-lg border p-2 transition-colors ${
                        isSelected
                          ? 'border-primary bg-muted/20 ring-2 ring-primary/40'
                          : 'border-border/40 bg-muted/15 hover:bg-muted/25'
                      }`}
                    >
                      <span className="text-xs font-medium text-muted-foreground">
                        {cell.dayNumber}
                      </span>
                    </div>
                  )
                }

                // A day inside ±0.05% of the balance it ends with is a
                // breakeven day (neutral cell), not a green/red one.
                const dayBand = breakevenThreshold(dayEndBalance.get(cell.dateKey) ?? startBalance)
                const isProfitable = stat.netPnl > dayBand
                const isLoss = stat.netPnl < -dayBand

                const cellStyle = isProfitable
                  ? 'border-chart-2/40 bg-chart-2/10 text-chart-2 hover:bg-chart-2/20'
                  : isLoss
                    ? 'border-destructive/40 bg-destructive/10 text-destructive hover:bg-destructive/20'
                    : 'border-border bg-muted/40 text-foreground hover:bg-muted/60'

                const selectedRing = isSelected
                  ? 'ring-2 ring-primary ring-offset-1 ring-offset-background'
                  : ''

                return (
                  <HoverCard key={cell.dateKey} openDelay={100} closeDelay={150}>
                    <HoverCardTrigger asChild>
                      <div
                        onClick={() => setSelectedDate(isSelected ? null : cell.dateKey)}
                        className={`flex aspect-square cursor-pointer flex-col justify-between rounded-lg border p-2 shadow-xs transition-all ${cellStyle} ${selectedRing}`}
                      >
                        <div className="flex items-center justify-between text-xs font-medium">
                          <span className="font-semibold">{cell.dayNumber}</span>
                          <span className="rounded-sm bg-background/50 px-1 py-0.5 font-mono text-[10px] font-semibold">
                            {stat.tradeCount}T
                          </span>
                        </div>

                        <div className="my-auto flex flex-col items-center justify-center text-center">
                          <div className="font-mono text-xs font-bold tracking-tight sm:text-sm">
                            {formatCurrency(stat.netPnl)}
                          </div>
                          <div className="mt-0.5 hidden text-[10px] opacity-75 sm:block">
                            {stat.wins}W · {stat.losses}L
                          </div>
                        </div>

                        <div className="flex items-center justify-between text-[10px] opacity-60">
                          <span>{stat.tradeCount} orders</span>
                          <span className="font-semibold uppercase">
                            {stat.netPnl > dayBand ? 'win' : stat.netPnl < -dayBand ? 'loss' : 'be'}
                          </span>
                        </div>
                      </div>
                    </HoverCardTrigger>
                    <HoverCardContent side="top" className="w-56 p-3 text-xs">
                      <div className="flex flex-col gap-2">
                        <div className="flex items-center justify-between border-b border-border/50 pb-1.5">
                          <span className="font-semibold text-foreground">{cell.dateKey}</span>
                          <span className="font-mono text-muted-foreground">
                            {stat.tradeCount} {stat.tradeCount === 1 ? 'trade' : 'trades'}
                          </span>
                        </div>

                        <div className="flex items-center justify-between text-xs">
                          <span className="text-muted-foreground">Daily Net PnL:</span>
                          <span
                            className={`font-mono font-bold ${
                              isProfitable
                                ? 'text-chart-2'
                                : isLoss
                                  ? 'text-destructive'
                                  : 'text-foreground'
                            }`}
                          >
                            {formatCurrency(stat.netPnl)}
                          </span>
                        </div>

                        <div className="flex items-center justify-between text-xs">
                          <span className="text-muted-foreground">Win Rate:</span>
                          <span className="font-mono font-medium">{stat.winRate.toFixed(1)}%</span>
                        </div>

                        <div className="flex items-center gap-1.5 border-t border-border/40 pt-1.5">
                          {stat.wins > 0 && (
                            <Badge
                              variant="secondary"
                              className="h-5 gap-1 px-1.5 font-mono text-[10px]"
                            >
                              WIN: {stat.wins}
                            </Badge>
                          )}
                          {stat.losses > 0 && (
                            <Badge
                              variant="destructive"
                              className="h-5 gap-1 px-1.5 font-mono text-[10px]"
                            >
                              LOSS: {stat.losses}
                            </Badge>
                          )}
                          {stat.breakevens > 0 && (
                            <Badge
                              variant="outline"
                              className="h-5 gap-1 px-1.5 font-mono text-[10px]"
                            >
                              BE: {stat.breakevens}
                            </Badge>
                          )}
                        </div>
                      </div>
                    </HoverCardContent>
                  </HoverCard>
                )
              })}
            </div>
          </div>

          {/* Right Inspector Column: Fills the remaining width across the card */}
          <div className="flex flex-col gap-4 rounded-xl border border-border/60 bg-muted/20 p-4 text-xs xl:col-span-4">
            {selectedDate && selectedDayStat ? (
              <>
                <div className="flex items-center justify-between border-b border-border/50 pb-3">
                  <div>
                    <h3 className="text-sm font-semibold text-foreground">Day Inspector</h3>
                    <p className="text-[11px] text-muted-foreground">{selectedDate}</p>
                  </div>
                  <Badge
                    variant={
                      selectedDayStat.netPnl >=
                      -breakevenThreshold(dayEndBalance.get(selectedDate) ?? startBalance)
                        ? 'secondary'
                        : 'destructive'
                    }
                    className="font-mono text-xs font-bold"
                  >
                    {formatCurrency(selectedDayStat.netPnl)}
                  </Badge>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div className="rounded-lg border border-border/50 bg-background/50 p-2.5">
                    <span className="text-[10px] uppercase text-muted-foreground">Trades</span>
                    <div className="font-mono text-sm font-bold text-foreground">
                      {selectedDayStat.tradeCount}
                    </div>
                  </div>
                  <div className="rounded-lg border border-border/50 bg-background/50 p-2.5">
                    <span className="text-[10px] uppercase text-muted-foreground">Win Rate</span>
                    <div className="font-mono text-sm font-bold text-foreground">
                      {selectedDayStat.winRate.toFixed(0)}%
                    </div>
                  </div>
                </div>

                <div className="flex-1">
                  <span className="text-[11px] font-semibold text-muted-foreground">
                    Orders Executed ({selectedDayOrders.length})
                  </span>
                  <div className="mt-2 flex max-h-[360px] flex-col gap-2 overflow-y-auto pr-1">
                    {selectedDayOrders.map((order) => (
                      <div
                        key={order.id}
                        className="flex items-center justify-between rounded-lg border border-border/40 bg-card p-2.5"
                      >
                        <div className="flex flex-col gap-0.5">
                          <div className="flex items-center gap-1.5">
                            <Badge
                              variant={order.direction === 'long' ? 'secondary' : 'destructive'}
                              className="px-1 py-0 text-[9px] font-bold uppercase"
                            >
                              {order.direction}
                            </Badge>
                            <span className="font-medium text-foreground">{order.symbol}</span>
                            {order.size !== undefined && (
                              <span className="font-mono text-[10px] text-muted-foreground">
                                {order.size.toFixed(2)} units
                              </span>
                            )}
                          </div>
                          <span className="font-mono text-[10px] text-muted-foreground">
                            {order.fillPrice ?? order.orderPrice} →{' '}
                            {order.exitPrice ?? order.takeProfit}
                          </span>
                        </div>
                        <span
                          className={`font-mono text-xs font-bold ${
                            (order.pnl ?? 0) >= 0 ? 'text-chart-2' : 'text-destructive'
                          }`}
                        >
                          {formatCurrency(order.pnl ?? 0)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            ) : (
              <>
                <div className="border-b border-border/50 pb-3">
                  <h3 className="text-sm font-semibold text-foreground">Month Overview</h3>
                  <p className="text-[11px] text-muted-foreground">{monthName}</p>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div className="rounded-lg border border-border/50 bg-background/50 p-2.5">
                    <span className="text-[10px] uppercase text-muted-foreground">
                      Total Trades
                    </span>
                    <div className="font-mono text-sm font-bold text-foreground">
                      {monthStats.totalTrades}
                    </div>
                  </div>
                  <div className="rounded-lg border border-border/50 bg-background/50 p-2.5">
                    <span className="text-[10px] uppercase text-muted-foreground">
                      Day Win Rate
                    </span>
                    <div className="font-mono text-sm font-bold text-foreground">
                      {monthStats.winRate.toFixed(0)}%
                    </div>
                  </div>
                </div>

                <div className="flex flex-col gap-2 rounded-lg border border-border/40 bg-background/40 p-3">
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="text-muted-foreground">Best Trading Day</span>
                    <span className="font-mono font-bold text-chart-2">
                      {monthStats.bestDay ? formatCurrency(monthStats.bestDay.pnl) : '$0.00'}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="text-muted-foreground">Worst Trading Day</span>
                    <span className="font-mono font-bold text-destructive">
                      {monthStats.worstDay ? formatCurrency(monthStats.worstDay.pnl) : '$0.00'}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="text-muted-foreground">Trading Days</span>
                    <span className="font-mono text-muted-foreground">
                      {monthStats.greenDays} Green · {monthStats.redDays} Red ·{' '}
                      {monthStats.breakevenDays} BE
                    </span>
                  </div>
                </div>

                <div className="rounded-lg border border-dashed border-border/60 p-4 text-center text-muted-foreground">
                  <p className="text-xs">
                    Click any day in the calendar to inspect specific orders and outcomes.
                  </p>
                </div>
              </>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
