import { useMemo, useState } from 'react'
import { AlertTriangle, CalendarIcon, Download } from 'lucide-react'
import { cn } from 'cn'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Calendar } from '@/components/ui/calendar'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput
} from '@/components/ui/input-group'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { daysAgoUtc, formatDateUtc, parseDateUtc, sanitizeDateInput, todayUtc } from '@/lib/dates'
import { Progress } from '@/components/ui/progress'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { ASSETS, ASSET_BY_ID } from '@shared/assets'
import type { Asset } from '@shared/assets'
import { TIMEFRAMES, TIMEFRAME_LABELS, type Timeframe } from '@shared/timeframes'
import { useSessionStore } from '@/store/session'

/**
 * New Session modal (Phase 3): pick an asset, the chart's initial timeframe,
 * a date range and starting balance, then kick off the cache-first download.
 * The session downloads EVERY timeframe for the range in one batch; while the
 * main process works, the modal becomes a progress panel driven by the IPC
 * progress events streamed into the session store.
 */

const CATEGORIES = Array.from(new Set(ASSETS.map((a) => a.category)))

/**
 * The chart-timeframe picker is currently hidden: a future feature lets the
 * user pick WHICH timeframes to download and use. Flip this to `true` to
 * re-enable the picker block below.
 */
const TIMEFRAME_PICKER_ENABLED = false

export interface NewSessionModalProps {
  open: boolean
  onClose: () => void
}

