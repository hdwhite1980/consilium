// ═════════════════════════════════════════════════════════════
// /api/backtest/outcomes — Cron endpoint (REWRITTEN 2026-04-30)
//
// Updates pending outcomes in verdict_log:
//   1. Finds verdicts where outcome_1d/1w/1m is 'pending' AND old enough
//   2. Fetches OHLC bars from ALPACA (was Finnhub — moved due to free-tier
//      restrictions on Finnhub's /candle endpoint)
//   3. Computes BOTH strict and directional outcomes
//   4. NEW: Threshold fallback for verdicts without target/stop —
//      previously marked 'expired'; now resolved against per-timeframe
//      threshold (3% / 5% / 8% by horizon)
//
// Auth: requires X-Cron-Secret header matching process.env.CRON_SECRET.
// Designed to be called by GitHub Actions cron daily.
//
// Safe to call multiple times — only updates verdicts where outcome is
// still 'pending'. Idempotent.
//
// What changed vs the old version:
//   - Replaced Finnhub /stock/candle (paid tier only) with Alpaca
//     /v2/stocks/{ticker}/bars (free, already in use elsewhere in the app)
//   - Added 1-day outcome resolution alongside 1w/1m
//   - Added threshold fallback for verdicts without target/stop
//   - Added optional `?horizon=1d|1w|1m|all` query param so cron jobs
//     can resolve specific horizons at different times of day
// ═════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { isCryptoPairSymbol, toCoinbaseProduct } from '@/app/lib/crypto-symbol'
import { fetchCryptoBars } from '@/app/lib/trading/crypto-bars'
import { makeOandaClient } from '@/app/lib/trading/oanda-client'
import { loadBrokerCredentialForUse } from '@/app/lib/trading/credentials'
import type { Bar } from '@/app/lib/signals/technicals'

export const runtime = 'nodejs'
export const maxDuration = 300  // 5 min max

// ─────────────────────────────────────────────────────────────
// Alpaca bars fetcher (replaces Finnhub /stock/candle)
// ─────────────────────────────────────────────────────────────
//
// Returns Finnhub-shape data so the rest of the resolver doesn't change:
//   { c: [], h: [], l: [], o: [], t: [] }
//
// Try SIP first (real-time consolidated), fall back to IEX for OTC etc.
// ─────────────────────────────────────────────────────────────

const ALPACA_BASE = 'https://data.alpaca.markets'

interface AlpacaBar {
  t: string  // ISO timestamp
  o: number
  h: number
  l: number
  c: number
  v: number
}

interface CandleResponse {
  c: number[]
  h: number[]
  l: number[]
  o: number[]
  t: number[]
}

type FetchResult =
  | { ok: true; candles: CandleResponse }
  | { ok: false; reason: 'nodata' | 'error' }

async function fetchCandles(
  ticker: string,
  fromUnix: number,
  toUnix: number,
): Promise<FetchResult> {
  const apiKey = process.env.ALPACA_API_KEY
  const apiSecret = process.env.ALPACA_SECRET_KEY
  if (!apiKey || !apiSecret) {
    console.warn('[backtest-resolver] ALPACA_API_KEY/SECRET missing')
    return { ok: false, reason: 'error' }
  }

  const headers = {
    'APCA-API-KEY-ID': apiKey,
    'APCA-API-SECRET-KEY': apiSecret,
    'Accept': 'application/json',
  }

  const startStr = new Date(fromUnix * 1000).toISOString().split('T')[0]
  const endStr = new Date(toUnix * 1000).toISOString().split('T')[0]

  // Distinguish a transient failure (HTTP error / network throw — retry next run)
  // from a clean "no data exists" (200 OK + 0 bars — permanent: non-stock, delisted).
  let sawTransientError = false

  // Try SIP first, fall back to IEX
  for (const feed of ['sip', 'iex']) {
    try {
      const url = `${ALPACA_BASE}/v2/stocks/${ticker}/bars` +
        `?timeframe=1Day&start=${startStr}&end=${endStr}` +
        `&limit=10000&adjustment=all&feed=${feed}`
      const res = await fetch(url, { headers, cache: 'no-store' })
      if (!res.ok) {
        console.warn(`[backtest-resolver] ${ticker} feed=${feed} HTTP ${res.status} ${res.statusText}`)
        sawTransientError = true
        continue
      }
      const data = await res.json()
      const bars = (data.bars ?? []) as AlpacaBar[]
      if (bars.length === 0) {
        console.warn(`[backtest-resolver] ${ticker} feed=${feed} returned 0 bars (${startStr}->${endStr})`)
        continue
      }
      // Convert to Finnhub-shape arrays
      return {
        ok: true,
        candles: {
          c: bars.map(b => b.c),
          h: bars.map(b => b.h),
          l: bars.map(b => b.l),
          o: bars.map(b => b.o),
          t: bars.map(b => Math.floor(new Date(b.t).getTime() / 1000)),
        },
      }
    } catch (e) {
      console.warn(`[backtest-resolver] ${ticker} feed=${feed} threw: ${(e as Error).message}`)
      sawTransientError = true
    }
  }
  // Both feeds exhausted. If any feed errored, treat as transient (retry).
  // If all feeds cleanly returned 0 bars, the data does not exist → permanent.
  return { ok: false, reason: sawTransientError ? 'error' : 'nodata' }
}

