// ═════════════════════════════════════════════════════════════
// /api/backtest/outcomes — Cron endpoint
//
// Updates pending outcomes in verdict_log:
//   1. Finds verdicts where outcome_1w is 'pending' and >=7 days old
//   2. Fetches 7-day bar history from Finnhub
//   3. Computes BOTH strict and directional outcomes
//   4. Same for 30-day window
//
// Auth: requires X-Cron-Secret header matching process.env.CRON_SECRET.
// Designed to be called by Railway cron daily at 4am ET.
//
// Safe to call multiple times — only updates verdicts where outcome is
// still 'pending'. Idempotent.
// ═════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const runtime = 'nodejs'
export const maxDuration = 300  // 5 min max

// Finnhub candle endpoint: returns daily OHLC for a ticker + time range
async function fetchCandles(ticker: string, fromUnix: number, toUnix: number): Promise<null | {
  c: number[]; h: number[]; l: number[]; o: number[]; t: number[];
}> {
  const key = process.env.FINNHUB_API_KEY
  if (!key) return null
  try {
    const url = `https://finnhub.io/api/v1/stock/candle?symbol=${ticker}&resolution=D&from=${fromUnix}&to=${toUnix}&token=${key}`
    const res = await fetch(url)
    if (!res.ok) return null
    const data = await res.json()
    if (data.s !== 'ok' || !data.c?.length) return null
    return data
  } catch {
    return null
  }
}

type StrictOutcome = 'win' | 'loss' | 'expired' | 'pending'
type DirectionalOutcome = 'win' | 'loss' | 'pending'

interface ComputedOutcomes {
  strict: StrictOutcome
  directional: DirectionalOutcome
  closePrice: number | null
}

/**
 * Compute both outcomes for a verdict given bar data over the horizon window.
 * 
 * Strict: did intraday high during window hit target? Did intraday low hit stop?
 *   - Both hit: whichever was hit FIRST wins (for BULLISH: if high hits target
 *     before low hits stop, it's a win; approximate by checking which daily
 *     high/low was reached first chronologically)
 *   - Only target hit: win
 *   - Only stop hit: loss
 *   - Neither: expired
 * 
 * Directional: close at end of window vs entry price.
 *   - BULLISH: close > entry is win, close < entry is loss
 *   - BEARISH: close < entry is win, close > entry is loss
 */
function computeOutcome(
  signal: string,
  entry: number,
  stop: number | null,
  target: number | null,
  candles: { c: number[]; h: number[]; l: number[]; o: number[]; t: number[] }
): ComputedOutcomes {
  const lastClose = candles.c[candles.c.length - 1]

  // ── Directional: simple close comparison ──
  let directional: DirectionalOutcome = 'pending'
  if (signal === 'BULLISH') {
    directional = lastClose > entry ? 'win' : 'loss'
  } else if (signal === 'BEARISH') {
    directional = lastClose < entry ? 'win' : 'loss'
  }

  // ── Strict: walk bars chronologically, find first hit ──
  let strict: StrictOutcome = 'expired'

  if (stop !== null && target !== null && signal !== 'NEUTRAL') {
    for (let i = 0; i < candles.h.length; i++) {
      const high = candles.h[i]
      const low = candles.l[i]

      if (signal === 'BULLISH') {
        // Check target first (we want win to take precedence in ambiguous same-bar cases)
        const targetHit = high >= target
        const stopHit   = low <= stop
        if (targetHit && stopHit) {
          // Ambiguous — same bar hit both. Use open-proximity heuristic:
          // if bar opened closer to stop, assume stop hit first.
          const open = candles.o[i]
          const distToStop = Math.abs(open - stop)
          const distToTarget = Math.abs(open - target)
          strict = distToStop < distToTarget ? 'loss' : 'win'
          break
        }
        if (targetHit) { strict = 'win'; break }
        if (stopHit)   { strict = 'loss'; break }
      } else if (signal === 'BEARISH') {
        const targetHit = low <= target     // for BEARISH, target is BELOW entry
        const stopHit   = high >= stop      // stop is ABOVE entry
        if (targetHit && stopHit) {
          const open = candles.o[i]
          const distToStop = Math.abs(open - stop)
          const distToTarget = Math.abs(open - target)
          strict = distToStop < distToTarget ? 'loss' : 'win'
          break
        }
        if (targetHit) { strict = 'win'; break }
        if (stopHit)   { strict = 'loss'; break }
      }
    }
  }

  return { strict, directional, closePrice: lastClose ?? null }
}

