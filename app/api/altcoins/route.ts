// ═════════════════════════════════════════════════════════════
// GET /api/altcoins?days=7
//
// Returns altcoins from the altcoins_cache table. Response has TWO
// sections:
//   - upcoming: tokens Grok found announced on X as launching soon
//   - launched: tokens CoinGecko has listed in the last N days
//
// Query params:
//   days: '1' | '7' | '30' (default '7') — filters the `launched` section
//   sort: 'mentions' (default) | 'listed' | 'price_change' | 'market_cap'
//   limit: number (default 100, max 200) — applies to each section
// ═════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const getAdmin = () => createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const daysParam = url.searchParams.get('days') ?? '7'
  const sortParam = url.searchParams.get('sort') ?? 'mentions'
  const limitParam = Math.min(200, Math.max(1, parseInt(url.searchParams.get('limit') ?? '100', 10)))

  const days = parseInt(daysParam, 10)
  if (![1, 7, 30].includes(days)) {
    return NextResponse.json({ error: 'days must be 1, 7, or 30' }, { status: 400 })
  }

  const admin = getAdmin()
  const selectCols = 'coingecko_id, symbol, name, listed_date, days_since_listed, current_price_usd, price_change_24h_pct, market_cap_rank, market_cap_usd, volume_24h_usd, image_url, x_mention_count, x_sentiment, x_top_post_summary, refreshed_at, status, launch_date, launch_source_url, launch_platform, launch_confidence'

  // ── Launched section ──
  let launchedQuery = admin
    .from('altcoins_cache')
    .select(selectCols)
    .eq('status', 'launched')
    .lte('days_since_listed', days)
    .limit(limitParam)

  switch (sortParam) {
    case 'listed':
      launchedQuery = launchedQuery.order('listed_date', { ascending: false })
      break
    case 'price_change':
      launchedQuery = launchedQuery.order('price_change_24h_pct', { ascending: false, nullsFirst: false })
      break
    case 'market_cap':
      launchedQuery = launchedQuery.order('market_cap_usd', { ascending: false, nullsFirst: false })
      break
    case 'mentions':
    default:
      launchedQuery = launchedQuery.order('x_mention_count', { ascending: false, nullsFirst: false })
      break
  }

  // ── Upcoming section ──
  // Only show upcoming entries refreshed in the last 48h (anything older
  // is likely stale — the launch may have happened or been cancelled)
  const fortyEightHoursAgo = new Date(Date.now() - 48 * 3600 * 1000).toISOString()

  const upcomingQuery = admin
    .from('altcoins_cache')
    .select(selectCols)
    .eq('status', 'upcoming')
    .gte('refreshed_at', fortyEightHoursAgo)
    .order('x_mention_count', { ascending: false, nullsFirst: false })
    .limit(limitParam)

  const [launchedResult, upcomingResult] = await Promise.all([launchedQuery, upcomingQuery])

  if (launchedResult.error) {
    console.error('[altcoins] launched query failed:', launchedResult.error.message)
    return NextResponse.json({ error: 'failed to load launched altcoins', detail: launchedResult.error.message }, { status: 500 })
  }

  if (upcomingResult.error) {
    console.error('[altcoins] upcoming query failed:', upcomingResult.error.message)
    // Don't fail the whole response — just return launched with empty upcoming
  }

  const launched = launchedResult.data ?? []
  const upcoming = upcomingResult.data ?? []

  // Determine cache age for UI freshness display
  const allRows = [...launched, ...upcoming]
  const mostRecentRefresh = allRows.length > 0
    ? allRows.reduce((latest, r) => r.refreshed_at > latest ? r.refreshed_at : latest, allRows[0].refreshed_at)
    : null

  return NextResponse.json({
    ok: true,
    days,
    sort: sortParam,
    upcomingCount: upcoming.length,
    launchedCount: launched.length,
    lastRefreshed: mostRecentRefresh,
    upcoming,
    launched,
    generatedAt: new Date().toISOString(),
  })
}
