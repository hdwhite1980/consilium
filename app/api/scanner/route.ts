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
import { fetchBars } from '@/app/lib/data/alpaca'
import { calculateTechnicals, type TechnicalSignals } from '@/app/lib/signals/technicals'
import {
  applyFilter,
  PREDEFINED_UNIVERSES,
  SCANNER_UNIVERSE,
  type ScannerFilter,
  type UniverseEntry,
} from '@/app/lib/scanner-universe'
import { scoreTicker, pctChangeOverDays, type TickerScore } from '@/app/lib/scanner-scoring'
import {
  scoreMomentum,
  computeLiquidity,
  type Horizon,
  type SetupType,
  type LiquidityTier,
} from '@/app/lib/scanner-momentum'
import {
  buildNewsExposureMap,
  applyExposureToComposite,
  type NewsExposureContext,
} from '@/app/lib/news-exposure'

// ─────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────

const MIN_BARS_FOR_30D = 32
const RATE_LIMIT_PER_MINUTE = 10
const DEFAULT_FAST_MOVER_PRICE_CEILING = 20

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

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

export type ScanType = 'directional' | 'fast_movers'

interface EnrichedScore extends TickerScore {
  sector: string
  cap: string
  priceTier: string
  tags: string[]

  // News exposure (from Track B)
  newsExposureScore?: number
  newsAlignedBoost?: number
  compositeWithNews?: number
  newsSummary?: string
  newsReasons?: string[]
  newsMatchType?: 'direct' | 'sector' | 'digest' | 'none'

  // Fast-mover fields (only populated when scanType='fast_movers')
  momentumScore?: number
  setupType?: SetupType
  activeMomentum?: number
  coiledPotential?: number
  setupQuality?: number
  momentumReasons?: string[]

  // Liquidity (always computed when scanType='fast_movers')
  dollarVolumeAvg?: number
  liquidityTier?: LiquidityTier
  liquidityLabel?: string
}

export interface ScanResult {
  universe: string
  mode: 'bullish' | 'bearish' | 'both'
  scanType: ScanType
  horizon?: Horizon
  priceCeiling?: number
  scannedCount: number
  withTechnicalsCount: number
  picks: EnrichedScore[]
  spyChange10d: number
  spyChange30d: number
  generatedAt: string
  elapsedMs: number
  cached: boolean
  ageMinutes?: number
  newsBoost: boolean
  error?: string
}

// ─────────────────────────────────────────────────────────────
// SPY context
// ─────────────────────────────────────────────────────────────
async function fetchSpyContext(): Promise<{ change10d: number; change30d: number } | null> {
  try {
    const bars = await fetchBars('SPY', '1M')
    if (!bars || bars.length < MIN_BARS_FOR_30D) return null
    const closes = bars.map(b => b.c)
    return {
      change10d: pctChangeOverDays(closes, 10),
      change30d: pctChangeOverDays(closes, 30),
    }
  } catch {
    return null
  }
}

// ─────────────────────────────────────────────────────────────
// Per-ticker fetch
// ─────────────────────────────────────────────────────────────
async function computeTickerTechnicals(ticker: string): Promise<{
  ticker: string
  technicals: TechnicalSignals
  closes: number[]
} | null> {
  try {
    const bars = await fetchBars(ticker, '1M')
    if (!bars || bars.length < MIN_BARS_FOR_30D) return null
    const t = calculateTechnicals(bars)
    if (!t.currentPrice || t.currentPrice <= 0) return null
    return { ticker, technicals: t, closes: bars.map(b => b.c) }
  } catch {
    return null
  }
}