// ─────────────────────────────────────────────────────────────
// Multi-asset bar dispatch: crypto → Coinbase, forex → OANDA, else → Alpaca stocks
// ─────────────────────────────────────────────────────────────

// Shared Bar {t:string,o,h,l,c,v} → resolver's CandleResponse (arrays, t in unix sec).
function barsToCandles(bars: Bar[]): CandleResponse {
  return {
    c: bars.map(b => b.c),
    h: bars.map(b => b.h),
    l: bars.map(b => b.l),
    o: bars.map(b => b.o),
    t: bars.map(b => Math.floor(new Date(b.t).getTime() / 1000)),
  }
}

const FIAT = new Set([
  'USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD', 'XAU', 'XAG',
  'HKD', 'SGD', 'NOK', 'SEK', 'MXN', 'ZAR', 'TRY', 'CNH', 'PLN', 'DKK',
])
function isForexPair(t: string): boolean {
  const s = (t ?? '').toUpperCase().replace(/[-_/]/g, '')
  return s.length === 6 && FIAT.has(s.slice(0, 3)) && FIAT.has(s.slice(3, 6))
}
function toOandaInstrument(t: string): string {
  const s = (t ?? '').toUpperCase().replace(/[-_/]/g, '')
  return `${s.slice(0, 3)}_${s.slice(3, 6)}`
}

// Coinbase daily candles for crypto pairs (public market endpoint — no creds).
async function fetchCryptoCandles(ticker: string, fromUnix: number, toUnix: number): Promise<FetchResult> {
  try {
    const product = toCoinbaseProduct(ticker)   // BTCUSD → BTC-USD
    const bars = await fetchCryptoBars({
      symbol: product, granularity: 'ONE_DAY', startUnix: fromUnix, endUnix: toUnix, limit: 300,
    })
    if (!bars || bars.length === 0) {
      console.warn(`[backtest-resolver] ${ticker} (crypto ${product}) returned 0 bars`)
      return { ok: false, reason: 'nodata' }
    }
    return { ok: true, candles: barsToCandles(bars) }
  } catch (e) {
    console.warn(`[backtest-resolver] ${ticker} crypto fetch threw: ${(e as Error).message}`)
    return { ok: false, reason: 'error' }
  }
}

// OANDA daily candles for forex pairs (needs the user's OANDA credential).
async function fetchForexCandles(
  ticker: string, fromUnix: number, toUnix: number, userId: string | null,
): Promise<FetchResult> {
  try {
    if (!userId) return { ok: false, reason: 'error' }
    const cred = await loadBrokerCredentialForUse(userId, 'oanda', 'paper', 'forex')
    if (!cred) {
      console.warn(`[backtest-resolver] ${ticker} forex: no OANDA credential for user ${userId}`)
      return { ok: false, reason: 'error' }   // missing cred is transient, not "no data"
    }
    const client = makeOandaClient(cred.keyId, cred.secret, 'paper')
    const instrument = toOandaInstrument(ticker)
    // OANDA candles() returns the most-recent N — fetch enough to cover the window.
    const nowUnix = Math.floor(Date.now() / 1000)
    const daysBack = Math.ceil((nowUnix - fromUnix) / 86400) + 5
    const count = Math.min(500, Math.max(20, daysBack))
    const bars = await client.candles(instrument, 'D', count)
    const inWindow = bars.filter(b => {
      const u = Math.floor(new Date(b.t).getTime() / 1000)
      return u >= fromUnix && u <= toUnix
    })
    if (inWindow.length === 0) {
      console.warn(`[backtest-resolver] ${ticker} (forex ${instrument}) 0 bars in window`)
      return { ok: false, reason: 'nodata' }
    }
    return { ok: true, candles: barsToCandles(inWindow) }
  } catch (e) {
    console.warn(`[backtest-resolver] ${ticker} forex fetch threw: ${(e as Error).message}`)
    return { ok: false, reason: 'error' }
  }
}

