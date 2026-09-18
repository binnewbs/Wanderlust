/**
 * The "wanderlust" Vela data provider: serves the ACTIVE backtest session's
 * candles for whatever symbol/timeframe the chart asks for.
 *
 * The workspace registers this provider (via `VelaShellOptions.providers`) and
 * addresses the chart with the session's ticker. The topbar's timeframe chips
 * and any price-scale depth request flow through the feed → `getBars`, which
 * looks up the corresponding candles in the session store (every timeframe was
 * downloaded when the session started) — so switching timeframe on the chart
 * actually swaps datasets instead of going blank.
 *
 * A fresh provider is created per workspace (per session), but it reads the
 * store live, so it always answers with the current session's data.
 */
import type {
  DataProvider,
  ProviderCapabilities,
  ProviderInfo,
  SymbolDescriptor
} from '@luxalgo/vela'
import { useSessionStore } from '@/store/session'
import { candlesToOhlcv, dukascopyTimeframe, VELA_TIMEFRAMES } from './vela'

export const SESSION_PROVIDER = 'wanderlust'

/** The ticker the chart addresses the session by (uppercase dukascopy id). */
export function sessionTicker(ticker?: string): string {
  return (ticker ?? '').toUpperCase()
}

export function createSessionDataProvider(): DataProvider {
  const capabilities: ProviderCapabilities = {
    enumerate: true, // listSymbols implemented → bare-symbol resolution + picker
    stream: false, // static history; no live ticks (backtest data)
    symbolInfo: true
  }

  return {
    /**
     * The only required provider method. Returns the session's bars for Vela's
     * `timeframe`. Range is deliberately ignored: the chart frames its requests
     * around "now" while a session is a fixed historical window, so we always
     * answer with the full dataset (bounded — one session) and let Vela frame
     * it. An empty dataset for a switched timeframe resolves to `[]` (blank
     * pane) rather than a parked load.
     */
    async getBars(ticker, timeframe) {
      const session = useSessionStore.getState().session
      if (!session) return []
      if (sessionTicker(ticker) !== sessionTicker(session.asset.id)) return []
      const candles = session.candlesByTimeframe[dukascopyTimeframe(timeframe)]
      return candles && candles.length > 0 ? candlesToOhlcv(candles) : []
    },

    /** Only the session's own asset is pickable, so switching symbols can't
     *  strand the chart on un-downloaded data. */
    async listSymbols(): Promise<SymbolDescriptor[]> {
      const session = useSessionStore.getState().session
      if (!session) return []
      return [
        {
          ticker: sessionTicker(session.asset.id),
          description: session.asset.label,
          type: session.asset.category
        }
      ]
    },

    async getSymbolInfo(ticker) {
      const session = useSessionStore.getState().session
      if (!session || sessionTicker(ticker) !== sessionTicker(session.asset.id)) return undefined
      return {
        ticker: sessionTicker(session.asset.id),
        description: session.asset.label,
        type: session.asset.category
      }
    },

    info(): ProviderInfo {
      return {
        name: SESSION_PROVIDER,
        displayName: 'Wanderlust session',
        supportedTimeframes: VELA_TIMEFRAMES,
        capabilities
      }
    }
  }
}