// ─────────────────────────────────────────────────────────────
// Scan tickers — handles both scan types in one pass
// ─────────────────────────────────────────────────────────────
async function scanTickers(
  entries: UniverseEntry[],
  spyChange10d: number,
  spyChange30d: number,
  newsExposureMap: Map<string, NewsExposureContext> | null,
  scanType: ScanType,
  horizon: Horizon,
  priceCeiling: number,
): Promise<EnrichedScore[]> {
  const BATCH_SIZE = 25
  const results: EnrichedScore[] = []

  for (let i = 0; i < entries.length; i += BATCH_SIZE) {
    const batch = entries.slice(i, i + BATCH_SIZE)

    const batchResults = await Promise.all(batch.map(async (entry) => {
      const data = await computeTickerTechnicals(entry.ticker)
      if (!data) return null

      // ── Fast-mover price gate ──
      // Done with FRESH price, not stale priceTier metadata. A ticker
      // tagged 'under50' last month might be $19 today (or $52).
      if (scanType === 'fast_movers' && data.technicals.currentPrice > priceCeiling) {
        return null
      }

      const tickerChange10d = pctChangeOverDays(data.closes, 10)
      const tickerChange30d = pctChangeOverDays(data.closes, 30)

      const score = scoreTicker({
        ticker: data.ticker,
        technicals: data.technicals,
        tickerChange10d,
        tickerChange30d,
        spyChange10d,
        spyChange30d,
      })

      const enriched: EnrichedScore = {
        ...score,
        sector: entry.sector,
        cap: entry.cap,
        priceTier: entry.priceTier,
        tags: entry.tags,
      }

      // ── News exposure overlay ──
      if (newsExposureMap) {
        const ctx = newsExposureMap.get(entry.ticker)
        if (ctx) {
          const applied = applyExposureToComposite({
            composite: score.compositeScore,
            direction: score.direction,
            exposureScore: ctx.score,
          })
          enriched.newsExposureScore = ctx.score
          enriched.newsAlignedBoost = applied.alignedBoost
          enriched.compositeWithNews = applied.compositeWithNews
          enriched.newsSummary = ctx.summary
          enriched.newsReasons = ctx.reasons
          enriched.newsMatchType = ctx.matchType
        }
      }

      // ── Fast-mover scoring ──
      if (scanType === 'fast_movers') {
        const change5d = pctChangeOverDays(data.closes, 5)
        const mom = scoreMomentum({
          technicals: data.technicals,
          horizon,
          change5d,
        })
        enriched.momentumScore = mom.score
        enriched.setupType = mom.setupType
        enriched.activeMomentum = mom.parts.activeMomentum
        enriched.coiledPotential = mom.parts.coiledPotential
        enriched.setupQuality = mom.parts.setupQuality
        enriched.momentumReasons = mom.reasons

        // Override direction if momentum scorer disagrees and it has
        // a confident view — momentum knows about coiled bias and
        // active breakouts in ways the directional scorer doesn't.
        if (mom.direction !== 'unclear' && mom.score >= 40) {
          enriched.direction = mom.direction === 'bullish' ? 'bullish' : 'bearish'
        }

        // Liquidity always computed for fast movers
        const liq = computeLiquidity(data.technicals)
        enriched.dollarVolumeAvg = liq.avgDollarVolume
        enriched.liquidityTier = liq.tier
        enriched.liquidityLabel = liq.label
      }

      return enriched
    }))

    for (const r of batchResults) {
      if (r) results.push(r)
    }
  }

  return results
}

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

    const key = cacheKey(universe, mode, hashFilter(effectiveFilter), newsBoost, scanType, horizon, priceCeiling)
    const cached = scanCache.get(key)
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      const age = Math.round((Date.now() - cached.fetchedAt) / 60000)
      console.log(`[scanner] cache hit (age ${age}m, scanType=${scanType})`)
      return NextResponse.json({ ...cached.result, cached: true, ageMinutes: age })
    }

    const entries = applyFilter(effectiveFilter)
    if (entries.length === 0) {
      return NextResponse.json({
        error: 'No tickers match your filter. Try a broader universe or remove some constraints.',
      }, { status: 400 })
    }
    console.log(`[scanner] scanning ${entries.length} tickers (universe: ${universe}, mode: ${mode}, scanType: ${scanType}, horizon: ${horizon}, ceiling: $${priceCeiling}, newsBoost: ${newsBoost})`)

    // SPY context
    const spyStart = Date.now()
    const spyContext = await fetchSpyContext()
    if (!spyContext) {
      console.warn('[scanner] SPY context unavailable — rel strength scores will be neutral')
    }
    console.log(`[scanner] SPY context in ${Date.now() - spyStart}ms`)
    const spyChange10d = spyContext?.change10d ?? 0
    const spyChange30d = spyContext?.change30d ?? 0

    // News exposure (best-effort)
    let newsExposureMap: Map<string, NewsExposureContext> | null = null
    if (newsBoost) {
      try {
        const newsStart = Date.now()
        newsExposureMap = await buildNewsExposureMap({
          entries: entries.map(e => ({ ticker: e.ticker, sector: e.sector, tags: e.tags })),
        })
        console.log(`[scanner] news exposure map built in ${Date.now() - newsStart}ms`)
      } catch (e) {
        console.warn('[scanner] news exposure failed, continuing without boost:', (e as Error).message?.slice(0, 200))
        newsExposureMap = null
      }
    }

    // Scan
    const scanStart = Date.now()
    const allScores = await scanTickers(
      entries, spyChange10d, spyChange30d, newsExposureMap,
      scanType, horizon, priceCeiling,
    )
    console.log(`[scanner] scored ${allScores.length}/${entries.length} tickers in ${Date.now() - scanStart}ms`)

    // ── Filter by mode ──
    // For fast_movers, the momentum scorer overrides direction so this still
    // works correctly. 'mixed' picks are included in 'both' but excluded
    // from 'bullish'/'bearish' (they explicitly couldn't pick a side).
    let filtered = allScores
    if (mode === 'bullish') filtered = allScores.filter(s => s.direction === 'bullish')
    else if (mode === 'bearish') filtered = allScores.filter(s => s.direction === 'bearish')

    // ── Sort ──
    if (scanType === 'fast_movers') {
      // Sort by combined: 0.6 × momentumScore + 0.4 × directionalScore
      // so structure still matters but momentum dominates
      filtered.sort((a, b) => {
        const aScore = (a.momentumScore ?? 0) * 0.6 + a.directionalScore * 0.4
        const bScore = (b.momentumScore ?? 0) * 0.6 + b.directionalScore * 0.4
        return bScore - aScore
      })
    } else {
      // Directional mode — use compositeWithNews when present
      filtered.sort((a, b) => {
        const aScore = newsBoost ? (a.compositeWithNews ?? a.compositeScore) : a.compositeScore
        const bScore = newsBoost ? (b.compositeWithNews ?? b.compositeScore) : b.compositeScore
        return bScore - aScore
      })
    }

    const picks = filtered.slice(0, limit)

    const result: ScanResult = {
      universe,
      mode,
      scanType,
      horizon: scanType === 'fast_movers' ? horizon : undefined,
      priceCeiling: scanType === 'fast_movers' ? priceCeiling : undefined,
      scannedCount: entries.length,
      withTechnicalsCount: allScores.length,
      picks,
      spyChange10d: Math.round(spyChange10d * 10) / 10,
      spyChange30d: Math.round(spyChange30d * 10) / 10,
      generatedAt: new Date().toISOString(),
      elapsedMs: Date.now() - started,
      cached: false,
      newsBoost,
    }

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
            spy_change_10d: spyChange10d,
            spy_change_30d: spyChange30d,
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
