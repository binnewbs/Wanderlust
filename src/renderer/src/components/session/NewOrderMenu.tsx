import { useMemo, useState } from 'react'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { sessionBaseCandles, sessionBaseRunUp, useSessionStore } from '@/store/session'
import { sizeForRisk, type OrderType, type TradeDirection } from '@/store/trading'

/**
 * New Order menu (Phase 5) — the bridge between Vela's Long/Short Position
 * tool and the simulated account.
 *
 * When a position drawing is selected on the chart it SEEDS the form: SL/TP
 * come locked from the tool's anchors, direction from its geometry, and the
 * entry defaults to the tool's entry anchor (editable for limit/stop). With no
 * tool selected the form is fully manual (entry, SL and TP all typed).
 *
 * Order types:
 *  - Market: fills at the NEXT candle's open.
 *  - Limit:  fills when price trades through the entry level (buy below, sell above).
 *  - Stop:   fills when price trades through the entry level (buy above, sell below).
 *
 * Risk % (of the account balance) sizes the position at FILL: the preview here
 * uses the current/fill-estimated entry so the user sees what they risk.
 */

const RISK_TEMPLATES = [0.25, 0.5, 1, 2, 3]

const ORDER_TYPE_OPTIONS: Array<{ value: OrderType; label: string }> = [
  { value: 'market', label: 'Market' },
  { value: 'limit', label: 'Limit' },
  { value: 'stop', label: 'Stop' }
]

function inputCls(disabled: boolean): string {
  return `w-full rounded-md border border-zinc-700 bg-zinc-950 px-2.5 py-1.5 text-sm text-zinc-100 outline-none focus:border-sky-500 ${
    disabled ? 'cursor-not-allowed opacity-50' : ''
  }`
}

function labelCls(): string {
  return 'mb-1 block text-[11px] font-medium uppercase tracking-wide text-zinc-500'
}

function segCls(active: boolean): string {
  return `rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
    active ? 'bg-sky-600 text-white' : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'
  }`
}

function riskBtnCls(active: boolean): string {
  return `rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
    active ? 'bg-sky-600 text-white' : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700'
  }`
}

export interface NewOrderMenuProps {
  onClose: () => void
}

