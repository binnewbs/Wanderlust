import React, { useMemo } from 'react'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { Badge } from '@/components/ui/badge'
import { useSessionStore } from '@/store/session'
import {
  calculateKpiMetrics,
  buildEquityCurve,
  calculateDayOfWeekStats,
  formatCurrency
} from '@/lib/analytics'
import KpiGrid from './KpiGrid'
import EquityChart from './EquityChart'
import DeepInsights from './DeepInsights'
import CalendarPnl from './CalendarPnl'
import TradeJournal from './TradeJournal'
import { BarChart3, TrendingUp, Calendar, BookOpen } from 'lucide-react'

interface AnalyticsViewProps {
  onBackToChart?: () => void
}

export default function AnalyticsView({
  onBackToChart: _onBackToChart
}: AnalyticsViewProps): React.JSX.Element {
  const session = useSessionStore((s) => s.session)
  const balance = useSessionStore((s) => s.balance)
  const startBalance = useSessionStore((s) => s.startBalance)
  const orders = useSessionStore((s) => s.orders)

  const kpis = useMemo(() => {
    return calculateKpiMetrics(startBalance, orders)
  }, [startBalance, orders])

  const equityCurve = useMemo(() => {
    return buildEquityCurve(startBalance, orders)
  }, [startBalance, orders])

  const dayStats = useMemo(() => {
    return calculateDayOfWeekStats(orders)
  }, [orders])

  const isProfitable = kpis.netProfit >= 0

  return (
    <div className="flex h-full w-full flex-col overflow-y-auto bg-background p-6">
      {/* Top Banner */}
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4 border-b border-border/60 pb-5">
        <div>
          <div className="flex items-center gap-2.5">
            <h2 className="text-xl font-bold tracking-tight text-foreground">
              {session?.name ?? 'Session Analytics'}
            </h2>
            <Badge
              variant={isProfitable ? 'secondary' : 'destructive'}
              className="font-mono text-xs"
            >
              Net {formatCurrency(kpis.netProfit)}
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground">
            Performance metrics, equity trajectory, calendar PnL, and trade ledger.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {session && (
            <div className="hidden items-center gap-2 rounded-lg border border-border bg-card/60 px-3 py-1.5 font-mono text-xs sm:flex">
              <span className="font-semibold text-foreground">{session.asset.label}</span>
              <span className="text-muted-foreground">·</span>
              <span className="text-muted-foreground uppercase">{session.timeframe}</span>
              <span className="text-muted-foreground">·</span>
              <span className="text-muted-foreground">
                {session.startDate} → {session.endDate}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Analytics Tabs View */}
      <Tabs defaultValue="overview" className="flex-1">
        <TabsList className="mb-4">
          <TabsTrigger value="overview" className="gap-1.5 text-xs">
            <BarChart3 className="size-3.5" />
            Overview
          </TabsTrigger>
          <TabsTrigger value="insights" className="gap-1.5 text-xs">
            <TrendingUp className="size-3.5" />
            Deep Insights
          </TabsTrigger>
          <TabsTrigger value="calendar" className="gap-1.5 text-xs">
            <Calendar className="size-3.5" />
            Calendar PnL
          </TabsTrigger>
          <TabsTrigger value="journal" className="gap-1.5 text-xs">
            <BookOpen className="size-3.5" />
            Trade Journal ({kpis.closedTrades})
          </TabsTrigger>
        </TabsList>

        {/* TAB 1: Overview */}
        <TabsContent value="overview" className="flex flex-col gap-4 focus-visible:outline-hidden">
          <KpiGrid kpis={kpis} balance={balance} startBalance={startBalance} />
          <EquityChart data={equityCurve} startBalance={startBalance} />
        </TabsContent>

        {/* TAB 2: Deep Insights */}
        <TabsContent value="insights" className="focus-visible:outline-hidden">
          <DeepInsights kpis={kpis} dayStats={dayStats} />
        </TabsContent>

        {/* TAB 3: Calendar PnL */}
        <TabsContent value="calendar" className="focus-visible:outline-hidden">
          <CalendarPnl orders={orders} defaultDate={session?.startDate} />
        </TabsContent>

        {/* TAB 4: Trade Journal */}
        <TabsContent value="journal" className="focus-visible:outline-hidden">
          <TradeJournal orders={orders} />
        </TabsContent>
      </Tabs>
    </div>
  )
}
