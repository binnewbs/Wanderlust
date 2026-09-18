import type { Candle, DownloadRequest } from '../shared/ipc'

export type ProgressReporter = (message: string, percent?: number) => void

/**
 * Fetches candles from Dukascopy via `dukascopy-node`.
 *
 * NOTE (Phase 1): this is a stub. Phase 2 replaces the body with the real
 * implementation, roughly:
 *
 *   import { getHistoricalRates } from 'dukascopy-node'
 *   const data = await getHistoricalRates({
 *     instrument: request.symbol,
 *     dates: { from: new Date(request.startDate), to: new Date(request.endDate) },
 *     timeframe: request.timeframe,
 *     format: 'json'
 *   })
 *
 * `dukascopy-node` must run in the Electron main process (Node) — the renderer
 * cannot call Dukascopy directly due to CORS. The IPC layer in `ipc.ts` is the
 * bridge. This function reports coarse progress through `onProgress`.
 */
export async function fetchFromDukascopy(
  _request: DownloadRequest,
  _onProgress: ProgressReporter
): Promise<Candle[]> {
  throw new Error('Dukascopy fetching is implemented in Phase 2.')
}
