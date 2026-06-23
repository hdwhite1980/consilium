// =============================================================
// app/api/movers/crypto/route.ts (v2 — June 23 2026)
//
// Discovery endpoint backing the "What's Moving" dashboard panel.
//
// v2 supports the full dynamic Coinbase USD universe with pre-filters
// and optional per-symbol technicals for top picks.
//
// Query params:
//   ?minComposite=N         default 0 (show everything)
//   ?minMovement=N          default 0.5 (% absolute 24h change)
//   ?minVolume=N            default 500000 (USD)
//   ?limit=N                default 50, max 100
//   ?direction=bullish|bearish|all   default all
//   ?onlyNew=true|false     default false
//   ?withTechnicals=N       default 0; top N picks get full TechnicalSignals
//   ?technicalsGranularity=FIFTEEN_MINUTE  default FIFTEEN_MINUTE
//
// Returns:
//   {
//     movers: [{ symbol, composite, direction, priceChange24h,
//                volumeUsd24h, liquidityTier, isNew, ... }, ...],
//     totalScanned, postFilterSize,
//     fromCache, universeAgeMs,
//     authedPath,
//     technicals: { "BTC-USD": { ... full TechnicalSignals }, ... },
//     generatedAt
//   }
// =============================================================

import { NextRequest, NextResponse } from 'next/server'
import { runCryptoScan } from '@/app/lib/trading/crypto-scanner'
import { fetchCryptoBars, type CryptoGranularity } from '@/app/lib/trading/crypto-bars'
import { calculateTechnicals, type TechnicalSignals } from '@/app/lib/signals/technicals'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const VALID_GRANULARITIES: CryptoGranularity[] = [
  'ONE_MINUTE', 'FIVE_MINUTE', 'FIFTEEN_MINUTE', 'THIRTY_MINUTE',
  'ONE_HOUR', 'TWO_HOUR', 'SIX_HOUR', 'ONE_DAY',
]

// Per-symbol technicals cache (60s)
const technicalsCache = new Map<string, { technicals: TechnicalSignals; fetchedAt: number }>()
const TECHNICALS_TTL_MS = 60_000

export async function GET(req: NextRequest): Promise<NextResponse> {
  const minComposite = Number(req.nextUrl.searchParams.get('minComposite') ?? '0')
  const minMovement = Number(req.nextUrl.searchParams.get('minMovement') ?? '0.5')
  const minVolume = Number(req.nextUrl.searchParams.get('minVolume') ?? '500000')
  const limit = Math.min(100, Math.max(1, Number(req.nextUrl.searchParams.get('limit') ?? '50')))
  const direction = (req.nextUrl.searchParams.get('direction') ?? 'all') as 'bullish' | 'bearish' | 'all'
  const onlyNew = req.nextUrl.searchParams.get('onlyNew') === 'true'
  const withTechnicals = Math.max(0, Math.min(20, Number(req.nextUrl.searchParams.get('withTechnicals') ?? '0')))

  let granularity: CryptoGranularity = 'FIFTEEN_MINUTE'
  const granParam = req.nextUrl.searchParams.get('technicalsGranularity')
  if (granParam && VALID_GRANULARITIES.includes(granParam as CryptoGranularity)) {
    granularity = granParam as CryptoGranularity
  }

  // Validate
  if (!['bullish', 'bearish', 'all'].includes(direction)) {
    return NextResponse.json({ error: 'direction must be bullish|bearish|all' }, { status: 400 })
  }

  try {
    const scan = await runCryptoScan({
      minComposite,
      minMovement,
      minVolume,
      limit,
      direction,
      onlyNew,
    })

    // Optional: fetch technicals for top N picks
    const technicals: Record<string, TechnicalSignals | { error: string }> = {}
    if (withTechnicals > 0) {
      const topPicks = scan.picks.slice(0, withTechnicals)
      // Run technicals fetches in parallel with light concurrency cap
      const CONCURRENCY = 4
      for (let i = 0; i < topPicks.length; i += CONCURRENCY) {
        const batch = topPicks.slice(i, i + CONCURRENCY)
        await Promise.allSettled(batch.map(async pick => {
          const cacheKey = `${pick.symbol}:${granularity}`
          const cached = technicalsCache.get(cacheKey)
          if (cached && (Date.now() - cached.fetchedAt) < TECHNICALS_TTL_MS) {
            technicals[pick.symbol] = cached.technicals
            return
          }
          try {
            const bars = await fetchCryptoBars({
              symbol: pick.symbol,
              granularity,
              limit: 200,
            })
            if (bars.length < 30) {
              technicals[pick.symbol] = { error: `only ${bars.length} bars available (need 30+)` }
              return
            }
            const t = calculateTechnicals(bars)
            technicalsCache.set(cacheKey, { technicals: t, fetchedAt: Date.now() })
            technicals[pick.symbol] = t
          } catch (e) {
            technicals[pick.symbol] = { error: e instanceof Error ? e.message : String(e) }
          }
        }))
      }
    }

    return NextResponse.json({
      movers: scan.picks,
      totalScanned: scan.universeSize,
      postFilterSize: scan.postFilterSize,
      fromCache: scan.fromCache,
      universeAgeMs: scan.universeAgeMs,
      authedPath: scan.authedPath,
      errors: scan.errors,
      ...(withTechnicals > 0 ? { technicals } : {}),
      generatedAt: scan.fetchedAt,
    })
  } catch (e) {
    return NextResponse.json({
      error: e instanceof Error ? e.message : 'scan failed',
    }, { status: 500 })
  }
}
