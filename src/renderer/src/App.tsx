import { useState } from 'react'
import { Activity, PlayCircle, Plus, X } from 'lucide-react'
import { Alert, AlertAction, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle
} from '@/components/ui/empty'
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

// Data-source colors use the theme's categorical chart tokens (semantic, not
// raw palette values) so they adapt to light/dark under the b0 neutral theme.
const sourceStyles: Record<string, string> = {
  cache: 'border-chart-2/40 bg-chart-2/10 text-chart-2',
  dukascopy: 'border-chart-4/40 bg-chart-4/10 text-chart-4',
  mixed: 'border-chart-5/40 bg-chart-5/10 text-chart-5'
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
    <div className="flex h-full flex-col bg-background text-foreground">
      {/* Header */}
      <header className="flex items-center justify-between border-b border-border px-5 py-3">
        <div className="flex items-center gap-2.5">
          <Activity className="size-5 text-primary" />
          <h1 className="text-base font-semibold tracking-tight">Wanderlust</h1>
          <Badge variant="secondary">Phase 5 · replay, orders & account</Badge>
          {session && (
            <span className="ml-1 hidden items-center gap-2 rounded-full border border-border bg-card px-2.5 py-0.5 text-[11px] text-muted-foreground sm:flex">
              <span className="font-semibold text-foreground">{session.asset.label}</span>
              <span>{session.timeframe}</span>
              <span>
                {session.startDate} → {session.endDate}
              </span>
              <Badge
                variant="outline"
                className={`px-1.5 py-px text-[9px] font-medium uppercase ${sourceStyles[sessionSource] ?? ''}`}
              >
                {sessionSource}
              </Badge>
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {session && (
            <span
              data-testid="header-balance"
              className="font-mono text-xs text-muted-foreground"
              title="Live account balance"
            >
              ${balance.toLocaleString('en-US', { maximumFractionDigits: 2 })}
            </span>
          )}
          <Button onClick={openModal} size="sm">
            <Plus data-icon="inline-start" />
            New Session
          </Button>
        </div>
      </header>

      {/* Download error surfaced outside the modal (e.g. a background failure). */}
      {error && status === 'error' && !modalOpen && (
        <Alert variant="destructive" className="rounded-none border-x-0 border-t-0">
          <AlertDescription>{error}</AlertDescription>
          <AlertAction>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={dismissError}
              aria-label="Dismiss error"
            >
              <X />
            </Button>
          </AlertAction>
        </Alert>
      )}

      {/* Main area */}
      <main className="relative flex-1 overflow-hidden">
        {session ? (
          <div className="absolute inset-0 flex flex-col">
            {/* Session info strip (shown when the header chip is too small) */}
            <div className="flex items-center gap-4 border-b border-border/60 px-5 py-1.5 text-[11px] text-muted-foreground sm:hidden">
              <span className="font-semibold text-foreground">{session.asset.label}</span>
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
          <Empty className="h-full">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <PlayCircle />
              </EmptyMedia>
              <EmptyTitle>No session yet</EmptyTitle>
              <EmptyDescription>
                Download a market range from Dukascopy (cached locally for reuse) and replay it on
                the chart. Your data stays on this machine.
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button onClick={openModal}>
                <Plus data-icon="inline-start" />
                Start a new backtest session
              </Button>
            </EmptyContent>
          </Empty>
        )}
      </main>

      <NewSessionModal key={modalNonce} open={modalOpen} onClose={() => setModalOpen(false)} />
    </div>
  )
}
