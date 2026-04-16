import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/app/lib/auth/server'
import { createClient as createAdmin } from '@supabase/supabase-js'

const admin = () => createAdmin(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// GET — fetch track record with stats
export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const checkOutcomes = searchParams.get('check') === 'true'

  // Check and update pending outcomes
  if (checkOutcomes) await updatePendingOutcomes(user.id)

  const { data: verdicts } = await admin()
    .from('verdict_log')
    .select('*')
    .eq('user_id', user.id)
    .order('verdict_date', { ascending: false })
    .limit(100)

  const all = verdicts ?? []

  // Compute stats
  const resolved1w = all.filter(v => v.outcome_1w && v.outcome_1w !== 'pending')
  const resolved1m = all.filter(v => v.outcome_1m && v.outcome_1m !== 'pending')

  const winRate1w = resolved1w.length > 0
    ? (resolved1w.filter(v => v.outcome_1w === 'correct').length / resolved1w.length) * 100
    : null

  const winRate1m = resolved1m.length > 0
    ? (resolved1m.filter(v => v.outcome_1m === 'correct').length / resolved1m.length) * 100
    : null

  const avgGain1w = resolved1w.filter(v => v.pct_change_1w !== null).length > 0
    ? resolved1w.reduce((s, v) => s + (v.pct_change_1w ?? 0), 0) / resolved1w.length
    : null

  const bySignal = ['BULLISH','BEARISH','NEUTRAL'].map(sig => {
    const sigVerdicts = resolved1w.filter(v => v.signal === sig)
    const correct = sigVerdicts.filter(v => v.outcome_1w === 'correct').length
    return { signal: sig, total: sigVerdicts.length, correct, winRate: sigVerdicts.length > 0 ? (correct / sigVerdicts.length) * 100 : null }
  })

  return NextResponse.json({
    verdicts: all,
    stats: {
      total: all.length,
      resolved1w: resolved1w.length,
      resolved1m: resolved1m.length,
      winRate1w,
      winRate1m,
      avgGain1w,
      bySignal,
    }
  })
}

// POST — log a new verdict
export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const { ticker, signal, confidence, entry_price, stop_loss, take_profit, time_horizon, persona, timeframe } = await req.json()
  if (!ticker || !signal) return NextResponse.json({ error: 'ticker and signal required' }, { status: 400 })

  // Don't log duplicate on same ticker same day
  const today = new Date().toISOString().split('T')[0]
  const { data: existing } = await admin()
    .from('verdict_log')
    .select('id')
    .eq('user_id', user.id)
    .eq('ticker', ticker.toUpperCase())
    .eq('verdict_date', today)
    .eq('signal', signal)
    .maybeSingle()

  if (existing) return NextResponse.json({ logged: false, reason: 'duplicate' })

  const { data } = await admin()
    .from('verdict_log')
    .insert({
      user_id: user.id,
      ticker: ticker.toUpperCase(),
      signal,
      confidence: confidence ?? null,
      entry_price: entry_price ? parseFloat(String(entry_price).replace(/[^0-9.-]/g,'')) : null,
      stop_loss: stop_loss ? parseFloat(String(stop_loss).replace(/[^0-9.-]/g,'')) : null,
      take_profit: take_profit ? parseFloat(String(take_profit).replace(/[^0-9.-]/g,'')) : null,
      time_horizon: time_horizon ?? null,
      persona: persona ?? 'balanced',
      timeframe: timeframe ?? '1W',
      outcome_1w: 'pending',
      outcome_1m: 'pending',
    })
    .select()
    .single()

  return NextResponse.json({ logged: true, verdict: data })
}

// ── Outcome checker ─────────────────────────────────────────
async function updatePendingOutcomes(userId: string) {
  const today = new Date().toISOString().split('T')[0]
  const finnhubKey = process.env.FINNHUB_API_KEY
  if (!finnhubKey) return

  // Get verdicts that are due for 1W or 1M check
  const { data: pending } = await admin()
    .from('verdict_log')
    .select('*')
    .eq('user_id', userId)
    .or(`and(outcome_1w.eq.pending,check_1w_after.lte.${today}),and(outcome_1m.eq.pending,check_1m_after.lte.${today})`)
    .limit(20)

  if (!pending?.length) return

  // Fetch current prices for unique tickers
  const tickers = [...new Set(pending.map(v => v.ticker))]
  const prices: Record<string, number> = {}

  await Promise.all(tickers.map(async ticker => {
    try {
      const r = await fetch(`https://finnhub.io/api/v1/quote?symbol=${ticker}&token=${finnhubKey}`, { cache: 'no-store' })
      if (!r.ok) return
      const d = await r.json()
      if (d.c > 0) prices[ticker] = d.c
    } catch { /* ignore */ }
  }))

  // Update each verdict
  for (const v of pending) {
    const currentPrice = prices[v.ticker]
    if (!currentPrice || !v.entry_price) continue

    const pctChange = ((currentPrice - v.entry_price) / v.entry_price) * 100

    const isCorrect = (v.signal === 'BULLISH' && pctChange > 2) ||
                      (v.signal === 'BEARISH' && pctChange < -2) ||
                      (v.signal === 'NEUTRAL' && Math.abs(pctChange) < 3)

    const outcome = isCorrect ? 'correct' : 'incorrect'
    const updates: Record<string, unknown> = {}

    if (v.outcome_1w === 'pending' && v.check_1w_after <= today) {
      updates.outcome_1w = outcome
      updates.price_at_1w = currentPrice
      updates.pct_change_1w = parseFloat(pctChange.toFixed(2))
    }

    if (v.outcome_1m === 'pending' && v.check_1m_after <= today) {
      updates.outcome_1m = outcome
      updates.price_at_1m = currentPrice
      updates.pct_change_1m = parseFloat(pctChange.toFixed(2))
    }

    if (Object.keys(updates).length > 0) {
      await admin().from('verdict_log').update(updates).eq('id', v.id)
    }
  }
}
