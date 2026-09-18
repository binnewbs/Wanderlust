import { useState } from 'react'
import { Activity, PlayCircle, Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useSessionStore } from '@/store/session'
import VelaChart from '@/components/chart/VelaChart'
import NewSessionModal from '@/components/session/NewSessionModal'
import PlaybackPanel from '@/components/session/PlaybackPanel'
import TradingPanel from '@/components/session/TradingPanel'

/**
 * Wanderlust — the backtesting session screen (Phase 3).
 *
 * Before a session exists, the main area shows an empty state; the New Session
 * modal collects asset / initial timeframe / range / balance and drives the
 * cache-first download of EVERY timeframe with live progress. Once the data is
 * ready, the Vela workspace is mounted (per-session, keyed by the session's
 * market) with the `wanderlust` data provider serving the session's candles,
 * and the playback control panel docks below the chart. Phase 4 wires the
 * playback controls; Phase 5 adds the trading strip — New Order (seeded by the
 * selected Long/Short Position drawing) driving the simulated account, with
 * tick-by-tick fill/exit evaluation during playback.
 */

const sourceStyles: Record<string, string> = {
  cache: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300',
  dukascopy: 'border-sky-500/40 bg-sky-500/10 text-sky-300',
  mixed: 'border-amber-500/40 bg-amber-500/10 text-amber-300'
}

export default function App(): React.JSX.Element {
  const session = useSessionStore((s) => s.session)
  const status = useSessionStore((s) => s.status)
  const error = useSessionStore((s) => s.error)
  const balance = useSessionStore((s) => s.balance)
  const dismissError = useSessionStore((s) => s.dismissError)

  const [modalOpen, setModalOpen] = useState(false)
  // Bumped on every open so the modal remounts with a fresh key — its form
  // state (asset/range/balance) resets to defaults without a reset effect.
  const [modalNonce, setModalNonce] = useState(0)

  const openModal = (): void => {
    setModalNonce((n) => n + 1)
    setModalOpen(true)
  }

  const sessionKey = session
    ? `${session.asset.id}-${session.timeframe}-${session.startDate}-${session.endDate}`
    : 'none'

  // Header badge shows where the INITIAL timeframe's data came from.
  const sessionSource = session ? (session.sources[session.timeframe] ?? 'cache') : 'cache'

  return (
    <div className="flex h-full flex-col bg-zinc-950 text-zinc-100">
      {/* Header */}
      <header className="flex items-center justify-between border-b border-zinc-800 px-5 py-3">
        <div className="flex items-center gap-2.5">
          <Activity className="size-5 text-sky-400" />
          <h1 className="text-base font-semibold tracking-tight">Wanderlust</h1>
          <span className="rounded-full border border-zinc-700 px-2 py-0.5 text-[10px] font-medium text-zinc-400">
            Phase 5 · replay, orders & account
          </span>
          {session && (
            <span className="ml-1 hidden items-center gap-2 rounded-full border border-zinc-800 bg-zinc-900 px-2.5 py-0.5 text-[11px] text-zinc-400 sm:flex">
              <span className="font-semibold text-zinc-200">{session.asset.label}</span>
              <span>{session.timeframe}</span>
              <span>
                {session.startDate} → {session.endDate}
              </span>
              <span
                className={`rounded-full border px-1.5 py-px text-[9px] font-medium uppercase ${sourceStyles[sessionSource] ?? ''}`}
              >
                {sessionSource}
              </span>
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {session && (
            <span
              data-testid="header-balance"
              className="font-mono text-xs text-zinc-400"
              title="Live account balance"
            >
              ${balance.toLocaleString('en-US', { maximumFractionDigits: 2 })}
            </span>
          )}
          <Button
            onClick={openModal}
            size="sm"
            className="bg-sky-600 text-xs text-white hover:bg-sky-500"
          >
            <Plus className="size-3.5" />
            New Session
          </Button>
        </div>
      </header>

      {/* Download error surfaced outside the modal (e.g. a background failure). */}
      {error && status === 'error' && !modalOpen && (
        <div className="flex items-center justify-between gap-3 border-b border-rose-500/30 bg-rose-500/10 px-5 py-2">
          <p className="text-xs text-rose-200">{error}</p>
          <button
            onClick={dismissError}
            className="rounded p-1 text-rose-300 hover:bg-rose-500/10"
            aria-label="Dismiss error"
          >
            <X className="size-3.5" />
          </button>
        </div>
      )}

      {/* Main area */}
      <main className="relative flex-1 overflow-hidden">
        {session ? (
          <div className="absolute inset-0 flex flex-col">
            {/* Session info strip (shown when the header chip is too small) */}
            <div className="flex items-center gap-4 border-b border-zinc-800/60 px-5 py-1.5 text-[11px] text-zinc-500 sm:hidden">
              <span className="font-semibold text-zinc-200">{session.asset.label}</span>
              <span>{session.timeframe}</span>
              <span>
                {session.startDate} → {session.endDate}
              </span>
              <span className="font-mono">
                ${balance.toLocaleString('en-US', { maximumFractionDigits: 2 })}
              </span>
            </div>
            <div className="relative flex-1">
              {/* Keyed per session: each session gets a fresh workspace + provider. */}
              <VelaChart key={sessionKey} symbol={session.asset.id} timeframe={session.timeframe} />
            </div>
            <TradingPanel />
            <PlaybackPanel />
          </div>
        ) : (
          /* -------- Empty state -------- */
          <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
            <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5">
              <PlayCircle className="size-10 text-sky-500" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-zinc-200">No session yet</h2>
              <p className="mx-auto mt-1 max-w-sm text-sm text-zinc-500">
                Download a market range from Dukascopy (cached locally for reuse) and replay it on
                the chart. Your data stays on this machine.
              </p>
            </div>
            <Button onClick={openModal} className="bg-sky-600 text-white hover:bg-sky-500">
              <Plus className="size-4" />
              Start a new backtest session
            </Button>
          </div>
        )}
      </main>

      <NewSessionModal key={modalNonce} open={modalOpen} onClose={() => setModalOpen(false)} />
    </div>
  )
}
