// ═════════════════════════════════════════════════════════════
// app/api/scanner/route.ts
//
// Stock scanner — scores liquid tickers (currently SCANNER_UNIVERSE.length)
// on directional setup + relative strength vs SPY, returns top 15 picks
// with key setup.
//
// GET  /api/scanner              — list available universes + filters
// POST /api/scanner               — run a scan
//   body: {
//     universe?: string            (predefined id, defaults to 'all')
//     filter?: ScannerFilter       (optional filter overlay)
//     mode?: 'bullish'|'bearish'|'both'   (default 'both')
//     limit?: number               (default 15, max 50)
//   }
//
// Architecture:
//   - Fetch SPY bars first (for rel strength baseline) — 1 call
//   - Fetch all universe ticker bars in parallel batches of 25 — ~5-10s total
//   - Compute calculateTechnicals + true 10d/30d % changes for each
//   - scoreTicker() against each — microseconds
//   - Sort by composite score, filter by mode, return top N
//
// Typical total time: 5-15 seconds for full universe.
// 5-minute cache shared across all users (the underlying bar data is
// the same regardless of who asked).
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

// ─────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────

// Minimum bars required to confidently compute a 30-day change.
// 30 trading days + a couple of buffer bars.
const MIN_BARS_FOR_30D = 32

// Per-user rate limit: max scans per minute. Each scan can spawn 200+
// upstream API calls + LLM token budget if user adds news boost later,
// so this prevents accidental hammering.
const RATE_LIMIT_PER_MINUTE = 10

// ─────────────────────────────────────────────────────────────
// Cache (in-memory, per-process) — SHARED across users
// ─────────────────────────────────────────────────────────────
// The cached bars/scores depend only on (universe, mode, filterHash),
// not on who asked. Including userId in the key was wasteful — every
// new user paid the full scan cost on first request.

interface ScanCacheEntry {
  result: ScanResult
  fetchedAt: number
}
const scanCache = new Map<string, ScanCacheEntry>()
const CACHE_TTL_MS = 5 * 60 * 1000  // 5 minutes

function cacheKey(universe: string, mode: string, filterHash: string): string {
  return `${universe}:${mode}:${filterHash}`
}

function hashFilter(f: ScannerFilter | undefined): string {
  if (!f) return 'nofilter'
  // Simple deterministic serialization
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
// Per-user rate limiting — naive sliding window
// ─────────────────────────────────────────────────────────────
const rateLimitState = new Map<string, number[]>()  // userId -> timestamps in ms

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

// Periodic cleanup of stale rate limit entries (every ~5 min, lazy)
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
interface EnrichedScore extends TickerScore {
  sector: string
  cap: string
  priceTier: string
  tags: string[]
}

export interface ScanResult {
  universe: string
  mode: 'bullish' | 'bearish' | 'both'
  scannedCount: number
  withTechnicalsCount: number
  picks: EnrichedScore[]
  spyChange10d: number
  spyChange30d: number
  generatedAt: string
  elapsedMs: number
  cached: boolean
  ageMinutes?: number
  error?: string
}

// ─────────────────────────────────────────────────────────────
// Fetch SPY context for the rel-strength baseline
// Returns true 10d / 30d changes, NOT roc10/priceChangePeriod.
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
// Fetch + calculate technicals for a single ticker
// Returns null on any failure or insufficient bars — caller filters.
// ─────────────────────────────────────────────────────────────
async function computeTickerTechnicals(ticker: string): Promise<{
  ticker: string
  technicals: TechnicalSignals
  closes: number[]
} | null> {
  try {
    const bars = await fetchBars(ticker, '1M')
    // Require enough bars for a meaningful 30-day change calculation.
    // Without this, freshly listed tickers get garbage rel-strength.
    if (!bars || bars.length < MIN_BARS_FOR_30D) return null
    const t = calculateTechnicals(bars)
    if (!t.currentPrice || t.currentPrice <= 0) return null
    return { ticker, technicals: t, closes: bars.map(b => b.c) }
  } catch {
    return null
  }
}

// ─────────────────────────────────────────────────────────────
// Scan a set of tickers in parallel batches
// ─────────────────────────────────────────────────────────────
async function scanTickers(
  entries: UniverseEntry[],
  spyChange10d: number,
  spyChange30d: number,
): Promise<EnrichedScore[]> {
  const BATCH_SIZE = 25
  const results: EnrichedScore[] = []

  for (let i = 0; i < entries.length; i += BATCH_SIZE) {
    const batch = entries.slice(i, i + BATCH_SIZE)

    const batchResults = await Promise.all(batch.map(async (entry) => {
      const data = await computeTickerTechnicals(entry.ticker)
      if (!data) return null

      // Compute TRUE 10d and 30d changes from the actual bar data,
      // rather than relying on technicals.priceChangePeriod (which is
      // the full ~500-day window for this timeframe).
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

      return enriched
    }))

    for (const r of batchResults) {
      if (r) results.push(r)
    }
  }

  return results
}

// ═════════════════════════════════════════════════════════════
// GET /api/scanner — return universe options + filter schema
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
      // Surface dynamic universe size so the UI can show truth instead
      // of a hardcoded "~500" that drifts as we add/remove tickers.
      universeSize: SCANNER_UNIVERSE.length,
    })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message?.slice(0, 200) }, { status: 500 })
  }
}

