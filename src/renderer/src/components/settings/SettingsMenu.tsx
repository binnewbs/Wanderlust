import React, { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  ArrowLeft,
  Clock,
  Database,
  HardDrive,
  History,
  Loader2,
  RefreshCw,
  Settings2,
  Sparkles,
  Trash2
} from 'lucide-react'
import { toast } from 'sonner'
import type { CacheStats, CacheStatsEntry, DeleteCacheRequest } from '@shared/ipc'
import { ASSET_BY_ID } from '@shared/assets'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@/components/ui/table'
import { useSessionStore, type SavedSession } from '@/store/session'

interface SettingsMenuProps {
  onBack: () => void
}

// Keys the session store persists to renderer localStorage (see store/session.ts).
const SESSIONS_STORAGE_KEY = 'wanderlust_saved_sessions'
const CHART_STATES_STORAGE_KEY = 'wanderlust_chart_states'
const DAY_MS = 86_400_000

/** A saved session's data window, widened by the run-up day it always pulls. */
interface SessionRange {
  symbol: string
  from: number
  to: number
}

type ConfirmTarget =
  | { kind: 'entry'; symbol: string; timeframe: string; candles: number; sizeBytes: number }
  | { kind: 'unused'; count: number; bytes: number }
  | { kind: 'all'; count: number; bytes: number }

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / 1024 ** i
  return `${value >= 100 || i === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[i]}`
}

function formatCount(n: number): string {
  return n.toLocaleString('en-US')
}

/** UTC yyyy-mm-dd for an epoch-ms value (cache timestamps are UTC). */
function formatDay(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '—'
  return new Date(ms).toISOString().slice(0, 10)
}

function localStorageUsage(): {
  sessionsBytes: number
  chartStatesBytes: number
  totalBytes: number
} {
  const bytesOf = (key: string): number => {
    if (typeof window === 'undefined' || !window.localStorage) return 0
    const raw = window.localStorage.getItem(key)
    return raw ? new TextEncoder().encode(raw).length : 0
  }
  const sessionsBytes = bytesOf(SESSIONS_STORAGE_KEY)
  const chartStatesBytes = bytesOf(CHART_STATES_STORAGE_KEY)
  return { sessionsBytes, chartStatesBytes, totalBytes: sessionsBytes + chartStatesBytes }
}

/**
 * A cache group is "in use" when a saved session on the same instrument covers
 * any of its timestamps. Sessions batch-download every timeframe for their
 * range, so the timeframe is intentionally ignored here. The range is widened
 * by one day because every session also pulls the previous 24h as run-up.
 */
function buildSessionRanges(sessions: SavedSession[]): SessionRange[] {
  const ranges: SessionRange[] = []
  for (const s of sessions) {
    const from = Date.parse(`${s.startDate}T00:00:00Z`)
    const to = Date.parse(`${s.endDate}T23:59:59.999Z`)
    if (!Number.isFinite(from) || !Number.isFinite(to)) continue
    ranges.push({ symbol: s.asset.id.toLowerCase(), from: from - DAY_MS, to })
  }
  return ranges
}

function isEntryInUse(entry: CacheStatsEntry, ranges: SessionRange[]): boolean {
  if (entry.first === null || entry.last === null) return false
  return ranges.some(
    (r) =>
      r.symbol === entry.symbol &&
      entry.first !== null &&
      entry.first <= r.to &&
      entry.last !== null &&
      entry.last >= r.from
  )
}

function assetLabel(symbol: string): string {
  return ASSET_BY_ID[symbol]?.label ?? symbol.toUpperCase()
}

function StatCard({
  icon: Icon,
  label,
  value,
  detail
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  value: string
  detail: string
}): React.JSX.Element {
  return (
    <Card size="sm">
      <CardHeader>
        <CardDescription className="flex items-center gap-1.5 text-xs">
          <Icon className="size-3.5" />
          {label}
        </CardDescription>
        <CardTitle className="font-mono text-2xl tracking-tight">{value}</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-xs text-muted-foreground">{detail}</p>
      </CardContent>
    </Card>
  )
}

