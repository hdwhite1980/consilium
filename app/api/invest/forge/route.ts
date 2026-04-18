import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/app/lib/auth/server'
import { createClient as createAdmin } from '@supabase/supabase-js'

const getAdmin = () => createAdmin(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// ── Milestone / stage config (server-authoritative) ──────────
const STAGES = [
  { name: 'Spark',   min: 0,      max: 10,        maxPositions: 2, emoji: '🔥',   color: '#fbbf24',
    tagline: 'Momentum micro-caps · find the first ember' },
  { name: 'Ember',   min: 10,     max: 50,        maxPositions: 2, emoji: '🔥🔥', color: '#f97316',
    tagline: 'Technical setups · feel the heat build' },
  { name: 'Flame',   min: 50,     max: 200,       maxPositions: 3, emoji: '🔥🔥🔥', color: '#ef4444',
    tagline: 'Catalysts + technicals · the fire holds' },
  { name: 'Blaze',   min: 200,    max: 1000,      maxPositions: 4, emoji: '⚡',   color: '#a78bfa',
    tagline: 'Full debate analysis · conviction grows' },
  { name: 'Inferno', min: 1000,   max: 10000,     maxPositions: 5, emoji: '💎',   color: '#60a5fa',
    tagline: 'High-conviction plays · the fire roars' },
  { name: 'Free',    min: 10000,  max: Infinity,  maxPositions: 10, emoji: '🏆', color: '#34d399',
    tagline: 'Any stock · the forge is yours' },
]

function getStage(totalValue: number) {
  return STAGES.find(s => totalValue >= s.min && totalValue < s.max) ?? STAGES[0]
}

function getNextStage(totalValue: number) {
  const idx = STAGES.findIndex(s => totalValue >= s.min && totalValue < s.max)
  if (idx < 0 || idx >= STAGES.length - 1) return null
  return STAGES[idx + 1]
}

// ── Live price helpers ───────────────────────────────────────
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

// ── Sector winds (from existing /api/macro) ──────────────────
async function fetchSectorWinds(): Promise<Array<{ name: string; etf: string; signal: string; change1D: number }>> {
  try {
    const res = await fetch(`${process.env.NEXT_PUBLIC_APP_URL}/api/macro`, {
      cache: 'no-store',
      headers: { 'x-internal': '1' },
    })
    if (!res.ok) return []
    const data = await res.json()
    return (data.sectors ?? []).map((s: { name: string; etf: string; signal: string; change1D: number }) => ({
      name: s.name,
      etf: s.etf,
      signal: s.signal,
      change1D: s.change1D,
    }))
  } catch { return [] }
}

// ── GET — everything the Forge page needs ────────────────────
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

  // Live prices for open positions (parallel)
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

  // Value math
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

  // Stage + progress
  const stage = getStage(totalValue)
  const nextStage = getNextStage(totalValue)
  const progressPct = nextStage
    ? Math.min(100, Math.max(0, ((totalValue - stage.min) / (nextStage.min - stage.min)) * 100))
    : 100
  const toNext = nextStage ? Math.max(0, nextStage.min - totalValue) : 0

  // Stats
  const winCount = closedTrades.filter(t => (t.exit_price ?? 0) > t.entry_price).length
  const winRate = closedTrades.length > 0 ? Math.round((winCount / closedTrades.length) * 100) : 0

  // Sector winds: top bullish + bearish for the UI ribbon
  const sectorWinds = sectorsRaw
    .filter(s => typeof s.change1D === 'number')
    .sort((a, b) => (b.change1D ?? 0) - (a.change1D ?? 0))

  return NextResponse.json({
    journey: journey ?? null,
    stage: {
      ...stage,
      progressPct: Math.round(progressPct),
      toNext: Number(toNext.toFixed(2)),
      nextStageName: nextStage?.name ?? null,
    },
    stages: STAGES.map(s => ({
      name: s.name, emoji: s.emoji, color: s.color,
      min: s.min, max: s.max === Infinity ? null : s.max,
      tagline: s.tagline,
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
