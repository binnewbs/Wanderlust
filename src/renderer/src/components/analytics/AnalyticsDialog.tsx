import React, { useMemo, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription
} from '@/components/ui/dialog'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { Badge } from '@/components/ui/badge'
import { cn } from 'cn'
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

interface AnalyticsDialogProps {
  open: boolean
  onClose: () => void
}

/** Tab order → moving right slides content in from the right, and vice versa. */
const TAB_ORDER = ['overview', 'insights', 'calendar', 'journal']

function tabContentClassName(
  direction: 'left' | 'right',
  base: string
): string {
  return cn(
    base,
    'data-[state=active]:animate-in data-[state=active]:fade-in data-[state=active]:duration-200',
    direction === 'right'
      ? 'data-[state=active]:slide-in-from-right-2'
      : 'data-[state=active]:slide-in-from-left-2'
  )
}

export default function AnalyticsDialog({
  open,
  onClose
}: AnalyticsDialogProps): React.JSX.Element {
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

  const [tab, setTab] = useState('overview')
  const [slideDir, setSlideDir] = useState<'left' | 'right'>('right')
  const selectTab = (value: string): void => {
    const prev = TAB_ORDER.indexOf(tab)
    const next = TAB_ORDER.indexOf(value)
    setSlideDir(prev >= 0 && next < prev ? 'left' : 'right')
    setTab(value)
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92vh] max-w-5xl overflow-y-auto p-6 sm:p-7">
        <DialogHeader className="gap-1 border-b border-border/60 pb-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <div className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <BarChart3 className="size-4" />
              </div>
              <div>
                <DialogTitle className="text-lg font-bold tracking-tight">
                  Analytics & Trade Journal
                </DialogTitle>
                <DialogDescription className="text-xs text-muted-foreground">
                  Performance insights, equity trajectory, daily PnL calendar, and trade ledger.
                </DialogDescription>
              </div>
            </div>

            {session && (
              <div className="flex flex-wrap items-center gap-2 font-mono text-xs">
                <span className="font-semibold text-foreground">{session.asset.label}</span>
                <span className="text-muted-foreground">·</span>
                <span className="text-muted-foreground">{session.timeframe}</span>
                <span className="text-muted-foreground">·</span>
                <span className="text-muted-foreground">
                  {session.startDate} → {session.endDate}
                </span>
                <span className="text-muted-foreground">·</span>
                <Badge
                  variant={isProfitable ? 'secondary' : 'destructive'}
                  className="font-mono text-xs"
                >
                  Net {formatCurrency(kpis.netProfit)}
                </Badge>
              </div>
            )}
          </div>
        </DialogHeader>

        <div className="mt-2 flex flex-col gap-4">
          <Tabs value={tab} onValueChange={selectTab} className="w-full">
            <TabsList className="mb-2">
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
            <TabsContent
              value="overview"
              className={tabContentClassName(slideDir, 'flex flex-col gap-4 focus-visible:outline-hidden')}
            >
              <KpiGrid kpis={kpis} balance={balance} startBalance={startBalance} />
              <EquityChart data={equityCurve} startBalance={startBalance} />
            </TabsContent>

            {/* TAB 2: Deep Insights */}
            <TabsContent
              value="insights"
              className={tabContentClassName(slideDir, 'focus-visible:outline-hidden')}
            >
              <DeepInsights kpis={kpis} dayStats={dayStats} />
            </TabsContent>

            {/* TAB 3: Calendar PnL */}
            <TabsContent
              value="calendar"
              className={tabContentClassName(slideDir, 'focus-visible:outline-hidden')}
            >
              <CalendarPnl orders={orders} defaultDate={session?.startDate} />
            </TabsContent>

            {/* TAB 4: Trade Journal */}
            <TabsContent
              value="journal"
              className={tabContentClassName(slideDir, 'focus-visible:outline-hidden')}
            >
              <TradeJournal orders={orders} />
            </TabsContent>
          </Tabs>
        </div>
      </DialogContent>
    </Dialog>
  )
}