// Route a verdict to the right bar source by asset class.
async function fetchBarsForVerdict(
  ticker: string, fromUnix: number, toUnix: number, userId: string | null,
): Promise<FetchResult> {
  if (isCryptoPairSymbol(ticker)) return fetchCryptoCandles(ticker, fromUnix, toUnix)
  if (isForexPair(ticker))        return fetchForexCandles(ticker, fromUnix, toUnix, userId)
  return fetchCandles(ticker, fromUnix, toUnix)   // stocks/ETFs; futures fall through → nodata → expired
}

// ─────────────────────────────────────────────────────────────
// Outcome computation
// ─────────────────────────────────────────────────────────────

type StrictOutcome = 'win' | 'loss' | 'expired' | 'pending'
type DirectionalOutcome = 'win' | 'loss' | 'pending'

interface ComputedOutcomes {
  strict: StrictOutcome
  directional: DirectionalOutcome
  closePrice: number | null
}

// Per-timeframe thresholds for the threshold-fallback path.
// When a verdict has no stop or no target, we use these to determine
// whether the move was meaningful enough to count as a "win".
//
// Aligned with how a trader would think about each horizon:
//   1d: a 3% move in a single day is non-trivial
//   1w: a 3% move in a week is normal-sized
//   1m: a 5% move in a month is meaningful (not noise)
//   3m: an 8% move in a quarter is a real trend
const THRESHOLDS: Record<string, number> = {
  '1d': 0.03,
  '1w': 0.03,
  '1m': 0.05,
  '3m': 0.08,
}

/**
 * Compute strict + directional outcomes for a verdict.
 *
 * STRICT logic:
 *   - If stop AND target are both set: walk bars, check first-hit (target=win, stop=loss)
 *   - If stop OR target missing: use threshold fallback against the horizon's % move
 *   - NEUTRAL signals: directional only, strict stays 'expired' (no direction to evaluate)
 *
 * DIRECTIONAL logic:
 *   - BULLISH correct if last close > entry (any positive move)
 *   - BEARISH correct if last close < entry (any negative move)
 *   - NEUTRAL correct if last close within ±2% of entry (no significant move)
 */
