/**
 * Vela adapter helpers — kept OUT of the component file so react-refresh stays
 * happy (component files must only export components).
 */
import type { OHLCV } from '@luxalgo/vela'
import type { Candle } from '@shared/ipc'

/** Our Dukascopy timeframe ids → Vela timeframe strings.
 *  Vela uses Pine resolution: a bare number is MINUTES ('240' = 4h), 'D'/'W'/'M'
 *  are the named daily/weekly/monthly periods. */
const VELA_TIMEFRAMES: Record<string, string> = {
  m1: '1',
  m5: '5',
  m15: '15',
  m30: '30',
  h1: '60',
  h4: '240',
  d1: 'D'
}

export function velaTimeframe(timeframe: string): string {
  return VELA_TIMEFRAMES[timeframe] ?? VELA_TIMEFRAMES['m1']
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
