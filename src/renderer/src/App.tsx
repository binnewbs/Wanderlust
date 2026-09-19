import { useState } from 'react'
import { Activity, ArrowLeft, BarChart3, CandlestickChart, Plus, X } from 'lucide-react'
import { Alert, AlertAction, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { useSessionStore } from '@/store/session'
import VelaChart from '@/components/chart/VelaChart'
import NewSessionModal from '@/components/session/NewSessionModal'
import PlaybackPanel from '@/components/session/PlaybackPanel'
import TradingPanel from '@/components/session/TradingPanel'
import AnalyticsView from '@/components/analytics/AnalyticsView'
import SessionsMenu from '@/components/session/SessionsMenu'

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
  const orders = useSessionStore((s) => s.orders)
  const dismissError = useSessionStore((s) => s.dismissError)
  const exitToMainMenu = useSessionStore((s) => s.exitToMainMenu)
  const resumeSavedSession = useSessionStore((s) => s.resumeSavedSession)

  const [modalOpen, setModalOpen] = useState(false)
  const [activeView, setActiveView] = useState<'chart' | 'analytics'>('chart')
  // Bumped on every open so the modal remounts with a fresh key — its form
  // state resets to defaults without a reset effect.
  const [modalNonce, setModalNonce] = useState(0)

  const openModal = (): void => {
    setModalNonce((n) => n + 1)
    setModalOpen(true)
  }

  const handleResumeSession = async (id: string): Promise<void> => {
    setActiveView('chart')
    await resumeSavedSession(id)
  }

  const handleViewAnalytics = async (id: string): Promise<void> => {
    setActiveView('analytics')
    await resumeSavedSession(id)
  }

  const sessionKey = session
    ? `${session.id}-${session.asset.id}-${session.timeframe}-${session.startDate}-${session.endDate}`
    : 'none'

  // Header badge shows where the INITIAL timeframe's data came from.
  const sessionSource = session ? (session.sources[session.timeframe] ?? 'cache') : 'cache'
  const closedTradesCount = orders.filter((o) => o.status === 'closed').length

  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      {/* Header */}
      <header className="flex items-center justify-between border-b border-border px-5 py-3">
        <div className="flex items-center gap-2.5">
          {session && (
            <>
              <Button
                variant="ghost"
                size="sm"
                onClick={exitToMainMenu}
                className="gap-1.5 text-xs text-muted-foreground hover:text-foreground"
                title="Back to sessions list"
              >
                <ArrowLeft data-icon="inline-start" />
                Sessions
              </Button>
              <Separator orientation="vertical" className="h-4" />
            </>
          )}

          <Activity className="size-5 text-primary" />
          <h1 className="text-base font-semibold tracking-tight">Wanderlust</h1>
          <Badge variant="secondary">Phase 5 & 6 · replay, orders & analytics</Badge>

          {session && (
            <div className="ml-1 hidden items-center gap-2 rounded-full border border-border bg-card px-2.5 py-0.5 text-[11px] text-muted-foreground sm:flex">
              <span className="font-semibold text-foreground">{session.name}</span>
              <span>·</span>
              <span className="font-medium text-foreground">{session.asset.label}</span>
              <span className="uppercase">{session.timeframe}</span>
              <span>
                {session.startDate} → {session.endDate}
              </span>
              <Badge
                variant="outline"
                className={`px-1.5 py-px text-[9px] font-medium uppercase ${sourceStyles[sessionSource] ?? ''}`}
              >
                {sessionSource}
              </Badge>
            </div>
          )}
        </div>

        {/* Center navigation inside session */}
        {session && (
          <div className="flex items-center rounded-lg border border-border bg-muted/40 p-0.5">
            <Button
              variant={activeView === 'chart' ? 'secondary' : 'ghost'}
              size="sm"
              onClick={() => setActiveView('chart')}
              className="h-7 gap-1.5 px-2.5 text-xs"
            >
              <CandlestickChart data-icon="inline-start" />
              Chart & Trading
            </Button>
            <Button
              variant={activeView === 'analytics' ? 'secondary' : 'ghost'}
              size="sm"
              onClick={() => setActiveView('analytics')}
              className="h-7 gap-1.5 px-2.5 text-xs"
            >
              <BarChart3 data-icon="inline-start" />
              Analytics & Journal
              {closedTradesCount > 0 && (
                <Badge variant="outline" className="ml-0.5 h-4 px-1 text-[10px]">
                  {closedTradesCount}
                </Badge>
              )}
            </Button>
          </div>
        )}

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
          activeView === 'chart' ? (
            <div className="absolute inset-0 flex flex-col">
              {/* Session info strip (shown when the header chip is too small) */}
              <div className="flex items-center gap-4 border-b border-border/60 px-5 py-1.5 text-[11px] text-muted-foreground sm:hidden">
                <span className="font-semibold text-foreground">{session.name}</span>
                <span>{session.asset.label}</span>
                <span className="uppercase">{session.timeframe}</span>
                <span>
                  {session.startDate} → {session.endDate}
                </span>
                <span className="font-mono">
                  ${balance.toLocaleString('en-US', { maximumFractionDigits: 2 })}
                </span>
              </div>
              <div className="relative flex-1">
                {/* Keyed per session: each session gets a fresh workspace + provider. */}
                <VelaChart
                  key={sessionKey}
                  symbol={session.asset.id}
                  timeframe={session.timeframe}
                />
              </div>
              <TradingPanel />
              <PlaybackPanel />
            </div>
          ) : (
            <div className="absolute inset-0 flex flex-col">
              <AnalyticsView onBackToChart={() => setActiveView('chart')} />
            </div>
          )
        ) : (
          <SessionsMenu
            onNewSession={openModal}
            onResumeSession={handleResumeSession}
            onViewAnalytics={handleViewAnalytics}
          />
        )}
      </main>

      <NewSessionModal key={modalNonce} open={modalOpen} onClose={() => setModalOpen(false)} />
    </div>
  )
}
