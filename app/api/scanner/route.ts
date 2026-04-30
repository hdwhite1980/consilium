// ═════════════════════════════════════════════════════════════
// app/api/scanner/route.ts
//
// Stock scanner — scores liquid tickers on directional setup
// + relative strength vs SPY, returns top picks with key setup.
//
// SOURCES (selected via predefined universe id):
//   curated          — static SCANNER_UNIVERSE (~500 hand-picked tickers)
//   screener-actives — Alpaca most-actives endpoint (~100 by volume)
//   screener-gainers — Alpaca movers gainers (~50)
//   screener-losers  — Alpaca movers losers (~50)
//   screener-all     — most-actives + gainers + losers, deduped (~150-250)
//   union            — curated joined with screener-all (~600-650, deduped)
//
// FILTERS:
//   priceMin / priceMax — applied POST-bars-fetch using actual current price
//                         (works for any source, including curated)
//   priceTiers          — legacy, applied to curated entries by tag
//   sectors / caps      — applied to curated entries (no-op for screener
//                         entries since they have no metadata)
//   tags                — applied to curated entries
//
// GET  /api/scanner              — list available universes + filter schema
// POST /api/scanner               — run a scan
//   body: {
//     universe?: string            (predefined id, defaults to 'all')
//     filter?: ScannerFilter       (optional filter overlay)
//     mode?: 'bullish'|'bearish'|'both'   (default 'both')
//     limit?: number               (default 15, max 50)
//   }
//
// Architecture:
//   - Resolve ticker list from chosen source (curated/screener/union)
//   - Fetch SPY bars first (for rel strength baseline) — 1 call
//   - Fetch all ticker bars in parallel batches of 25
//   - Compute calculateTechnicals for each
//   - Apply priceMin/priceMax filter using technicals.currentPrice
//   - scoreTicker() against each
//   - Sort by composite score, filter by mode, return top N
//
// 5-minute cache per (user, universe+filter+mode hash).
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
  getUniverseSource,
  type ScannerFilter,
  type UniverseEntry,
  type UniverseSource,
} from '@/app/lib/scanner-universe'
import { scoreTicker, pctChangeOverDays, type TickerScore } from '@/app/lib/scanner-scoring'
import {
  getMostActives,
  getMovers,
  getAllScreenerMovers,
  isAlpacaConfigured,
  type ScreenerMover,
} from '@/app/lib/alpaca-screener'

// ─────────────────────────────────────────────────────────────
// Cache (in-memory, per-process)
// ─────────────────────────────────────────────────────────────
interface ScanCacheEntry {
  result: ScanResult
  fetchedAt: number
}
const scanCache = new Map<string, ScanCacheEntry>()
const CACHE_TTL_MS = 5 * 60 * 1000  // 5 minutes

function cacheKey(userId: string, universe: string, mode: string, filterHash: string): string {
  return `${userId}:${universe}:${mode}:${filterHash}`
}

function hashFilter(f: ScannerFilter | undefined): string {
  if (!f) return 'nofilter'
  return JSON.stringify({
    s: f.sectors?.slice().sort(),
    c: f.caps?.slice().sort(),
    p: f.priceTiers?.slice().sort(),
    pmin: f.priceMin ?? null,
    pmax: f.priceMax ?? null,
    any: f.tagsIncludeAny?.slice().sort(),
    all: f.tagsIncludeAll?.slice().sort(),
    ex: f.tagsExcludeAny?.slice().sort(),
    t: f.tickers?.slice().sort(),
    pd: f.predefined,
  })
}

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────
interface EnrichedScore extends TickerScore {
  sector: string
  cap: string
  priceTier: string
  tags: string[]
  // Where this ticker came from in the scan (informational)
  origin: 'curated' | 'screener'
}

