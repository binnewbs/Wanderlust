import React from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { formatCurrency, formatPlainBalance, formatRatio, type KpiMetrics } from '@/lib/analytics'
import { TrendingUp, ShieldAlert, Award, Scale, Target, Wallet } from 'lucide-react'

interface KpiGridProps {
  kpis: KpiMetrics
  balance: number
  startBalance: number
}

export default function KpiGrid({ kpis, balance, startBalance }: KpiGridProps): React.JSX.Element {
  const isNetProfitPositive = kpis.netProfit >= 0

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      {/* 1. Expectancy */}
      <Card size="sm" className="bg-card/70 backdrop-blur-xs">
        <CardHeader className="flex flex-row items-center justify-between pb-1">
          <CardTitle className="text-[11px] font-semibold tracking-wider uppercase text-muted-foreground">
            Expectancy
          </CardTitle>
          <Target className="size-3.5 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          <div
            className={`font-mono text-xl font-bold tracking-tight ${
              kpis.expectancy > 0
                ? 'text-chart-2'
                : kpis.expectancy < 0
                  ? 'text-destructive'
                  : 'text-foreground'
            }`}
          >
            {formatCurrency(kpis.expectancy)}
          </div>
          <p className="mt-0.5 text-[10px] text-muted-foreground">per trade return</p>
        </CardContent>
      </Card>

      {/* 2. Profit Factor */}
      <Card size="sm" className="bg-card/70 backdrop-blur-xs">
        <CardHeader className="flex flex-row items-center justify-between pb-1">
          <CardTitle className="text-[11px] font-semibold tracking-wider uppercase text-muted-foreground">
            Profit Factor
          </CardTitle>
          <Scale className="size-3.5 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          <div
            className={`font-mono text-xl font-bold tracking-tight ${
              kpis.profitFactor >= 1.5
                ? 'text-chart-2'
                : kpis.profitFactor >= 1.0
                  ? 'text-foreground'
                  : 'text-destructive'
            }`}
          >
            {formatRatio(kpis.profitFactor)}
          </div>
          <p className="mt-0.5 text-[10px] text-muted-foreground">gross profit / loss</p>
        </CardContent>
      </Card>

      {/* 3. Average RR */}
      <Card size="sm" className="bg-card/70 backdrop-blur-xs">
        <CardHeader className="flex flex-row items-center justify-between pb-1">
          <CardTitle className="text-[11px] font-semibold tracking-wider uppercase text-muted-foreground">
            Avg RR
          </CardTitle>
          <Award className="size-3.5 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          <div className="font-mono text-xl font-bold tracking-tight text-foreground">
            {formatRatio(kpis.averageRR)}R
          </div>
          <p className="mt-0.5 text-[10px] text-muted-foreground">realized win / loss</p>
        </CardContent>
      </Card>

      {/* 4. Win Rate */}
      <Card size="sm" className="bg-card/70 backdrop-blur-xs">
        <CardHeader className="flex flex-row items-center justify-between pb-1">
          <CardTitle className="text-[11px] font-semibold tracking-wider uppercase text-muted-foreground">
            Win Rate
          </CardTitle>
          <TrendingUp className="size-3.5 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          <div
            className={`font-mono text-xl font-bold tracking-tight ${
              kpis.winRate >= 50 ? 'text-chart-2' : 'text-foreground'
            }`}
          >
            {kpis.winRate.toFixed(1)}%
          </div>
          <p className="mt-0.5 text-[10px] text-muted-foreground">
            {kpis.winningTrades}W / {kpis.losingTrades}L / {kpis.breakevenTrades}BE
          </p>
        </CardContent>
      </Card>

      {/* 5. Max Drawdown */}
      <Card size="sm" className="bg-card/70 backdrop-blur-xs">
        <CardHeader className="flex flex-row items-center justify-between pb-1">
          <CardTitle className="text-[11px] font-semibold tracking-wider uppercase text-muted-foreground">
            Max Drawdown
          </CardTitle>
          <ShieldAlert className="size-3.5 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          <div className="font-mono text-xl font-bold tracking-tight text-destructive">
            {kpis.maxDrawdownPercent > 0 ? `-${kpis.maxDrawdownPercent.toFixed(1)}%` : '0.0%'}
          </div>
          <p className="mt-0.5 text-[10px] text-muted-foreground">
            {formatCurrency(-kpis.maxDrawdownAmount)} peak drop
          </p>
        </CardContent>
      </Card>

      {/* 6. Net Profit & Balance */}
      <Card size="sm" className="bg-card/70 backdrop-blur-xs">
        <CardHeader className="flex flex-row items-center justify-between pb-1">
          <CardTitle className="text-[11px] font-semibold tracking-wider uppercase text-muted-foreground">
            Net PnL
          </CardTitle>
          <Wallet className="size-3.5 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          <div
            className={`font-mono text-xl font-bold tracking-tight ${
              isNetProfitPositive ? 'text-chart-2' : 'text-destructive'
            }`}
          >
            {formatCurrency(kpis.netProfit)}
          </div>
          <p className="mt-0.5 text-[10px] text-muted-foreground">
            Start: {formatPlainBalance(startBalance)} · Bal: {formatPlainBalance(balance)}
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
