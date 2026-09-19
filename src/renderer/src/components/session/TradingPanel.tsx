import { useState } from 'react'
import { Plus, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { useSessionStore } from '@/store/session'
import type { Order } from '@/store/trading'
import NewOrderMenu from './NewOrderMenu'

/**
 * Trading strip (Phase 5): the simulated account surface.
 *
 * Shows the live balance, the New Order entry point, which position drawing is
 * currently selected on the chart (the New Order menu seeds from it), and the
 * session's orders as compact rows — pending (secondary), active/filled
 * (outline) and the most recent closed trades (muted) with their realized pnl.
 */

const ORDER_TYPE_LABEL: Record<Order['orderType'], string> = {
  market: 'MKT',
  limit: 'LMT',
  stop: 'STP'
}

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

function fmtMoney(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return '—'
  const sign = n > 0 ? '+' : n < 0 ? '−' : ''
  return `${sign}$${Math.abs(n).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`
}

function directionGlyph(o: Order): string {
  return o.direction === 'long' ? '▲' : '▼'
}

function OrderChip({ order }: { order: Order }): React.JSX.Element {
  const pending = order.status === 'pending'
  return (
    <Badge
      data-testid="order-chip"
      variant={pending ? 'secondary' : 'outline'}
      className="h-auto items-baseline gap-1.5 rounded-md px-2 py-1 font-mono text-[11px] font-normal"
    >
      <span className="text-[9px] font-sans font-semibold uppercase tracking-wide opacity-70">
        {pending ? 'Pending' : 'Active'} · {ORDER_TYPE_LABEL[order.orderType]}
      </span>
      <span>{directionGlyph(order)}</span>
      <span className="font-semibold">{fmtPrice(order.fillPrice ?? order.orderPrice)}</span>
      <span>SL {fmtPrice(order.stopLoss)}</span>
      <span>TP {fmtPrice(order.takeProfit)}</span>
      <span className="opacity-70">{fmtQty(order.size)}u</span>
    </Badge>
  )
}

function ClosedRow({ order }: { order: Order }): React.JSX.Element {
  const won = (order.pnl ?? 0) >= 0
  const exitLabel =
    order.exitReason === 'take_profit' ? 'TP' : order.exitReason === 'stop_loss' ? 'SL' : 'Manual'
  return (
    <span
      data-testid="closed-row"
      className="inline-flex items-baseline gap-1.5 font-mono text-[11px] text-muted-foreground"
    >
      <span>
        {ORDER_TYPE_LABEL[order.orderType]} {directionGlyph(order)}
      </span>
      <span className={order.exitReason === 'take_profit' ? 'text-positive' : 'text-foreground'}>
        {exitLabel}
      </span>
      <span>{fmtPrice(order.fillPrice ?? order.orderPrice)}</span>
      <span className={won ? 'text-positive' : 'text-destructive'}>{fmtMoney(order.pnl)}</span>
    </span>
  )
}

export default function TradingPanel(): React.JSX.Element {
  const session = useSessionStore((s) => s.session)
  const balance = useSessionStore((s) => s.balance)
  const orders = useSessionStore((s) => s.orders)
  const selectedDrawing = useSessionStore((s) => s.selectedDrawing)
  const setSelectedDrawing = useSessionStore((s) => s.setSelectedDrawing)
  const [menuOpen, setMenuOpen] = useState(false)

  const pending = orders.filter((o) => o.status === 'pending')
  const active = orders.filter((o) => o.status === 'filled')
  const closed = orders.filter((o) => o.status === 'closed')

  return (
    <div className="border-t border-border bg-card px-4 py-2.5">
      {menuOpen && <NewOrderMenu onClose={() => setMenuOpen(false)} />}

      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          Trading
        </span>

        <div className="flex items-baseline gap-1.5">
          <span className="text-[11px] text-muted-foreground">Balance</span>
          <span
            data-testid="trading-balance"
            className="font-mono text-sm font-semibold text-foreground"
          >
            $
            {balance.toLocaleString('en-US', {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2
            })}
          </span>
        </div>

        <Button
          data-testid="new-order-btn"
          size="sm"
          disabled={!session}
          onClick={() => setMenuOpen(true)}
        >
          <Plus data-icon="inline-start" /> New Order
        </Button>

        {selectedDrawing ? (
          <Badge
            data-testid="selected-position"
            variant="outline"
            className="h-auto items-baseline gap-1.5 rounded-md border-chart-2/40 bg-chart-2/10 px-2 py-1 font-mono text-[11px] font-normal text-chart-2"
          >
            <span className="text-[9px] font-sans font-semibold uppercase tracking-wide">
              Selected
            </span>
            <span>{selectedDrawing.direction === 'long' ? '▲' : '▼'}</span>
            <span>{fmtPrice(selectedDrawing.entryPrice)}</span>
            <span className="opacity-70">SL {fmtPrice(selectedDrawing.stopLoss)}</span>
            <span className="opacity-70">TP {fmtPrice(selectedDrawing.takeProfit)}</span>
            <Button
              data-testid="clear-selection"
              onClick={() => setSelectedDrawing(null)}
              className="ml-1 h-auto w-auto rounded-sm p-0.5 text-current hover:bg-chart-2/20 hover:text-chart-2 dark:hover:bg-chart-2/20"
              variant="ghost"
              size="icon-xs"
              aria-label="Clear selection (New Order falls back to manual)"
              title="Clear selection"
            >
              <X />
            </Button>
          </Badge>
        ) : (
          <span className="text-[11px] text-muted-foreground">No position tool selected</span>
        )}

        <div className="ml-auto flex items-center gap-3 text-[11px] text-muted-foreground">
          <span data-testid="pending-count">{pending.length} pending</span>
          <span data-testid="active-count">{active.length} active</span>
          <span data-testid="closed-count">{closed.length} closed</span>
        </div>
      </div>

      {(pending.length > 0 || active.length > 0) && (
        <div data-testid="live-orders" className="mt-2 flex flex-wrap gap-1.5">
          {pending.map((o) => (
            <OrderChip key={o.id} order={o} />
          ))}
          {active.map((o) => (
            <OrderChip key={o.id} order={o} />
          ))}
        </div>
      )}

      {closed.length > 0 && (
        <div data-testid="closed-orders" className="mt-2">
          <Separator className="mb-2" />
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              Recent closes
            </span>
            {closed.slice(-6).map((o) => (
              <ClosedRow key={o.id} order={o} />
            ))}
          </div>
        </div>
      )}

      {session && orders.length === 0 && (
        <p data-testid="orders-empty" className="mt-2 text-[11px] text-muted-foreground">
          Place a Long/Short Position tool on the chart, click it to select, then New Order — or go
          manual.
        </p>
      )}
    </div>
  )
}
