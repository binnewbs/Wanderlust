import { ChevronLeft, ChevronRight, Gauge, Pause, Play, SkipBack, SkipForward } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { sessionBaseCandles, useSessionStore } from '@/store/session'

/**
 * Playback control panel (Phase 3 renders the shell).
 *
 * The plan ships the panel now — Play / Pause, Step Forward/Back, Go To, and a
 * speed slider — and wires them in Phase 4 (the playback loop that slices
 * `masterCandleArray` by `currentIndex`). The controls are therefore rendered
 * but disabled until that phase lands; the store fields they will drive
 * (`currentIndex`, `playing`, `speed`) already exist.
 */

const phaseHint = 'Available in Phase 4 (playback loop)'

export default function PlaybackPanel(): React.JSX.Element {
  const currentIndex = useSessionStore((s) => s.currentIndex)
  const playing = useSessionStore((s) => s.playing)
  const speed = useSessionStore((s) => s.speed)
  const session = useSessionStore((s) => s.session)
  const totalCandles = sessionBaseCandles(session).length

  const ctlCls =
    'inline-flex items-center justify-center rounded-md border border-zinc-700 bg-zinc-900 p-2 text-zinc-500 disabled:cursor-not-allowed disabled:opacity-40'

  return (
    <div className="flex items-center justify-between gap-3 border-t border-zinc-800 bg-zinc-900/80 px-4 py-2.5">
      <div className="flex items-center gap-1.5">
        <span className="mr-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-600">
          Playback
        </span>

        <button className={ctlCls} disabled title={phaseHint} aria-label="Skip to start">
          <SkipBack className="size-4" />
        </button>
        <button className={ctlCls} disabled title={phaseHint} aria-label="Step back">
          <ChevronLeft className="size-4" />
        </button>

        <Button
          size="sm"
          className={
            'mx-1 min-w-[84px] bg-sky-600 text-white hover:bg-sky-500 disabled:opacity-40 ' +
            (playing ? 'bg-amber-600 hover:bg-amber-500' : '')
          }
          disabled
          title={phaseHint}
        >
          {playing ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
          {playing ? 'Pause' : 'Play'}
        </Button>

        <button className={ctlCls} disabled title={phaseHint} aria-label="Step forward">
          <ChevronRight className="size-4" />
        </button>
        <button className={ctlCls} disabled title={phaseHint} aria-label="Skip to end">
          <SkipForward className="size-4" />
        </button>
      </div>

      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2">
          <label className="text-[10px] font-medium uppercase tracking-wider text-zinc-500">
            Go to
          </label>
          <input
            type="date"
            disabled
            title={phaseHint}
            className="rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-400 outline-none disabled:opacity-40"
          />
        </div>

        <div className="flex items-center gap-2">
          <Gauge className="size-3.5 text-zinc-600" />
          <input
            type="range"
            min={1}
            max={120}
            value={speed}
            disabled
            title={phaseHint}
            className="w-32 accent-sky-500 disabled:opacity-40"
          />
          <span className="w-8 text-right font-mono text-xs text-zinc-500">{speed}×</span>
        </div>
      </div>

      <div className="font-mono text-xs text-zinc-500">
        <span data-testid="playback-index">{currentIndex}</span>/{totalCandles} candles
      </div>
    </div>
  )
}
