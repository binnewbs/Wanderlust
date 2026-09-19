import React, { useState, useMemo } from 'react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { ChevronLeft, ChevronRight, Calendar as CalendarIcon } from 'lucide-react'
import { formatCurrency, type CalendarDayStat } from '@/lib/analytics'
import type { Order } from '@/store/trading'

interface CalendarPnlProps {
  orders: Order[]
  defaultDate?: string // ISO date e.g. '2024-01-15'
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export default function CalendarPnl({ orders, defaultDate }: CalendarPnlProps): React.JSX.Element {
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

  // Map of YYYY-MM-DD -> CalendarDayStat
  const statsMap = useMemo(() => {
    const map = new Map<string, CalendarDayStat>()
    const closed = orders.filter((o) => o.status === 'closed' && o.pnl !== undefined)

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
      if (pnl > 0.001) {
        stat.wins += 1
      } else if (pnl < -0.001) {
        stat.losses += 1
      } else {
        stat.breakevens += 1
      }

      stat.winRate = stat.tradeCount > 0 ? (stat.wins / stat.tradeCount) * 100 : 0
      map.set(key, stat)
    }
    return map
  }, [orders])

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

  // Month-level totals
  const monthStats = useMemo(() => {
    let netPnl = 0
    let totalTrades = 0
    let greenDays = 0
    let redDays = 0

    for (let day = 1; day <= daysInMonth; day++) {
      const mm = String(month + 1).padStart(2, '0')
      const dd = String(day).padStart(2, '0')
      const key = `${year}-${mm}-${dd}`
      const stat = statsMap.get(key)
      if (stat && stat.tradeCount > 0) {
        netPnl += stat.netPnl
        totalTrades += stat.tradeCount
        if (stat.netPnl > 0.001) greenDays += 1
        else if (stat.netPnl < -0.001) redDays += 1
      }
    }
    return { netPnl, totalTrades, greenDays, redDays }
  }, [year, month, daysInMonth, statsMap])

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
    <Card className="bg-card/70 backdrop-blur-xs">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2 text-sm font-semibold">
              <CalendarIcon className="size-4 text-primary" />
              Calendar PnL
            </CardTitle>
            <CardDescription className="text-xs">
              Daily net performance and trade outcomes. Hover over active days for detailed stats.
            </CardDescription>
          </div>

          <div className="flex items-center gap-3">
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

      <CardContent>
        {/* Days of week header */}
        <div className="grid grid-cols-7 gap-1 text-center font-medium text-[11px] text-muted-foreground mb-1">
          {WEEKDAYS.map((day) => (
            <div key={day} className="py-1">
              {day}
            </div>
          ))}
        </div>

        {/* Days grid */}
        <div className="grid grid-cols-7 gap-1">
          {cells.map((cell) => {
            const hasTrades = cell.stat && cell.stat.tradeCount > 0
            const stat = cell.stat

            if (!cell.isCurrentMonth) {
              return (
                <div
                  key={cell.dateKey}
                  className="flex h-16 flex-col justify-between rounded-lg border border-transparent p-1.5 opacity-25"
                >
                  <span className="text-[11px] text-muted-foreground">{cell.dayNumber}</span>
                </div>
              )
            }

            if (!hasTrades || !stat) {
              return (
                <div
                  key={cell.dateKey}
                  className="flex h-16 flex-col justify-between rounded-lg border border-border/40 bg-muted/15 p-1.5 transition-colors"
                >
                  <span className="text-[11px] font-medium text-muted-foreground">
                    {cell.dayNumber}
                  </span>
                </div>
              )
            }

            const isProfitable = stat.netPnl > 0.001
            const isLoss = stat.netPnl < -0.001

            const cellStyle = isProfitable
              ? 'border-chart-2/40 bg-chart-2/10 text-chart-2 hover:bg-chart-2/20'
              : isLoss
                ? 'border-destructive/40 bg-destructive/10 text-destructive hover:bg-destructive/20'
                : 'border-border bg-muted/40 text-foreground hover:bg-muted/60'

            return (
              <HoverCard key={cell.dateKey} openDelay={100} closeDelay={150}>
                <HoverCardTrigger asChild>
                  <div
                    className={`flex h-16 cursor-pointer flex-col justify-between rounded-lg border p-1.5 transition-all shadow-xs ${cellStyle}`}
                  >
                    <div className="flex items-center justify-between text-[11px] font-medium">
                      <span>{cell.dayNumber}</span>
                      <span className="text-[10px] opacity-75">{stat.tradeCount}T</span>
                    </div>
                    <div className="font-mono text-[11px] font-bold tracking-tight">
                      {formatCurrency(stat.netPnl)}
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

                    {/* Outcome Badges */}
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
                        <Badge variant="outline" className="h-5 gap-1 px-1.5 font-mono text-[10px]">
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
      </CardContent>
    </Card>
  )
}
