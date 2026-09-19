import { useEffect, useRef, useState } from 'react'
import {
  Calendar as CalendarIcon,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Gauge,
  Pause,
  Play,
  SkipBack,
  SkipForward
} from 'lucide-react'
import { cn } from 'cn'
import { Button } from '@/components/ui/button'
import { Calendar } from '@/components/ui/calendar'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Field, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Slider } from '@/components/ui/slider'
import {
  indexAtOrAfter,
  sessionBaseCandles,
  revealedTime,
  stepIndexForTimeframe,
  useSessionStore
} from '@/store/session'
import { lastSltpCloseIndex } from '@/store/trading'
import { formatDateUtc, parseDateUtc } from '@/lib/dates'

/**
 * Playback control panel (Phase 4 wires the loop).
 *
 * Play/Pause drives a `setInterval` that advances the store's `currentIndex`
 * one candle per tick (delay from the speed slider); VelaChart reacts to the
 * index change and re-slices the chart. Step Forward/Back, Skip to start/end,
 * and Go To (jump to a date) move the index directly — the chart re-slices on
 * any index change, whatever the size of the jump.
 */

/** Interval delay (ms) for a speed value (1..120): 120 → 50 ms (20 bars/s). */
function delayForSpeed(speed: number): number {
  return Math.round((121 - speed) * 50)
}

