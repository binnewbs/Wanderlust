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

/** Today's UTC calendar date as a `YYYY-MM-DD` string. */
export function todayUtc(): string {
  return formatDateUtc(new Date()) ?? ''
}

/** The UTC calendar date `days` days before today, as a `YYYY-MM-DD` string. */
export function daysAgoUtc(days: number): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - days)
  return formatDateUtc(d) ?? ''
}

/**
 * Sanitize a `YYYY-MM-DD` date input capped at `max` (a `YYYY-MM-DD` string,
 * typically `todayUtc()`). Incomplete text is kept exactly as typed so the
 * field never fights the user mid-keystroke; once the value parses to a full
 * date it is re-formatted (loose forms like `2024-1-2` → `2024-01-02`) and
 * clamped to `max` when it falls in the future. Returns `''` for blank input.
 */
export function sanitizeDateInput(value: string, max: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ''
  const parsed = parseDateUtc(trimmed)
  if (!parsed) return trimmed
  const maxMs = Date.parse(`${max}T00:00:00Z`)
  if (Number.isFinite(maxMs) && parsed.getTime() > maxMs) return max
  return formatDateUtc(parsed) ?? trimmed
}
