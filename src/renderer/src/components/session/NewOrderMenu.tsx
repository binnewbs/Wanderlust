import { useMemo, useState } from 'react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { sessionBaseCandles, sessionBaseRunUp, useSessionStore } from '@/store/session'
import { sizeForRisk, type OrderType, type TradeDirection } from '@/store/trading'
import { positionAnchorsOf, velaChartRef } from '@/components/chart/chartBridge'

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
    // Snapshot the live drawing at the confirmation click. This is a final
    // guard against an event/render boundary after the user has just dragged a
    // position-tool handle, so the submitted order always gets its last
    // on-chart entry/SL/TP values.
    const live = selectedDrawing
      ? positionAnchorsOf(velaChartRef.current, selectedDrawing.drawingId)
      : null
    const submitEntry = live?.entry ?? entry
    const submitStop = live?.stop ?? sl
    const submitTarget = live?.target ?? tp
    const submitDirection: TradeDirection = live
      ? live.target >= live.entry
        ? 'long'
        : 'short'
      : direction
    submitOrder({
      drawingId: selectedDrawing?.drawingId,
      orderType,
      direction: submitDirection,
      orderPrice: submitEntry,
      stopLoss: submitStop,
      takeProfit: submitTarget,
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
      <Badge variant="outline" className="border-chart-2/40 bg-chart-2/10 text-chart-2">
        ▲ LONG
      </Badge>
    ) : (
      <Badge variant="outline" className="border-destructive/40 bg-destructive/10 text-destructive">
        ▼ SHORT
      </Badge>
    )

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>New order</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          {/* Source banner: chart tool or manual */}
          {fromTool ? (
            <Alert
              data-testid="order-source"
              className="border-chart-2/40 bg-chart-2/10 text-chart-2"
            >
              <AlertTitle>From chart tool</AlertTitle>
              <AlertDescription>
                {selectedDrawing!.direction === 'long' ? 'Long' : 'Short'} position drawing · SL/TP
                locked to the tool
              </AlertDescription>
            </Alert>
          ) : (
            <Alert data-testid="order-source">
              <AlertTitle>Manual order</AlertTitle>
              <AlertDescription>
                Set entry, stop-loss and take-profit below (no position tool selected).
              </AlertDescription>
            </Alert>
          )}

          {/* Order type */}
          <Field>
            <FieldLabel>Order type</FieldLabel>
            <Tabs
              value={orderType}
              onValueChange={(v) => setOrderType(v as OrderType)}
              data-testid="order-type"
              className="w-full"
            >
              <TabsList className="grid w-full grid-cols-3">
                {ORDER_TYPE_OPTIONS.map((o) => (
                  <TabsTrigger key={o.value} value={o.value}>
                    {o.label}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          </Field>

          {/* Direction */}
          <Field>
            <FieldLabel>Direction</FieldLabel>
            {fromTool ? (
              <div className="flex items-center gap-2">{dirChip}</div>
            ) : (
              <Tabs
                value={direction}
                onValueChange={(v) => setDirection(v as TradeDirection)}
                className="w-full"
              >
                <TabsList className="grid w-full grid-cols-2">
                  <TabsTrigger
                    value="long"
                    data-testid="dir-long"
                    className="data-[state=active]:text-chart-2"
                  >
                    Long
                  </TabsTrigger>
                  <TabsTrigger
                    value="short"
                    data-testid="dir-short"
                    className="data-[state=active]:text-destructive"
                  >
                    Short
                  </TabsTrigger>
                </TabsList>
              </Tabs>
            )}
          </Field>

          {/* Levels */}
          <div className="grid grid-cols-3 gap-2">
            <Field>
              <FieldLabel>Entry</FieldLabel>
              <Input
                data-testid="order-entry"
                value={entryLockedToMarket ? 'Market' : entryStr}
                onChange={(e) => setEntryStr(e.target.value)}
                disabled={entryLockedToMarket}
                inputMode="decimal"
                placeholder={entryLockedToMarket ? 'Market' : '0.00000'}
              />
              {entryLockedToMarket && (
                <FieldDescription>Fills on the next candle open</FieldDescription>
              )}
            </Field>
            <Field>
              <FieldLabel>Stop-loss</FieldLabel>
              <Input
                data-testid="order-sl"
                value={slStr}
                onChange={(e) => setSlStr(e.target.value)}
                disabled={fromTool}
                inputMode="decimal"
                placeholder="0.00000"
              />
            </Field>
            <Field>
              <FieldLabel>Take-profit</FieldLabel>
              <Input
                data-testid="order-tp"
                value={tpStr}
                onChange={(e) => setTpStr(e.target.value)}
                disabled={fromTool}
                inputMode="decimal"
                placeholder="0.00000"
              />
            </Field>
          </div>

          {/* Risk */}
          <Field>
            <FieldLabel>Risk per trade</FieldLabel>
            <div className="flex items-center gap-1.5">
              <ToggleGroup
                type="single"
                data-testid="risk-templates"
                value={RISK_TEMPLATES.some((r) => risk === r) ? String(risk) : undefined}
                onValueChange={(v) => v && setRiskStr(v)}
              >
                {RISK_TEMPLATES.map((r) => (
                  <ToggleGroupItem key={r} value={String(r)}>
                    {r}%
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
              <Input
                data-testid="order-risk"
                className="w-20"
                value={riskStr}
                onChange={(e) => setRiskStr(e.target.value)}
                inputMode="decimal"
                aria-label="Custom risk percent"
              />
            </div>
            <p data-testid="size-preview" className="text-xs text-muted-foreground">
              {sizeValid
                ? `Position size ≈ ${size.toLocaleString('en-US', { maximumFractionDigits: 0 })} units · ${
                    orderType === 'market' ? '≈ ' : ''
                  }${(size * Math.abs(sl - sizeEntry)).toLocaleString('en-US', {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2
                  })} risked`
                : 'Set entry + stop-loss to preview size'}
            </p>
          </Field>

          {error && (
            <Alert variant="destructive" data-testid="order-error">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </div>

        <DialogFooter className="sm:justify-between">
          <div className="flex items-center text-xs text-muted-foreground">
            Balance{' '}
            <span className="ml-1 font-mono text-foreground">
              ${balance.toLocaleString('en-US', { maximumFractionDigits: 2 })}
            </span>
          </div>
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
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
