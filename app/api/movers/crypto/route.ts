// =============================================================
// app/api/movers/crypto/route.ts
//
// Public(ish) endpoint that returns the current crypto movers list.
// Backs a "What's Moving" dashboard panel.
//
// No auth required for the simplest path — the data is from a public
// Coinbase feed and is non-sensitive. If you want to gate access,
// add session cookie checking. For now, soft caching at 60s prevents
// abuse and reduces Coinbase load.
//
// Query params:
//   ?minComposite=65  (default 60)
//   ?limit=20         (default 30)
//   ?direction=bullish|bearish|any  (default any)
// =============================================================

import { NextRequest, NextResponse } from 'next/server'
import { runCryptoScan, type CryptoTickerStats } from '@/app/lib/trading/crypto-scanner'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Tiny in-memory cache: most page hits within 60s share the same scan.
let cachedResult: { fetchedAt: number; payload: CryptoTickerStats[] } | null = null
const CACHE_TTL_MS = 60_000

export async function GET(req: NextRequest): Promise<NextResponse> {
  const minComposite = Number(req.nextUrl.searchParams.get('minComposite') ?? '60')
  const limit = Math.min(50, Math.max(1, Number(req.nextUrl.searchParams.get('limit') ?? '30')))
  const direction = (req.nextUrl.searchParams.get('direction') ?? 'any') as 'bullish' | 'bearish' | 'any'

  try {
    // Use cache if recent
    let picks: CryptoTickerStats[]
    if (cachedResult && (Date.now() - cachedResult.fetchedAt) < CACHE_TTL_MS) {
      picks = cachedResult.payload
    } else {
      const scan = await runCryptoScan({ minComposite: 0, limit: 50 })  // get raw, filter below
      picks = scan.picks
      cachedResult = { fetchedAt: Date.now(), payload: picks }
    }

    // Apply filters
    let filtered = picks.filter(p => p.composite >= minComposite)
    if (direction !== 'any') {
      filtered = filtered.filter(p => p.direction === direction)
    }
    filtered = filtered.slice(0, limit)

    return NextResponse.json({
      movers: filtered,
      generatedAt: cachedResult.fetchedAt,
      totalScanned: picks.length,
    })
  } catch (e) {
    return NextResponse.json({
      error: e instanceof Error ? e.message : 'scan failed',
    }, { status: 500 })
  }
}
