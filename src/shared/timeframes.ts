/**
 * Canonical Dukascopy timeframe list shared by main (download validation),
 * the renderer store (session downloads), and the Vela adapter (mapping).
 *
 * A backtest session downloads EVERY timeframe in this list, so the chart can
 * switch freely (finest → coarsest).
 */

/** All supported Dukascopy candle timeframes, ordered finest → coarsest. */
export const TIMEFRAMES = ['m1', 'm5', 'm15', 'm30', 'h1', 'h4', 'd1'] as const

export type Timeframe = (typeof TIMEFRAMES)[number]

export const TIMEFRAME_LABELS: Record<Timeframe, string> = {
  m1: '1 minute',
  m5: '5 minutes',
  m15: '15 minutes',
  m30: '30 minutes',
  h1: '1 hour',
  h4: '4 hours',
  d1: '1 day'
}

export function isTimeframe(value: unknown): value is Timeframe {
  return typeof value === 'string' && (TIMEFRAMES as readonly string[]).includes(value)
}