function computeOutcome(
  signal: string,
  entry: number,
  stop: number | null,
  target: number | null,
  candles: CandleResponse,
  horizon: '1d' | '1w' | '1m',
): ComputedOutcomes {
  const lastClose = candles.c[candles.c.length - 1] ?? null

  // ── DIRECTIONAL ──
  let directional: DirectionalOutcome = 'pending'
  if (lastClose !== null && entry > 0) {
    if (signal === 'BULLISH') {
      directional = lastClose > entry ? 'win' : 'loss'
    } else if (signal === 'BEARISH') {
      directional = lastClose < entry ? 'win' : 'loss'
    } else if (signal === 'NEUTRAL') {
      const pctMove = Math.abs((lastClose - entry) / entry)
      directional = pctMove < 0.02 ? 'win' : 'loss'
    }
  }

  // ── STRICT ──
  let strict: StrictOutcome = 'expired'

  // Path A: Hit-target-or-stop (when both are set)
  if (stop !== null && target !== null && signal !== 'NEUTRAL') {
    for (let i = 0; i < candles.h.length; i++) {
      const high = candles.h[i]
      const low = candles.l[i]
      if (signal === 'BULLISH') {
        const targetHit = high >= target
        const stopHit = low <= stop
        if (targetHit && stopHit) {
          // Same-bar ambiguity: use open-proximity heuristic
          const open = candles.o[i]
          strict = Math.abs(open - stop) < Math.abs(open - target) ? 'loss' : 'win'
          break
        }
        if (targetHit) { strict = 'win'; break }
        if (stopHit) { strict = 'loss'; break }
      } else if (signal === 'BEARISH') {
        const targetHit = low <= target  // BEARISH target is below entry
        const stopHit = high >= stop     // BEARISH stop is above entry
        if (targetHit && stopHit) {
          const open = candles.o[i]
          strict = Math.abs(open - stop) < Math.abs(open - target) ? 'loss' : 'win'
          break
        }
        if (targetHit) { strict = 'win'; break }
        if (stopHit) { strict = 'loss'; break }
      }
    }
  }
  // Path B: Threshold fallback — verdict didn't have target/stop set
  // Use per-horizon % threshold to determine if directional move was significant
  else if (lastClose !== null && entry > 0 && signal !== 'NEUTRAL') {
    const threshold = THRESHOLDS[horizon] ?? 0.03
    if (signal === 'BULLISH') {
      const pctMove = (lastClose - entry) / entry
      strict = pctMove >= threshold ? 'win'
        : pctMove <= -threshold ? 'loss'
        : 'expired'  // didn't move enough either way
    } else if (signal === 'BEARISH') {
      const pctMove = (entry - lastClose) / entry
      strict = pctMove >= threshold ? 'win'
        : pctMove <= -threshold ? 'loss'
        : 'expired'
    }
  }

  return { strict, directional, closePrice: lastClose }
}

// ─────────────────────────────────────────────────────────────
// Per-horizon resolver
// ─────────────────────────────────────────────────────────────

interface HorizonConfig {
  key: '1d' | '1w' | '1m'
  daysOld: number              // verdict must be at least this old
  windowDays: number           // how many days of candles to fetch
  strictColumn: string
  directionalColumn: string
  priceColumn: string
  computedAtColumn: string
  legacyColumn?: string        // for back-compat (1w/1m have legacy outcome_1w / outcome_1m)
  timeframeFilter?: string     // if set, only resolve verdicts where timeframe matches
}

const HORIZONS: HorizonConfig[] = [
  {
    key: '1d',
    daysOld: 2,                    // wait 2 days so weekend/Friday-PM verdicts have a real trading session
    windowDays: 2,                 // grab 2 days of bars to handle weekend gaps
    strictColumn: 'outcome_1d_strict',
    directionalColumn: 'outcome_1d_directional',
    priceColumn: 'outcome_1d_price',
    computedAtColumn: 'outcome_1d_computed_at',
    timeframeFilter: '1D',         // ONLY resolve verdicts whose declared timeframe is 1D
    // No legacy column — 1d outcomes are new
  },
  {
    key: '1w',
    daysOld: 7,
    windowDays: 7,
    strictColumn: 'outcome_1w_strict',
    directionalColumn: 'outcome_1w_directional',
    priceColumn: 'outcome_1w_price',
    computedAtColumn: 'outcome_1w_computed_at',
    legacyColumn: 'outcome_1w',
  },
  {
    key: '1m',
    daysOld: 30,
    windowDays: 30,
    strictColumn: 'outcome_1m_strict',
    directionalColumn: 'outcome_1m_directional',
    priceColumn: 'outcome_1m_price',
    computedAtColumn: 'outcome_1m_computed_at',
    legacyColumn: 'outcome_1m',
  },
]

