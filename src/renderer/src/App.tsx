import { useCallback, useEffect, useState } from 'react'
import { Activity, CheckCircle2, Database, Download, RefreshCw, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type {
  CacheEntry,
  DownloadProgressEvent,
  DownloadRequest,
  DownloadResult
} from '@shared/ipc'

/**
 * Phase 1 smoke test.
 * Proves the full IPC contract works end-to-end:
 *   renderer (window.api) -> preload bridge -> main handlers -> SQLite cache.
 * This panel is temporary; Phase 3 replaces it with the real session UI.
 */

const TIMEFRAMES = ['m1', 'm5', 'm15', 'm30', 'h1', 'h4', 'd1']

const phaseColors: Record<DownloadProgressEvent['phase'], string> = {
  'checking-cache': 'text-sky-300',
  downloading: 'text-amber-300',
  saving: 'text-violet-300',
  ready: 'text-emerald-300',
  error: 'text-rose-300'
}

function inputCls(extra = ''): string {
  return `w-full rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-sm text-zinc-100 outline-none focus:border-sky-500 ${extra}`
}

function labelCls(): string {
  return 'mb-1 block text-[11px] font-medium uppercase tracking-wide text-zinc-500'
}

export default function App(): React.JSX.Element {
  const [symbol, setSymbol] = useState('eurusd')
  const [timeframe, setTimeframe] = useState('m1')
  const [startDate, setStartDate] = useState('2024-01-02')
  const [endDate, setEndDate] = useState('2024-01-05')
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<DownloadProgressEvent[]>([])
  const [lastResult, setLastResult] = useState<string>('')
  const [cacheEntries, setCacheEntries] = useState<CacheEntry[]>([])
  const [summaryError, setSummaryError] = useState('')

  const request = useCallback(
    (): DownloadRequest => ({ symbol, timeframe, startDate, endDate }),
    [symbol, timeframe, startDate, endDate]
  )

  const refreshSummary = useCallback(async () => {
    const res = await window.api.getCacheSummary()
    if (res.ok) {
      setCacheEntries(res.entries)
      setSummaryError('')
    } else {
      setSummaryError(res.error ?? 'Failed to load cache summary')
    }
  }, [])

  useEffect(() => {
    let cancelled = false

    // Initial cache summary (setState happens after the await, so no sync render cascade).
    void (async () => {
      const res = await window.api.getCacheSummary()
      if (cancelled) return
      if (res.ok) {
        setCacheEntries(res.entries)
        setSummaryError('')
      } else {
        setSummaryError(res.error ?? 'Failed to load cache summary')
      }
    })()

    // Subscribe to main-process progress events; unsubscribe on unmount.
    const unsubscribe = window.api.onDownloadProgress((event) => {
      setProgress((prev) => [...prev, event])
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  const handleQueryCache = useCallback(async () => {
    setBusy(true)
    setProgress([])
    setLastResult('')
    try {
      const res = await window.api.getCachedData(request())
      setLastResult(
        res.ok
          ? `Cache lookup OK — ${res.count} candle(s) in range.`
          : `Cache lookup failed — ${res.error}`
      )
    } catch (err) {
      setLastResult(`IPC error: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
      void refreshSummary()
    }
  }, [refreshSummary, request])

  const handleDownload = useCallback(async () => {
    setBusy(true)
    setProgress([])
    setLastResult('')
    try {
      const res: DownloadResult = await window.api.downloadData(request())
      setLastResult(
        res.ok
          ? `Download OK — ${res.candles} candle(s) from ${res.source}.`
          : `Download failed — ${res.message}`
      )
    } catch (err) {
      setLastResult(`IPC error: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
      void refreshSummary()
    }
  }, [refreshSummary, request])

  return (
    <div className="flex h-full flex-col bg-zinc-950 text-zinc-100">
      {/* Header */}
      <header className="flex items-center justify-between border-b border-zinc-800 px-5 py-3">
        <div className="flex items-center gap-2.5">
          <Activity className="size-5 text-sky-400" />
          <h1 className="text-base font-semibold tracking-tight">Wanderlust</h1>
          <span className="rounded-full border border-zinc-700 px-2 py-0.5 text-[10px] font-medium text-zinc-400">
            Phase 2 · Dukascopy download test
          </span>
        </div>
        <Button
          onClick={() => void refreshSummary()}
          variant="outline"
          size="sm"
          className="text-xs text-zinc-300"
        >
          <RefreshCw className="size-3.5" />
          Refresh cache
        </Button>
      </header>

      <main className="flex-1 space-y-4 overflow-y-auto p-5">
        {/* Request form */}
        <section className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-4">
          <div className="grid grid-cols-[1fr_110px_140px_140px] gap-3">
            <div>
              <label className={labelCls()}>Symbol</label>
              <input
                className={inputCls()}
                value={symbol}
                onChange={(e) => setSymbol(e.target.value)}
                placeholder="eurusd"
                spellCheck={false}
              />
            </div>
            <div>
              <label className={labelCls()}>Timeframe</label>
              <select
                className={inputCls()}
                value={timeframe}
                onChange={(e) => setTimeframe(e.target.value)}
              >
                {TIMEFRAMES.map((tf) => (
                  <option key={tf} value={tf}>
                    {tf}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelCls()}>From</label>
              <input
                type="date"
                className={inputCls()}
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
              />
            </div>
            <div>
              <label className={labelCls()}>To</label>
              <input
                type="date"
                className={inputCls()}
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
              />
            </div>
          </div>

          <div className="mt-3 flex items-center gap-2">
            <Button
              onClick={() => void handleQueryCache()}
              disabled={busy}
              variant="outline"
              size="sm"
              className="text-xs text-zinc-100"
            >
              <Database className="size-3.5" />
              Query cache
            </Button>
            <Button
              onClick={() => void handleDownload()}
              disabled={busy}
              size="sm"
              className="bg-sky-600 text-xs text-white hover:bg-sky-500"
            >
              <Download className="size-3.5" />
              Trigger download
            </Button>
            {busy && (
              <span className="flex items-center gap-1.5 text-xs text-zinc-400">
                <RefreshCw className="size-3.5 animate-spin" />
                Working…
              </span>
            )}
          </div>

          {lastResult && (
            <p className="mt-3 rounded-md border border-zinc-800 bg-zinc-950/60 px-3 py-2 font-mono text-xs text-zinc-300">
              {lastResult}
            </p>
          )}
        </section>

        {/* Progress events */}
        <section className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-4">
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">
            Download progress events (main → renderer)
          </h2>
          {progress.length === 0 ? (
            <p className="text-xs text-zinc-600">
              No events yet. Trigger a download to see them stream in.
            </p>
          ) : (
            <ul className="space-y-1">
              {progress.map((event, i) => (
                <li
                  key={i}
                  className={`flex items-start gap-2 font-mono text-xs ${phaseColors[event.phase]}`}
                >
                  {event.phase === 'error' ? (
                    <XCircle className="mt-0.5 size-3.5 shrink-0" />
                  ) : event.phase === 'ready' ? (
                    <CheckCircle2 className="mt-0.5 size-3.5 shrink-0" />
                  ) : (
                    <Activity className="mt-0.5 size-3.5 shrink-0 opacity-70" />
                  )}
                  <span>
                    {event.message}
                    {event.percent !== undefined && (
                      <span className="text-zinc-500"> ({event.percent}%)</span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Cache summary */}
        <section className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-4">
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">
            SQLite cache contents
          </h2>
          {summaryError ? (
            <p className="text-xs text-rose-300">{summaryError}</p>
          ) : cacheEntries.length === 0 ? (
            <p className="text-xs text-zinc-600">
              Cache is empty — trigger a download to populate it.
            </p>
          ) : (
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="text-zinc-500">
                  <th className="pb-1.5 font-medium">Symbol</th>
                  <th className="pb-1.5 font-medium">Timeframe</th>
                  <th className="pb-1.5 text-right font-medium">Candles</th>
                  <th className="pb-1.5 text-right font-medium">First (UTC)</th>
                  <th className="pb-1.5 text-right font-medium">Last (UTC)</th>
                </tr>
              </thead>
              <tbody className="font-mono text-zinc-300">
                {cacheEntries.map((entry) => (
                  <tr
                    key={`${entry.symbol}-${entry.timeframe}`}
                    className="border-t border-zinc-800"
                  >
                    <td className="py-1.5">{entry.symbol}</td>
                    <td className="py-1.5">{entry.timeframe}</td>
                    <td className="py-1.5 text-right">{entry.candles}</td>
                    <td className="py-1.5 text-right text-zinc-500">
                      {entry.first ? new Date(entry.first).toISOString().slice(0, 16) : '—'}
                    </td>
                    <td className="py-1.5 text-right text-zinc-500">
                      {entry.last ? new Date(entry.last).toISOString().slice(0, 16) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </main>
    </div>
  )
}