export default function NewOrderMenu({ onClose }: NewOrderMenuProps): React.JSX.Element {
  const session = useSessionStore((s) => s.session)
  const balance = useSessionStore((s) => s.balance)
  const currentIndex = useSessionStore((s) => s.currentIndex)
  const selectedDrawing = useSessionStore((s) => s.selectedDrawing)
  const submitOrder = useSessionStore((s) => s.submitOrder)

  // Seeded once on open (the panel remounts this modal per open, so state is
  // always fresh). SL/TP lock to the tool when a drawing is selected.
  const [orderType, setOrderType] = useState<OrderType>('market')
  const [direction, setDirection] = useState<TradeDirection>(selectedDrawing?.direction ?? 'long')
  const [riskStr, setRiskStr] = useState(String(useSessionStore.getState().riskPercent))
  const [entryStr, setEntryStr] = useState(
    selectedDrawing ? String(selectedDrawing.entryPrice) : ''
  )
  const [slStr, setSlStr] = useState(selectedDrawing ? String(selectedDrawing.stopLoss) : '')
  const [tpStr, setTpStr] = useState(selectedDrawing ? String(selectedDrawing.takeProfit) : '')
  const [error, setError] = useState<string | null>(null)

  const risk = Number(riskStr)
  const entry = Number(entryStr)
  const sl = Number(slStr)
  const tp = Number(tpStr)

  // Last revealed close — the fill proxy for market orders (they enter at the
  // next candle's open, unknown ahead of time; preview shows ≈ size).
  const lastClose = useMemo(() => {
    const base = sessionBaseCandles(session)
    const revealed = currentIndex > 0 ? base[currentIndex - 1] : undefined
    if (revealed) return revealed.close
    const runUp = sessionBaseRunUp(session)
    return runUp[runUp.length - 1]?.close
  }, [session, currentIndex])

  const marketEstimate = lastClose !== undefined ? lastClose : entry
  const sizeEntry = orderType === 'market' ? marketEstimate : entry
  const size = sizeForRisk(sizeEntry, sl, risk, balance)
  const sizeValid = Number.isFinite(size) && size > 0

  const fromTool = selectedDrawing !== null
  const entryLockedToMarket = orderType === 'market'

  const handleSubmit = (): void => {
    setError(null)
    submitOrder({
      drawingId: selectedDrawing?.drawingId,
      orderType,
      direction,
      orderPrice: entry,
      stopLoss: sl,
      takeProfit: tp,
      riskPercent: risk
    })
    const result = useSessionStore.getState().lastOrderResult
    if (result?.ok) {
      onClose()
    } else {
      setError(result?.message ?? 'Order rejected.')
    }
  }

  const dirChip =
    direction === 'long' ? (
      <span className="inline-flex items-center gap-1 rounded-md bg-emerald-500/15 px-2 py-0.5 text-xs font-semibold text-emerald-300">
        ▲ LONG
      </span>
    ) : (
      <span className="inline-flex items-center gap-1 rounded-md bg-rose-500/15 px-2 py-0.5 text-xs font-semibold text-rose-300">
        ▼ SHORT
      </span>
    )

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="New order"
    >
      <div className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-lg border border-zinc-800 bg-zinc-900 p-5 shadow-2xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-semibold tracking-tight text-zinc-100">New order</h2>
          <button
            onClick={onClose}
            className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
            aria-label="Close"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="space-y-4">
          {/* Source banner: chart tool or manual */}
          {fromTool ? (
            <div
              data-testid="order-source"
              className="rounded-md border border-sky-500/30 bg-sky-500/10 px-3 py-2 text-xs text-sky-200"
            >
              <span className="font-semibold uppercase tracking-wide">From chart tool</span>
              <span className="ml-2 text-zinc-400">
                {selectedDrawing!.direction === 'long' ? 'Long' : 'Short'} position drawing
                {' · '}SL/TP locked to the tool
              </span>
            </div>
          ) : (
            <div
              data-testid="order-source"
              className="rounded-md border border-zinc-700 bg-zinc-800/60 px-3 py-2 text-xs text-zinc-400"
            >
              Manual order — set entry, stop-loss and take-profit below (no position tool selected).
            </div>
          )}

          {/* Order type */}
          <div>
            <span className={labelCls()}>Order type</span>
            <div data-testid="order-type" className="flex gap-1 rounded-md bg-zinc-950 p-1">
              {ORDER_TYPE_OPTIONS.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  className={segCls(orderType === o.value)}
                  onClick={() => setOrderType(o.value)}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </div>

          {/* Direction */}
          <div>
            <span className={labelCls()}>Direction</span>
            {fromTool ? (
              <div className="flex items-center gap-2">{dirChip}</div>
            ) : (
              <div className="flex gap-1 rounded-md bg-zinc-950 p-1">
                <button
                  type="button"
                  data-testid="dir-long"
                  className={segCls(direction === 'long')}
                  onClick={() => setDirection('long')}
                >
                  Long
                </button>
                <button
                  type="button"
                  data-testid="dir-short"
                  className={segCls(direction === 'short')}
                  onClick={() => setDirection('short')}
                >
                  Short
                </button>
              </div>
            )}
          </div>

          {/* Levels */}
          <div className="grid grid-cols-3 gap-2">
            <div>
              <span className={labelCls()}>Entry</span>
              <input
                data-testid="order-entry"
                className={inputCls(entryLockedToMarket)}
                value={entryLockedToMarket ? 'Market' : entryStr}
                onChange={(e) => setEntryStr(e.target.value)}
                disabled={entryLockedToMarket}
                inputMode="decimal"
                placeholder={entryLockedToMarket ? 'Market' : '0.00000'}
              />
              {entryLockedToMarket && (
                <p className="mt-1 text-[10px] leading-tight text-zinc-500">
                  Fills on the next candle open
                </p>
              )}
            </div>
            <div>
              <span className={labelCls()}>Stop-loss</span>
              <input
                data-testid="order-sl"
                className={inputCls(fromTool)}
                value={slStr}
                onChange={(e) => setSlStr(e.target.value)}
                disabled={fromTool}
                inputMode="decimal"
                placeholder="0.00000"
              />
            </div>
            <div>
              <span className={labelCls()}>Take-profit</span>
              <input
                data-testid="order-tp"
                className={inputCls(fromTool)}
                value={tpStr}
                onChange={(e) => setTpStr(e.target.value)}
                disabled={fromTool}
                inputMode="decimal"
                placeholder="0.00000"
              />
            </div>
          </div>

          {/* Risk */}
          <div>
            <span className={labelCls()}>Risk per trade</span>
            <div data-testid="risk-templates" className="flex gap-1.5">
              {RISK_TEMPLATES.map((r) => (
                <button
                  key={r}
                  type="button"
                  className={riskBtnCls(risk === r)}
                  onClick={() => setRiskStr(String(r))}
                >
                  {r}%
                </button>
              ))}
              <input
                data-testid="order-risk"
                className="w-20 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-100 outline-none focus:border-sky-500"
                value={riskStr}
                onChange={(e) => setRiskStr(e.target.value)}
                inputMode="decimal"
                aria-label="Custom risk percent"
              />
            </div>
            <p data-testid="size-preview" className="mt-1 text-[10px] text-zinc-500">
              {sizeValid
                ? `Position size ≈ ${size.toLocaleString('en-US', { maximumFractionDigits: 0 })} units · ${
                    orderType === 'market' ? '≈ ' : ''
                  }${(size * Math.abs(sl - sizeEntry)).toLocaleString('en-US', {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2
                  })} risked`
                : 'Set entry + stop-loss to preview size'}
            </p>
          </div>

          {error && (
            <p data-testid="order-error" className="text-xs text-rose-400">
              {error}
            </p>
          )}

          <div className="flex items-center justify-between gap-3 pt-1">
            <span className="text-[11px] text-zinc-500">
              Balance{' '}
              <span className="font-mono text-zinc-300">
                ${balance.toLocaleString('en-US', { maximumFractionDigits: 2 })}
              </span>
            </span>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={onClose}>
                Cancel
              </Button>
              <Button
                data-testid="confirm-order"
                size="sm"
                onClick={handleSubmit}
                disabled={!session || risk <= 0}
              >
                Place {ORDER_TYPE_OPTIONS.find((o) => o.value === orderType)?.label} order
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
