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
