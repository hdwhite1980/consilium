// =============================================================
// app/api/active-stories/route.ts
//
// GET /api/active-stories?session=today
//
// Returns the unified Active Stories payload for the dashboard.
// The frontend filters by session toggle (today/tomorrow/weekend)
// and groups within each session by timeframe.
//
// Thin read-only endpoint — all heavy lifting happens in the
// 4×daily cron route. This endpoint just reads the cached state.
// =============================================================

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/app/lib/auth/server'
import { createClient as createAdmin } from '@supabase/supabase-js'
import {
  loadStoriesBySession,
  type SessionAnchor,
  type Signal,
  type Timeframe,
  type TrackedStory,
} from '@/app/lib/story-tracker'
import { fetchCurrentPricesMany } from '@/app/lib/data/current-price'
import type { ActiveStoriesPayload } from '@/app/lib/types/active-stories'

export const runtime = 'nodejs'
export const maxDuration = 15  // bumped from 10 to accommodate price fetches

const VALID_SESSIONS: SessionAnchor[] = ['today', 'tomorrow', 'weekend']
const VALID_ASSET_TYPES = ['stock', 'crypto', 'forex', 'futures'] as const
type AssetTypeFilter = typeof VALID_ASSET_TYPES[number]

function getAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!
  return createAdmin(url, key)
}

