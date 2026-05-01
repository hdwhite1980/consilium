// ═════════════════════════════════════════════════════════════
// app/api/scanner/route.ts
//
// Stock scanner — scores liquid tickers (currently SCANNER_UNIVERSE.length)
// on directional setup + relative strength vs SPY, returns top 15 picks.
//
// GET  /api/scanner              — list available universes + filters
// POST /api/scanner               — run a scan
//   body: {
//     universe?: string                    (predefined id, defaults to 'all')
//     filter?: ScannerFilter               (optional filter overlay)
//     mode?: 'bullish'|'bearish'|'both'    (default 'both')
//     scanType?: 'directional'|'fast_movers'  (default 'directional')
//     horizon?: 'day'|'week'                (only used when scanType='fast_movers')
//     priceCeiling?: number                 (only fast_movers; default 20)
//     limit?: number                        (default 15, max 50)
//     newsBoost?: boolean                   (default false)
//   }
//
// SCAN TYPES
//   - directional   : original Track A/B scoring (60% directional + 40% rel-strength)
//   - fast_movers   : new mode — surfaces sub-priceCeiling tickers that look ready
//                     to move fast, scoring momentum + coiled potential together,
//                     respecting the user's "no liquidity floor" choice but
//                     surfacing a liquidity badge on every pick.
//
// CACHE
//   5-minute cache shared across users. Key includes scanType, horizon,
//   priceCeiling, newsBoost so different combinations don't collide.
// ═════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/app/lib/auth/server'
import { createClient as createAdmin } from '@supabase/supabase-js'
import {
  PREDEFINED_UNIVERSES,
  SCANNER_UNIVERSE,
  type ScannerFilter,
} from '@/app/lib/scanner-universe'
import type { Horizon } from '@/app/lib/scanner-momentum'
import {
  runScan,
  DEFAULT_FAST_MOVER_PRICE_CEILING,
  type ScanType,
  type ScanResult,
} from '@/app/lib/scanner-engine'

// ─────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────

const RATE_LIMIT_PER_MINUTE = 10

// ─────────────────────────────────────────────────────────────
// Cache
// ─────────────────────────────────────────────────────────────

interface ScanCacheEntry {
  result: ScanResult
  fetchedAt: number
}
const scanCache = new Map<string, ScanCacheEntry>()
const CACHE_TTL_MS = 5 * 60 * 1000

function cacheKey(
  universe: string, mode: string, filterHash: string, newsBoost: boolean,
  scanType: ScanType, horizon: Horizon, priceCeiling: number,
): string {
  return `${universe}:${mode}:${filterHash}:${newsBoost ? 'nb1' : 'nb0'}:${scanType}:${horizon}:${priceCeiling}`
}

function hashFilter(f: ScannerFilter | undefined): string {
  if (!f) return 'nofilter'
  return JSON.stringify({
    s: f.sectors?.slice().sort(),
    c: f.caps?.slice().sort(),
    p: f.priceTiers?.slice().sort(),
    any: f.tagsIncludeAny?.slice().sort(),
    all: f.tagsIncludeAll?.slice().sort(),
    ex: f.tagsExcludeAny?.slice().sort(),
    t: f.tickers?.slice().sort(),
    pd: f.predefined,
  })
}

// ─────────────────────────────────────────────────────────────
// Per-user rate limiting
// ─────────────────────────────────────────────────────────────
const rateLimitState = new Map<string, number[]>()

function checkRateLimit(userId: string): { allowed: boolean; retryAfterSec?: number } {
  const now = Date.now()
  const windowStart = now - 60_000
  const timestamps = (rateLimitState.get(userId) ?? []).filter(t => t > windowStart)
  if (timestamps.length >= RATE_LIMIT_PER_MINUTE) {
    const oldest = timestamps[0]
    const retryAfterSec = Math.ceil((oldest + 60_000 - now) / 1000)
    return { allowed: false, retryAfterSec: Math.max(1, retryAfterSec) }
  }
  timestamps.push(now)
  rateLimitState.set(userId, timestamps)
  return { allowed: true }
}

