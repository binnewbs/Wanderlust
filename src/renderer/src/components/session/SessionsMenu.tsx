import React from 'react'
import { Plus, Play, BarChart3, Trash2, Calendar, Layers, PlayCircle } from 'lucide-react'
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter
} from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle
} from '@/components/ui/empty'
import { useSessionStore, type SavedSession } from '@/store/session'
import { formatCurrency, formatPlainBalance } from '@/lib/analytics'

interface SessionsMenuProps {
  onNewSession: () => void
  onResumeSession: (sessionId: string) => void
  onViewAnalytics: (sessionId: string) => void
}

export default function SessionsMenu({
  onNewSession,
  onResumeSession,
  onViewAnalytics
}: SessionsMenuProps): React.JSX.Element {
  const savedSessions = useSessionStore((s) => s.savedSessions)
  const deleteSavedSession = useSessionStore((s) => s.deleteSavedSession)

  if (savedSessions.length === 0) {
    return (
      <Empty className="h-full">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <PlayCircle />
          </EmptyMedia>
          <EmptyTitle>No session yet</EmptyTitle>
          <EmptyDescription>
            Download a market range from Dukascopy (cached locally for reuse) and replay it on the
            chart. Your data stays on this machine.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button onClick={onNewSession}>
            <Plus data-icon="inline-start" />
            Start a new backtest session
          </Button>
        </EmptyContent>
      </Empty>
    )
  }

  return (
    <div className="flex h-full w-full flex-col overflow-y-auto bg-background p-6 sm:p-8">
      {/* Menu Header */}
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4 border-b border-border/60 pb-5">
        <div>
          <div className="flex items-center gap-2.5">
            <Layers className="size-5 text-primary" />
            <h2 className="text-xl font-bold tracking-tight text-foreground">Backtest Sessions</h2>
            <Badge variant="secondary" className="font-mono text-xs">
              {savedSessions.length} {savedSessions.length === 1 ? 'session' : 'sessions'}
            </Badge>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Select a session to resume trading, inspect detailed analytics and trade journal, or
            start a new backtest.
          </p>
        </div>

        <Button onClick={onNewSession} size="sm">
          <Plus data-icon="inline-start" />
          New Session
        </Button>
      </div>

      {/* Sessions Grid */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {savedSessions.map((s: SavedSession) => {
          const closedOrders = s.orders.filter((o) => o.status === 'closed')
          const netPnl = s.balance - s.startBalance
          const isProfitable = netPnl >= 0
          const wins = closedOrders.filter((o) => (o.pnl ?? 0) > 0.001).length
          const winRate = closedOrders.length > 0 ? (wins / closedOrders.length) * 100 : 0
          const pendingActive = s.orders.filter((o) => o.status !== 'closed').length

          return (
            <Card
              key={s.id}
              className="flex flex-col justify-between border-border/80 bg-card/80 transition-all hover:border-primary/40 hover:shadow-md"
            >
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <CardTitle className="truncate text-base font-semibold text-foreground">
                      {s.name}
                    </CardTitle>
                    <CardDescription className="mt-1 flex items-center gap-1.5 text-xs">
                      <Calendar className="size-3 text-muted-foreground" />
                      <span>
                        {s.startDate} → {s.endDate}
                      </span>
                    </CardDescription>
                  </div>
                  <Badge variant="outline" className="font-semibold uppercase tracking-wider">
                    {s.asset.label}
                  </Badge>
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <Badge variant="secondary" className="text-[10px] uppercase">
                    {s.timeframe}
                  </Badge>
                  <span className="text-[11px] text-muted-foreground">
                    Updated {new Date(s.updatedAt).toLocaleDateString()}
                  </span>
                </div>
              </CardHeader>

              <CardContent className="py-2">
                <div className="grid grid-cols-2 gap-2 rounded-lg border border-border/50 bg-muted/20 p-3 text-xs">
                  <div>
                    <span className="text-[11px] text-muted-foreground">Net PnL</span>
                    <div
                      className={`font-mono text-sm font-bold ${
                        isProfitable ? 'text-chart-2' : 'text-destructive'
                      }`}
                    >
                      {formatCurrency(netPnl)}
                    </div>
                  </div>

                  <div>
                    <span className="text-[11px] text-muted-foreground">Balance</span>
                    <div className="font-mono text-sm font-semibold text-foreground">
                      {formatPlainBalance(s.balance)}
                    </div>
                  </div>

                  <div className="border-t border-border/40 pt-1.5">
                    <span className="text-[11px] text-muted-foreground">Closed Trades</span>
                    <div className="font-mono font-medium text-foreground">
                      {closedOrders.length}{' '}
                      <span className="text-[10px] text-muted-foreground">
                        ({winRate.toFixed(0)}% win)
                      </span>
                    </div>
                  </div>

                  <div className="border-t border-border/40 pt-1.5">
                    <span className="text-[11px] text-muted-foreground">Open / Pending</span>
                    <div className="font-mono font-medium text-foreground">
                      {pendingActive} orders
                    </div>
                  </div>
                </div>
              </CardContent>

              <CardFooter className="flex items-center justify-between border-t border-border/50 pt-3">
                <div className="flex items-center gap-2">
                  <Button size="sm" onClick={() => onResumeSession(s.id)}>
                    <Play data-icon="inline-start" />
                    Resume
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => onViewAnalytics(s.id)}>
                    <BarChart3 data-icon="inline-start" />
                    Analytics
                  </Button>
                </div>

                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => deleteSavedSession(s.id)}
                  title="Delete session"
                  aria-label="Delete session"
                  className="text-muted-foreground hover:text-destructive"
                >
                  <Trash2 />
                </Button>
              </CardFooter>
            </Card>
          )
        })}
      </div>
    </div>
  )
}
