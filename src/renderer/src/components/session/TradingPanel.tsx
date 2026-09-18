import { useState } from 'react'
import { Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useSessionStore } from '@/store/session'
import type { Order } from '@/store/trading'
import NewOrderMenu from './NewOrderMenu'

/**
 * Trading strip (Phase 5): the simulated account surface.
 *
 * Shows the live balance, the New Order entry point, which position drawing is
 * currently selected on the chart (the New Order menu seeds from it), and the
 * session's orders as compact rows — pending (amber), active/filled (sky) and
 * the most recent closed trades (zinc) with their realized pnl.
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
    <span
      data-testid="order-chip"
      className={`inline-flex items-baseline gap-1.5 rounded-md border px-2 py-1 font-mono text-[11px] ${
        pending
          ? 'border-amber-500/40 bg-amber-500/10 text-amber-200'
          : 'border-sky-500/40 bg-sky-500/10 text-sky-200'
      }`}
    >
      <span className="text-[9px] font-sans font-semibold uppercase tracking-wide opacity-70">
        {pending ? 'Pending' : 'Active'} · {ORDER_TYPE_LABEL[order.orderType]}
      </span>
      <span>{directionGlyph(order)}</span>
      <span className="font-semibold">{fmtPrice(order.fillPrice ?? order.orderPrice)}</span>
      <span>SL {fmtPrice(order.stopLoss)}</span>
      <span>TP {fmtPrice(order.takeProfit)}</span>
      <span className="opacity-70">{fmtQty(order.size)}u</span>
    </span>
  )
}

function ClosedRow({ order }: { order: Order }): React.JSX.Element {
  const won = (order.pnl ?? 0) >= 0
  return (
    <span
      data-testid="closed-row"
      className="inline-flex items-baseline gap-1.5 font-mono text-[11px] text-zinc-400"
    >
      <span className="text-zinc-500">
        {ORDER_TYPE_LABEL[order.orderType]} {directionGlyph(order)}
      </span>
      <span className={order.exitReason === 'take_profit' ? 'text-emerald-300' : 'text-rose-300'}>
        {order.exitReason === 'take_profit' ? 'TP' : 'SL'}
      </span>
      <span>{fmtPrice(order.fillPrice ?? order.orderPrice)}</span>
      <span className={won ? 'text-emerald-300' : 'text-rose-300'}>{fmtMoney(order.pnl)}</span>
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
    <div className="border-t border-zinc-800 bg-zinc-900/60 px-4 py-2.5">
      {menuOpen && <NewOrderMenu onClose={() => setMenuOpen(false)} />}

      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        <span className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">
          Trading
        </span>

        <div className="flex items-baseline gap-1.5">
          <span className="text-[11px] text-zinc-500">Balance</span>
          <span
            data-testid="trading-balance"
            className="font-mono text-sm font-semibold text-zinc-100"
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
          <Plus /> New Order
        </Button>

        {selectedDrawing ? (
          <span
            data-testid="selected-position"
            className="inline-flex items-center gap-1.5 rounded-md border border-sky-500/30 bg-sky-500/10 px-2 py-1 font-mono text-[11px] text-sky-200"
          >
            <span className="text-[9px] font-sans font-semibold uppercase tracking-wide text-sky-300">
              Selected
            </span>
            <span>{selectedDrawing.direction === 'long' ? '▲' : '▼'}</span>
            <span>{fmtPrice(selectedDrawing.entryPrice)}</span>
            <span className="text-sky-400/60">SL {fmtPrice(selectedDrawing.stopLoss)}</span>
            <span className="text-sky-400/60">TP {fmtPrice(selectedDrawing.takeProfit)}</span>
            <button
              data-testid="clear-selection"
              onClick={() => setSelectedDrawing(null)}
              className="ml-1 rounded p-0.5 text-sky-400/70 transition-colors hover:bg-sky-500/20 hover:text-sky-200"
              aria-label="Clear selection (New Order falls back to manual)"
              title="Clear selection"
            >
              <X className="size-3" />
            </button>
          </span>
        ) : (
          <span className="text-[11px] text-zinc-600">No position tool selected</span>
        )}

        <div className="ml-auto flex items-center gap-3 text-[11px] text-zinc-500">
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
        <div
          data-testid="closed-orders"
          className="mt-2 flex flex-wrap gap-x-4 gap-y-1 border-t border-zinc-800/70 pt-2"
        >
          <span className="text-[10px] font-medium uppercase tracking-wide text-zinc-600">
            Recent closes
          </span>
          {closed.slice(-6).map((o) => (
            <ClosedRow key={o.id} order={o} />
          ))}
        </div>
      )}

      {session && orders.length === 0 && (
        <p data-testid="orders-empty" className="mt-2 text-[11px] text-zinc-600">
          Place a Long/Short Position tool on the chart, click it to select, then New Order — or go
          manual.
        </p>
      )}
    </div>
  )
}
