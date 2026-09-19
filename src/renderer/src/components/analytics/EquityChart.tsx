import React from 'react'
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid
} from 'recharts'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { formatCurrency, formatPlainBalance, type EquityPoint } from '@/lib/analytics'

interface EquityChartProps {
  data: EquityPoint[]
  startBalance: number
}

interface CustomTooltipProps {
  active?: boolean
  payload?: Array<{
    value: number
    dataKey: string
    payload: EquityPoint
  }>
}

function CustomTooltip({ active, payload }: CustomTooltipProps): React.JSX.Element | null {
  if (!active || !payload || payload.length === 0) return null
  const point = payload[0].payload

  return (
    <div className="rounded-lg border border-border bg-popover/95 p-2.5 text-xs text-popover-foreground shadow-xl backdrop-blur-md">
      <div className="mb-1.5 flex items-center justify-between gap-4 border-b border-border/50 pb-1 font-medium">
        <span>{point.label}</span>
        <span className="font-mono text-muted-foreground">Trade #{point.index}</span>
      </div>
      <div className="flex flex-col gap-1 font-mono text-[11px]">
        <div className="flex items-center justify-between gap-4">
          <span className="text-muted-foreground">Equity:</span>
          <span className="font-semibold text-foreground">{formatPlainBalance(point.equity)}</span>
        </div>
        <div className="flex items-center justify-between gap-4">
          <span className="text-muted-foreground">Peak HWM:</span>
          <span>{formatPlainBalance(point.highWaterMark)}</span>
        </div>
        {point.drawdown > 0 && (
          <div className="flex items-center justify-between gap-4 text-destructive">
            <span>Drawdown:</span>
            <span>
              -{point.drawdownPercent.toFixed(1)}% ({formatCurrency(-point.drawdown)})
            </span>
          </div>
        )}
        {point.index > 0 && (
          <div className="flex items-center justify-between gap-4 border-t border-border/40 pt-1">
            <span className="text-muted-foreground">Trade PnL:</span>
            <span
              className={
                point.tradePnl > 0
                  ? 'text-chart-2 font-semibold'
                  : point.tradePnl < 0
                    ? 'text-destructive font-semibold'
                    : 'text-foreground'
              }
            >
              {formatCurrency(point.tradePnl)}
            </span>
          </div>
        )}
      </div>
    </div>
  )
}

export default function EquityChart({ data, startBalance }: EquityChartProps): React.JSX.Element {
  if (data.length <= 1) {
    return (
      <Card className="h-72 items-center justify-center p-6 text-center text-muted-foreground">
        <p className="text-sm">No closed trades yet to plot equity curve.</p>
        <p className="mt-1 text-xs">Execute and close trades during playback to see performance.</p>
      </Card>
    )
  }

  // Calculate domain min & max with padding
  const equities = data.map((d) => d.equity)
  const hwms = data.map((d) => d.highWaterMark)
  const allValues = [...equities, ...hwms, startBalance]
  const minVal = Math.min(...allValues)
  const maxVal = Math.max(...allValues)
  const range = maxVal - minVal || 100
  const yDomain = [Math.floor(minVal - range * 0.05), Math.ceil(maxVal + range * 0.05)]

  return (
    <Card className="bg-card/70 backdrop-blur-xs">
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <div>
          <CardTitle className="text-sm font-semibold">Equity Curve & High Water Mark</CardTitle>
          <CardDescription className="text-xs">
            Account balance progression over closed trades. Faint dashed line tracks peak equity.
          </CardDescription>
        </div>
        <div className="flex items-center gap-4 text-[11px] text-muted-foreground">
          <div className="flex items-center gap-1.5">
            <span className="inline-block size-2.5 rounded-full bg-primary" />
            <span>Equity</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="inline-block h-0.5 w-3 border-b-2 border-dashed border-chart-5" />
            <span>High Water Mark</span>
          </div>
        </div>
      </CardHeader>
      <CardContent className="h-72 w-full pt-2">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 10, right: 15, left: 10, bottom: 0 }}>
            <defs>
              <linearGradient id="equityGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="var(--color-primary)" stopOpacity={0.35} />
                <stop offset="95%" stopColor="var(--color-primary)" stopOpacity={0.0} />
              </linearGradient>
            </defs>
            <CartesianGrid
              strokeDasharray="3 3"
              stroke="var(--color-border)"
              opacity={0.4}
              vertical={false}
            />
            <XAxis
              dataKey="label"
              stroke="var(--color-muted-foreground)"
              fontSize={11}
              tickLine={false}
              axisLine={false}
            />
            <YAxis
              domain={yDomain}
              stroke="var(--color-muted-foreground)"
              fontSize={11}
              tickLine={false}
              axisLine={false}
              tickFormatter={(v) => `$${(v / 1000).toFixed(1)}k`}
              width={52}
            />
            <Tooltip content={<CustomTooltip />} />
            {/* High water mark secondary line */}
            <Line
              type="stepAfter"
              dataKey="highWaterMark"
              stroke="var(--color-chart-5)"
              strokeDasharray="4 4"
              strokeWidth={1.5}
              dot={false}
              isAnimationActive={false}
            />
            {/* Main equity area */}
            <Area
              type="monotone"
              dataKey="equity"
              stroke="var(--color-primary)"
              strokeWidth={2}
              fillOpacity={1}
              fill="url(#equityGradient)"
              dot={{ r: 3, fill: 'var(--color-primary)', strokeWidth: 0 }}
              activeDot={{ r: 5, fill: 'var(--color-primary)' }}
            />
          </AreaChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  )
}
