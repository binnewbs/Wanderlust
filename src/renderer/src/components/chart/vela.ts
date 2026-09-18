/**
 * Vela adapter helpers — kept OUT of the component file so react-refresh stays
 * happy (component files must only export components).
 */
import type { OHLCV } from '@luxalgo/vela'
import type { Candle } from '@shared/ipc'

/** Pairing of our Dukascopy timeframe ids with Vela's canonical timeframe
 *  strings. Vela uses Pine resolution: a bare number is MINUTES ('240' = 4h),
 *  'D'/'W'/'M' are the named daily/weekly/monthly periods. One source of truth
 *  so the two mappings can never drift apart. */
const TF_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['m1', '1'],
  ['m5', '5'],
  ['m15', '15'],
  ['m30', '30'],
  ['h1', '60'],
  ['h4', '240'],
  ['d1', 'D']
]

const DUKA_TO_VELA: Record<string, string> = Object.fromEntries(TF_PAIRS)
const VELA_TO_DUKA: Record<string, string> = Object.fromEntries(
  TF_PAIRS.map(([duka, vela]) => [vela, duka])
)

export const VELA_TIMEFRAMES: string[] = TF_PAIRS.map(([, vela]) => vela)

/** Dukascopy timeframe id → Vela timeframe string (chart options, topbar). */
export function velaTimeframe(timeframe: string): string {
  return DUKA_TO_VELA[timeframe] ?? DUKA_TO_VELA['m1']
}

/** Vela timeframe string → Dukascopy timeframe id (data provider lookups). */
export function dukascopyTimeframe(velaTf: string): string {
  return VELA_TO_DUKA[velaTf] ?? 'm1'
}

/** Map our Candle[] (ms epoch) onto Vela's OHLCV[] (time = bar open, epoch ms). */
export function candlesToOhlcv(candles: Candle[]): OHLCV[] {
  return candles.map((c) => ({
    time: c.timestamp,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume
  }))
}