function formatUtc(ms: number | undefined): string {
  if (ms === undefined) return '—'
  const d = new Date(ms)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`
}

type JumpTarget = 'next_day' | 'new_york' | 'asia' | 'london'

const JUMP_TARGETS: Array<{ value: JumpTarget; label: string }> = [
  { value: 'next_day', label: 'Next Day Open' },
  { value: 'new_york', label: 'New York Open' },
  { value: 'asia', label: 'Asian Open' },
  { value: 'london', label: 'London Open' }
]

interface DateParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
}

function partsInZone(timestamp: number, timeZone: string): DateParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    hourCycle: 'h23'
  }).formatToParts(new Date(timestamp))
  const value = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? 0)
  return {
    year: value('year'),
    month: value('month'),
    day: value('day'),
    hour: value('hour'),
    minute: value('minute')
  }
}

/** Convert a wall-clock date in an IANA zone to UTC, including historical DST. */
function zonedWallTimeUtc(date: DateParts, timeZone: string, hour: number, minute: number): number {
  const desired = Date.UTC(date.year, date.month - 1, date.day, hour, minute)
  let candidate = desired
  // Two passes resolve the zone offset; a third is harmless around DST edges.
  for (let i = 0; i < 3; i += 1) {
    const actual = partsInZone(candidate, timeZone)
    candidate +=
      desired - Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute)
  }
  return candidate
}

function nextSessionTimestamp(after: number, target: JumpTarget): number {
  if (target === 'next_day') {
    const d = new Date(after)
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)
  }
  if (target === 'asia') {
    // 07:00 in UTC+7 is a fixed 00:00 UTC: no seasonal timezone adjustment.
    const d = new Date(after)
    let candidate = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
    if (candidate <= after) candidate += 86_400_000
    return candidate
  }
  const zone = 'America/New_York'
  const local = partsInZone(after, zone)
  const [hour, minute] = target === 'new_york' ? [9, 29] : [2, 59]
  let candidate = zonedWallTimeUtc(local, zone, hour, minute)
  if (candidate <= after) {
    const tomorrow = new Date(Date.UTC(local.year, local.month - 1, local.day + 1))
    candidate = zonedWallTimeUtc(
      {
        year: tomorrow.getUTCFullYear(),
        month: tomorrow.getUTCMonth() + 1,
        day: tomorrow.getUTCDate(),
        hour: 0,
        minute: 0
      },
      zone,
      hour,
      minute
    )
  }
  return candidate
}

export default function PlaybackPanel(): React.JSX.Element {
  const session = useSessionStore((s) => s.session)
  const currentIndex = useSessionStore((s) => s.currentIndex)
  const playing = useSessionStore((s) => s.playing)
  const speed = useSessionStore((s) => s.speed)
  const orders = useSessionStore((s) => s.orders)

  const baseCandles = sessionBaseCandles(session)
  const totalCandles = baseCandles.length
  // The readout shows the last revealed candle INCLUDING run-up context: at
  // index 0 that's the run-up day's last candle, so a fresh session reads e.g.
  // "2024-01-02 23:59 UTC" (yesterday's close) instead of '—'.
  const currentTime = revealedTime(session, currentIndex)

  const togglePlay = useSessionStore((s) => s.togglePlay)
  const stepForward = useSessionStore((s) => s.stepForward)
  const stepBackward = useSessionStore((s) => s.stepBackward)
  const skipToStart = useSessionStore((s) => s.skipToStart)
  const skipToEnd = useSessionStore((s) => s.skipToEnd)
  const goToTimestamp = useSessionStore((s) => s.goToTimestamp)
  const setSpeed = useSessionStore((s) => s.setSpeed)
  const playbackTimeframe = useSessionStore((s) => s.playbackTimeframe)
  const flattenPositions = useSessionStore((s) => s.flattenPositions)
  const dismissRewindWarning = useSessionStore((s) => s.dismissRewindWarning)

  const [gotoDate, setGotoDate] = useState('')
  const [gotoMenuOpen, setGotoMenuOpen] = useState(false)
  const [calendarOpen, setCalendarOpen] = useState(false)

  // Go-back flow dialogs. Every backward move funnels through `attemptBackward`:
  //  - while a position is OPEN a dialog offers Close Now / Nevermind (closing
  //    flattens the position, then the move proceeds);
  //  - once flat, if the move reaches the most recent SL/TP exit, a second
  //    dialog warns the taken positions (and their PnL) will be gone, with a
  //    "don't ask again this session" checkbox.
  const [pendingBack, setPendingBack] = useState<{
    action: () => void
    target: number | undefined
  } | null>(null)
  const [closeDialogOpen, setCloseDialogOpen] = useState(false)
  const [warnDialogOpen, setWarnDialogOpen] = useState(false)
  const [warnChecked, setWarnChecked] = useState(false)

  // Playback loop: advance one candle per tick while playing. The interval is
  // re-armed only when play state or speed changes.
  useEffect(() => {
    if (!playing) return
    const id = window.setInterval(() => {
      const st = useSessionStore.getState()
      if (st.currentIndex >= sessionBaseCandles(st.session).length) {
        st.pause()
        return
      }
      st.advance()
    }, delayForSpeed(speed))
    return () => window.clearInterval(id)
  }, [playing, speed])

  /** Route a user's backward move through the guard dialogs. `target` is the
   *  destination index the move will land on (`undefined` when not known
   *  cheaply) — read live from the store so the decision is always current. */
  const attemptBackward = (action: () => void, target: number | undefined): void => {
    const st = useSessionStore.getState()
    const flat = !st.orders.some((order) => order.status === 'filled')
    if (!flat) {
      setPendingBack({ action, target })
      setCloseDialogOpen(true)
      return
    }
    if (target !== undefined && !st.rewindWarningDismissed) {
      const boundary = lastSltpCloseIndex(st.orders)
      if (boundary !== undefined && target <= boundary) {
        setPendingBack({ action, target })
        setWarnChecked(false)
        setWarnDialogOpen(true)
        return
      }
    }
    action()
  }
  // Latest-handler ref so the (single) keyboard listener always routes through
  // the current dialog funnel without re-subscribing on every render. Refs are
  // only written in an effect (never during render).
  const attemptBackwardRef = useRef(attemptBackward)
  useEffect(() => {
    attemptBackwardRef.current = attemptBackward
  })

  // Keyboard shortcuts: Space = Play/Pause, Ctrl+Space = step forward,
  // Shift+Space = step back. Ignored while typing in a field or inside any
  // open overlay (Go To dropdown, modals) so native Space behavior wins there.
  // Reads store state live so the handlers never go stale with the loop.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.code !== 'Space') return
      const target = event.target as HTMLElement | null
      const inOverlay =
        target !== null &&
        target.closest(
          '[role="menu"], [role="menuitem"], [role="dialog"], [role="listbox"], [role="option"]'
        ) !== null
      const editable =
        target !== null &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      if (inOverlay || editable) return
      const st = useSessionStore.getState()
      if (!st.session) return
      if (event.ctrlKey && event.metaKey) return
      if (event.ctrlKey) {
        // Holding Ctrl+Space steps repeatedly.
        event.preventDefault()
        st.stepForward()
      } else if (event.shiftKey) {
        // Holding Shift+Space steps back repeatedly — routed through the
        // go-back dialog flow.
        event.preventDefault()
        const target = stepIndexForTimeframe(st.session, st.currentIndex, st.playbackTimeframe, -1)
        attemptBackwardRef.current(st.stepBackward, target)
      } else if (!event.metaKey && !event.altKey) {
        // Ignore key repeats so holding Space doesn't jitter play/pause.
        if (event.repeat) return
        event.preventDefault()
        st.togglePlay()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  // Dialog confirmations.
  const confirmCloseNow = (): void => {
    const pending = pendingBack
    setPendingBack(null)
    setCloseDialogOpen(false)
    flattenPositions()
    // Re-run the funnel: flat now, so it either executes or warns (rewind).
    if (pending) attemptBackward(pending.action, pending.target)
  }
  const cancelCloseNow = (): void => {
    setPendingBack(null)
    setCloseDialogOpen(false)
  }
  const confirmWarnRewind = (): void => {
    if (warnChecked) dismissRewindWarning()
    const pending = pendingBack
    setPendingBack(null)
    setWarnDialogOpen(false)
    if (pending) pending.action()
  }
  const cancelWarnRewind = (): void => {
    setPendingBack(null)
    setWarnDialogOpen(false)
  }

  const goTo = (): void => {
    if (!gotoDate) return
    const [y, m, d] = gotoDate.split('-').map(Number)
    if (!y || !m || !d) return
    setGotoMenuOpen(false)
    const ts = Date.UTC(y, m - 1, d)
    const st = useSessionStore.getState()
    const target = indexAtOrAfter(sessionBaseCandles(st.session), ts)
    // A custom-date jump behind the clock is a backward move: go through the
    // guard dialogs so an open position can't silently be rewound.
    if (target < st.currentIndex) {
      attemptBackward(() => goToTimestamp(ts), target)
    } else {
      goToTimestamp(ts)
    }
  }
  const goToSessionTarget = (target: JumpTarget): void => {
    if (currentTime === undefined) return
    goToTimestamp(nextSessionTimestamp(currentTime, target))
  }

  const enabled = session !== null
  // Backward moves are locked while a position is open — close it first.
  const inPosition = orders.some((order) => order.status === 'filled')

  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-border bg-card px-4 py-2.5">
      <div className="flex items-center gap-1.5">
        <span className="mr-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Playback
        </span>

        <Button
          variant="outline"
          size="icon"
          disabled={!enabled}
          onClick={() => attemptBackward(skipToStart, 0)}
          title={inPosition ? 'You must close your position first' : 'Skip to start'}
          aria-label="Skip to start"
        >
          <SkipBack />
        </Button>
        <Button
          variant="outline"
          size="icon"
          disabled={!enabled}
          onClick={() =>
            attemptBackward(
              stepBackward,
              stepIndexForTimeframe(session, currentIndex, playbackTimeframe, -1)
            )
          }
          data-testid="playback-step-back"
          title={inPosition ? 'You must close your position first' : 'Step back'}
          aria-label="Step back"
        >
          <ChevronLeft />
        </Button>

        <Button
          size="sm"
          data-testid="playback-play"
          className="mx-1 min-w-[84px] disabled:opacity-40"
          disabled={!enabled}
          onClick={() => {
            // Restarting from the end is a rewind to candle 0 — route it
            // through the go-back dialogs when a position is still open.
            if (currentIndex >= totalCandles && inPosition) {
              attemptBackward(togglePlay, 0)
              return
            }
            togglePlay()
          }}
          title={playing ? 'Pause' : 'Play'}
        >
          {playing ? <Pause /> : <Play />}
          {playing ? 'Pause' : 'Play'}
        </Button>

        <Button
          variant="outline"
          size="icon"
          disabled={!enabled}
          onClick={stepForward}
          data-testid="playback-step"
          title="Step forward"
          aria-label="Step forward"
        >
          <ChevronRight />
        </Button>
        <Button
          variant="outline"
          size="icon"
          disabled={!enabled}
          onClick={skipToEnd}
          title="Skip to end"
          aria-label="Skip to end"
        >
          <SkipForward />
        </Button>
      </div>

      <div className="flex items-center gap-5">
        <DropdownMenu
          open={gotoMenuOpen}
          onOpenChange={(next) => {
            setGotoMenuOpen(next)
            if (!next) setCalendarOpen(false)
          }}
        >
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="gap-1"
              disabled={!enabled || currentTime === undefined}
              data-testid="playback-session-goto-btn"
            >
              Go To
              <ChevronUp
                className={cn('transition-transform duration-200', gotoMenuOpen && 'rotate-180')}
              />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-64">
            <DropdownMenuGroup>
              {JUMP_TARGETS.map((target) => (
                <DropdownMenuItem
                  key={target.value}
                  disabled={!enabled}
                  onSelect={() => goToSessionTarget(target.value)}
                >
                  {target.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>

            <DropdownMenuSeparator />

            <DropdownMenuGroup>
              <DropdownMenuItem
                onSelect={(e) => {
                  e.preventDefault()
                  setCalendarOpen((prev) => !prev)
                }}
                className="cursor-pointer justify-between"
              >
                <span className="flex items-center gap-2">
                  <CalendarIcon />
                  <span>Custom Date</span>
                </span>
                <ChevronDown
                  className={cn('transition-transform duration-200', calendarOpen && 'rotate-180')}
                />
              </DropdownMenuItem>
            </DropdownMenuGroup>

            <div className="flex flex-col gap-2 p-1.5 pt-0.5">
              <div className="flex items-center gap-1.5">
                <Input
                  type="text"
                  data-testid="playback-goto-date"
                  value={gotoDate}
                  placeholder="YYYY-MM-DD"
                  maxLength={10}
                  onChange={(e) => setGotoDate(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      goTo()
                    }
                  }}
                  className="h-7 min-w-0 flex-1 text-xs"
                />
                <Button
                  size="xs"
                  disabled={!enabled || !gotoDate}
                  onClick={goTo}
                  data-testid="playback-goto-btn"
                >
                  Go
                </Button>
              </div>

              {calendarOpen && (
                <div className="pt-1">
                  <Calendar
                    mode="single"
                    captionLayout="dropdown"
                    className="mx-auto rounded-md border border-border/50 bg-background/50 p-2"
                    selected={parseDateUtc(gotoDate)}
                    defaultMonth={
                      parseDateUtc(gotoDate) ?? parseDateUtc(session?.startDate ?? '') ?? new Date()
                    }
                    startMonth={parseDateUtc(session?.startDate ?? '') ?? new Date(2020, 0, 1)}
                    endMonth={parseDateUtc(session?.endDate ?? '') ?? new Date()}
                    disabled={(day) => {
                      const start = parseDateUtc(session?.startDate ?? '')
                      const end = parseDateUtc(session?.endDate ?? '')
                      if (start && day < start) return true
                      if (end && day > end) return true
                      return false
                    }}
                    onSelect={(day) => {
                      const next = formatDateUtc(day)
                      if (next) setGotoDate(next)
                    }}
                  />
                </div>
              )}
            </div>
          </DropdownMenuContent>
        </DropdownMenu>

        <div className="flex items-center gap-2">
          <Gauge className="size-3.5 text-muted-foreground" />
          <Slider
            data-testid="playback-speed"
            className="w-32 [&_[data-slot='slider-track']]:bg-muted-foreground/20 [&_[data-slot='slider-range']]:bg-chart-2 [&_[data-slot='slider-thumb']]:border-chart-2 [&_[data-slot='slider-thumb']]:ring-chart-2/40"
            min={1}
            max={120}
            step={1}
            value={[speed]}
            onValueChange={(v) => setSpeed(v[0] ?? 1)}
            disabled={!enabled}
            aria-label="Playback speed"
            title="Playback speed"
          />
          <span className="w-14 text-right font-mono text-xs text-muted-foreground">{speed}×</span>
        </div>

        <div className="text-right font-mono text-xs text-muted-foreground">
          <div>
            <span data-testid="playback-index">{currentIndex}</span>/
            <span data-testid="playback-total">{totalCandles}</span> candles
          </div>
          <div data-testid="playback-time" className="text-[10px] text-muted-foreground">
            {formatUtc(currentTime)}
          </div>
        </div>
      </div>

      {/* Go-back while a position is open: offer to close it first. */}
      {closeDialogOpen && pendingBack !== null && (
        <Dialog
          open
          onOpenChange={(next) => {
            if (!next) cancelCloseNow()
          }}
        >
          <DialogContent showCloseButton={false} className="max-w-sm">
            <DialogHeader>
              <DialogTitle>You&apos;re still in a position</DialogTitle>
              <DialogDescription>
                Going back requires closing your position first. Close it now at the current market
                price, or stay where you are.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={cancelCloseNow}>
                Nevermind
              </Button>
              <Button onClick={confirmCloseNow} data-testid="rewind-close-now">
                Close Now
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {/* Rewind warning: going back erases the positions (and PnL) taken. */}
      {warnDialogOpen && pendingBack !== null && (
        <Dialog
          open
          onOpenChange={(next) => {
            if (!next) cancelWarnRewind()
          }}
        >
          <DialogContent showCloseButton={false} className="max-w-sm">
            <DialogHeader>
              <DialogTitle>Going back</DialogTitle>
              <DialogDescription>
                If you go back, the positions you took will be gone — the account rewinds to before
                those trades and their PnL disappears.
              </DialogDescription>
            </DialogHeader>
            <Field orientation="horizontal" className="items-start gap-2">
              <Checkbox
                id="rewind-skip-warning"
                checked={warnChecked}
                onCheckedChange={(c) => setWarnChecked(c === true)}
              />
              <FieldLabel htmlFor="rewind-skip-warning" className="font-normal">
                Don&apos;t show this dialog for the rest of this session
              </FieldLabel>
            </Field>
            <DialogFooter>
              <Button variant="outline" onClick={cancelWarnRewind}>
                Stay here
              </Button>
              <Button onClick={confirmWarnRewind} data-testid="rewind-confirm">
                Go Back
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}
