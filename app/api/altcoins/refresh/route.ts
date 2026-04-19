// ═════════════════════════════════════════════════════════════
// POST /api/altcoins/refresh — daily cron endpoint
//
// Runs THREE passes:
//   1. CoinGecko: fetch recently listed tokens, upsert as status='launched'
//   2. Grok (upcoming scan): search X for upcoming launch announcements,
//      upsert as status='upcoming'
//   3. Grok (buzz enrichment): for each launched/upcoming token, score
//      X mention volume and sentiment
//
// Fire-and-forget pattern. Returns 202 immediately.
// Writes failures to cron_job_failures.
// ═════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { callGrok } from '@/app/lib/grok'

export const runtime = 'nodejs'
export const maxDuration = 300  // 5 min budget

const getAdmin = () => createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

function logJobFailure(err: unknown, context: string): void {
  void (async () => {
    try {
      const admin = getAdmin()
      await admin.from('cron_job_failures').insert({
        job_type: 'altcoins-refresh',
        error_message: `[${context}] ${err instanceof Error ? err.message : String(err)}`,
        error_stack: err instanceof Error ? err.stack?.slice(0, 4000) : null,
      })
    } catch (e) {
      console.error('[altcoins-refresh] failure log failed:', (e as Error).message)
    }
  })()
}

// ─────────────────────────────────────────────────────────────
// CoinGecko: fetch new listings
// ─────────────────────────────────────────────────────────────
interface CoinGeckoMarket {
  id: string
  symbol: string
  name: string
  image: string | null
  current_price: number | null
  price_change_percentage_24h: number | null
  market_cap: number | null
  market_cap_rank: number | null
  total_volume: number | null
  atl_date: string | null
  ath_date: string | null
  last_updated: string | null
}

async function fetchCoinGeckoNewListings(): Promise<CoinGeckoMarket[]> {
  const url = new URL('https://api.coingecko.com/api/v3/coins/markets')
  url.searchParams.set('vs_currency', 'usd')
  url.searchParams.set('order', 'market_cap_asc')
  url.searchParams.set('per_page', '250')
  url.searchParams.set('page', '1')
  url.searchParams.set('sparkline', 'false')
  url.searchParams.set('price_change_percentage', '24h')

  const res = await fetch(url.toString(), {
    headers: {
      'Accept': 'application/json',
      ...(process.env.COINGECKO_API_KEY ? { 'x-cg-pro-api-key': process.env.COINGECKO_API_KEY } : {}),
    },
  })

  if (!res.ok) throw new Error(`CoinGecko /coins/markets returned ${res.status}`)
  const data = await res.json()
  return Array.isArray(data) ? data : []
}

