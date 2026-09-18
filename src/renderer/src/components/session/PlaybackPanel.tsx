import { useEffect, useState } from 'react'
import { ChevronLeft, ChevronRight, Gauge, Pause, Play, SkipBack, SkipForward } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { sessionBaseCandles, revealedTime, useSessionStore } from '@/store/session'

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

export default function PlaybackPanel(): React.JSX.Element {
  const session = useSessionStore((s) => s.session)
  const currentIndex = useSessionStore((s) => s.currentIndex)
  const playing = useSessionStore((s) => s.playing)
  const speed = useSessionStore((s) => s.speed)

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

  const [gotoDate, setGotoDate] = useState('')

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

  const goTo = (): void => {
    if (!gotoDate) return
    const [y, m, d] = gotoDate.split('-').map(Number)
    if (!y || !m || !d) return
    goToTimestamp(Date.UTC(y, m - 1, d))
  }

  const enabled = session !== null
  const ctlCls =
    'inline-flex items-center justify-center rounded-md border border-zinc-700 bg-zinc-900 p-2 text-zinc-300 disabled:cursor-not-allowed disabled:opacity-40'

  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-zinc-800 bg-zinc-900/80 px-4 py-2.5">
      <div className="flex items-center gap-1.5">
        <span className="mr-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-600">
          Playback
        </span>

        <button
          className={ctlCls}
          disabled={!enabled}
          onClick={skipToStart}
          title="Skip to start"
          aria-label="Skip to start"
        >
          <SkipBack className="size-4" />
        </button>
        <button
          className={ctlCls}
          disabled={!enabled}
          onClick={stepBackward}
          data-testid="playback-step-back"
          title="Step back"
          aria-label="Step back"
        >
          <ChevronLeft className="size-4" />
        </button>

        <Button
          size="sm"
          data-testid="playback-play"
          className={
            'mx-1 min-w-[84px] text-white disabled:opacity-40 ' +
            (playing ? 'bg-amber-600 hover:bg-amber-500' : 'bg-sky-600 hover:bg-sky-500')
          }
          disabled={!enabled}
          onClick={togglePlay}
          title={playing ? 'Pause' : 'Play'}
        >
          {playing ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
          {playing ? 'Pause' : 'Play'}
        </Button>

        <button
          className={ctlCls}
          disabled={!enabled}
          onClick={stepForward}
          data-testid="playback-step"
          title="Step forward"
          aria-label="Step forward"
        >
          <ChevronRight className="size-4" />
        </button>
        <button
          className={ctlCls}
          disabled={!enabled}
          onClick={skipToEnd}
          title="Skip to end"
          aria-label="Skip to end"
        >
          <SkipForward className="size-4" />
        </button>
      </div>

      <div className="flex items-center gap-5">
        <div className="flex items-center gap-2">
          <label className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">
            Go to
          </label>
          <input
            type="date"
            data-testid="playback-goto-date"
            value={gotoDate}
            min={session?.startDate}
            max={session?.endDate}
            onChange={(e) => setGotoDate(e.target.value)}
            className="rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-300 outline-none"
          />
          <button
            className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
            disabled={!enabled || !gotoDate}
            onClick={goTo}
            data-testid="playback-goto-btn"
          >
            Go
          </button>
        </div>

        <div className="flex items-center gap-2">
          <Gauge className="size-3.5 text-zinc-600" />
          <input
            type="range"
            min={1}
            max={120}
            data-testid="playback-speed"
            value={speed}
            disabled={!enabled}
            onChange={(e) => setSpeed(Number(e.target.value))}
            className="w-32 accent-sky-500 disabled:opacity-40"
            title="Playback speed"
          />
          <span className="w-14 text-right font-mono text-xs text-zinc-400">{speed}×</span>
        </div>

        <div className="text-right font-mono text-xs text-zinc-400">
          <div>
            <span data-testid="playback-index">{currentIndex}</span>/
            <span data-testid="playback-total">{totalCandles}</span> candles
          </div>
          <div data-testid="playback-time" className="text-[10px] text-zinc-500">
            {formatUtc(currentTime)}
          </div>
        </div>
      </div>
    </div>
  )
}