let lastRateLimitCleanup = Date.now()
function maybeCleanupRateLimits(): void {
  const now = Date.now()
  if (now - lastRateLimitCleanup < 5 * 60_000) return
  lastRateLimitCleanup = now
  const cutoff = now - 60_000
  for (const [userId, timestamps] of rateLimitState.entries()) {
    const recent = timestamps.filter(t => t > cutoff)
    if (recent.length === 0) rateLimitState.delete(userId)
    else rateLimitState.set(userId, recent)
  }
}

// Types ScanType, EnrichedScore, ScanResult moved to scanner-engine.
// Re-export ScanResult for any external consumers (e.g. shared types).
export type { ScanResult, ScanType } from '@/app/lib/scanner-engine'

// fetchSpyContext + computeTickerTechnicals moved to scanner-engine.

// scanTickers moved to scanner-engine.

// resolveScreenerEntries + helpers moved to scanner-engine.

// ═════════════════════════════════════════════════════════════
// GET
// ═════════════════════════════════════════════════════════════
export async function GET() {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    return NextResponse.json({
      universes: PREDEFINED_UNIVERSES.map(u => ({
        id: u.id,
        label: u.label,
        description: u.description,
      })),
      filterSchema: {
        sectors: ['tech', 'healthcare', 'financials', 'energy', 'consumer_disc',
          'consumer_staples', 'industrials', 'materials', 'real_estate',
          'utilities', 'communications', 'crypto_adj', 'macro_etf',
          'sector_etf', 'thematic_etf'],
        caps: ['mega', 'large', 'mid', 'small', 'etf'],
        priceTiers: ['sub10', 'under50', 'under100', 'under500', 'over500'],
        commonTags: ['ai', 'semis', 'growth', 'dividend', 'defensive', 'ev',
          'crypto', 'cloud', 'biotech', 'cybersec', 'volatile', 'meme'],
      },
      universeSize: SCANNER_UNIVERSE.length,
      newsBoostAvailable: true,
      scanTypes: [
        { id: 'directional', label: 'Directional', description: 'Setup + rel-strength vs SPY (default)' },
        { id: 'fast_movers', label: 'Fast Movers', description: 'Sub-$20 stocks ready to move (day or week horizon)' },
      ],
    })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message?.slice(0, 200) }, { status: 500 })
  }
}

