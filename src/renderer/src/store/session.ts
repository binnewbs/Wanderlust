import { create } from 'zustand'
import type { Asset } from '@shared/assets'
import type { Candle, DownloadBatchResult, DownloadProgressEvent } from '@shared/ipc'
import { TIMEFRAMES, type Timeframe } from '@shared/timeframes'

/**
 * The backtest session's state machine.
 *
 * A session downloads EVERY timeframe (m1…d1) for the chosen range in ONE batch
 * IPC call, streams progress into the UI, and stores the candles per timeframe
 * (`candlesByTimeframe`) — the per-timeframe `masterCandleArray`s the playback
 * loop slices in Phase 4. Fields marked "Phase 4" are seeded now so the store
 * shape stays stable when the playback loop lands.
 */

export type SessionStatus = 'idle' | 'downloading' | 'ready' | 'error'

export interface NewSessionInput {
  asset: Asset
  /** Dukascopy timeframe id ('m1' | 'm5' | 'm15' | 'm30' | 'h1' | 'h4' | 'd1')
   *  — the chart's INITIAL timeframe; every timeframe is downloaded regardless. */
  timeframe: Timeframe
  /** ISO date, inclusive start (e.g. '2024-01-02') */
  startDate: string
  /** ISO date, inclusive end (e.g. '2024-01-31') */
  endDate: string
  /** Simulated starting balance in account currency */
  balance: number
}

export interface ActiveSession extends NewSessionInput {
  /** Candles for every downloaded timeframe, keyed by dukascopy timeframe id. */
  candlesByTimeframe: Partial<Record<Timeframe, Candle[]>>
  /** Where each timeframe's data came from ('cache' | 'dukascopy' | 'mixed') */
  sources: Partial<Record<Timeframe, string>>
}

export interface SessionState {
  status: SessionStatus
  session: ActiveSession | null
  /** Progress events streamed from the main process during a download */
  progress: DownloadProgressEvent[]
  error: string | null
  // --- playback state; Phase 4 wires these, the fields live here already ---
  currentIndex: number
  playing: boolean
  speed: number

  startSession: (input: NewSessionInput) => Promise<void>
  dismissError: () => void
}

/** Candles of the session's initial timeframe — the playback panel's counter. */
export function sessionBaseCandles(session: ActiveSession | null): Candle[] {
  if (!session) return []
  return session.candlesByTimeframe[session.timeframe] ?? []
}

export const useSessionStore = create<SessionState>((set) => ({
  status: 'idle',
  session: null,
  progress: [],
  error: null,
  currentIndex: 0,
  playing: false,
  speed: 30,

  dismissError: () => set({ error: null, status: 'idle' }),

  startSession: async (input) => {
    // One batch call downloads every timeframe for the range (cache-first;
    // progress is scaled across timeframes by the main process).
    const request = {
      symbol: input.asset.id,
      timeframe: input.timeframe,
      timeframes: [...TIMEFRAMES],
      startDate: input.startDate,
      endDate: input.endDate
    }
    set({ status: 'downloading', progress: [], error: null, session: null, currentIndex: 0 })
    try {
      const raw = await window.api.downloadData(request)
      if (!('timeframes' in raw)) {
        set({ status: 'error', error: raw.message ?? 'Download failed.' })
        return
      }
      const res = raw as DownloadBatchResult
      if (!res.ok) {
        set({ status: 'error', error: res.message ?? 'Download failed.' })
        return
      }

      // downloadData reports counts; read the actual candles back from cache.
      const candlesByTimeframe: Partial<Record<Timeframe, Candle[]>> = {}
      for (const tf of TIMEFRAMES) {
        const data = await window.api.getCachedData({
          symbol: input.asset.id,
          timeframe: tf,
          startDate: input.startDate,
          endDate: input.endDate
        })
        if (data.ok && data.candles.length > 0) candlesByTimeframe[tf] = data.candles
      }
      if (Object.values(candlesByTimeframe).every((c) => !c?.length)) {
        set({
          status: 'error',
          error:
            'Dukascopy returned no candles for that range (weekends and holidays have no data). Try a different asset or date range.'
        })
        return
      }

      const sources: Partial<Record<Timeframe, string>> = {}
      for (const tfRes of res.timeframes) {
        sources[tfRes.timeframe as Timeframe] = tfRes.source
      }

      set({
        status: 'ready',
        session: { ...input, candlesByTimeframe, sources }
      })
    } catch (err) {
      set({ status: 'error', error: err instanceof Error ? err.message : String(err) })
    }
  }
}))

// Stream main-process download progress into the store while a download runs.
// Module scope (not a React effect) so StrictMode's double-mount never
// double-subscribes; HMR re-imports are guarded by the existing handle.
let progressUnsub: (() => void) | null = null
if (!progressUnsub && typeof window !== 'undefined' && window.api) {
  progressUnsub = window.api.onDownloadProgress((event) => {
    const { status } = useSessionStore.getState()
    if (status === 'downloading') {
      useSessionStore.setState((s) => ({ progress: [...s.progress, event] }))
    }
  })
}
