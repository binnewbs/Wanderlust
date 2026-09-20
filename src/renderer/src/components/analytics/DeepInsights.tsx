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
import { Bar, BarChart, XAxis, YAxis, type YAxisTickContentProps } from 'recharts'
import { ChartContainer, ChartTooltip, type ChartConfig } from '@/components/ui/chart'

interface DeepInsightsProps {
  kpis: KpiMetrics
  dayStats: DayOfWeekStat[]
}

const chartConfig = {
  pnl: { label: 'PnL' }
} satisfies ChartConfig

interface DayTooltipRow {
  dayName: string
  pnl: number
  tradesCount: number
  winRate: number
}

function DayTooltipBody({ row }: { row: DayTooltipRow }): React.JSX.Element {
  return (
    <div className="grid gap-1.5 rounded-lg border border-border/50 bg-background px-3 py-2 text-xs shadow-xl">
      <div className="font-medium text-foreground">{row.dayName}</div>
      <div className="flex items-center justify-between gap-8">
        <span className="text-muted-foreground">PnL</span>
        <span
          className={`font-mono font-medium ${row.pnl >= 0 ? 'text-chart-2' : 'text-destructive'}`}
        >
          {formatCurrency(row.pnl)}
        </span>
      </div>
      <div className="flex items-center justify-between gap-8">
        <span className="text-muted-foreground">{row.tradesCount === 1 ? 'Trade' : 'Trades'}</span>
        <span className="font-mono font-medium text-foreground">{row.tradesCount}</span>
      </div>
      <div className="flex items-center justify-between gap-8">
        <span className="text-muted-foreground">Win Rate</span>
        <span className="font-mono font-medium text-foreground">{row.winRate.toFixed(0)}%</span>
      </div>
    </div>
  )
}

function DayPerformanceTooltip({
  active,
  payload
}: {
  active?: boolean
  payload?: ReadonlyArray<{ payload?: DayTooltipRow }>
}): React.JSX.Element | null {
  if (!active || !payload?.length) {
    return null
  }

  const row = payload[0]?.payload
  if (!row) {
    return null
  }

  return <DayTooltipBody row={row} />
}

export default function DeepInsights({ kpis, dayStats }: DeepInsightsProps): React.JSX.Element {
  const chartData = dayStats.map((stat) => ({
    dayName: stat.dayName,
    pnl: stat.pnl,
    value: stat.pnl > 0 ? stat.pnl : 0,
    tradesCount: stat.tradesCount,
    winRate: stat.winRate
  }))

  // Hovering the day name on the Y axis shows the tooltip for that day, since
  // losing days don't render a bar (value clamped to 0) and are otherwise
  // unreachable by hovering the plot area.
  const [hoveredDay, setHoveredDay] = React.useState<{
    dayName: string
    x: number
    y: number
  } | null>(null)
  const hoveredStat = hoveredDay
    ? (chartData.find((d) => d.dayName === hoveredDay.dayName) ?? null)
    : null

  return (
    <div className="flex flex-col gap-4">
      {/* Top row: Streaks, Holding Time, Best/Worst Cards */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {/* Consecutive Streaks */}
        <Card size="sm" className="bg-card/70 backdrop-blur-xs">
          <CardHeader className="flex flex-row items-center justify-between pb-1">
            <CardTitle className="text-xs font-semibold tracking-wider capitalize text-foreground">
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
            <CardTitle className="text-xs font-semibold tracking-wider capitalize text-foreground">
              Avg holding time
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
            <CardTitle className="text-xs font-semibold tracking-wider capitalize text-foreground">
              Best & worst
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
            <CardTitle className="text-xs font-semibold tracking-wider capitalize text-foreground">
              Breakeven trades
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
          <div className="relative">
            <ChartContainer config={chartConfig} className="h-[220px] w-full">
              <BarChart
                accessibilityLayer
                data={chartData}
                layout="vertical"
                margin={{ left: 0, right: 12 }}
              >
                <XAxis
                  type="number"
                  dataKey="value"
                  tickLine={false}
                  axisLine={false}
                  tickMargin={8}
                  tickFormatter={(value) => formatCurrency(Number(value))}
                />
                <YAxis
                  type="category"
                  dataKey="dayName"
                  width={84}
                  tickLine={false}
                  axisLine={false}
                  tickMargin={10}
                  tick={(props: YAxisTickContentProps) => {
                    const { x, y, payload, textAnchor } = props
                    const day = chartData.find((d) => d.dayName === String(payload.value))
                    const isLosingDay = day != null && day.pnl < 0
                    const dayName = String(payload.value)
                    const tickX = Number(x)
                    const tickY = Number(y)
                    return (
                      <g>
                        <text
                          x={x}
                          y={y}
                          dy="0.355em"
                          textAnchor={textAnchor}
                          style={{ fill: isLosingDay ? 'var(--destructive)' : props.fill }}
                        >
                          {dayName}
                        </text>
                        {/* Invisible hitbox: covers the whole label column and most of
                            the row band, so the tooltip is easy to trigger. */}
                        <rect
                          x={tickX - 90}
                          y={tickY - 22}
                          width={102}
                          height={44}
                          fill="transparent"
                          pointerEvents="all"
                          onMouseEnter={() => setHoveredDay({ dayName, x: tickX, y: tickY })}
                          onMouseLeave={() =>
                            setHoveredDay((current) =>
                              current?.dayName === dayName ? null : current
                            )
                          }
                        />
                      </g>
                    )
                  }}
                />
                <ChartTooltip cursor={false} content={<DayPerformanceTooltip />} />
                <Bar dataKey="value" fill="var(--color-chart-2)" radius={4} barSize={12} />
              </BarChart>
            </ChartContainer>
            {hoveredDay != null && hoveredStat != null && (
              <div
                className="pointer-events-none absolute z-10"
                style={{
                  left: hoveredDay.x + 12,
                  top: hoveredDay.y,
                  transform: 'translateY(-50%)'
                }}
              >
                <DayTooltipBody row={hoveredStat} />
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
