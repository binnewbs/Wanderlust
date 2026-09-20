import React from 'react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import {
  formatCurrency,
  formatDuration,
  type DayOfWeekStat,
  type KpiMetrics
} from '@/lib/analytics'
import { Calendar, Clock, Flame, Trophy, TrendingDown, MinusCircle } from 'lucide-react'

interface DeepInsightsProps {
  kpis: KpiMetrics
  dayStats: DayOfWeekStat[]
}

export default function DeepInsights({ kpis, dayStats }: DeepInsightsProps): React.JSX.Element {
  // Find max absolute day PnL for scaling the bar width
  const maxDayAbs = Math.max(...dayStats.map((d) => Math.abs(d.pnl)), 100)

  return (
    <div className="flex flex-col gap-4">
      {/* Top row: Streaks, Holding Time, Best/Worst Cards */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {/* Consecutive Streaks */}
        <Card size="sm" className="bg-card/70 backdrop-blur-xs">
          <CardHeader className="flex flex-row items-center justify-between pb-1">
            <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Streaks
            </CardTitle>
            <Flame className="size-4 text-muted-foreground" />
          </CardHeader>
          <CardContent className="flex flex-col gap-1.5 pt-1">
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">Max Win Streak:</span>
              <span className="font-mono font-bold text-chart-2">
                {kpis.maxConsecutiveWins} trades
              </span>
            </div>
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">Max Loss Streak:</span>
              <span className="font-mono font-bold text-destructive">
                {kpis.maxConsecutiveLosses} trades
              </span>
            </div>
            <div className="mt-1 flex items-center justify-between border-t border-border/40 pt-1 text-[11px]">
              <span className="text-muted-foreground">Current Streak:</span>
              <Badge
                variant={
                  kpis.currentStreak.type === 'win'
                    ? 'secondary'
                    : kpis.currentStreak.type === 'loss'
                      ? 'destructive'
                      : 'outline'
                }
                className="h-5 px-1.5 font-mono text-[10px]"
              >
                {kpis.currentStreak.count} {kpis.currentStreak.type.toUpperCase()}
              </Badge>
            </div>
          </CardContent>
        </Card>

        {/* Holding Time */}
        <Card size="sm" className="bg-card/70 backdrop-blur-xs">
          <CardHeader className="flex flex-row items-center justify-between pb-1">
            <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Avg Holding Time
            </CardTitle>
            <Clock className="size-4 text-muted-foreground" />
          </CardHeader>
          <CardContent className="flex flex-col gap-1 pt-1">
            <div className="font-mono text-xl font-bold tracking-tight text-foreground">
              {formatDuration(kpis.avgHoldingTimeMs)}
            </div>
            <p className="text-[11px] text-muted-foreground">
              From order fill to stop loss / take profit / manual exit.
            </p>
          </CardContent>
        </Card>

        {/* Best Win & Worst Loss */}
        <Card size="sm" className="bg-card/70 backdrop-blur-xs">
          <CardHeader className="flex flex-row items-center justify-between pb-1">
            <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Best & Worst
            </CardTitle>
            <Trophy className="size-4 text-muted-foreground" />
          </CardHeader>
          <CardContent className="flex flex-col gap-1.5 pt-1">
            <div className="flex items-center justify-between text-xs">
              <span className="flex items-center gap-1 text-muted-foreground">
                <Trophy className="size-3 text-chart-2" /> Best Win:
              </span>
              <span className="font-mono font-bold text-chart-2">
                {formatCurrency(kpis.bestWin)}
              </span>
            </div>
            <div className="flex items-center justify-between text-xs">
              <span className="flex items-center gap-1 text-muted-foreground">
                <TrendingDown className="size-3 text-destructive" /> Worst Loss:
              </span>
              <span className="font-mono font-bold text-destructive">
                {formatCurrency(kpis.worstLoss)}
              </span>
            </div>
          </CardContent>
        </Card>

        {/* Breakeven Trades */}
        <Card size="sm" className="bg-card/70 backdrop-blur-xs">
          <CardHeader className="flex flex-row items-center justify-between pb-1">
            <CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Breakeven Trades
            </CardTitle>
            <MinusCircle className="size-4 text-muted-foreground" />
          </CardHeader>
          <CardContent className="flex flex-col gap-1 pt-1">
            <div className="font-mono text-xl font-bold tracking-tight text-foreground">
              {kpis.breakevenTrades}{' '}
              <span className="text-xs font-normal text-muted-foreground">
                ({kpis.breakevenRate.toFixed(1)}%)
              </span>
            </div>
            <p className="text-[11px] text-muted-foreground">
              Trades closed within spread/breakeven threshold ($0.00).
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Day of Week Performance Breakdown */}
      <Card className="bg-card/70 backdrop-blur-xs">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <Calendar className="size-4 text-primary" />
                Performance by Day of Week
              </CardTitle>
              <CardDescription className="text-xs">
                PnL and win rate aggregated by trade entry day (Monday to Friday).
              </CardDescription>
            </div>
            {kpis.mostGainDay && (
              <Badge
                variant="outline"
                className="border-chart-2/40 bg-chart-2/10 text-chart-2 font-mono text-xs"
              >
                Top Day: {kpis.mostGainDay.day} ({formatCurrency(kpis.mostGainDay.gain)})
              </Badge>
            )}
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-3">
            {dayStats.map((stat) => {
              const isProfit = stat.pnl >= 0
              const barPercent = Math.min(100, Math.max(8, (Math.abs(stat.pnl) / maxDayAbs) * 100))

              return (
                <div key={stat.dayIndex} className="flex items-center gap-4 text-xs">
                  {/* Day label */}
                  <div className="w-24 font-medium text-foreground">{stat.dayName}</div>

                  {/* Visual PnL bar */}
                  <div className="flex-1">
                    <div className="h-5 w-full rounded-md bg-muted/40 relative overflow-hidden flex items-center px-2">
                      <div
                        className={`absolute inset-y-0 left-0 rounded-md transition-all duration-300 ${
                          stat.tradesCount === 0
                            ? 'bg-transparent'
                            : isProfit
                              ? 'bg-chart-2/25 border-r-2 border-chart-2'
                              : 'bg-destructive/25 border-r-2 border-destructive'
                        }`}
                        style={{ width: stat.tradesCount === 0 ? '0%' : `${barPercent}%` }}
                      />
                      <div className="relative z-10 flex items-center justify-between w-full font-mono text-[11px]">
                        <span className="text-muted-foreground">
                          {stat.tradesCount} {stat.tradesCount === 1 ? 'trade' : 'trades'} ·{' '}
                          {stat.winRate.toFixed(0)}% WR
                        </span>
                        <span
                          className={`font-semibold ${
                            stat.tradesCount === 0
                              ? 'text-muted-foreground'
                              : isProfit
                                ? 'text-chart-2'
                                : 'text-destructive'
                          }`}
                        >
                          {stat.tradesCount === 0 ? '$0.00' : formatCurrency(stat.pnl)}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