// ═════════════════════════════════════════════════════════════
// POST
// ═════════════════════════════════════════════════════════════
export async function POST(req: NextRequest) {
  const started = Date.now()
  console.log('[scanner] START')

  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    maybeCleanupRateLimits()
    const rl = checkRateLimit(user.id)
    if (!rl.allowed) {
      return NextResponse.json(
        { error: `Too many scans. Try again in ${rl.retryAfterSec}s.`, retryAfterSec: rl.retryAfterSec },
        { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } },
      )
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body: any = await req.json().catch(() => ({}))
    const universe: string = typeof body?.universe === 'string' ? body.universe : 'all'
    const filter: ScannerFilter = (typeof body?.filter === 'object' && body.filter !== null ? body.filter : {}) as ScannerFilter
    const mode: 'bullish' | 'bearish' | 'both' = ['bullish', 'bearish', 'both'].includes(body?.mode) ? body.mode : 'both'
    const limit = Math.max(1, Math.min(50, typeof body?.limit === 'number' ? body.limit : 15))
    const newsBoost: boolean = body?.newsBoost === true
    const scanType: ScanType = body?.scanType === 'fast_movers' ? 'fast_movers' : 'directional'
    const horizon: Horizon = body?.horizon === 'day' ? 'day' : 'week'
    const priceCeiling: number = scanType === 'fast_movers'
      ? Math.max(1, Math.min(500, typeof body?.priceCeiling === 'number' ? body.priceCeiling : DEFAULT_FAST_MOVER_PRICE_CEILING))
      : 0

    const effectiveFilter: ScannerFilter = { ...filter, predefined: filter.predefined ?? universe }

    // Auto-set priceMax=5 for the penny_movers preset
    if (universe === 'penny_movers' && typeof effectiveFilter.priceMax !== 'number') {
      effectiveFilter.priceMax = 5
    }

    const key = cacheKey(universe, mode, hashFilter(effectiveFilter), newsBoost, scanType, horizon, priceCeiling)
    const cached = scanCache.get(key)
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      const age = Math.round((Date.now() - cached.fetchedAt) / 60000)
      console.log(`[scanner] cache hit (age ${age}m, scanType=${scanType})`)
      return NextResponse.json({ ...cached.result, cached: true, ageMinutes: age })
    }

    console.log(`[scanner] scanning (universe: ${universe}, mode: ${mode}, scanType: ${scanType}, horizon: ${horizon}, ceiling: $${priceCeiling}, newsBoost: ${newsBoost})`)

    // Delegate to scanner-engine — handles entries resolution, SPY, news,
    // scoring, mode filter, and sort. Returns final ScanResult.
    const result = await runScan({
      universe,
      filter: effectiveFilter,
      mode,
      limit,
      newsBoost,
      scanType,
      horizon,
      priceCeiling,
    })

    if (result.scannedCount === 0) {
      return NextResponse.json({
        error: 'No tickers match your filter. Try a broader universe or remove some constraints.',
      }, { status: 400 })
    }

    const picks = result.picks

    scanCache.set(key, { result, fetchedAt: Date.now() })

    // Log scan to DB
    void (async () => {
      try {
        const admin = createAdmin(
          process.env.NEXT_PUBLIC_SUPABASE_URL!,
          process.env.SUPABASE_SERVICE_ROLE_KEY!,
        )
        const { data: scanRow, error: logErr } = await admin
          .from('scanner_log')
          .insert({
            user_id: user.id,
            universe,
            mode,
            filter_hash: hashFilter(effectiveFilter),
            pick_count: picks.length,
            picks: picks.map(p => ({
              ticker: p.ticker,
              compositeScore: p.compositeScore,
              compositeWithNews: p.compositeWithNews ?? null,
              newsExposureScore: p.newsExposureScore ?? null,
              momentumScore: p.momentumScore ?? null,
              setupType: p.setupType ?? null,
              liquidityTier: p.liquidityTier ?? null,
              directionalScore: p.directionalScore,
              relStrengthScore: p.relStrengthScore,
              direction: p.direction,
              currentPrice: p.currentPrice,
            })),
            spy_change_10d: result.spyChange10d,
            spy_change_30d: result.spyChange30d,
            news_boost: newsBoost,
            scan_type: scanType,
            horizon: scanType === 'fast_movers' ? horizon : null,
            price_ceiling: scanType === 'fast_movers' ? priceCeiling : null,
            generated_at: result.generatedAt,
            elapsed_ms: result.elapsedMs,
          })
          .select('id')
          .single()

        if (logErr || !scanRow) {
          console.warn('[scanner] log insert failed:', logErr?.message)
          return
        }

        if (picks.length > 0) {
          const stubs = picks.map(p => ({
            scan_id: scanRow.id,
            ticker: p.ticker,
            direction: p.direction,
            composite_score: p.compositeScore,
            price_at_scan: p.currentPrice,
          }))
          await admin.from('scanner_pick_outcomes').insert(stubs)
        }
      } catch (e) {
        console.warn('[scanner] log task failed:', (e as Error).message?.slice(0, 200))
      }
    })()

    console.log(`[scanner] DONE in ${result.elapsedMs}ms — ${picks.length} picks (scanType=${scanType})`)
    return NextResponse.json(result)

  } catch (e) {
    console.error('[scanner] ERROR:', (e as Error).message)
    return NextResponse.json(
      { error: (e as Error).message?.slice(0, 200) ?? 'Scanner failed' },
      { status: 500 },
    )
  }
}
