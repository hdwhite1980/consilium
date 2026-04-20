import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/app/lib/auth/server'
import { createClient as createAdmin } from '@supabase/supabase-js'

const getAdmin = () => createAdmin(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// ── Tier config (server-authoritative) ──────────────────────
// 5 tiers from Buyer to Sovereign.
const TIERS = [
  { name: 'Buyer',     min: 1,     max: 50,       maxPositions: 2,  color: '#14b8a6',
    tagline: 'First positions — sizing and stops over speed' },
  { name: 'Builder',   min: 50,    max: 200,      maxPositions: 3,  color: '#3b82f6',
    tagline: 'Technical setups — building a real book' },
  { name: 'Operator',  min: 200,   max: 1000,     maxPositions: 4,  color: '#6366f1',
    tagline: 'Full debate analysis — running the book with intent' },
  { name: 'Principal', min: 1000,  max: 10000,    maxPositions: 5,  color: '#d4a857',
    tagline: 'High-conviction plays — decisions with real weight' },
  { name: 'Sovereign', min: 10000, max: Infinity, maxPositions: 10, color: '#f5f5f5',
    tagline: 'Any instrument — complete capital authority' },
]

function getTier(totalValue: number) {
  return TIERS.find(t => totalValue >= t.min && totalValue < t.max) ?? TIERS[0]
}
function getNextTier(totalValue: number) {
  const idx = TIERS.findIndex(t => totalValue >= t.min && totalValue < t.max)
  if (idx < 0 || idx >= TIERS.length - 1) return null
  return TIERS[idx + 1]
}

async function fetchLivePrice(ticker: string): Promise<number | null> {
  const key = process.env.FINNHUB_API_KEY
  if (!key) return null
  try {
    const res = await fetch(
      `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(ticker)}&token=${key}`,
      { cache: 'no-store' }
    )
    if (!res.ok) return null
    const q = await res.json()
    return (q.c && q.c > 0) ? Number(q.c) : null
  } catch { return null }
}

async function fetchSectorWinds(): Promise<Array<{ name: string; etf: string; signal: string; change1D: number }>> {
  try {
    const res = await fetch(`${process.env.NEXT_PUBLIC_APP_URL}/api/macro`, {
      cache: 'no-store',
      headers: { 'x-internal': '1' },
    })
    if (!res.ok) return []
    const data = await res.json()
    return (data.sectors ?? []).map((s: { name: string; etf: string; signal: string; change1D: number }) => ({
      name: s.name, etf: s.etf, signal: s.signal, change1D: s.change1D,
    }))
  } catch { return [] }
}

export async function GET(_req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const admin = getAdmin()

  const [{ data: trades }, { data: journey }, sectorsRaw] = await Promise.all([
    admin.from('invest_trades').select('*').eq('user_id', user.id).order('opened_at', { ascending: false }),
    admin.from('invest_journey').select('*').eq('user_id', user.id).maybeSingle(),
    fetchSectorWinds(),
  ])

  const allTrades = trades ?? []
  const openTrades = allTrades.filter(t => !t.exit_price)
  const closedTrades = allTrades.filter(t => !!t.exit_price)

  const priceMap: Record<string, number | null> = {}
  await Promise.all(openTrades.map(async t => {
    priceMap[t.ticker] = await fetchLivePrice(t.ticker)
  }))

  const enrichedOpen = openTrades.map(t => {
    const currentPrice = priceMap[t.ticker] ?? null
    const pnl = currentPrice != null ? (currentPrice - t.entry_price) * t.shares : null
    const pnlPct = currentPrice != null ? ((currentPrice - t.entry_price) / t.entry_price) * 100 : null
    return { ...t, currentPrice, pnl, pnlPct }
  })

  const unrealizedValue = enrichedOpen.reduce(
    (s, t) => s + ((t.currentPrice ?? t.entry_price) * t.shares), 0
  )
  const realized = closedTrades.reduce(
    (s, t) => s + ((t.exit_price! - t.entry_price) * t.shares), 0
  )
  const totalInvested = enrichedOpen.reduce(
    (s, t) => s + (t.entry_price * t.shares), 0
  )
  const startBal = journey?.starting_balance ?? 0
  const cashRemaining = Math.max(0, startBal - totalInvested + realized)
  const totalValue = cashRemaining + unrealizedValue

  const tier = getTier(totalValue)
  const nextTier = getNextTier(totalValue)
  const progressPct = nextTier
    ? Math.min(100, Math.max(0, ((totalValue - tier.min) / (nextTier.min - tier.min)) * 100))
    : 100
  const toNext = nextTier ? Math.max(0, nextTier.min - totalValue) : 0

  const winCount = closedTrades.filter(t => (t.exit_price ?? 0) > t.entry_price).length
  const winRate = closedTrades.length > 0 ? Math.round((winCount / closedTrades.length) * 100) : 0

  const sectorWinds = sectorsRaw
    .filter(s => typeof s.change1D === 'number')
    .sort((a, b) => (b.change1D ?? 0) - (a.change1D ?? 0))

  return NextResponse.json({
    journey: journey ?? null,
    tier: {
      ...tier,
      progressPct: Math.round(progressPct),
      toNext: Number(toNext.toFixed(2)),
      nextTierName: nextTier?.name ?? null,
    },
    tiers: TIERS.map(t => ({
      name: t.name, color: t.color,
      min: t.min, max: t.max === Infinity ? null : t.max,
      tagline: t.tagline,
    })),
    value: {
      total: Number(totalValue.toFixed(2)),
      cashRemaining: Number(cashRemaining.toFixed(2)),
      unrealized: Number(unrealizedValue.toFixed(2)),
      realized: Number(realized.toFixed(2)),
      openPnL: Number((unrealizedValue - totalInvested).toFixed(2)),
    },
    openTrades: enrichedOpen,
    closedTrades,
    stats: {
      totalTrades: closedTrades.length + openTrades.length,
      closedCount: closedTrades.length,
      winCount,
      winRate,
      winStreak: journey?.win_streak ?? 0,
      bestStreak: journey?.best_streak ?? 0,
      firstWinAt: journey?.first_win_at ?? null,
    },
    sectorWinds,
  })
}

// ════════════════════════════════════════════════════════════════
// POST — dispatches three actions by `type` discriminator
//
//   set_balance  — opens the book (sets starting_balance on invest_journey)
//   open_trade   — inserts a new row into invest_trades
//   close_trade  — sets exit_price on invest_trades, updates streaks
//
// All three expect a JSON body with { type, ...payload }.
// All three return { ok: true, ...data } on success or
// { ok: false, error } with appropriate status on failure.
// ════════════════════════════════════════════════════════════════

export async function POST(req: NextRequest) {
  // ── Auth ──────────────────────────────────────────────────
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ ok: false, error: 'Not authenticated' }, { status: 401 })
  }

  // ── Parse body ────────────────────────────────────────────
  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON body' }, { status: 400 })
  }

  const type = typeof body.type === 'string' ? body.type : null
  if (!type) {
    return NextResponse.json({ ok: false, error: 'Missing `type` field' }, { status: 400 })
  }

  const admin = getAdmin()

  // ══════════════════════════════════════════════════════════
  // ACTION: set_balance — "Open the book" submission
  // ══════════════════════════════════════════════════════════
  if (type === 'set_balance') {
    const balance = Number(body.balance)
    if (!Number.isFinite(balance) || balance <= 0) {
      return NextResponse.json(
        { ok: false, error: 'balance must be a positive number' },
        { status: 400 }
      )
    }

    // Upsert — creates journey on first open, updates on subsequent changes.
    // We only set starting_balance, win_streak, best_streak on insert;
    // on update we only touch starting_balance so we don't reset streaks.
    const { data: existing } = await admin
      .from('invest_journey')
      .select('user_id')
      .eq('user_id', user.id)
      .maybeSingle()

    if (existing) {
      const { error } = await admin
        .from('invest_journey')
        .update({ starting_balance: balance })
        .eq('user_id', user.id)
      if (error) {
        return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
      }
    } else {
      const { error } = await admin
        .from('invest_journey')
        .insert({
          user_id: user.id,
          starting_balance: balance,
          win_streak: 0,
          best_streak: 0,
        })
      if (error) {
        return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
      }
    }

    return NextResponse.json({ ok: true, starting_balance: balance })
  }

  // ══════════════════════════════════════════════════════════
  // ACTION: open_trade — log a new position (stock OR option)
  //
  // Stock trades use: ticker, shares, entry_price
  // Option trades use: ticker (underlying), option_type, strike, expiry,
  //                    contracts, entry_premium
  //   - shares is derived (contracts * 100) for consistent P/L math
  //   - entry_price is stored as entry_premium for option rows
  // ══════════════════════════════════════════════════════════
  if (type === 'open_trade') {
    const ticker = typeof body.ticker === 'string' ? body.ticker.toUpperCase().trim() : ''
    if (!ticker || !/^[A-Z0-9.\-]{1,10}$/.test(ticker)) {
      return NextResponse.json({ ok: false, error: 'Invalid ticker' }, { status: 400 })
    }

    const position_type = (body.position_type === 'option') ? 'option' : 'stock'

    // Optional common fields
    const council_signal = typeof body.council_signal === 'string' ? body.council_signal : null
    const confidenceRaw = body.confidence
    const confidence = typeof confidenceRaw === 'number' && Number.isFinite(confidenceRaw)
      ? Math.max(0, Math.min(100, Math.round(confidenceRaw)))
      : null
    const notes = typeof body.notes === 'string' && body.notes.trim().length > 0
      ? body.notes.trim().slice(0, 2000)
      : null

    // ══ Commit A: new required/optional fields ══════════════════════════
    // rationale: REQUIRED (min 10 chars) — the user's thesis for entering
    // stop_price / target_price: REQUIRED — exit plan defined at entry
    // verdict_id: OPTIONAL — links this trade back to the verdict_log row
    //             that inspired it (null for manual trades without a council signal)
    const rationaleRaw = typeof body.rationale === 'string' ? body.rationale.trim() : ''
    if (rationaleRaw.length < 10) {
      return NextResponse.json({
        ok: false,
        error: 'rationale is required (min 10 characters) — describe why you are entering this trade',
      }, { status: 400 })
    }
    const rationale = rationaleRaw.slice(0, 2000)

    const stopPriceRaw = Number(body.stop_price)
    if (!Number.isFinite(stopPriceRaw) || stopPriceRaw <= 0) {
      return NextResponse.json({
        ok: false,
        error: 'stop_price must be a positive number — define your stop-loss at entry',
      }, { status: 400 })
    }
    const stop_price = stopPriceRaw

    const targetPriceRaw = Number(body.target_price)
    if (!Number.isFinite(targetPriceRaw) || targetPriceRaw <= 0) {
      return NextResponse.json({
        ok: false,
        error: 'target_price must be a positive number — define your take-profit target at entry',
      }, { status: 400 })
    }
    const target_price = targetPriceRaw

    // verdict_id is optional — only present when the trade came from a council idea.
    // Sanity-check format (UUID or the text IDs our pipeline uses).
    const verdictIdRaw = typeof body.verdict_id === 'string' ? body.verdict_id.trim() : ''
    const verdict_id = verdictIdRaw.length > 0 && verdictIdRaw.length <= 100 ? verdictIdRaw : null

    let insertRow: Record<string, unknown> = {
      user_id: user.id,
      ticker,
      council_signal,
      confidence,
      notes,
      position_type,
      opened_at: new Date().toISOString(),
      // Commit A additions
      stop_price,
      target_price,
      rationale,
      verdict_id,
      plan_outcome: 'still_open',
    }

    if (position_type === 'stock') {
      const shares = Number(body.shares)
      const entry_price = Number(body.entry_price)
      if (!Number.isFinite(shares) || shares <= 0) {
        return NextResponse.json({ ok: false, error: 'shares must be a positive number' }, { status: 400 })
      }
      if (!Number.isFinite(entry_price) || entry_price <= 0) {
        return NextResponse.json({ ok: false, error: 'entry_price must be a positive number' }, { status: 400 })
      }
      insertRow.shares = shares
      insertRow.entry_price = entry_price
    } else {
      // Option trade validation
      const option_type = body.option_type === 'put' ? 'put' : body.option_type === 'call' ? 'call' : null
      const strike = Number(body.strike)
      const expiry = typeof body.expiry === 'string' ? body.expiry : null
      const contracts = Number(body.contracts ?? 1)
      const entry_premium = Number(body.entry_premium)
      const underlying = typeof body.underlying === 'string' ? body.underlying.toUpperCase() : ticker

      if (!option_type) {
        return NextResponse.json({ ok: false, error: 'option_type must be call or put' }, { status: 400 })
      }
      if (!Number.isFinite(strike) || strike <= 0) {
        return NextResponse.json({ ok: false, error: 'strike must be a positive number' }, { status: 400 })
      }
      if (!expiry || !/^\d{4}-\d{2}-\d{2}$/.test(expiry)) {
        return NextResponse.json({ ok: false, error: 'expiry must be YYYY-MM-DD' }, { status: 400 })
      }
      if (!Number.isFinite(contracts) || contracts <= 0) {
        return NextResponse.json({ ok: false, error: 'contracts must be a positive number' }, { status: 400 })
      }
      if (!Number.isFinite(entry_premium) || entry_premium <= 0) {
        return NextResponse.json({ ok: false, error: 'entry_premium must be a positive number' }, { status: 400 })
      }

      insertRow.option_type = option_type
      insertRow.strike = strike
      insertRow.expiry = expiry
      insertRow.contracts = contracts
      insertRow.entry_premium = entry_premium
      insertRow.underlying = underlying
      // Store shares = contracts * 100 so existing P/L queries still work
      insertRow.shares = contracts * 100
      // Store entry_price = entry_premium so stock-centric views stay consistent
      insertRow.entry_price = entry_premium
    }

    const { data: inserted, error } = await admin
      .from('invest_trades')
      .insert(insertRow)
      .select()
      .single()

    if (error) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
    }

    return NextResponse.json({ ok: true, trade: inserted })
  }

  // ══════════════════════════════════════════════════════════
  // ACTION: close_trade — set exit_price, update streaks
  //
  // Stock trades: body has { id, exit_price }
  // Option trades: body has { id, exit_premium } — the actual sell
  //   price per share of premium. We store this in BOTH exit_price
  //   (so existing P/L math keeps working — exit_price and entry_price
  //   are both per-share premium for options) AND exit_premium.
  //
  // Frontend expects { isWin, postmortemPending } in the response.
  // isWin is used for the first-win celebration animation.
  // postmortemPending signals the UI to poll /api/invest/analyze-trade
  // for the grade + analysis.
  // ══════════════════════════════════════════════════════════
  if (type === 'close_trade') {
    const id = typeof body.id === 'string' ? body.id : null
    if (!id) {
      return NextResponse.json({ ok: false, error: 'id required' }, { status: 400 })
    }

    // Fetch first to verify ownership + detect stock vs option
    const { data: trade, error: fetchErr } = await admin
      .from('invest_trades')
      .select('*')
      .eq('id', id)
      .eq('user_id', user.id)
      .maybeSingle()

    if (fetchErr || !trade) {
      return NextResponse.json({ ok: false, error: 'Trade not found' }, { status: 404 })
    }
    if (trade.exit_price != null) {
      return NextResponse.json({ ok: false, error: 'Trade already closed' }, { status: 409 })
    }

    const isOption = trade.position_type === 'option'
    const exit_price = isOption ? Number(body.exit_premium) : Number(body.exit_price)
    const exit_premium = isOption ? Number(body.exit_premium) : null

    if (!Number.isFinite(exit_price) || exit_price <= 0) {
      return NextResponse.json(
        { ok: false, error: isOption ? 'exit_premium must be a positive number' : 'exit_price must be a positive number' },
        { status: 400 }
      )
    }

    const isWin = exit_price > trade.entry_price

    // ══ Commit A: classify plan_outcome at close ══════════════════════════
    // Compare exit price vs the user's pre-defined stop/target. Track whether
    // the trade followed the plan or bailed early. This lets the postmortem
    // and Track Record dashboard tell you "stop hit as planned" vs
    // "target reached as planned" vs "closed early without hitting either."
    const stop = trade.stop_price as number | null
    const target = trade.target_price as number | null
    let plan_outcome: 'stop_hit' | 'target_hit' | 'closed_early' = 'closed_early'
    let stop_hit_at: string | null = null
    let target_hit_at: string | null = null
    const nowIso = new Date().toISOString()

    // For both stocks and options the winning direction is exit > entry,
    // losing direction exit < entry. We use that to interpret stop/target.
    // Determine bullish vs bearish stance from the signal rather than entry/exit,
    // since entry and stop form the truth regardless.
    if (stop !== null && target !== null) {
      // Bullish plan: target > entry > stop. Bearish plan: stop > entry > target.
      const isBullishPlan = target > trade.entry_price && stop < trade.entry_price
      const isBearishPlan = target < trade.entry_price && stop > trade.entry_price

      if (isBullishPlan) {
        // Bullish: exit at/above target = target hit; exit at/below stop = stop hit
        if (exit_price >= target) {
          plan_outcome = 'target_hit'
          target_hit_at = nowIso
        } else if (exit_price <= stop) {
          plan_outcome = 'stop_hit'
          stop_hit_at = nowIso
        }
      } else if (isBearishPlan) {
        // Bearish: exit at/below target = target hit; exit at/above stop = stop hit
        if (exit_price <= target) {
          plan_outcome = 'target_hit'
          target_hit_at = nowIso
        } else if (exit_price >= stop) {
          plan_outcome = 'stop_hit'
          stop_hit_at = nowIso
        }
      }
      // If neither condition hit, the user closed early — plan_outcome stays 'closed_early'
    }

    // Update the trade
    const updateRow: Record<string, unknown> = {
      exit_price,
      exit_date: nowIso,
      plan_outcome,
      stop_hit_at,
      target_hit_at,
    }
    if (isOption && exit_premium !== null) {
      updateRow.exit_premium = exit_premium
    }

    const { error: updateErr } = await admin
      .from('invest_trades')
      .update(updateRow)
      .eq('id', id)
      .eq('user_id', user.id)

    if (updateErr) {
      return NextResponse.json({ ok: false, error: updateErr.message }, { status: 500 })
    }

    // Update streaks on invest_journey
    const { data: journey } = await admin
      .from('invest_journey')
      .select('*')
      .eq('user_id', user.id)
      .maybeSingle()

    if (journey) {
      const currentStreak = journey.win_streak ?? 0
      const bestStreak = journey.best_streak ?? 0
      const newWinStreak = isWin ? currentStreak + 1 : 0
      const newBestStreak = Math.max(bestStreak, newWinStreak)
      const firstWinAt = journey.first_win_at ?? (isWin ? new Date().toISOString() : null)

      await admin
        .from('invest_journey')
        .update({
          win_streak: newWinStreak,
          best_streak: newBestStreak,
          first_win_at: firstWinAt,
        })
        .eq('user_id', user.id)
    }

    // Fire-and-forget post-mortem generation. We don't await — the client
    // will poll /api/invest/analyze-trade?tradeId={id} to fetch once ready.
    // Errors in this background request are logged but don't block close.
    const appUrl = process.env.NEXT_PUBLIC_APP_URL
    if (appUrl) {
      // Forward the user's auth cookie so the downstream route authenticates
      // as the same user. We don't await this.
      const cookieHeader = req.headers.get('cookie') ?? ''
      fetch(`${appUrl}/api/invest/analyze-trade`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          cookie: cookieHeader,
        },
        body: JSON.stringify({ tradeId: id }),
      }).catch(err => console.error('[close_trade] postmortem fire-and-forget failed:', err))
    }

    return NextResponse.json({ ok: true, isWin, postmortemPending: true })
  }

  // ── Unknown action ────────────────────────────────────────
  return NextResponse.json(
    { ok: false, error: `Unknown action type: ${type}` },
    { status: 400 }
  )
}
