// ═════════════════════════════════════════════════════════════
// /api/earnings/calendar — Market-wide earnings calendar
//
// Query params:
//   range: 'week' (default) | 'month'
//   page:  number (for pagination, 1-indexed)
//
// Returns:
//   - earnings: array of { ticker, date, hour, epsEstimate, revenueEstimate, isYours }
//   - isYours: true if user holds the ticker (from portfolio OR recent analyses fallback)
//   - userSubscriptions: list of tickers the user has manually subscribed to (bell on)
//   - autoPortfolioEnabled: user's master-toggle state
//
// Anonymous users: still see the calendar, just with isYours=false everywhere.
// ═════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { cookies } from 'next/headers'
import { createServerClient } from '@supabase/ssr'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface FinnhubEarning {
  date: string           // YYYY-MM-DD
  hour: string           // 'bmo' | 'amc' | 'dmh' (before open / after close / during market hours)
  symbol: string
  epsEstimate: number | null
  revenueEstimate: number | null
  year: number
  quarter: number
}

async function fetchFinnhubEarnings(fromDate: string, toDate: string): Promise<FinnhubEarning[]> {
  const key = process.env.FINNHUB_API_KEY
  if (!key) return []
  try {
    const url = `https://finnhub.io/api/v1/calendar/earnings?from=${fromDate}&to=${toDate}&token=${key}`
    const res = await fetch(url, { next: { revalidate: 3600 } })  // cache 1h
    if (!res.ok) return []
    const data = await res.json()
    return data.earningsCalendar ?? []
  } catch {
    return []
  }
}

/**
 * Fetch user's portfolio tickers.
 * Tries multiple table name conventions — whichever exists will match.
 * Falls back to recent verdict_log entries if no portfolio table found.
 */
async function fetchUserHoldings(userId: string): Promise<Set<string>> {
  const admin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )

  const holdings = new Set<string>()

  // Try common portfolio table names — first one that returns data wins
  const candidateTables = ['portfolios', 'portfolio', 'holdings', 'user_holdings', 'user_portfolio']
  for (const tbl of candidateTables) {
    try {
      const { data, error } = await admin
        .from(tbl)
        .select('ticker, symbol')
        .eq('user_id', userId)
        .limit(500)
      if (!error && data && data.length > 0) {
        for (const row of data) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const t = ((row as any).ticker ?? (row as any).symbol ?? '').toString().toUpperCase()
          if (t) holdings.add(t)
        }
        if (holdings.size > 0) return holdings
      }
    } catch { /* table doesn't exist, try next */ }
  }

  // Fallback: use tickers from recent verdict_log entries (last 60 days)
  const sixtyDaysAgo = new Date(Date.now() - 60 * 86400000).toISOString().split('T')[0]
  try {
    const { data } = await admin
      .from('verdict_log')
      .select('ticker')
      .eq('user_id', userId)
      .gte('verdict_date', sixtyDaysAgo)
      .limit(500)
    for (const row of data ?? []) {
      if (row.ticker) holdings.add(row.ticker.toUpperCase())
    }
  } catch { /* non-critical */ }

  return holdings
}

async function fetchUserSubscriptions(userId: string): Promise<{ manualTickers: Set<string>; autoEnabled: boolean }> {
  const admin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )

  const manualTickers = new Set<string>()
  let autoEnabled = false

  try {
    const { data: subs } = await admin
      .from('earnings_subscriptions')
      .select('ticker, subscription_type')
      .eq('user_id', userId)
    for (const s of subs ?? []) {
      if (s.subscription_type === 'manual_ticker' && s.ticker) {
        manualTickers.add(s.ticker.toUpperCase())
      }
    }
  } catch { /* table may not exist yet */ }

  try {
    const { data: settings } = await admin
      .from('earnings_notification_settings')
      .select('auto_portfolio_enabled')
      .eq('user_id', userId)
      .maybeSingle()
    autoEnabled = settings?.auto_portfolio_enabled ?? false
  } catch { /* table may not exist yet */ }

  return { manualTickers, autoEnabled }
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const range = url.searchParams.get('range') ?? 'week'
  const page = Math.max(1, parseInt(url.searchParams.get('page') ?? '1', 10))
  const pageSize = 50

  // Compute date range
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const fromDate = startOfToday.toISOString().split('T')[0]
  const toDate = new Date(startOfToday.getTime() + (range === 'month' ? 30 : 7) * 86400000)
    .toISOString().split('T')[0]

  // Auth (optional — earnings calendar works for anonymous users too)
  let userId: string | null = null
  try {
    const cookieStore = await cookies()
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll: () => cookieStore.getAll(),
          setAll: () => {},
        },
      }
    )
    const { data: { user } } = await supabase.auth.getUser()
    userId = user?.id ?? null
  } catch { /* anonymous is fine */ }

  // Parallel fetch
  const [earnings, holdings, subs] = await Promise.all([
    fetchFinnhubEarnings(fromDate, toDate),
    userId ? fetchUserHoldings(userId) : Promise.resolve(new Set<string>()),
    userId ? fetchUserSubscriptions(userId) : Promise.resolve({ manualTickers: new Set<string>(), autoEnabled: false }),
  ])

  // Enrich + sort: user holdings first (within same date), then chronological
  const enriched = earnings.map(e => ({
    ticker: e.symbol,
    date: e.date,
    hour: e.hour,               // 'bmo' | 'amc' | 'dmh'
    epsEstimate: e.epsEstimate,
    revenueEstimate: e.revenueEstimate,
    year: e.year,
    quarter: e.quarter,
    isYours: holdings.has(e.symbol?.toUpperCase() ?? ''),
    isSubscribed: subs.manualTickers.has(e.symbol?.toUpperCase() ?? '') ||
                  (subs.autoEnabled && holdings.has(e.symbol?.toUpperCase() ?? '')),
  }))

  // Sort: group by date, within each date put isYours first, then alphabetical
  enriched.sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date)
    if (a.isYours !== b.isYours) return a.isYours ? -1 : 1
    return (a.ticker ?? '').localeCompare(b.ticker ?? '')
  })

  // Paginate
  const start = (page - 1) * pageSize
  const pageItems = enriched.slice(start, start + pageSize)
  const totalPages = Math.ceil(enriched.length / pageSize)

  return NextResponse.json({
    ok: true,
    range,
    page,
    pageSize,
    totalCount: enriched.length,
    totalPages,
    earnings: pageItems,
    userContext: userId ? {
      authenticated: true,
      holdingsCount: holdings.size,
      autoPortfolioEnabled: subs.autoEnabled,
      manualSubscriptions: Array.from(subs.manualTickers),
    } : {
      authenticated: false,
    },
    generatedAt: new Date().toISOString(),
  })
}
