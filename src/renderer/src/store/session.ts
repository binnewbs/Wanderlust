import { create } from 'zustand'
import type { Asset } from '@shared/assets'
import type { Candle, DownloadProgressEvent } from '@shared/ipc'

/**
 * The backtest session's state machine.
 *
 * Phase 3 responsibilities: capture a session request (asset, timeframe, date
 * range, starting balance), drive the cache-first download while streaming
 * progress events into the UI, and hold the resulting candle array for the
 * chart. Fields marked "Phase 4" are seeded now so the store shape stays
 * stable when the playback loop lands.
 */

export type SessionStatus = 'idle' | 'downloading' | 'ready' | 'error'

export interface NewSessionInput {
  asset: Asset
  /** Dukascopy timeframe id ('m1' | 'm5' | 'm15' | 'm30' | 'h1' | 'h4' | 'd1') */
  timeframe: string
  /** ISO date, inclusive start (e.g. '2024-01-02') */
  startDate: string
  /** ISO date, inclusive end (e.g. '2024-01-31') */
  endDate: string
  /** Simulated starting balance in account currency */
  balance: number
}

export interface ActiveSession extends NewSessionInput {
  /** Candles for the whole session range, time-ordered. This is the
   *  `masterCandleArray` the playback loop slices in Phase 4. */
  candles: Candle[]
  /** 'cache' | 'dukascopy' | 'mixed' — where this session's data came from */
  source: string
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
    const request = {
      symbol: input.asset.id,
      timeframe: input.timeframe,
      startDate: input.startDate,
      endDate: input.endDate
    }
    set({ status: 'downloading', progress: [], error: null, session: null, currentIndex: 0 })
    try {
      // Cache-first: the main process serves cached days instantly and fetches
      // the rest, streaming progress into `progress` above.
      const res = await window.api.downloadData(request)
      if (!res.ok) {
        set({ status: 'error', error: res.message ?? 'Download failed.' })
        return
      }

      // downloadData reports a count; read the actual candles back from cache.
      const data = await window.api.getCachedData(request)
      if (!data.ok) {
        set({ status: 'error', error: data.error ?? 'Failed to read downloaded data.' })
        return
      }
      if (data.candles.length === 0) {
        set({
          status: 'error',
          error:
            'Dukascopy returned no candles for that range (weekends and holidays have no data). Try a different asset or date range.'
        })
        return
      }

      set({
        status: 'ready',
        session: { ...input, candles: data.candles, source: res.source }
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
