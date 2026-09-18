import { useMemo, useState } from 'react'
import { AlertTriangle, Download, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
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

function fieldCls(): string {
  return 'w-full rounded-md border border-zinc-700 bg-zinc-950 px-2.5 py-1.5 text-sm text-zinc-100 outline-none focus:border-sky-500'
}

function labelCls(): string {
  return 'mb-1 block text-[11px] font-medium uppercase tracking-wide text-zinc-500'
}

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

  const [assetId, setAssetId] = useState('eurusd')
  const [timeframe, setTimeframe] = useState<Timeframe>('m1')
  const [startDate, setStartDate] = useState('2024-01-02')
  const [endDate, setEndDate] = useState('2024-01-31')
  const [balanceStr, setBalanceStr] = useState('100000')

  // NOTE: the form is intentionally NOT reset here — App remounts this modal
  // with a fresh `key` on every open, so state starts at the defaults above.

  const asset: Asset | undefined = ASSET_BY_ID[assetId]
  const balance = Number(balanceStr)

  const valid = useMemo(() => {
    const s = Date.parse(`${startDate}T00:00:00Z`)
    const e = Date.parse(`${endDate}T00:00:00Z`)
    return !!asset && Number.isFinite(s) && Number.isFinite(e) && e >= s && balance > 0
  }, [asset, startDate, endDate, balance])

  if (!open) return null

  const handleStart = async (): Promise<void> => {
    if (!valid || !asset) return
    await startSession({ asset, timeframe, startDate, endDate, balance })
    // startSession settles with 'ready' (success) or 'error'. On success the
    // session screen takes over, so close the modal; on error it stays open
    // showing the failure with a retry path.
    if (useSessionStore.getState().status === 'ready') onClose()
  }

  const latest = progress[progress.length - 1]

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="New session"
    >
      <div className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-lg border border-zinc-800 bg-zinc-900 p-5 shadow-2xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-semibold tracking-tight text-zinc-100">
            New backtest session
          </h2>
          <button
            onClick={onClose}
            disabled={status === 'downloading'}
            className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200 disabled:opacity-40"
            aria-label="Close"
          >
            <X className="size-4" />
          </button>
        </div>

        {status === 'downloading' ? (
          /* -------- Loading state: progress streamed over IPC -------- */
          <div className="space-y-3">
            <p className="text-xs text-zinc-400">
              Downloading {asset?.label ?? assetId} {timeframe} · {startDate} → {endDate}
            </p>
            <div className="h-2 w-full overflow-hidden rounded-full bg-zinc-800">
              <div
                className="h-full rounded-full bg-sky-500 transition-all duration-300"
                style={{ width: `${latest?.percent ?? 0}%` }}
              />
            </div>
            <p className="font-mono text-xs text-zinc-300">
              {latest?.message ?? 'Starting…'}
              {latest?.percent !== undefined && (
                <span className="text-zinc-500"> ({latest.percent}%)</span>
              )}
            </p>
            <ul className="max-h-28 space-y-0.5 overflow-y-auto font-mono text-[11px] text-zinc-500">
              {progress.slice(0, -1).map((event, i) => (
                <li key={i}>{event.message}</li>
              ))}
            </ul>
          </div>
        ) : status === 'error' ? (
          /* -------- Download failed -------- */
          <div className="space-y-3">
            <div className="flex items-start gap-2 rounded-md border border-rose-500/30 bg-rose-500/10 p-3">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-rose-400" />
              <p className="text-xs leading-relaxed text-rose-200">{error}</p>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={onClose}>
                Cancel
              </Button>
              <Button
                size="sm"
                className="bg-sky-600 text-white hover:bg-sky-500"
                onClick={dismissError}
              >
                Try again
              </Button>
            </div>
          </div>
        ) : (
          /* -------- The form -------- */
          <div className="space-y-3.5">
            <div>
              <label className={labelCls()}>Asset</label>
              <select
                className={fieldCls()}
                value={assetId}
                onChange={(e) => setAssetId(e.target.value)}
              >
                {CATEGORIES.map((category) => (
                  <optgroup key={category} label={category}>
                    {ASSETS.filter((a) => a.category === category).map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.label}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
              <p className="mt-1 text-[11px] text-zinc-500">
                {asset?.category} · Dukascopy id <code className="text-zinc-400">{assetId}</code>
              </p>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelCls()}>Chart timeframe</label>
                <select
                  className={fieldCls()}
                  value={timeframe}
                  onChange={(e) => setTimeframe(e.target.value as Timeframe)}
                >
                  {TIMEFRAMES.map((tf) => (
                    <option key={tf} value={tf}>
                      {TIMEFRAME_LABELS[tf]}
                    </option>
                  ))}
                </select>
                <p className="mt-1 text-[11px] text-zinc-500">
                  Initial view — every timeframe is downloaded, switch on the chart anytime.
                </p>
              </div>
              <div>
                <label className={labelCls()}>Starting balance ($)</label>
                <input
                  type="number"
                  min={1}
                  step={500}
                  className={fieldCls()}
                  value={balanceStr}
                  onChange={(e) => setBalanceStr(e.target.value)}
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelCls()}>From</label>
                <input
                  id="ns-date-from"
                  type="date"
                  className={fieldCls()}
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                />
              </div>
              <div>
                <label className={labelCls()}>To</label>
                <input
                  id="ns-date-to"
                  type="date"
                  className={fieldCls()}
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                />
              </div>
            </div>

            {!valid && (
              <p className="text-[11px] text-rose-300">
                {balance <= 0
                  ? 'Starting balance must be greater than 0.'
                  : 'Range must be valid and start on or before the end date.'}
              </p>
            )}

            <div className="flex justify-end gap-2 pt-1">
              <Button variant="outline" size="sm" onClick={onClose}>
                Cancel
              </Button>
              <Button
                size="sm"
                className="bg-sky-600 text-white hover:bg-sky-500"
                disabled={!valid}
                onClick={handleStart}
              >
                <Download className="size-3.5" />
                Start Session
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
