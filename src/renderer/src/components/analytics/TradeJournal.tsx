import React, { useState, useMemo } from 'react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell
} from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { formatCurrency, formatDuration, formatRatio } from '@/lib/analytics'
import type { Order } from '@/store/trading'
import { BookOpen } from 'lucide-react'

interface TradeJournalProps {
  orders: Order[]
}

type OutcomeFilter = 'all' | 'win' | 'loss' | 'breakeven'

function fmtPrice(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return '—'
  return n.toLocaleString('en-US', { minimumFractionDigits: 5, maximumFractionDigits: 5 })
}

function fmtQty(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return '—'
  const abs = Math.abs(n)
  if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}k`
  return n.toFixed(0)
}

function fmtDate(ts: number | undefined): string {
  if (!ts) return '—'
  const d = new Date(ts)
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(
    d.getMinutes()
  ).padStart(2, '0')}`
}

export default function TradeJournal({ orders }: TradeJournalProps): React.JSX.Element {
  const [filter, setFilter] = useState<OutcomeFilter>('all')

  const closedTrades = useMemo(() => {
    return orders
      .filter((o) => o.status === 'closed' && o.pnl !== undefined)
      .sort((a, b) => {
        const timeA =
          a.closedAtTime ?? (a.closedAtIndex !== undefined ? a.closedAtIndex * 60000 : 0)
        const timeB =
          b.closedAtTime ?? (b.closedAtIndex !== undefined ? b.closedAtIndex * 60000 : 0)
        return timeB - timeA // newest first
      })
  }, [orders])

  const filteredTrades = useMemo(() => {
    if (filter === 'all') return closedTrades
    return closedTrades.filter((t) => {
      const pnl = t.pnl ?? 0
      if (filter === 'win') return pnl > 0.001
      if (filter === 'loss') return pnl < -0.001
      if (filter === 'breakeven') return Math.abs(pnl) <= 0.001
      return true
    })
  }, [closedTrades, filter])

  return (
    <Card className="bg-card/70 backdrop-blur-xs">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-sm font-semibold">
              <BookOpen className="size-4 text-primary" />
              Trade Journal
            </CardTitle>
            <CardDescription className="text-xs">
              Complete historical record of closed trades in this session.
            </CardDescription>
          </div>

          <div className="flex items-center gap-1.5">
            <Button
              variant={filter === 'all' ? 'secondary' : 'ghost'}
              size="xs"
              onClick={() => setFilter('all')}
              className="font-mono text-xs"
            >
              All ({closedTrades.length})
            </Button>
            <Button
              variant={filter === 'win' ? 'secondary' : 'ghost'}
              size="xs"
              onClick={() => setFilter('win')}
              className="font-mono text-xs text-chart-2"
            >
              Wins ({closedTrades.filter((t) => (t.pnl ?? 0) > 0.001).length})
            </Button>
            <Button
              variant={filter === 'loss' ? 'secondary' : 'ghost'}
              size="xs"
              onClick={() => setFilter('loss')}
              className="font-mono text-xs text-destructive"
            >
              Losses ({closedTrades.filter((t) => (t.pnl ?? 0) < -0.001).length})
            </Button>
            <Button
              variant={filter === 'breakeven' ? 'secondary' : 'ghost'}
              size="xs"
              onClick={() => setFilter('breakeven')}
              className="font-mono text-xs"
            >
              BE ({closedTrades.filter((t) => Math.abs(t.pnl ?? 0) <= 0.001).length})
            </Button>
          </div>
        </div>
      </CardHeader>

      <CardContent className="p-0">
        {filteredTrades.length === 0 ? (
          <div className="p-8 text-center text-xs text-muted-foreground">
            No closed trades matching the selected filter.
          </div>
        ) : (
          <div className="max-h-[380px] overflow-auto">
            <Table>
              <TableHeader className="sticky top-0 z-10 bg-card/95 backdrop-blur-xs">
                <TableRow className="border-border hover:bg-transparent">
                  <TableHead className="w-16 font-mono text-[11px]">Outcome</TableHead>
                  <TableHead className="font-mono text-[11px]">Time (Entry → Exit)</TableHead>
                  <TableHead className="font-mono text-[11px]">Side / Type</TableHead>
                  <TableHead className="font-mono text-[11px]">Fill Price</TableHead>
                  <TableHead className="font-mono text-[11px]">Exit Price</TableHead>
                  <TableHead className="font-mono text-[11px]">Size</TableHead>
                  <TableHead className="font-mono text-[11px]">Duration</TableHead>
                  <TableHead className="font-mono text-[11px]">Exit Trigger</TableHead>
                  <TableHead className="text-right font-mono text-[11px]">Realized PnL</TableHead>
                  <TableHead className="text-right font-mono text-[11px]">RR</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredTrades.map((t) => {
                  const pnl = t.pnl ?? 0
                  const isWin = pnl > 0.001
                  const isLoss = pnl < -0.001
                  const outcome = isWin ? 'WIN' : isLoss ? 'LOSS' : 'BREAKEVEN'
                  const outcomeVariant = isWin ? 'secondary' : isLoss ? 'destructive' : 'outline'

                  // Compute realized RR
                  const riskDist = Math.abs((t.fillPrice ?? t.orderPrice) - t.stopLoss)
                  const rewardDist = Math.abs(
                    (t.exitPrice ?? t.orderPrice) - (t.fillPrice ?? t.orderPrice)
                  )
                  const realizedRr = riskDist > 0 ? rewardDist / riskDist : 0

                  const holdingMs =
                    t.filledAtTime && t.closedAtTime && t.closedAtTime >= t.filledAtTime
                      ? t.closedAtTime - t.filledAtTime
                      : 0

                  const exitTrigger =
                    t.exitReason === 'take_profit'
                      ? 'Take Profit'
                      : t.exitReason === 'stop_loss'
                        ? 'Stop Loss'
                        : 'Manual'

                  return (
                    <TableRow key={t.id} className="border-border/50 text-xs">
                      <TableCell>
                        <Badge
                          variant={outcomeVariant}
                          className="h-5 px-1.5 font-mono text-[9px] font-semibold tracking-wider uppercase"
                        >
                          {outcome}
                        </Badge>
                      </TableCell>
                      <TableCell className="font-mono text-[11px] text-muted-foreground whitespace-nowrap">
                        {fmtDate(t.filledAtTime)} → {fmtDate(t.closedAtTime)}
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        <span
                          className={`font-semibold ${
                            t.direction === 'long' ? 'text-chart-2' : 'text-destructive'
                          }`}
                        >
                          {t.direction === 'long' ? '▲ Long' : '▼ Short'}
                        </span>{' '}
                        <span className="text-[10px] text-muted-foreground uppercase">
                          ({t.orderType})
                        </span>
                      </TableCell>
                      <TableCell className="font-mono text-[11px]">
                        {fmtPrice(t.fillPrice ?? t.orderPrice)}
                      </TableCell>
                      <TableCell className="font-mono text-[11px]">
                        {fmtPrice(t.exitPrice)}
                      </TableCell>
                      <TableCell className="font-mono text-[11px] text-muted-foreground">
                        {fmtQty(t.size)}u
                      </TableCell>
                      <TableCell className="font-mono text-[11px] text-muted-foreground whitespace-nowrap">
                        {formatDuration(holdingMs)}
                      </TableCell>
                      <TableCell className="text-xs">
                        <span
                          className={
                            t.exitReason === 'take_profit'
                              ? 'text-chart-2 font-medium'
                              : t.exitReason === 'stop_loss'
                                ? 'text-destructive font-medium'
                                : 'text-foreground'
                          }
                        >
                          {exitTrigger}
                        </span>
                      </TableCell>
                      <TableCell
                        className={`text-right font-mono text-xs font-semibold ${
                          isWin ? 'text-chart-2' : isLoss ? 'text-destructive' : 'text-foreground'
                        }`}
                      >
                        {formatCurrency(pnl)}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs text-muted-foreground">
                        {isLoss ? '−1.00R' : `${formatRatio(realizedRr)}R`}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
