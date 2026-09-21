import { useEffect, useState } from 'react'
import { Activity, ArrowLeft, BarChart3, CandlestickChart, Plus, Settings, X } from 'lucide-react'
import { Alert, AlertAction, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { Toaster } from '@/components/ui/sonner'
import { useSessionStore } from '@/store/session'
import { setChartViewVisible } from '@/components/chart/chartVisible'
import VelaChart from '@/components/chart/VelaChart'
import NewSessionModal from '@/components/session/NewSessionModal'
import PlaybackPanel from '@/components/session/PlaybackPanel'
import TradingPanel from '@/components/session/TradingPanel'
import AnalyticsView from '@/components/analytics/AnalyticsView'
import SessionsMenu from '@/components/session/SessionsMenu'
import SettingsMenu from '@/components/settings/SettingsMenu'

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
  // Settings is a full-page menu layered over the workspace (chart stays
  // mounted underneath, so drawings/indicators survive the round trip).
  const [settingsOpen, setSettingsOpen] = useState(false)
  // Bumped on every open so the modal remounts with a fresh key — its form
  // state resets to defaults without a reset effect.
  const [modalNonce, setModalNonce] = useState(0)

  useEffect(() => {
    if (activeView === 'chart' && session) {
      window.dispatchEvent(new Event('resize'))
    }
  }, [activeView, session])

  // Tell the chart side whether its pane is actually on screen. While the
  // Analytics tab is up, the chart keeps advancing (store) but Vela's repaints
  // and the order-level overlay placement are skipped entirely — no CPU/GPU for
  // invisible pixels, and a flush on return catches the tape up in one push.
  useEffect(() => {
    setChartViewVisible(activeView === 'chart')
  }, [activeView])

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
      <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-2 sm:px-5">
        <div className="flex min-w-0 items-center gap-2 sm:gap-2.5">
          {session && (
            <>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={exitToMainMenu}
                className="shrink-0 text-muted-foreground hover:text-foreground"
                title="Back to sessions list"
                aria-label="Back to sessions list"
              >
                <ArrowLeft />
              </Button>
              <Separator orientation="vertical" className="h-4 shrink-0" />
            </>
          )}

          <div className="flex shrink-0 items-center gap-2">
            <Activity className="size-5 text-primary" />
            <h1 className="text-base font-semibold tracking-tight">Wanderlust</h1>
          </div>

          {session && (
            <div className="ml-1 flex min-w-0 max-w-[200px] shrink items-center gap-1.5 overflow-hidden rounded-full border border-border bg-card px-2.5 py-0.5 text-[11px] whitespace-nowrap text-muted-foreground sm:max-w-[300px] md:max-w-[420px] lg:max-w-[560px]">
              <span className="min-w-0 truncate font-semibold text-foreground">{session.name}</span>
              <span className="shrink-0">·</span>
              <span className="shrink-0 font-medium text-foreground">{session.asset.label}</span>
              <span className="shrink-0 uppercase">{session.timeframe}</span>
              <span className="hidden shrink-0 md:inline">
                {session.startDate} → {session.endDate}
              </span>
              <Badge
                variant="outline"
                className={`shrink-0 px-1.5 py-px text-[9px] font-medium uppercase ${sourceStyles[sessionSource] ?? ''}`}
              >
                {sessionSource}
              </Badge>
            </div>
          )}
        </div>

        {/* Right side navigation / actions */}
        <div className="flex shrink-0 items-center gap-2">
          {session ? (
            <>
              {/* Headless E2E balance test hook (hidden visually) */}
              <span data-testid="header-balance" className="sr-only">
                {balance}
              </span>
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
            </>
          ) : (
            <Button onClick={openModal} size="sm">
              <Plus data-icon="inline-start" />
              New Session
            </Button>
          )}

          {/* Settings manages local cache/sessions, so it only belongs on the
              main menu — hide it (and its divider) once a session is open. */}
          {!session && (
            <>
              <Separator orientation="vertical" className="h-4 shrink-0" />
              <Button
                variant={settingsOpen ? 'secondary' : 'ghost'}
                size="icon-sm"
                onClick={() => setSettingsOpen((open) => !open)}
                title="Settings"
                aria-label="Settings"
                className="shrink-0 text-muted-foreground hover:text-foreground"
              >
                <Settings />
              </Button>
            </>
          )}
        </div>
      </header>

      {/* Download error surfaced outside the modal (e.g. a background failure). */}
      {error && status === 'error' && !modalOpen && (
        <Alert
          variant="destructive"
          className="animate-in fade-in slide-in-from-top-2 duration-200 rounded-none border-x-0 border-t-0"
        >
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
          <>
            {/* Chart view container: kept mounted so workspace, drawings, indicators and user settings survive */}
            <div
              className={`absolute inset-0 flex flex-col ${
                activeView === 'chart'
                  ? 'visible z-10 animate-in fade-in slide-in-from-right-2 duration-200'
                  : 'invisible pointer-events-none -z-10'
              }`}
            >
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

            {/* Analytics view container */}
            <div
              className={`absolute inset-0 flex flex-col bg-background ${
                activeView === 'analytics'
                  ? 'visible z-10 animate-in fade-in slide-in-from-left-2 duration-200'
                  : 'invisible pointer-events-none -z-10'
              }`}
            >
              <AnalyticsView onBackToChart={() => setActiveView('chart')} />
            </div>
          </>
        ) : (
          <SessionsMenu
            onNewSession={openModal}
            onResumeSession={handleResumeSession}
            onViewAnalytics={handleViewAnalytics}
          />
        )}

        {/* Full-page Settings menu, layered over whatever is behind it */}
        {settingsOpen && (
          <div className="absolute inset-0 z-30 flex flex-col bg-background animate-in fade-in duration-200">
            <SettingsMenu onBack={() => setSettingsOpen(false)} />
          </div>
        )}
      </main>

      <NewSessionModal key={modalNonce} open={modalOpen} onClose={() => setModalOpen(false)} />

      {/* App-wide toast notifications (blocked SL/TP drags, etc.). Styled by
          the b0 neutral theme tokens — no richColors, so toasts match the
          card/popover surfaces of the rest of the UI. */}
      <Toaster position="bottom-right" />
    </div>
  )
}
