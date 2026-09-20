import React, { useState } from 'react'
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
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
  const [sessionToDelete, setSessionToDelete] = useState<SavedSession | null>(null)

  if (savedSessions.length === 0) {
    return (
      <Empty className="h-full animate-in fade-in zoom-in-95 duration-300">
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
      </div>

      {/* Sessions Grid */}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,300px),340px))] gap-5">
        {savedSessions.map((s: SavedSession, index) => {
          const closedOrders = s.orders.filter((o) => o.status === 'closed')
          const netPnl = s.balance - s.startBalance
          const isProfitable = netPnl >= 0
          const wins = closedOrders.filter((o) => (o.pnl ?? 0) > 0.001).length
          const winRate = closedOrders.length > 0 ? (wins / closedOrders.length) * 100 : 0
          const pendingActive = s.orders.filter((o) => o.status !== 'closed').length

          return (
            <Card
              key={s.id}
              className="flex aspect-square w-full flex-col justify-between border-border/80 bg-card/80 transition-all animate-in fade-in slide-in-from-bottom-3 zoom-in-95 duration-200 fill-mode-backwards hover:border-primary/40 hover:-translate-y-0.5 hover:shadow-lg"
              style={{ animationDelay: `${Math.min(index * 45, 450)}ms` }}
            >
              <CardHeader className="p-4 pb-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <CardTitle className="truncate text-base font-semibold text-foreground">
                      {s.name}
                    </CardTitle>
                    <CardDescription className="mt-1 flex items-center gap-1.5 text-xs">
                      <Calendar className="size-3 shrink-0 text-muted-foreground" />
                      <span className="truncate">
                        {s.startDate} → {s.endDate}
                      </span>
                    </CardDescription>
                  </div>
                  <Badge
                    variant="outline"
                    className="shrink-0 font-semibold uppercase tracking-wider"
                  >
                    {s.asset.label}
                  </Badge>
                </div>
                <div className="mt-1.5 flex items-center gap-2">
                  <span className="text-[11px] text-muted-foreground">
                    Updated {new Date(s.updatedAt).toLocaleDateString()}
                  </span>
                </div>
              </CardHeader>

              <CardContent className="p-4 py-1">
                <div className="grid grid-cols-2 gap-2 rounded-lg border border-border/50 bg-muted/20 p-2.5 text-xs">
                  <div>
                    <span className="text-[10px] uppercase text-muted-foreground">Net PnL</span>
                    <div
                      className={`font-mono text-sm font-bold ${
                        isProfitable ? 'text-chart-2' : 'text-destructive'
                      }`}
                    >
                      {formatCurrency(netPnl)}
                    </div>
                  </div>

                  <div>
                    <span className="text-[10px] uppercase text-muted-foreground">Balance</span>
                    <div className="font-mono text-sm font-semibold text-foreground">
                      {formatPlainBalance(s.balance)}
                    </div>
                  </div>

                  <div className="border-t border-border/40 pt-1.5">
                    <span className="text-[10px] uppercase text-muted-foreground">
                      Closed Trades
                    </span>
                    <div className="font-mono font-medium text-foreground">
                      {closedOrders.length}{' '}
                      <span className="text-[10px] text-muted-foreground">
                        ({winRate.toFixed(0)}% win)
                      </span>
                    </div>
                  </div>

                  <div className="border-t border-border/40 pt-1.5">
                    <span className="text-[10px] uppercase text-muted-foreground">
                      Open / Pending
                    </span>
                    <div className="font-mono font-medium text-foreground">
                      {pendingActive} orders
                    </div>
                  </div>
                </div>
              </CardContent>

              <CardFooter className="flex items-center justify-between border-t border-border/50 p-4 pt-2.5">
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
                  onClick={() => setSessionToDelete(s)}
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

      {/* Delete Confirmation Dialog */}
      <Dialog
        open={sessionToDelete !== null}
        onOpenChange={(open) => {
          if (!open) setSessionToDelete(null)
        }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete session?</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete{' '}
              <strong className="text-foreground">{sessionToDelete?.name}</strong>? All simulated
              orders and session history will be permanently removed.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSessionToDelete(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (sessionToDelete) {
                  deleteSavedSession(sessionToDelete.id)
                  setSessionToDelete(null)
                }
              }}
            >
              <Trash2 data-icon="inline-start" />
              Delete Session
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