async function fetchCoinGenesisDate(id: string): Promise<string | null> {
  try {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/coins/${id}?localization=false&tickers=false&community_data=false&developer_data=false&sparkline=false`,
      { headers: { 'Accept': 'application/json', ...(process.env.COINGECKO_API_KEY ? { 'x-cg-pro-api-key': process.env.COINGECKO_API_KEY } : {}) } }
    )
    if (!res.ok) return null
    const data = await res.json()
    return data.genesis_date ?? null
  } catch {
    return null
  }
}

// ─────────────────────────────────────────────────────────────
// Grok: scan X for upcoming launch announcements
// ─────────────────────────────────────────────────────────────
interface UpcomingLaunch {
  symbol: string
  name: string
  launchDate: string | null      // ISO date or null if unknown
  platform: string | null         // 'Base' | 'Solana' | 'Ethereum' | 'CoinList' | etc.
  confidence: 'verified' | 'user_reported' | 'rumor'
  sourceUrl: string | null
  mentionCount: number
  summary: string
}

async function fetchGrokUpcomingLaunches(): Promise<UpcomingLaunch[]> {
  try {
    const today = new Date().toISOString().split('T')[0]
    const nextWeek = new Date(Date.now() + 7 * 86400000).toISOString().split('T')[0]

    const result = await callGrok(
      [
        {
          role: 'system',
          content: `You are a crypto market analyst scanning X (Twitter) for upcoming altcoin and memecoin launches scheduled between ${today} and ${nextWeek}.

Your job: identify tokens that have CONCRETE launch announcements — not vague "coming soon" posts.

Signals that a launch is real:
- Specific date mentioned (e.g., "launching April 24", "TGE on Friday")
- Contract address already deployed (even if trading isn't live)
- Launchpad confirmed (CoinList, Binance Launchpad, Coinbase, Fjord, DAOMaker, pump.fun)
- Chain specified (Base, Solana, Ethereum, Arbitrum, etc.)
- Multiple credible posters discussing it (not just one shill account)

Return ONLY this JSON, no other text:
{
  "launches": [
    {
      "symbol": "TICKER",
      "name": "Full project name",
      "launchDate": "YYYY-MM-DD or null if unknown",
      "platform": "Base / Solana / Ethereum / CoinList / pump.fun / etc. or null",
      "confidence": "verified" | "user_reported" | "rumor",
      "sourceUrl": "URL of the most credible X post about it, or null",
      "mentionCount": <rough integer count of X posts mentioning it>,
      "summary": "1-2 sentence description of what the token is and why X is talking about it"
    }
  ]
}

Rules:
- Return 5-15 launches max. Quality over quantity.
- Set "confidence": "verified" ONLY if a well-known launchpad or project team confirmed it
- Set "confidence": "user_reported" if date/platform is claimed but unverified
- Set "confidence": "rumor" for speculative memecoin launches
- Skip obvious spam, scam tokens, or rugpull patterns
- If you cannot find 3+ credible upcoming launches, return "launches": []`,
        },
        {
          role: 'user',
          content: `What altcoin/memecoin launches are scheduled on X between ${today} and ${nextWeek}? Focus on ones with concrete dates, contract addresses, or launchpad confirmation. Return the JSON.`,
        },
      ],
      { temperature: 0.3, maxTokens: 2500, searchEnabled: true, timeoutMs: 60000 }
    )

    const cleaned = result.replace(/```json|```/g, '').trim()
    const start = cleaned.indexOf('{')
    const end = cleaned.lastIndexOf('}')
    if (start === -1 || end === -1) {
      console.warn('[altcoins-refresh] Grok upcoming scan: no JSON found')
      return []
    }

    const parsed = JSON.parse(cleaned.slice(start, end + 1))
    const launches = Array.isArray(parsed.launches) ? parsed.launches : []

    // Validate + normalize
    return launches
      .filter((l: unknown) => typeof l === 'object' && l !== null)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((l: any) => ({
        symbol: (l.symbol ?? '').toString().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10),
        name: (l.name ?? '').toString().slice(0, 120),
        launchDate: l.launchDate && /^\d{4}-\d{2}-\d{2}$/.test(l.launchDate) ? l.launchDate : null,
        platform: l.platform ? l.platform.toString().slice(0, 40) : null,
        confidence: ['verified', 'user_reported', 'rumor'].includes(l.confidence) ? l.confidence : 'user_reported',
        sourceUrl: l.sourceUrl ? l.sourceUrl.toString().slice(0, 500) : null,
        mentionCount: Math.max(0, parseInt(l.mentionCount ?? 0, 10)),
        summary: (l.summary ?? '').toString().slice(0, 500),
      }))
      .filter((l: UpcomingLaunch) => l.symbol && l.name)
  } catch (e) {
    console.error('[altcoins-refresh] Grok upcoming scan failed:', (e as Error).message)
    logJobFailure(e, 'fetchGrokUpcomingLaunches')
    return []
  }
}

// ─────────────────────────────────────────────────────────────
// Grok: buzz enrichment for a specific token
// ─────────────────────────────────────────────────────────────
interface GrokBuzz {
  mentionCount: number
  sentiment: 'bullish' | 'bearish' | 'mixed' | 'neutral' | 'unknown'
  topPostSummary: string
  error?: string
}

async function fetchGrokBuzz(symbol: string, name: string): Promise<GrokBuzz> {
  try {
    const result = await callGrok(
      [
        {
          role: 'system',
          content: `You are a crypto market analyst. The user will ask about a specific altcoin. Search X (Twitter) for recent posts mentioning this token (last 48 hours). Count approximate mention volume and assess sentiment.

Return ONLY this JSON structure, no other text:
{
  "mentionCount": <integer approximate mention count from last 48 hours, 0 if none>,
  "sentiment": "bullish" | "bearish" | "mixed" | "neutral" | "unknown",
  "topPostSummary": "<1-2 sentences summarizing the loudest narrative OR 'No substantive X activity found'>"
}

Rules:
- If you find 0 or 1 posts, mentionCount should be under 10, sentiment "unknown" or "neutral"
- Real buzz (>1000 mentions) is rare; don't inflate numbers
- "Bullish" means posters are celebrating price action, shilling the coin, hyping launches
- "Bearish" means posters warn scam/rugpull, complaining about price
- "Mixed" means genuine disagreement
- Never invent specific prices or facts; only report what you see in posts`,
        },
        {
          role: 'user',
          content: `Search X for recent posts about the altcoin "${name}" (ticker: $${symbol}). How many mentions in the last 48 hours, and what is the dominant sentiment? Return JSON.`,
        },
      ],
      { temperature: 0.2, maxTokens: 500, searchEnabled: true, timeoutMs: 30000 }
    )

    const cleaned = result.replace(/```json|```/g, '').trim()
    const start = cleaned.indexOf('{')
    const end = cleaned.lastIndexOf('}')
    if (start === -1 || end === -1) {
      return { mentionCount: 0, sentiment: 'unknown', topPostSummary: 'No substantive X activity found', error: 'no-json' }
    }
    const parsed = JSON.parse(cleaned.slice(start, end + 1))

    return {
      mentionCount: Math.max(0, parseInt(parsed.mentionCount ?? 0, 10)),
      sentiment: ['bullish', 'bearish', 'mixed', 'neutral', 'unknown'].includes(parsed.sentiment) ? parsed.sentiment : 'unknown',
      topPostSummary: (parsed.topPostSummary ?? '').toString().slice(0, 500),
    }
  } catch (e) {
    return {
      mentionCount: 0,
      sentiment: 'unknown',
      topPostSummary: '',
      error: (e as Error).message?.slice(0, 200) ?? 'unknown error',
    }
  }
}

// ─────────────────────────────────────────────────────────────
// Main refresh logic
// ─────────────────────────────────────────────────────────────
async function runRefresh(): Promise<{
  launchedProcessed: number
  upcomingProcessed: number
  enriched: number
  errors: number
}> {
  const admin = getAdmin()
  const now = new Date()
  let launchedProcessed = 0
  let upcomingProcessed = 0
  let enriched = 0
  let errors = 0

  // ── PASS 1: CoinGecko new listings ──
  console.log('[altcoins-refresh] PASS 1: Fetching CoinGecko new listings...')
  let markets: CoinGeckoMarket[] = []
  try {
    markets = await fetchCoinGeckoNewListings()
    console.log(`[altcoins-refresh] got ${markets.length} coins from CoinGecko`)
  } catch (e) {
    console.error('[altcoins-refresh] CoinGecko fetch failed:', (e as Error).message)
    logJobFailure(e, 'fetchCoinGeckoNewListings')
  }

  const thirtyDaysAgo = new Date(now.getTime() - 30 * 86400000)
  const candidates = markets.filter((m) => {
    const atl = m.atl_date ? new Date(m.atl_date) : null
    const ath = m.ath_date ? new Date(m.ath_date) : null
    return (atl && atl > thirtyDaysAgo) || (ath && ath > thirtyDaysAgo)
  })

  console.log(`[altcoins-refresh] ${candidates.length} candidates after 30-day filter`)
  const LAUNCHED_ENRICH_CAP = 40
  const launchedToProcess = candidates.slice(0, LAUNCHED_ENRICH_CAP)

  for (const market of launchedToProcess) {
    try {
      await new Promise((r) => setTimeout(r, 3000))  // rate limit CoinGecko
      const genesisDate = await fetchCoinGenesisDate(market.id)
      const listedDate = genesisDate ?? (market.atl_date ?? market.ath_date ?? now.toISOString().split('T')[0])
      const listedDateObj = new Date(listedDate)
      const daysSince = Math.max(0, Math.floor((now.getTime() - listedDateObj.getTime()) / 86400000))

      if (daysSince > 30) continue

      const buzz = await fetchGrokBuzz(market.symbol?.toUpperCase() ?? '', market.name)
      if (buzz.error) errors++
      else enriched++

      await admin.from('altcoins_cache').upsert({
        coingecko_id: market.id,
        symbol: market.symbol?.toUpperCase() ?? '',
        name: market.name,
        status: 'launched',
        listed_date: listedDate.split('T')[0],
        days_since_listed: daysSince,
        current_price_usd: market.current_price,
        price_change_24h_pct: market.price_change_percentage_24h,
        market_cap_rank: market.market_cap_rank,
        market_cap_usd: market.market_cap,
        volume_24h_usd: market.total_volume,
        image_url: market.image,
        x_mention_count: buzz.mentionCount,
        x_sentiment: buzz.sentiment,
        x_top_post_summary: buzz.topPostSummary,
        x_search_error: buzz.error ?? null,
        refreshed_at: now.toISOString(),
        refresh_source: 'cron',
        // Clear upcoming fields if this was previously upcoming
        launch_date: null,
        launch_source_url: null,
        launch_platform: null,
        launch_confidence: null,
      }, { onConflict: 'coingecko_id' })

      launchedProcessed++
    } catch (e) {
      errors++
      console.error(`[altcoins-refresh] failed on ${market.id}:`, (e as Error).message)
    }
  }

  // ── PASS 2: Grok upcoming launches ──
  console.log('[altcoins-refresh] PASS 2: Scanning X for upcoming launches...')
  const upcomingLaunches = await fetchGrokUpcomingLaunches()
  console.log(`[altcoins-refresh] Grok found ${upcomingLaunches.length} upcoming launches`)

  for (const launch of upcomingLaunches) {
    try {
      // Synthesize a coingecko_id for upcoming launches (they don't have real
      // CoinGecko IDs until they launch). Prefix with "upcoming-" so they can't
      // collide with real CoinGecko ids.
      const syntheticId = `upcoming-${launch.symbol.toLowerCase()}-${launch.launchDate ?? 'tbd'}`

      await admin.from('altcoins_cache').upsert({
        coingecko_id: syntheticId,
        symbol: launch.symbol,
        name: launch.name,
        status: 'upcoming',
        listed_date: null,
        days_since_listed: null,
        current_price_usd: null,
        price_change_24h_pct: null,
        market_cap_rank: null,
        market_cap_usd: null,
        volume_24h_usd: null,
        image_url: null,
        x_mention_count: launch.mentionCount,
        x_sentiment: launch.mentionCount > 500 ? 'bullish' : launch.mentionCount > 50 ? 'mixed' : 'unknown',
        x_top_post_summary: launch.summary,
        x_search_error: null,
        refreshed_at: now.toISOString(),
        refresh_source: 'cron',
        launch_date: launch.launchDate,
        launch_source_url: launch.sourceUrl,
        launch_platform: launch.platform,
        launch_confidence: launch.confidence,
        last_upcoming_scan: now.toISOString(),
      }, { onConflict: 'coingecko_id' })

      upcomingProcessed++
    } catch (e) {
      errors++
      console.error(`[altcoins-refresh] failed on upcoming ${launch.symbol}:`, (e as Error).message)
    }
  }

  // ── CLEANUP: remove stale upcoming entries (launch date passed by 3+ days) ──
  const threeDaysAgo = new Date(now.getTime() - 3 * 86400000).toISOString().split('T')[0]
  try {
    const { error: delErr, count } = await admin
      .from('altcoins_cache')
      .delete({ count: 'exact' })
      .eq('status', 'upcoming')
      .lt('launch_date', threeDaysAgo)
    if (!delErr && count && count > 0) {
      console.log(`[altcoins-refresh] cleaned up ${count} stale upcoming entries`)
    }
  } catch (e) {
    console.error('[altcoins-refresh] cleanup failed:', (e as Error).message)
  }

  console.log(`[altcoins-refresh] done: ${launchedProcessed} launched, ${upcomingProcessed} upcoming, ${enriched} enriched, ${errors} errors`)
  return { launchedProcessed, upcomingProcessed, enriched, errors }
}

export async function POST(req: NextRequest) {
  const secret = req.headers.get('x-cron-secret')
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const startedAt = new Date().toISOString()
  console.log(`[altcoins-refresh] Starting background job at ${startedAt}`)

  void (async () => {
    try {
      const stats = await runRefresh()
      console.log('[altcoins-refresh] Completed:', stats)
    } catch (e) {
      console.error('[altcoins-refresh] Background job failed:', e)
      logJobFailure(e, 'runRefresh')
    }
  })()

  return NextResponse.json(
    { ok: true, status: 'processing', startedAt },
    { status: 202 }
  )
}

export async function GET(req: NextRequest) {
  const secret = req.headers.get('x-cron-secret')
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const admin = getAdmin()
  const { data, count } = await admin
    .from('altcoins_cache')
    .select('coingecko_id, status, refreshed_at, days_since_listed, launch_date', { count: 'exact', head: false })
    .order('refreshed_at', { ascending: false })
    .limit(10)

  return NextResponse.json({
    ok: true,
    totalRows: count ?? 0,
    mostRecentSample: data ?? [],
    checkedAt: new Date().toISOString(),
  })
}
