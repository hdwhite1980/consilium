// =============================================================
// app/api/bars/crypto/route.ts
//
// Returns OHLCV bars for a crypto symbol. Used by:
//   - Chart UI components (visualization)
//   - Signal/pattern analysis on-demand
//   - Council during /api/analyze if invoked for crypto tickers
//
// 60s in-memory cache per (symbol, granularity).
//
// Query params:
//   ?symbol=BTC-USD            required
//   ?granularity=FIVE_MINUTE   default
//   ?limit=100                 default 100, max 300
//   ?signals=1                 if set, also returns computed signal counts
// =============================================================

import { NextRequest, NextResponse } from 'next/server'
import { fetchCryptoBars, computeCryptoSignals, type CryptoGranularity } from '@/app/lib/trading/crypto-bars'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface CachedBars {
  bars: unknown
  fetchedAt: number
}
const cache = new Map<string, CachedBars>()
const CACHE_TTL_MS = 60_000

const VALID_GRANULARITIES: CryptoGranularity[] = [
  'ONE_MINUTE', 'FIVE_MINUTE', 'FIFTEEN_MINUTE', 'THIRTY_MINUTE',
  'ONE_HOUR', 'TWO_HOUR', 'SIX_HOUR', 'ONE_DAY',
]

export async function GET(req: NextRequest): Promise<NextResponse> {
  const symbol = req.nextUrl.searchParams.get('symbol')
  if (!symbol) {
    return NextResponse.json({ error: 'Missing symbol query param' }, { status: 400 })
  }
  if (!/^[A-Z0-9]+-[A-Z]+$/.test(symbol)) {
    return NextResponse.json({ error: 'Invalid symbol format. Expected like BTC-USD' }, { status: 400 })
  }

  const granularity = (req.nextUrl.searchParams.get('granularity') ?? 'FIVE_MINUTE') as CryptoGranularity
  if (!VALID_GRANULARITIES.includes(granularity)) {
    return NextResponse.json({
      error: `Invalid granularity. Use one of: ${VALID_GRANULARITIES.join(', ')}`,
    }, { status: 400 })
  }

  const limit = Math.min(300, Math.max(1, Number(req.nextUrl.searchParams.get('limit') ?? '100')))
  const wantSignals = req.nextUrl.searchParams.get('signals') === '1'

  const cacheKey = `${symbol}:${granularity}:${limit}`
  const cached = cache.get(cacheKey)
  if (cached && (Date.now() - cached.fetchedAt) < CACHE_TTL_MS) {
    const payload = cached.bars as { bars: unknown[]; signals?: unknown }
    return NextResponse.json({
      symbol, granularity, limit,
      bars: payload.bars,
      signals: wantSignals && payload.signals ? payload.signals : undefined,
      cached: true,
    })
  }

  try {
    const bars = await fetchCryptoBars({ symbol, granularity, limit })
    const signals = wantSignals ? computeCryptoSignals(bars) : null
    const cacheVal = { bars, signals }
    cache.set(cacheKey, { bars: cacheVal, fetchedAt: Date.now() })
    return NextResponse.json({
      symbol, granularity, limit,
      barsCount: bars.length,
      bars,
      signals: wantSignals ? signals : undefined,
    })
  } catch (e) {
    return NextResponse.json({
      error: e instanceof Error ? e.message : String(e),
    }, { status: 500 })
  }
}