export default function SettingsMenu({ onBack }: SettingsMenuProps): React.JSX.Element {
  const savedSessions = useSessionStore((s) => s.savedSessions)

  const [stats, setStats] = useState<CacheStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<ConfirmTarget | null>(null)

  /** Writes an IPC response into state (used from callbacks, never directly). */
  const applyStats = useCallback(
    (res: Awaited<ReturnType<typeof window.api.getCacheStats>>): void => {
      if (!res.ok || !res.stats) {
        setStats(null)
        setError(res.error ?? 'Could not read the cache database.')
      } else {
        setStats(res.stats)
        setError(null)
      }
    },
    []
  )

  const recordError = useCallback((err: unknown): void => {
    setStats(null)
    setError(err instanceof Error ? err.message : String(err))
  }, [])

  const reload = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      applyStats(await window.api.getCacheStats())
    } catch (err) {
      recordError(err)
    } finally {
      setLoading(false)
    }
  }, [applyStats, recordError])

  useEffect(() => {
    // Initial load. State updates live in the .then/.catch/.finally callbacks so
    // the effect body itself never calls setState.
    let cancelled = false
    window.api
      .getCacheStats()
      .then((res) => {
        if (!cancelled) applyStats(res)
      })
      .catch((err) => {
        if (!cancelled) recordError(err)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [applyStats, recordError])

  const ranges = useMemo(() => buildSessionRanges(savedSessions), [savedSessions])
  const unusedEntries = useMemo(
    () => (stats ? stats.entries.filter((e) => !isEntryInUse(e, ranges)) : []),
    [stats, ranges]
  )
  const unusedBytes = useMemo(
    () => unusedEntries.reduce((sum, e) => sum + e.sizeBytes, 0),
    [unusedEntries]
  )
  // Recomputed each render: chart states are written straight to localStorage
  // by the store, so React state cannot signal every change anyway.
  const storageUsage = localStorageUsage()

  const runDelete = useCallback(
    async (targets: DeleteCacheRequest[], label: string): Promise<void> => {
      setBusy(true)
      try {
        let deleted = 0
        for (const target of targets) {
          const res = await window.api.deleteCacheData(target)
          if (!res.ok) throw new Error(res.error ?? 'Delete failed.')
          deleted += res.deleted
        }
        toast.success(`${label}: removed ${formatCount(deleted)} candles.`)
        setConfirm(null)
        await reload()
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err))
      } finally {
        setBusy(false)
      }
    },
    [reload]
  )

  const runVacuum = useCallback(async (): Promise<void> => {
    setBusy(true)
    try {
      const res = await window.api.vacuumCache()
      if (!res.ok) throw new Error(res.error ?? 'Vacuum failed.')
      toast.success(`Database compacted — ${formatBytes(res.totalSizeBytes)} on disk.`)
      await reload()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [reload])

  const confirmDelete = useCallback((): void => {
    if (!confirm) return
    if (confirm.kind === 'entry') {
      void runDelete(
        [{ symbol: confirm.symbol, timeframe: confirm.timeframe }],
        `${assetLabel(confirm.symbol)} ${confirm.timeframe}`
      )
    } else if (confirm.kind === 'unused') {
      void runDelete(
        unusedEntries.map((e) => ({ symbol: e.symbol, timeframe: e.timeframe })),
        'Unused data'
      )
    } else {
      void runDelete([{}], 'All cached data')
    }
  }, [confirm, runDelete, unusedEntries])

  const entries = stats?.entries ?? []
  const disabled = loading || busy

  return (
    // Plain block scroll container: a flex column here would let the Cards
    // (flex items with `overflow-hidden`) shrink and clip their content instead
    // of overflowing, leaving the page unscrollable.
    <div className="h-full w-full overflow-y-auto bg-background">
      <div className="w-full p-6 sm:p-8">
        {/* Header */}
        <div className="mb-6 flex flex-wrap items-center justify-between gap-4 border-b border-border/60 pb-5">
          <div className="flex min-w-0 items-center gap-3">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={onBack}
              title="Back"
              aria-label="Back"
              className="shrink-0 text-muted-foreground hover:text-foreground"
            >
              <ArrowLeft />
            </Button>
            <div className="flex min-w-0 items-center gap-2.5">
              <Settings2 className="size-5 shrink-0 text-primary" />
              <h2 className="text-xl font-bold tracking-tight text-foreground">Settings</h2>
              <Badge variant="secondary" className="font-mono text-xs">
                Storage
              </Badge>
            </div>
          </div>
          <Button variant="outline" size="sm" onClick={() => void reload()} disabled={disabled}>
            <RefreshCw data-icon="inline-start" />
            Refresh
          </Button>
        </div>

        <p className="mb-5 max-w-2xl text-xs text-muted-foreground">
          Downloaded market data is cached locally so backtests replay instantly. Manage that cache
          here — remove ranges you no longer need and compact the database to reclaim disk space.
        </p>

        {error && (
          <Alert variant="destructive" className="mb-5">
            <AlertTriangle />
            <AlertTitle>Could not read storage</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {/* Overview stats */}
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard
            icon={HardDrive}
            label="Cache on disk"
            value={formatBytes(stats?.totalSizeBytes ?? 0)}
            detail={`Database ${formatBytes(stats?.dbSizeBytes ?? 0)} · WAL ${formatBytes(
              stats?.walSizeBytes ?? 0
            )}`}
          />
          <StatCard
            icon={Database}
            label="Cached candles"
            value={formatCount(stats?.totalCandles ?? 0)}
            detail={`${entries.length} data ${entries.length === 1 ? 'group' : 'groups'} across instruments`}
          />
          <StatCard
            icon={History}
            label="Unused data"
            value={formatBytes(unusedBytes)}
            detail={`${unusedEntries.length} ${unusedEntries.length === 1 ? 'group' : 'groups'} not referenced by a saved session`}
          />
          <StatCard
            icon={Clock}
            label="Saved sessions"
            value={formatCount(savedSessions.length)}
            detail={`${formatBytes(storageUsage.totalBytes)} in local storage`}
          />
        </div>

        {/* Cached market data */}
        <Card className="mt-6">
          <CardHeader className="border-b">
            <CardTitle className="flex items-center gap-2">
              <Database className="size-4 text-primary" />
              Cached market data
              <Badge variant="outline" className="font-mono text-xs">
                {entries.length}
              </Badge>
            </CardTitle>
            <CardDescription>
              Historical OHLC candles grouped by instrument and timeframe. Sizes per group are
              approximate; the on-disk figures use the real database file size.
            </CardDescription>
            <CardAction>
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  setConfirm({ kind: 'unused', count: unusedEntries.length, bytes: unusedBytes })
                }
                disabled={disabled || unusedEntries.length === 0}
              >
                <Trash2 data-icon="inline-start" />
                Delete unused
              </Button>
            </CardAction>
          </CardHeader>

          <CardContent>
            {loading ? (
              <div className="flex items-center justify-center gap-2 p-8 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                Reading cache…
              </div>
            ) : entries.length === 0 ? (
              <Empty>
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <Database />
                  </EmptyMedia>
                  <EmptyTitle>No cached data</EmptyTitle>
                  <EmptyDescription>
                    Nothing has been downloaded yet. Starting a session fetches its range from
                    Dukascopy and stores it here for instant replays.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Instrument</TableHead>
                    <TableHead>Timeframe</TableHead>
                    <TableHead className="text-right">Candles</TableHead>
                    <TableHead>Range (UTC)</TableHead>
                    <TableHead className="text-right">Size (approx.)</TableHead>
                    <TableHead>Usage</TableHead>
                    <TableHead className="w-10" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {entries.map((entry) => {
                    const inUse = isEntryInUse(entry, ranges)
                    return (
                      <TableRow key={`${entry.symbol}-${entry.timeframe}`}>
                        <TableCell>
                          <span className="font-medium text-foreground">
                            {assetLabel(entry.symbol)}
                          </span>
                          <span className="ml-1.5 font-mono text-[10px] uppercase text-muted-foreground">
                            {entry.symbol}
                          </span>
                        </TableCell>
                        <TableCell className="font-mono uppercase">{entry.timeframe}</TableCell>
                        <TableCell className="text-right font-mono">
                          {formatCount(entry.candles)}
                        </TableCell>
                        <TableCell className="font-mono text-xs text-muted-foreground">
                          {formatDay(entry.first)} → {formatDay(entry.last)}
                        </TableCell>
                        <TableCell className="text-right font-mono">
                          {formatBytes(entry.sizeBytes)}
                        </TableCell>
                        <TableCell>
                          <Badge variant={inUse ? 'secondary' : 'outline'}>
                            {inUse ? 'In use' : 'Unused'}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            onClick={() =>
                              setConfirm({
                                kind: 'entry',
                                symbol: entry.symbol,
                                timeframe: entry.timeframe,
                                candles: entry.candles,
                                sizeBytes: entry.sizeBytes
                              })
                            }
                            disabled={disabled}
                            title="Delete this data"
                            aria-label={`Delete ${assetLabel(entry.symbol)} ${entry.timeframe} data`}
                            className="text-muted-foreground hover:text-destructive"
                          >
                            <Trash2 />
                          </Button>
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        {/* Danger zone */}
        <Card className="mt-6">
          <CardHeader className="border-b">
            <CardTitle className="flex items-center gap-2">
              <AlertTriangle className="size-4 text-destructive" />
              Danger zone
            </CardTitle>
            <CardDescription>
              These actions free disk space but are irreversible. Saved sessions and their trades
              are untouched — only the cached candles are removed.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <Alert variant="destructive">
              <AlertTriangle />
              <AlertTitle>This cannot be undone</AlertTitle>
              <AlertDescription>
                Deleted candles are re-downloaded from Dukascopy the next time a session needs them,
                which requires an internet connection and takes time.
              </AlertDescription>
            </Alert>
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => void runVacuum()}
                disabled={disabled}
                title="Reclaim disk space freed by deletes"
              >
                <Sparkles data-icon="inline-start" />
                Compact database
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={() =>
                  setConfirm({
                    kind: 'all',
                    count: entries.length,
                    bytes: stats?.totalEntryBytes ?? 0
                  })
                }
                disabled={disabled || entries.length === 0}
              >
                <Trash2 data-icon="inline-start" />
                Delete all cached data
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Delete confirmation */}
      <Dialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setConfirm(null)
        }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>
              {confirm?.kind === 'entry'
                ? 'Delete cached data?'
                : confirm?.kind === 'unused'
                  ? 'Delete unused data?'
                  : 'Delete all cached data?'}
            </DialogTitle>
            <DialogDescription>
              {confirm?.kind === 'entry' && (
                <>
                  Remove the{' '}
                  <strong className="text-foreground">
                    {assetLabel(confirm.symbol)} {confirm.timeframe.toUpperCase()}
                  </strong>{' '}
                  cache ({formatCount(confirm.candles)} candles, {formatBytes(confirm.sizeBytes)}{' '}
                  approx.). It will be re-downloaded if a session needs it again.
                </>
              )}
              {confirm?.kind === 'unused' && (
                <>
                  Remove{' '}
                  <strong className="text-foreground">
                    {confirm.count} {confirm.count === 1 ? 'group' : 'groups'}
                  </strong>{' '}
                  not referenced by any saved session, freeing about {formatBytes(confirm.bytes)}.
                </>
              )}
              {confirm?.kind === 'all' && (
                <>
                  Remove all{' '}
                  <strong className="text-foreground">
                    {confirm.count} {confirm.count === 1 ? 'group' : 'groups'}
                  </strong>{' '}
                  of cached candles (about {formatBytes(confirm.bytes)}). Saved sessions keep their
                  trades but will need their data re-downloaded.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirm(null)} disabled={busy}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={confirmDelete} disabled={busy}>
              {busy ? (
                <Loader2 data-icon="inline-start" className="animate-spin" />
              ) : (
                <Trash2 data-icon="inline-start" />
              )}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
