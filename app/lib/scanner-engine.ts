// ═════════════════════════════════════════════════════════════
// app/lib/scanner-engine.ts
//
// Core scanner logic, extracted from app/api/scanner/route.ts so it can be
// invoked from non-route contexts (e.g. /api/invest/ideas which builds
// tier-aware idea lists from scanner-scored tickers).
//
// This module is PURE LOGIC:
//   - No HTTP request/response
//   - No auth / Supabase
//   - No rate limiting (caller's job)
//   - No caching (caller's job)
//   - No DB logging (caller's job)
//
// The /api/scanner route imports `runScan` and wraps it with all of the
// above. Other internal callers can call `runScan` directly with a config.
// ═════════════════════════════════════════════════════════════

import { fetchBars } from '@/app/lib/data/alpaca'
import { calculateTechnicals, type TechnicalSignals } from '@/app/lib/signals/technicals'
import {
  applyFilter,
  SCANNER_UNIVERSE,
  getUniverseSource,
  type ScannerFilter,
  type UniverseEntry,
  type UniverseSource,
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
import {
  getMostActives,
  getMovers,
  getAllScreenerMovers,
  isAlpacaConfigured,
} from '@/app/lib/alpaca-screener'

// ─────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────

export const MIN_BARS_FOR_30D = 32
export const DEFAULT_FAST_MOVER_PRICE_CEILING = 20

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

export type ScanType = 'directional' | 'fast_movers'

export interface EnrichedScore extends TickerScore {
  sector: string
  cap: string
  priceTier: string
  tags: string[]

  // News exposure overlay
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

export interface RunScanConfig {
  universe: string
  filter: ScannerFilter
  mode: 'bullish' | 'bearish' | 'both'
  limit: number
  newsBoost: boolean
  scanType: ScanType
  horizon: Horizon
  priceCeiling: number
}

// ─────────────────────────────────────────────────────────────
// SPY context
// ─────────────────────────────────────────────────────────────

export async function fetchSpyContext(): Promise<{ change10d: number; change30d: number } | null> {
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

export async function computeTickerTechnicals(ticker: string): Promise<{
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

export async function scanTickers(
  entries: UniverseEntry[],
  spyChange10d: number,
  spyChange30d: number,
  newsExposureMap: Map<string, NewsExposureContext> | null,
  scanType: ScanType,
  horizon: Horizon,
  priceCeiling: number,
  priceMin: number | null,
  priceMax: number | null,
): Promise<EnrichedScore[]> {
  const BATCH_SIZE = 25
  const results: EnrichedScore[] = []

  for (let i = 0; i < entries.length; i += BATCH_SIZE) {
    const batch = entries.slice(i, i + BATCH_SIZE)

    const batchResults = await Promise.all(batch.map(async (entry) => {
      const data = await computeTickerTechnicals(entry.ticker)
      if (!data) return null

      // ── Fast-mover price gate ──
      if (scanType === 'fast_movers' && data.technicals.currentPrice > priceCeiling) {
        return null
      }

      // ── Live priceMin/priceMax filter (works on any scan type) ──
      const livePrice = data.technicals.currentPrice
      if (priceMin !== null && livePrice < priceMin) return null
      if (priceMax !== null && livePrice > priceMax) return null

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

        if (mom.direction !== 'unclear' && mom.score >= 40) {
          enriched.direction = mom.direction === 'bullish' ? 'bullish' : 'bearish'
        }

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

// ─────────────────────────────────────────────────────────────
// Universe resolution
// ─────────────────────────────────────────────────────────────

function makeStubEntry(ticker: string): UniverseEntry {
  return {
    ticker: ticker.toUpperCase(),
    sector: 'tech',
    cap: 'small',
    priceTier: 'sub10',
    tags: [],
  }
}

function dedupeEntries(entries: UniverseEntry[]): UniverseEntry[] {
  const seen = new Set<string>()
  const out: UniverseEntry[] = []
  for (const e of entries) {
    const t = e.ticker.toUpperCase()
    if (!seen.has(t)) { seen.add(t); out.push(e) }
  }
  return out
}

export async function resolveScreenerEntries(
  source: UniverseSource,
  filter: ScannerFilter,
): Promise<UniverseEntry[]> {
  if (!isAlpacaConfigured()) {
    console.warn('[scanner-engine] Alpaca not configured — falling back to curated all')
    return applyFilter({ ...filter, predefined: 'all' })
  }

  let tickers: string[] = []

  if (source === 'screener-actives') {
    tickers = (await getMostActives(100)).map(m => m.ticker)
  } else if (source === 'screener-gainers') {
    tickers = (await getMovers(50)).gainers.map(m => m.ticker)
  } else if (source === 'screener-losers') {
    tickers = (await getMovers(50)).losers.map(m => m.ticker)
  } else if (source === 'screener-all' || source === 'union') {
    tickers = (await getAllScreenerMovers({ mostActiveTop: 100, moversTop: 50 })).map(m => m.ticker)
  }

  const screenerEntries: UniverseEntry[] = tickers.map(t => {
    const curated = SCANNER_UNIVERSE.find(e => e.ticker === t)
    return curated ?? makeStubEntry(t)
  })

  if (source === 'union') {
    const curatedFiltered = applyFilter(filter)
    return dedupeEntries([...curatedFiltered, ...screenerEntries])
  }

  return dedupeEntries(screenerEntries)
}

// ─────────────────────────────────────────────────────────────
// Top-level orchestration: runScan
// ─────────────────────────────────────────────────────────────
//
// Takes a config, returns a ScanResult. No auth, no rate limit, no cache,
// no DB log. Caller wraps as needed.

export async function runScan(config: RunScanConfig): Promise<ScanResult> {
  const started = Date.now()
  const { universe, filter, mode, limit, newsBoost, scanType, horizon, priceCeiling } = config

  // Auto-set priceMax=5 for the penny_movers preset (matches POST behavior)
  const effectiveFilter: ScannerFilter = { ...filter, predefined: filter.predefined ?? universe }
  if (universe === 'penny_movers' && typeof effectiveFilter.priceMax !== 'number') {
    effectiveFilter.priceMax = 5
  }

  const source = getUniverseSource(universe)

  // Resolve entries
  const entries = source === 'curated'
    ? applyFilter(effectiveFilter)
    : await resolveScreenerEntries(source, effectiveFilter)

  if (entries.length === 0) {
    return {
      universe,
      mode,
      scanType,
      horizon: scanType === 'fast_movers' ? horizon : undefined,
      priceCeiling: scanType === 'fast_movers' ? priceCeiling : undefined,
      scannedCount: 0,
      withTechnicalsCount: 0,
      picks: [],
      spyChange10d: 0,
      spyChange30d: 0,
      generatedAt: new Date().toISOString(),
      elapsedMs: Date.now() - started,
      cached: false,
      newsBoost,
      error: source === 'curated'
        ? 'No tickers match filter'
        : 'No tickers from screener',
    }
  }

  // SPY context
  const spyContext = await fetchSpyContext()
  const spyChange10d = spyContext?.change10d ?? 0
  const spyChange30d = spyContext?.change30d ?? 0

  // News exposure (best-effort)
  let newsExposureMap: Map<string, NewsExposureContext> | null = null
  if (newsBoost) {
    try {
      newsExposureMap = await buildNewsExposureMap({
        entries: entries.map(e => ({ ticker: e.ticker, sector: e.sector, tags: e.tags })),
      })
    } catch (e) {
      console.warn('[scanner-engine] news exposure failed, continuing without:', (e as Error).message?.slice(0, 200))
      newsExposureMap = null
    }
  }

  // Scan
  const pmin = typeof effectiveFilter.priceMin === 'number' && effectiveFilter.priceMin > 0
    ? effectiveFilter.priceMin : null
  const pmax = typeof effectiveFilter.priceMax === 'number' && effectiveFilter.priceMax > 0
    ? effectiveFilter.priceMax : null

  const allScores = await scanTickers(
    entries, spyChange10d, spyChange30d, newsExposureMap,
    scanType, horizon, priceCeiling, pmin, pmax,
  )

  // Filter by mode
  let filtered = allScores
  if (mode === 'bullish') filtered = allScores.filter(s => s.direction === 'bullish')
  else if (mode === 'bearish') filtered = allScores.filter(s => s.direction === 'bearish')

  // Sort
  if (scanType === 'fast_movers') {
    filtered.sort((a, b) => {
      const aScore = (a.momentumScore ?? 0) * 0.6 + a.directionalScore * 0.4
      const bScore = (b.momentumScore ?? 0) * 0.6 + b.directionalScore * 0.4
      return bScore - aScore
    })
  } else {
    filtered.sort((a, b) => {
      const aScore = newsBoost ? (a.compositeWithNews ?? a.compositeScore) : a.compositeScore
      const bScore = newsBoost ? (b.compositeWithNews ?? b.compositeScore) : b.compositeScore
      return bScore - aScore
    })
  }

  const picks = filtered.slice(0, limit)

  return {
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
}