// ═════════════════════════════════════════════════════════════
// POST /api/scanner — run a scan
// ═════════════════════════════════════════════════════════════
export async function POST(req: NextRequest) {
  const started = Date.now()
  console.log('[scanner] START')

  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    // Per-user rate limit
    maybeCleanupRateLimits()
    const rl = checkRateLimit(user.id)
    if (!rl.allowed) {
      return NextResponse.json(
        {
          error: `Too many scans. Try again in ${rl.retryAfterSec}s.`,
          retryAfterSec: rl.retryAfterSec,
        },
        { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } },
      )
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body: any = await req.json().catch(() => ({}))
    const universe: string = typeof body?.universe === 'string' ? body.universe : 'all'
    const filter: ScannerFilter = (typeof body?.filter === 'object' && body.filter !== null ? body.filter : {}) as ScannerFilter
    const mode: 'bullish' | 'bearish' | 'both' = ['bullish', 'bearish', 'both'].includes(body?.mode) ? body.mode : 'both'
    const limit = Math.max(1, Math.min(50, typeof body?.limit === 'number' ? body.limit : 15))

    // Merge universe into filter.predefined if not already set
    const effectiveFilter: ScannerFilter = { ...filter, predefined: filter.predefined ?? universe }

    // Cache check — shared across users
    const key = cacheKey(universe, mode, hashFilter(effectiveFilter))
    const cached = scanCache.get(key)
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      const age = Math.round((Date.now() - cached.fetchedAt) / 60000)
      console.log(`[scanner] cache hit (age ${age}m)`)
      return NextResponse.json({ ...cached.result, cached: true, ageMinutes: age })
    }

    // Resolve which tickers to scan
    const entries = applyFilter(effectiveFilter)
    if (entries.length === 0) {
      return NextResponse.json({
        error: 'No tickers match your filter. Try a broader universe or remove some constraints.',
      }, { status: 400 })
    }
    console.log(`[scanner] scanning ${entries.length} tickers (universe: ${universe}, mode: ${mode})`)

    // Fetch SPY context FIRST — we cannot compute rel-strength scores
    // without it. The previous version used a fake `Promise.all` here
    // with the second slot as `Promise.resolve(null)`, which did
    // nothing useful. Removed; replaced with a plain await.
    const spyStart = Date.now()
    const spyContext = await fetchSpyContext()
    if (!spyContext) {
      console.warn('[scanner] SPY context unavailable — rel strength scores will be neutral')
    }
    console.log(`[scanner] SPY context in ${Date.now() - spyStart}ms`)

    const spyChange10d = spyContext?.change10d ?? 0
    const spyChange30d = spyContext?.change30d ?? 0

    // Scan all tickers
    const scanStart = Date.now()
    const allScores = await scanTickers(entries, spyChange10d, spyChange30d)
    console.log(`[scanner] scored ${allScores.length}/${entries.length} tickers in ${Date.now() - scanStart}ms`)

    // Filter by mode
    let filtered = allScores
    if (mode === 'bullish') filtered = allScores.filter(s => s.direction === 'bullish')
    else if (mode === 'bearish') filtered = allScores.filter(s => s.direction === 'bearish')
    // mode === 'both' includes mixed too

    // Sort by composite score (highest first).
    // NOTE: compositeScore is direction-AGNOSTIC — a high score means
    // "strong setup in the picked direction". For mode='bearish', we've
    // already filtered to bearish picks above, so sorting by composite
    // here returns the strongest bearish setups (which is what we want).
    filtered.sort((a, b) => b.compositeScore - a.compositeScore)

    const picks = filtered.slice(0, limit)

    const result: ScanResult = {
      universe,
      mode,
      scannedCount: entries.length,
      withTechnicalsCount: allScores.length,
      picks,
      spyChange10d: Math.round(spyChange10d * 10) / 10,
      spyChange30d: Math.round(spyChange30d * 10) / 10,
      generatedAt: new Date().toISOString(),
      elapsedMs: Date.now() - started,
      cached: false,
    }

    // Cache
    scanCache.set(key, { result, fetchedAt: Date.now() })

    // Log scan to DB for performance tracking (fire-and-forget, never throws)
    void (async () => {
      try {
        const admin = createAdmin(
          process.env.NEXT_PUBLIC_SUPABASE_URL!,
          process.env.SUPABASE_SERVICE_ROLE_KEY!,
        )
        // Insert the scan record
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
              directionalScore: p.directionalScore,
              relStrengthScore: p.relStrengthScore,
              direction: p.direction,
              currentPrice: p.currentPrice,
            })),
            spy_change_10d: spyChange10d,
            spy_change_30d: spyChange30d,
            generated_at: result.generatedAt,
            elapsed_ms: result.elapsedMs,
          })
          .select('id')
          .single()

        if (logErr || !scanRow) {
          console.warn('[scanner] log insert failed:', logErr?.message)
          return
        }

        // Insert pick outcomes stubs (return_1d etc. start as null,
        // backfilled by the /api/scanner/outcomes cron)
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

    console.log(`[scanner] DONE in ${result.elapsedMs}ms — ${picks.length} picks`)
    return NextResponse.json(result)

  } catch (e) {
    console.error('[scanner] ERROR:', (e as Error).message)
    return NextResponse.json(
      { error: (e as Error).message?.slice(0, 200) ?? 'Scanner failed' },
      { status: 500 },
    )
  }
}
