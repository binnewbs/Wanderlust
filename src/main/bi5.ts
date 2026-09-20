/**
 * Dukascopy native-candle bi5 decoding.
 *
 * Strategy ported from the `dukascopy-downloader` project: instead of fetching
 * 24 tick files per day (and converting ticks -> candles ourselves), we fetch
 * Dukascopy's PRE-COMPUTED M1 candle files — one (~11 KiB) request per day per
 * symbol, 1440 candles. That's a 24x request reduction over the tick path,
 * which is what keeps us under Dukascopy's aggressive rate limiter.
 *
 * File format (verified against live downloads):
 *   - LZMA-alone compressed stream
 *   - Uncompressed payload: 24 bytes per candle, big-endian struct `!IIIIIf`
 *       u32 timestamp offset (ms from UTC midnight of that day)
 *       u32 open, u32 close, u32 low, u32 high  (raw ints, see pointValue)
 *       f32 volume                             (float, as-is)
 *
 * Dukascopy injects synthetic forward-filled candles (identical OHLCV as the
 * previous one) during non-trading periods, so those are filtered out.
 */

import * as lzma from 'lzma-native'
import type { Candle } from '../shared/ipc'

/** Default raw-price divisor for most FX pairs (EURUSD 1.1015 -> 110150). */
const DEFAULT_POINT_VALUE = 100_000

/**
 * Dukascopy stores JPY crosses, RUB, XAU/XAG and index CFDs at a different
 * scale: raw 149875 -> 149.875 (3 decimals). Mirror dukascopy-downloader's
 * `get_point_value`.
 */
export function getPointValue(symbol: string): number {
  const up = symbol.toUpperCase()
  if (/(JPY|RUB|IDX|XAG|XAU)/.test(up)) return 1_000
  return DEFAULT_POINT_VALUE
}

/** Symbols must match Dukascopy's datafeed naming: uppercase, no separators. */
export function normalizeSymbolForUrl(symbol: string): string {
  return symbol.replace(/[/.\-_]/g, '').toUpperCase()
}

export interface NativeCandle {
  /** Absolute UTC epoch ms (day start + per-candle offset). */
  timestamp: number
  open: number
  high: number
  low: number
  close: number
  /** Float volume as shipped (NOT the tick-path `*1e6` scaling). */
  volume: number
}

/**
 * Decompress a bi5 payload to its raw 24-bytes-per-candle buffer.
 * Candle files are single LZMA streams; tick files can concatenate several,
 * which `lzma.decompress` (autoDecoder) handles.
 *
 * Note: `@types/lzma-native` only models the success callback
 * `(result: Buffer) => void`, but the native runtime calls `(result)` on
 * success and `(null, err)` on failure — hence the shim here.
 */
type DecompressCallback = (result: Buffer | null, err?: Error | null) => void
type RawDecompress = (
  buf: Buffer,
  options: unknown,
  cb: DecompressCallback
) => void
const rawDecompress = lzma.decompress as unknown as RawDecompress

export function decompressBi5(payload: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    rawDecompress(payload, {}, (result, err) => {
      if (err) reject(err)
      else resolve(result as Buffer)
    })
  })
}

const CANDLE_SIZE = 24

/** One entry in a native M1 candle file before price/scale normalization. */
interface RawCandle {
  offsetSec: number
  o: number
  c: number
  l: number
  h: number
  v: number
}

/**
 * Parse a decompressed native candle buffer into raw entries, dropping
 * forward-filled duplicates and all-zero server artefacts.
 *
 * @param data    Raw 24-bytes-per-candle buffer from {@link decompressBi5}.
 * @param point   Price divisor from {@link getPointValue}.
 * @param dayMs   UTC midnight (ms) of the day this file covers.
 */
export function parseNativeCandles(data: Buffer, point: number, dayMs: number): NativeCandle[] {
  const count = Math.floor(data.length / CANDLE_SIZE)
  const out: NativeCandle[] = []
  let prev: RawCandle | null = null

  for (let i = 0; i < count; i++) {
    const off = i * CANDLE_SIZE
    // Per-candle offset from UTC midnight of this day, in SECONDS.
    const offsetSec = data.readUInt32BE(off)
    const o = data.readUInt32BE(off + 4)
    const c = data.readUInt32BE(off + 8)
    const l = data.readUInt32BE(off + 12)
    const h = data.readUInt32BE(off + 16)
    const v = data.readFloatBE(off + 20)

    // Forward-filled candle: Dukascopy repeats the last OHLCV to fill gaps
    // (weekends/holidays). Skip identical-to-prev entries.
    const same =
      prev !== null &&
      prev.o === o && prev.c === c && prev.l === l && prev.h === h &&
      prev.v === v
    if (same) continue

    // All-zero candles are server artefacts.
    if (o === 0 && c === 0 && l === 0 && h === 0) continue

    prev = { offsetSec, o, c, l, h, v }

    const p = 1 / point
    out.push({
      timestamp: dayMs + offsetSec * 1000,
      open: o * p,
      high: h * p,
      low: l * p,
      close: c * p,
      volume: v
    })
  }

  return out
}

/**
 * Bucket M1 candles into a coarser timeframe. Timestamps align to UTC
 * boundaries (minute/hour/day), so aggregation truncates cleanly.
 *
 * @param m1      Ascending M1 candles, all on minute boundaries.
 * @param tfMs    Target candle length in ms (from TIMEFRAME_MS).
 * @param fromMs  Keep only candles with timestamp >= fromMs.
 * @param toMs    Keep only candles with timestamp <= toMs.
 */
export function aggregateM1(
  m1: NativeCandle[],
  tfMs: number,
  fromMs: number,
  toMs: number
): Candle[] {
  if (tfMs <= 60_000) {
    // m1 identity: just filter + shape.
    return m1
      .filter((c) => c.timestamp >= fromMs && c.timestamp <= toMs)
      .map((c) => ({ timestamp: c.timestamp, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }))
  }

  const buckets = new Map<number, { timestamp: number; open: number; high: number; low: number; close: number; volume: number }>()

  for (const c of m1) {
    if (c.timestamp < fromMs || c.timestamp > toMs) continue
    const bucket = Math.floor(c.timestamp / tfMs) * tfMs
    let b = buckets.get(bucket)
    if (!b) {
      b = { timestamp: bucket, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }
      buckets.set(bucket, b)
    } else {
      if (c.high > b.high) b.high = c.high
      if (c.low < b.low) b.low = c.low
      b.close = c.close
      b.volume += c.volume
    }
  }

  return [...buckets.values()].sort((a, b) => a.timestamp - b.timestamp)
}