export async function POST(req: NextRequest) {
  // ── Auth check ──
  const secret = req.headers.get('x-cron-secret')
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const admin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )

  const now = new Date()
  const nowSec = Math.floor(now.getTime() / 1000)

  // ── Process 1-week outcomes ──
  const oneWeekAgo = new Date(now.getTime() - 7 * 86400000).toISOString().split('T')[0]
  const { data: pending1w, error: err1w } = await admin
    .from('verdict_log')
    .select('id, ticker, signal, entry_price, stop_loss, take_profit, verdict_date')
    .eq('outcome_1w_strict', 'pending')
    .lte('verdict_date', oneWeekAgo)
    .limit(500)

  if (err1w) {
    console.error('[backtest-cron] 1w fetch failed:', err1w.message)
  }

  let processed1w = 0
  let errors1w = 0
  for (const v of pending1w ?? []) {
    if (!v.entry_price || !v.signal) {
      // Mark as expired if we can't compute
      await admin.from('verdict_log').update({
        outcome_1w_strict: 'expired',
        outcome_1w_directional: 'pending',
        outcome_1w_computed_at: now.toISOString(),
      }).eq('id', v.id)
      continue
    }
    const verdictDate = new Date(v.verdict_date)
    const fromUnix = Math.floor(verdictDate.getTime() / 1000)
    const toUnix = Math.floor((verdictDate.getTime() + 7 * 86400000) / 1000)
    const candles = await fetchCandles(v.ticker, fromUnix, toUnix)
    if (!candles) {
      errors1w++
      continue
    }
    const outcomes = computeOutcome(v.signal, v.entry_price, v.stop_loss, v.take_profit, candles)
    await admin.from('verdict_log').update({
      outcome_1w_strict: outcomes.strict,
      outcome_1w_directional: outcomes.directional,
      outcome_1w_price: outcomes.closePrice,
      outcome_1w_computed_at: now.toISOString(),
      // Keep the old `outcome_1w` column in sync so any existing code that
      // reads it still works (maps to strict outcome).
      outcome_1w: outcomes.strict,
    }).eq('id', v.id)
    processed1w++
  }

  // ── Process 1-month outcomes ──
  const oneMonthAgo = new Date(now.getTime() - 30 * 86400000).toISOString().split('T')[0]
  const { data: pending1m, error: err1m } = await admin
    .from('verdict_log')
    .select('id, ticker, signal, entry_price, stop_loss, take_profit, verdict_date')
    .eq('outcome_1m_strict', 'pending')
    .lte('verdict_date', oneMonthAgo)
    .limit(500)

  if (err1m) {
    console.error('[backtest-cron] 1m fetch failed:', err1m.message)
  }

  let processed1m = 0
  let errors1m = 0
  for (const v of pending1m ?? []) {
    if (!v.entry_price || !v.signal) {
      await admin.from('verdict_log').update({
        outcome_1m_strict: 'expired',
        outcome_1m_directional: 'pending',
        outcome_1m_computed_at: now.toISOString(),
      }).eq('id', v.id)
      continue
    }
    const verdictDate = new Date(v.verdict_date)
    const fromUnix = Math.floor(verdictDate.getTime() / 1000)
    const toUnix = Math.floor((verdictDate.getTime() + 30 * 86400000) / 1000)
    const candles = await fetchCandles(v.ticker, fromUnix, toUnix)
    if (!candles) {
      errors1m++
      continue
    }
    const outcomes = computeOutcome(v.signal, v.entry_price, v.stop_loss, v.take_profit, candles)
    await admin.from('verdict_log').update({
      outcome_1m_strict: outcomes.strict,
      outcome_1m_directional: outcomes.directional,
      outcome_1m_price: outcomes.closePrice,
      outcome_1m_computed_at: now.toISOString(),
      outcome_1m: outcomes.strict,
    }).eq('id', v.id)
    processed1m++
  }

  return NextResponse.json({
    ok: true,
    processed_1w: processed1w,
    errors_1w: errors1w,
    processed_1m: processed1m,
    errors_1m: errors1m,
    timestamp: now.toISOString(),
  })
}

// GET for manual testing — returns counts of pending verdicts without updating
export async function GET(req: NextRequest) {
  const secret = req.headers.get('x-cron-secret')
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const admin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )

  const now = new Date()
  const oneWeekAgo = new Date(now.getTime() - 7 * 86400000).toISOString().split('T')[0]
  const oneMonthAgo = new Date(now.getTime() - 30 * 86400000).toISOString().split('T')[0]

  const { count: pending1w } = await admin
    .from('verdict_log')
    .select('*', { count: 'exact', head: true })
    .eq('outcome_1w_strict', 'pending')
    .lte('verdict_date', oneWeekAgo)

  const { count: pending1m } = await admin
    .from('verdict_log')
    .select('*', { count: 'exact', head: true })
    .eq('outcome_1m_strict', 'pending')
    .lte('verdict_date', oneMonthAgo)

  return NextResponse.json({
    ok: true,
    pending_1w: pending1w ?? 0,
    pending_1m: pending1m ?? 0,
    timestamp: now.toISOString(),
  })
}