export default function NewSessionModal({
  open,
  onClose
}: NewSessionModalProps): React.JSX.Element | null {
  const status = useSessionStore((s) => s.status)
  const progress = useSessionStore((s) => s.progress)
  const error = useSessionStore((s) => s.error)
  const startSession = useSessionStore((s) => s.startSession)
  const dismissError = useSessionStore((s) => s.dismissError)

  const [sessionName, setSessionName] = useState('EUR/USD M1 Replay')
  const [assetId, setAssetId] = useState('eurusd')
  const [timeframe, setTimeframe] = useState<Timeframe>('m1')
  // Default range: the trailing 30 calendar days ending today (UTC). Both ends
  // are capped at "today" — there is no data past the present to download.
  const today = todayUtc()
  const maxDay = parseDateUtc(today)
  const [startDate, setStartDate] = useState(daysAgoUtc(30))
  const [endDate, setEndDate] = useState(today)
  const [balanceStr, setBalanceStr] = useState('100000')
  // Popover visibility per date field — closed once a day is picked.
  const [fromOpen, setFromOpen] = useState(false)
  const [toOpen, setToOpen] = useState(false)

  // NOTE: the form is intentionally NOT reset here — App remounts this modal
  // with a fresh `key` on every open, so state starts at the defaults above.

  const asset: Asset | undefined = ASSET_BY_ID[assetId]
  const balance = Number(balanceStr)

  const valid = useMemo(() => {
    const s = Date.parse(`${startDate}T00:00:00Z`)
    const e = Date.parse(`${endDate}T00:00:00Z`)
    const cap = maxDay ? maxDay.getTime() : Number.POSITIVE_INFINITY
    return (
      sessionName.trim().length > 0 &&
      !!asset &&
      Number.isFinite(s) &&
      Number.isFinite(e) &&
      e >= s &&
      s <= cap &&
      e <= cap &&
      balance > 0
    )
  }, [sessionName, asset, startDate, endDate, balance, maxDay])

  const handleStart = async (): Promise<void> => {
    if (!valid || !asset) return
    await startSession({
      name: sessionName.trim(),
      asset,
      timeframe,
      startDate,
      endDate,
      balance
    })
    // startSession settles with 'ready' (success) or 'error'. On success the
    // session screen takes over, so close the modal; on error it stays open
    // showing the failure with a retry path.
    if (useSessionStore.getState().status === 'ready') onClose()
  }

  const latest = progress[progress.length - 1]

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Lock the dialog shut while the download is running.
        if (!next && status !== 'downloading') onClose()
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>New backtest session</DialogTitle>
          <DialogDescription>
            Download every timeframe for the range in one batch — cached locally for reuse.
          </DialogDescription>
        </DialogHeader>

        {status === 'downloading' ? (
          /* -------- Loading state: progress streamed over IPC -------- */
          <div className="flex animate-in fade-in zoom-in-95 flex-col gap-3 duration-200">
            <p className="text-xs text-muted-foreground">
              Downloading {asset?.label ?? assetId} {timeframe} · {startDate} → {endDate}
            </p>
            <Progress value={latest?.percent ?? 0} className="progress-shimmer" />
            <p className="font-mono text-xs text-foreground">
              {latest?.message ?? 'Starting…'}
              {latest?.percent !== undefined && (
                <span className="text-muted-foreground"> ({latest.percent}%)</span>
              )}
            </p>
            <ul className="flex max-h-28 flex-col gap-0.5 overflow-y-auto font-mono text-[11px] text-muted-foreground">
              {progress.slice(0, -1).map((event, i) => (
                <li key={i} className="animate-in fade-in slide-in-from-left-1 duration-200">
                  {event.message}
                </li>
              ))}
            </ul>
          </div>
        ) : status === 'error' ? (
          /* -------- Download failed -------- */
          <>
            <Alert
              variant="destructive"
              className="animate-in fade-in slide-in-from-top-1 duration-200"
            >
              <AlertTriangle className="size-4 shrink-0" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
            <DialogFooter>
              <Button variant="outline" size="sm" onClick={onClose}>
                Cancel
              </Button>
              <Button size="sm" onClick={dismissError}>
                Try again
              </Button>
            </DialogFooter>
          </>
        ) : (
          /* -------- The form -------- */
          <>
            <FieldGroup className="gap-4">
              <Field>
                <FieldLabel htmlFor="ns-session-name">Session Name</FieldLabel>
                <Input
                  id="ns-session-name"
                  placeholder="e.g. EUR/USD Jan 2024 Breakouts"
                  value={sessionName}
                  onChange={(e) => setSessionName(e.target.value)}
                  required
                />
                <FieldDescription>
                  Give your session a distinct name to recognize it in the main menu.
                </FieldDescription>
              </Field>

              <Field>
                <FieldLabel>Asset</FieldLabel>
                <Select value={assetId} onValueChange={setAssetId}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Select asset" />
                  </SelectTrigger>
                  <SelectContent>
                    <ScrollArea type="always" className="h-72 w-full pr-1">
                      {CATEGORIES.map((category) => (
                        <SelectGroup key={category}>
                          <SelectLabel>{category}</SelectLabel>
                          {ASSETS.filter((a) => a.category === category).map((a) => (
                            <SelectItem key={a.id} value={a.id}>
                              {a.label}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      ))}
                    </ScrollArea>
                  </SelectContent>
                </Select>
                <FieldDescription>
                  {asset?.category} · Dukascopy id{' '}
                  <code className="text-foreground">{assetId}</code>
                </FieldDescription>
              </Field>

              <div
                className={cn(
                  'grid gap-3',
                  TIMEFRAME_PICKER_ENABLED ? 'grid-cols-2' : 'grid-cols-1'
                )}
              >
                {TIMEFRAME_PICKER_ENABLED && (
                  <Field>
                    <FieldLabel>Chart timeframe</FieldLabel>
                    <Select value={timeframe} onValueChange={(v) => setTimeframe(v as Timeframe)}>
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder="Select timeframe" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          {TIMEFRAMES.map((tf) => (
                            <SelectItem key={tf} value={tf}>
                              {TIMEFRAME_LABELS[tf]}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                    <FieldDescription>
                      Initial view — every timeframe is downloaded, switch on the chart anytime. The
                      previous 24 hours of candles are pre-loaded as run-up context, so the chart
                      starts with a full day of price action instead of a blank screen.
                    </FieldDescription>
                  </Field>
                )}
                <Field>
                  <FieldLabel>Starting balance ($)</FieldLabel>
                  <Input
                    type="number"
                    min={1}
                    step={500}
                    value={balanceStr}
                    onChange={(e) => setBalanceStr(e.target.value)}
                  />
                </Field>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <Field>
                  <FieldLabel>From</FieldLabel>
                  {/* Text input (typed entry) + shadcn Calendar in a popover —
                      no native date picker popup. */}
                  <Popover open={fromOpen} onOpenChange={setFromOpen}>
                    <InputGroup>
                      <InputGroupInput
                        id="ns-date-from"
                        value={startDate}
                        onChange={(e) => setStartDate(sanitizeDateInput(e.target.value, today))}
                        placeholder="YYYY-MM-DD"
                        maxLength={10}
                      />
                      <InputGroupAddon align="inline-end">
                        <PopoverTrigger asChild>
                          <InputGroupButton
                            size="icon-sm"
                            variant="ghost"
                            aria-label="Pick start date from calendar"
                          >
                            <CalendarIcon />
                          </InputGroupButton>
                        </PopoverTrigger>
                      </InputGroupAddon>
                    </InputGroup>
                    <PopoverContent className="w-auto p-0" align="start">
                      <Calendar
                        mode="single"
                        captionLayout="dropdown"
                        startMonth={new Date(2015, 0, 1)}
                        endMonth={maxDay}
                        selected={parseDateUtc(startDate)}
                        defaultMonth={parseDateUtc(startDate) ?? new Date()}
                        // Nothing past UTC today is selectable — there is no
                        // data beyond the present to download.
                        disabled={(day) => (maxDay ? day.getTime() > maxDay.getTime() : false)}
                        onSelect={(day) => {
                          const next = formatDateUtc(day)
                          if (next) setStartDate(next)
                          setFromOpen(false)
                        }}
                      />
                    </PopoverContent>
                  </Popover>
                </Field>
                <Field>
                  <FieldLabel>To</FieldLabel>
                  <Popover open={toOpen} onOpenChange={setToOpen}>
                    <InputGroup>
                      <InputGroupInput
                        id="ns-date-to"
                        value={endDate}
                        onChange={(e) => setEndDate(sanitizeDateInput(e.target.value, today))}
                        placeholder="YYYY-MM-DD"
                        maxLength={10}
                      />
                      <InputGroupAddon align="inline-end">
                        <PopoverTrigger asChild>
                          <InputGroupButton
                            size="icon-sm"
                            variant="ghost"
                            aria-label="Pick end date from calendar"
                          >
                            <CalendarIcon />
                          </InputGroupButton>
                        </PopoverTrigger>
                      </InputGroupAddon>
                    </InputGroup>
                    <PopoverContent className="w-auto p-0" align="start">
                      <Calendar
                        mode="single"
                        captionLayout="dropdown"
                        startMonth={new Date(2015, 0, 1)}
                        endMonth={maxDay}
                        selected={parseDateUtc(endDate)}
                        defaultMonth={
                          parseDateUtc(endDate) ?? parseDateUtc(startDate) ?? new Date()
                        }
                        disabled={(day) => (maxDay ? day.getTime() > maxDay.getTime() : false)}
                        onSelect={(day) => {
                          const next = formatDateUtc(day)
                          if (next) setEndDate(next)
                          setToOpen(false)
                        }}
                      />
                    </PopoverContent>
                  </Popover>
                </Field>
              </div>

              {!valid && (
                <p className="text-xs text-destructive">
                  {balance <= 0
                    ? 'Starting balance must be greater than 0.'
                    : 'Range must be valid and start on or before the end date.'}
                </p>
              )}
            </FieldGroup>
            <DialogFooter>
              <Button variant="outline" size="sm" onClick={onClose}>
                Cancel
              </Button>
              <Button size="sm" disabled={!valid} onClick={handleStart}>
                <Download data-icon="inline-start" />
                Start Session
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
