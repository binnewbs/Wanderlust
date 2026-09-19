/**
 * Small UTC helpers for the date pickers.
 *
 * Session dates are kept as `YYYY-MM-DD` strings (UTC) end-to-end — from the
 * store to the Dukascopy downloader — so every Calendar pick must round-trip
 * through UTC midnight to avoid local-timezone drift in displayed days.
 */

/** Parse a `YYYY-MM-DD` string as a UTC-midnight `Date` (undefined when empty/invalid). */
export function parseDateUtc(value: string): Date | undefined {
  if (!value) return undefined
  const ms = Date.parse(`${value}T00:00:00Z`)
  return Number.isFinite(ms) ? new Date(ms) : undefined
}

/** Format a Date as a `YYYY-MM-DD` string in UTC (undefined when empty/invalid). */
export function formatDateUtc(date: Date | undefined | null): string | undefined {
  if (!date || !Number.isFinite(date.getTime())) return undefined
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${date.getUTCFullYear()}-${p(date.getUTCMonth() + 1)}-${p(date.getUTCDate())}`
}