export async function GET(req: NextRequest) {
  try {
    // Auth check
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // Parse session param (default: today)
    const url = new URL(req.url)
    const sessionParam = (url.searchParams.get('session') ?? 'today') as SessionAnchor
    const session: SessionAnchor = VALID_SESSIONS.includes(sessionParam) ? sessionParam : 'today'

    // Parse assetType param (default: stock).
    // The forex Active Stories page passes ?assetType=forex to get only
    // forex pairs + the forex run metadata. Equity callers either omit
    // the param (defaults to stock) or pass ?assetType=stock — both behave
    // identically and match pre-forex behavior for backward compatibility.
    const assetTypeParam = url.searchParams.get('assetType') as AssetTypeFilter | null
    const assetType: AssetTypeFilter =
      assetTypeParam && VALID_ASSET_TYPES.includes(assetTypeParam) ? assetTypeParam : 'stock'

    // Meta row id: 1 = equity (stocks/crypto), 2 = forex, 3 = futures (macro).
    // Each cron persists its own metadata so it doesn't clobber the others.
    const metaId = assetType === 'forex' ? 2 : assetType === 'futures' ? 3 : 1

    // Load filtered stories + latest run metadata in parallel
    const admin = getAdmin()
    const [storiesAll, metaRes] = await Promise.all([
      loadStoriesBySession(session),
      admin.from('active_stories_meta').select('*').eq('id', metaId).maybeSingle(),
    ])

    // Filter stories by asset type. forex = forex only; futures = futures only;
    // stock (default) = everything that's neither forex nor futures (stocks AND
    // crypto, preserving the original combined-payload behavior).
    const stories =
      assetType === 'forex'   ? storiesAll.filter(s => (s.assetType as string) === 'forex')   :
      assetType === 'futures' ? storiesAll.filter(s => (s.assetType as string) === 'futures') :
      storiesAll.filter(s => (s.assetType as string) !== 'forex' && (s.assetType as string) !== 'futures')

    // Bug 23: enrich with live current price (60s cache server-side, so repeated
    // page loads within a minute don't re-hit external APIs)
    const enrichedStories = await enrichWithCurrentPrice(stories)

    // Build counts breakdown
    const counts = computeCounts(enrichedStories)

    // Assemble payload
    const meta = metaRes.data
    const payload: ActiveStoriesPayload = {
      generatedAt: meta?.generated_at ?? new Date().toISOString(),
      lastRunSource: meta?.trigger_source ?? 'unknown',
      marketTheme: meta?.market_theme ?? '',
      marketStatus: meta?.market_status ?? '',
      summary: meta?.summary ?? '',
      stories: enrichedStories,
      counts,
    }

    return NextResponse.json(payload, {
      headers: {
        // Cache for 60s — matches the price-cache TTL
        'Cache-Control': 'private, max-age=60',
      },
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error'
    console.error('[active-stories GET] Error:', msg)
    return NextResponse.json({ error: msg.slice(0, 200) }, { status: 500 })
  }
}

// ─────────────────────────────────────────────────────────────
// Live price enrichment
//
// Stories are stored without current price — only entry price is
// persisted. On every GET, we look up live prices for the displayed
// set in parallel (60s in-memory cache deduplicates repeated loads).
// ─────────────────────────────────────────────────────────────

interface EnrichedTrackedStory extends TrackedStory {
  currentPrice: number | null
  currentPriceAt: string | null
  /** % change from entryPrice → currentPrice. Null if either is missing. */
  pctChangeFromEntry: number | null
}

async function enrichWithCurrentPrice(stories: TrackedStory[]): Promise<EnrichedTrackedStory[]> {
  if (stories.length === 0) return []

  // Dedupe by ticker (multiple stories on same ticker get one lookup)
  const uniqueTickers = new Map<string, { ticker: string; assetType: string }>()
  for (const s of stories) {
    const key = `${s.ticker}:${s.assetType}`
    if (!uniqueTickers.has(key)) {
      uniqueTickers.set(key, { ticker: s.ticker, assetType: s.assetType })
    }
  }

  let lookups: Awaited<ReturnType<typeof fetchCurrentPricesMany>>
  try {
    lookups = await fetchCurrentPricesMany(Array.from(uniqueTickers.values()))
  } catch (e) {
    // Lookup failure is non-fatal — we just return stories without current prices
    console.warn('[active-stories GET] price enrichment failed, returning stories without current prices:', e instanceof Error ? e.message : e)
    return stories.map(s => ({
      ...s,
      currentPrice: null,
      currentPriceAt: null,
      pctChangeFromEntry: null,
    }))
  }

  return stories.map(s => {
    const lookup = lookups.get(s.ticker.toUpperCase())
    const currentPrice = lookup?.price ?? null
    const currentPriceAt = lookup?.fetchedAt ?? null
    let pctChangeFromEntry: number | null = null
    if (
      s.entryPrice !== null && s.entryPrice !== undefined && s.entryPrice > 0 &&
      currentPrice !== null && currentPrice > 0
    ) {
      pctChangeFromEntry = ((currentPrice - s.entryPrice) / s.entryPrice) * 100
    }
    return {
      ...s,
      currentPrice,
      currentPriceAt,
      pctChangeFromEntry,
    }
  })
}

// ─────────────────────────────────────────────────────────────
// Counts helper — gives the dashboard a quick breakdown for
// rendering counts/badges by session/timeframe/signal.
// ─────────────────────────────────────────────────────────────

function computeCounts(
  stories: TrackedStory[],
): ActiveStoriesPayload['counts'] {
  const bySession: Record<SessionAnchor, number> = { today: 0, tomorrow: 0, weekend: 0 }
  const byTimeframe: Record<Timeframe, number> = { '1D': 0, '1W': 0, '1M': 0, '3M': 0 }
  const bySignal: Record<Signal, number> = { BULLISH: 0, BEARISH: 0, NEUTRAL: 0 }

  for (const s of stories) {
    bySession[s.sessionAnchor] = (bySession[s.sessionAnchor] ?? 0) + 1
    bySignal[s.signal] = (bySignal[s.signal] ?? 0) + 1
    for (const tf of s.timeframes) {
      if (tf in byTimeframe) byTimeframe[tf] = (byTimeframe[tf] ?? 0) + 1
    }
  }

  return {
    total: stories.length,
    bySession,
    byTimeframe,
    bySignal,
  }
}