interface VerdictRow {
  id: number
  ticker: string
  signal: string
  entry_price: number | null
  stop_loss: number | null
  take_profit: number | null
  verdict_date: string
  user_id: string | null
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function processHorizon(
  admin: any,
  horizon: HorizonConfig,
  now: Date,
): Promise<{ processed: number; errors: number; expired: number; resolved: number }> {

  const cutoff = new Date(now.getTime() - horizon.daysOld * 86400000)
    .toISOString().split('T')[0]

  let baseQuery = admin
    .from('verdict_log')
    .select('id, ticker, signal, entry_price, stop_loss, take_profit, verdict_date, user_id')
    .eq(horizon.strictColumn, 'pending')
    .lte('verdict_date', cutoff)

  // For horizons that should ONLY resolve a specific timeframe (e.g. 1d
  // only resolves timeframe='1D' verdicts), apply the additional filter.
  if (horizon.timeframeFilter) {
    baseQuery = baseQuery.eq('timeframe', horizon.timeframeFilter)
  }

  const { data: pending, error } = await baseQuery.limit(500)

  if (error) {
    console.error(`[backtest-resolver] ${horizon.key} fetch failed:`, error.message)
    return { processed: 0, errors: 1, expired: 0, resolved: 0 }
  }

  const rows = (pending ?? []) as VerdictRow[]
  if (rows.length === 0) {
    return { processed: 0, errors: 0, expired: 0, resolved: 0 }
  }

  console.log(`[backtest-resolver] ${horizon.key}: ${rows.length} pending verdicts to process`)

  let processed = 0
  let errors = 0
  let expired = 0
  let resolved = 0

  for (const v of rows) {
    // A signal is the only hard requirement — entry_price can be missing and is
    // derived from the verdict-date bar below, so directional calls logged
    // without a recorded entry still resolve instead of silently expiring.
    if (!v.signal) {
      const update: Record<string, unknown> = {
        [horizon.strictColumn]: 'expired',
        [horizon.directionalColumn]: 'pending',
        [horizon.computedAtColumn]: now.toISOString(),
      }
      if (horizon.legacyColumn) update[horizon.legacyColumn] = 'expired'
      await admin.from('verdict_log').update(update).eq('id', v.id)
      expired++
      continue
    }

    const verdictDate = new Date(v.verdict_date)
    const fromUnix = Math.floor(verdictDate.getTime() / 1000)
    // Add a small buffer to the window for weekend/holiday gaps
    const toUnix = Math.floor(
      (verdictDate.getTime() + (horizon.windowDays + 2) * 86400000) / 1000
    )

    const candleResult = await fetchBarsForVerdict(v.ticker, fromUnix, toUnix, v.user_id)
    if (!candleResult.ok) {
      if (candleResult.reason === 'nodata') {
        // No bars exist for this symbol (non-stock pair, delisted, warrant). It will
        // NEVER be resolvable on the stocks endpoint — expire it so it stops looping
        // as a permanent error and stops polluting the pending count.
        const update: Record<string, unknown> = {
          [horizon.strictColumn]: 'expired',
          [horizon.directionalColumn]: 'pending',
          [horizon.computedAtColumn]: now.toISOString(),
        }
        if (horizon.legacyColumn) update[horizon.legacyColumn] = 'expired'
        await admin.from('verdict_log').update(update).eq('id', v.id)
        console.log(`[backtest-resolver] ${v.ticker}: no stock data — marked expired (non-equity/delisted)`)
        expired++
      } else {
        // Transient (HTTP error / network) — leave pending, retry next run.
        errors++
      }
      continue
    }
    const candles = candleResult.candles

    // Derive the entry from the verdict-date bar when the verdict was logged
    // without one (some directional / active-story verdicts don't capture an
    // entry price). The first in-window bar's open is the price on verdict day.
    let entryPrice: number | null = v.entry_price != null ? Number(v.entry_price) : null
    let derivedEntry = false
    if (entryPrice === null || !Number.isFinite(entryPrice) || entryPrice <= 0) {
      const firstOpen = candles.o?.[0]
      if (firstOpen != null && Number.isFinite(firstOpen) && firstOpen > 0) {
        entryPrice = firstOpen
        derivedEntry = true
      } else {
        // No usable price anywhere — genuinely can't score it.
        const update: Record<string, unknown> = {
          [horizon.strictColumn]: 'expired',
          [horizon.directionalColumn]: 'pending',
          [horizon.computedAtColumn]: now.toISOString(),
        }
        if (horizon.legacyColumn) update[horizon.legacyColumn] = 'expired'
        await admin.from('verdict_log').update(update).eq('id', v.id)
        expired++
        continue
      }
    }

    const outcomes = computeOutcome(
      v.signal,
      entryPrice,
      v.stop_loss,
      v.take_profit,
      candles,
      horizon.key,
    )

    const update: Record<string, unknown> = {
      [horizon.strictColumn]: outcomes.strict,
      [horizon.directionalColumn]: outcomes.directional,
      [horizon.priceColumn]: outcomes.closePrice,
      [horizon.computedAtColumn]: now.toISOString(),
    }
    // Persist the derived entry so the record is complete and the dashboard shows it.
    if (derivedEntry && entryPrice !== null) update.entry_price = entryPrice
    // Keep legacy 1w/1m columns in sync
    if (horizon.legacyColumn) update[horizon.legacyColumn] = outcomes.strict

    const { error: updateErr } = await admin.from('verdict_log').update(update).eq('id', v.id)
    if (updateErr) {
      console.error(`[backtest-resolver] update failed for verdict ${v.id}:`, updateErr.message)
      errors++
      continue
    }

    processed++
    if (outcomes.strict === 'win' || outcomes.strict === 'loss') resolved++
    else if (outcomes.strict === 'expired') expired++

    // Small delay between Alpaca calls to be polite
    await new Promise(r => setTimeout(r, 50))
  }

  return { processed, errors, expired, resolved }
}

// ─────────────────────────────────────────────────────────────
// Route handlers
// ─────────────────────────────────────────────────────────────

// Auth: accept the cron secret via X-Cron-Secret OR Authorization, with or
// without a "Bearer " prefix. QStash forwards the secret as a header whose value
// sometimes carries a "Bearer " prefix; stripping it (and accepting either
// header) keeps this aligned with every other cron and avoids silent 401s.
function isCronAuthorized(req: NextRequest): boolean {
  const expected = process.env.CRON_SECRET
  if (!expected) return false
  const strip = (v: string | null) => (v ?? '').replace(/^Bearer\s+/i, '').trim()
  return strip(req.headers.get('x-cron-secret')) === expected
      || strip(req.headers.get('authorization')) === expected
}

export async function POST(req: NextRequest) {
  // Auth
  if (!isCronAuthorized(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const admin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )

  const url = new URL(req.url)
  const horizonParam = url.searchParams.get('horizon') ?? 'all'
  const targetHorizons = horizonParam === 'all'
    ? HORIZONS
    : HORIZONS.filter(h => h.key === horizonParam)

  if (targetHorizons.length === 0) {
    return NextResponse.json({
      error: `Invalid horizon: ${horizonParam}. Use 1d, 1w, 1m, or all.`,
    }, { status: 400 })
  }

  const now = new Date()
  const startedAt = now.toISOString()

  const results: Record<string, ReturnType<typeof processHorizon> extends Promise<infer R> ? R : never> = {}
  for (const h of targetHorizons) {
    results[h.key] = await processHorizon(admin, h, now)
  }

  const totalProcessed = Object.values(results).reduce((s, r) => s + r.processed, 0)
  const totalErrors = Object.values(results).reduce((s, r) => s + r.errors, 0)
  const totalResolved = Object.values(results).reduce((s, r) => s + r.resolved, 0)

  console.log(`[backtest-resolver] DONE: ${totalProcessed} processed, ${totalResolved} resolved (win/loss), ${totalErrors} errors`)

  return NextResponse.json({
    ok: true,
    horizons: targetHorizons.map(h => h.key),
    results,
    totals: {
      processed: totalProcessed,
      resolved: totalResolved,
      errors: totalErrors,
    },
    startedAt,
    finishedAt: new Date().toISOString(),
  })
}

// GET — manual diagnostic. Returns counts of pending verdicts WITHOUT updating.
// Useful for sanity-checking before running a real resolution pass.
export async function GET(req: NextRequest) {
  if (!isCronAuthorized(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const admin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )

  const now = new Date()
  const counts: Record<string, { pending: number; daysOld: number }> = {}

  for (const h of HORIZONS) {
    const cutoff = new Date(now.getTime() - h.daysOld * 86400000)
      .toISOString().split('T')[0]
    let q = admin
      .from('verdict_log')
      .select('*', { count: 'exact', head: true })
      .eq(h.strictColumn, 'pending')
      .lte('verdict_date', cutoff)
    if (h.timeframeFilter) {
      q = q.eq('timeframe', h.timeframeFilter)
    }
    const { count } = await q
    counts[h.key] = { pending: count ?? 0, daysOld: h.daysOld }
  }

  return NextResponse.json({
    ok: true,
    counts,
    timestamp: now.toISOString(),
  })
}