export interface ScanResult {
  universe: string
  source: UniverseSource           // NEW: which source produced these tickers
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
// Resolve ticker list from a UniverseSource
// Returns UniverseEntry[] — for screener-sourced tickers we
// synthesize stub entries with sector='unknown' etc so the
// downstream pipeline (which expects UniverseEntry) works.
// ─────────────────────────────────────────────────────────────

function makeStubEntry(ticker: string): UniverseEntry {
  return {
    ticker: ticker.toUpperCase(),
    sector: 'tech',           // placeholder — won't pass sector filters
    cap: 'small',             // placeholder
    priceTier: 'sub10',       // placeholder — actual price filtered post-bars
    tags: [],
  }
}

function dedupeEntries(entries: UniverseEntry[]): UniverseEntry[] {
  const seen = new Set<string>()
  const out: UniverseEntry[] = []
  for (const e of entries) {
    const t = e.ticker.toUpperCase()
    if (!seen.has(t)) {
      seen.add(t)
      out.push(e)
    }
  }
  return out
}

async function resolveEntriesFromSource(
  source: UniverseSource,
  filter: ScannerFilter,
  presetId: string,
): Promise<{ entries: UniverseEntry[]; screenerTickers: Set<string> }> {
  // For pure curated, just apply the filter and return
  if (source === 'curated') {
    const entries = applyFilter(filter)
    return { entries, screenerTickers: new Set() }
  }

  // For screener-sourced, fetch from Alpaca
  if (!isAlpacaConfigured()) {
    console.warn('[scanner] Alpaca not configured — falling back to curated')
    const entries = applyFilter({ ...filter, predefined: 'all' })
    return { entries, screenerTickers: new Set() }
  }

  let movers: ScreenerMover[] = []

  if (source === 'screener-actives') {
    movers = await getMostActives(100)
  } else if (source === 'screener-gainers') {
    const m = await getMovers(50)
    movers = m.gainers
  } else if (source === 'screener-losers') {
    const m = await getMovers(50)
    movers = m.losers
  } else if (source === 'screener-all') {
    movers = await getAllScreenerMovers({ mostActiveTop: 100, moversTop: 50 })
  } else if (source === 'union') {
    // Curated + screener-all, deduped
    movers = await getAllScreenerMovers({ mostActiveTop: 100, moversTop: 50 })
  }

  // Convert screener movers to stub UniverseEntry, but reuse curated metadata
  // when we have it (so e.g. NVDA showing up in most-actives keeps its 'tech' tag)
  const screenerTickers = new Set(movers.map(m => m.ticker))
  const screenerEntries: UniverseEntry[] = movers.map(m => {
    const curated = SCANNER_UNIVERSE.find(e => e.ticker === m.ticker)
    return curated ?? makeStubEntry(m.ticker)
  })

  if (source === 'union') {
    // Apply filter to curated side, then merge with screener
    const curatedFiltered = applyFilter(filter)
    const combined = dedupeEntries([...curatedFiltered, ...screenerEntries])
    return { entries: combined, screenerTickers }
  }

  // Pure screener — no curated filtering applies (sector/tag filters can't
  // narrow tickers we don't have metadata for). Return all screener entries.
  return { entries: dedupeEntries(screenerEntries), screenerTickers }
}

// ─────────────────────────────────────────────────────────────
// Fetch SPY technicals for the rel-strength baseline
// ─────────────────────────────────────────────────────────────
async function fetchSpyContext(): Promise<{ change10d: number; change30d: number } | null> {
  try {
    const bars = await fetchBars('SPY', '1M')
    if (!bars || bars.length < 20) return null
    const t = calculateTechnicals(bars)
    return {
      change10d: t.roc10 ?? 0,
      change30d: t.priceChangePeriod ?? 0,
    }
  } catch {
    return null
  }
}

// ─────────────────────────────────────────────────────────────
// Fetch + calculate technicals for a single ticker
// Returns null on any failure — caller filters out nulls
// ─────────────────────────────────────────────────────────────
async function computeTickerTechnicals(ticker: string): Promise<{
  ticker: string
  technicals: TechnicalSignals
  closes: number[]
} | null> {
  try {
    const bars = await fetchBars(ticker, '1M')
    if (!bars || bars.length < 20) return null
    const t = calculateTechnicals(bars)
    if (!t.currentPrice || t.currentPrice <= 0) return null
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const closes = bars.map((b: any) => b.c).filter((c: number) => typeof c === 'number')
    return { ticker, technicals: t, closes }
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
  screenerTickers: Set<string>,
  filter: ScannerFilter,
): Promise<EnrichedScore[]> {
  const BATCH_SIZE = 25
  const results: EnrichedScore[] = []

  // Precompute price filter bounds (post-bars price filtering)
  const pmin = typeof filter.priceMin === 'number' && filter.priceMin > 0 ? filter.priceMin : null
  const pmax = typeof filter.priceMax === 'number' && filter.priceMax > 0 ? filter.priceMax : null

  for (let i = 0; i < entries.length; i += BATCH_SIZE) {
    const batch = entries.slice(i, i + BATCH_SIZE)

    const batchResults = await Promise.all(batch.map(async (entry) => {
      const data = await computeTickerTechnicals(entry.ticker)
      if (!data) return null

      // Apply live price filter (works for curated + screener sources)
      const price = data.technicals.currentPrice
      if (pmin !== null && price < pmin) return null
      if (pmax !== null && price > pmax) return null

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
        origin: screenerTickers.has(entry.ticker) ? 'screener' : 'curated',
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
        source: u.source ?? 'curated',
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
        // Live price filter range — supersedes priceTiers when set
        supportsPriceRange: true,
      },
      alpacaConfigured: isAlpacaConfigured(),
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

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body: any = await req.json().catch(() => ({}))
    const universe: string = typeof body?.universe === 'string' ? body.universe : 'all'
    const filter: ScannerFilter = (typeof body?.filter === 'object' && body.filter !== null ? body.filter : {}) as ScannerFilter
    const mode: 'bullish' | 'bearish' | 'both' = ['bullish', 'bearish', 'both'].includes(body?.mode) ? body.mode : 'both'
    const limit = Math.max(1, Math.min(50, typeof body?.limit === 'number' ? body.limit : 15))

    // Merge universe into filter.predefined if not already set
    const effectiveFilter: ScannerFilter = { ...filter, predefined: filter.predefined ?? universe }

    // ── Special handling for penny_movers — auto-set priceMax=5 ──
    if (universe === 'penny_movers' && typeof effectiveFilter.priceMax !== 'number') {
      effectiveFilter.priceMax = 5
    }

    // Resolve which source to use
    const source = getUniverseSource(universe)
    console.log(`[scanner] universe='${universe}' source='${source}'`)

    // Cache check
    const key = cacheKey(user.id, universe, mode, hashFilter(effectiveFilter))
    const cached = scanCache.get(key)
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      const age = Math.round((Date.now() - cached.fetchedAt) / 60000)
      console.log(`[scanner] cache hit (age ${age}m)`)
      return NextResponse.json({ ...cached.result, cached: true, ageMinutes: age })
    }

    // Resolve ticker list
    const resolveStart = Date.now()
    const { entries, screenerTickers } = await resolveEntriesFromSource(source, effectiveFilter, universe)
    console.log(`[scanner] resolved ${entries.length} tickers in ${Date.now() - resolveStart}ms (${screenerTickers.size} from screener)`)

    if (entries.length === 0) {
      return NextResponse.json({
        error: source === 'curated'
          ? 'No tickers match your filter. Try a broader universe or remove some constraints.'
          : 'No tickers returned from screener. The market may be closed or Alpaca is unavailable.',
      }, { status: 400 })
    }

    // Fetch SPY context
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
    const allScores = await scanTickers(entries, spyChange10d, spyChange30d, screenerTickers, effectiveFilter)
    console.log(`[scanner] scored ${allScores.length}/${entries.length} tickers in ${Date.now() - scanStart}ms`)

    // Filter by mode
    let filtered = allScores
    if (mode === 'bullish') filtered = allScores.filter(s => s.direction === 'bullish')
    else if (mode === 'bearish') filtered = allScores.filter(s => s.direction === 'bearish')

    // Sort by composite score
    filtered.sort((a, b) => b.compositeScore - a.compositeScore)

    const picks = filtered.slice(0, limit)

    const result: ScanResult = {
      universe,
      source,
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
              origin: p.origin,
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

        // Insert pick outcome stubs
        if (picks.length > 0) {
          const stubs = picks.map(p => ({
            scan_id: scanRow.id,
            user_id: user.id,
            ticker: p.ticker,
            pick_at_price: p.currentPrice,
            direction: p.direction,
            composite_score: p.compositeScore,
          }))
          await admin.from('scanner_pick_outcomes').insert(stubs)
        }
      } catch (e) {
        console.warn('[scanner] async log error:', (e as Error).message?.slice(0, 100))
      }
    })()

    console.log(`[scanner] DONE in ${Date.now() - started}ms — ${picks.length} picks from ${source}`)
    return NextResponse.json(result)

  } catch (e) {
    const msg = (e as Error).message?.slice(0, 200) ?? 'unknown error'
    console.error('[scanner] error:', msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
