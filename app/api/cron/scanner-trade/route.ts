// =============================================================
// app/api/cron/scanner-trade/route.ts
//
// Scanner-feeds-Council worker. Every 5 min during market hours:
//   1. For each scanner-enabled user
//   2. Run the scanner (fast_movers, bullish, newsBoost)
//   3. Filter picks: composite >= scannerMinComposite, news direct,
//      price change in safe range, dedupe against recent verdicts
//   4. For top picks, POST internally to /api/analyze
//   5. Existing auto-trade worker will pick up TAKE verdicts naturally
//
// We don't place orders here directly — the analyze route writes to
// verdict_log, and the existing auto-trade cron picks them up. This
// keeps scanner trades on the same discipline path as Council trades.
//
// Concurrent-position check: counts current OPEN scanner-source
// positions for this user. If at scannerMaxConcurrent, skip.
// =============================================================

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/app/lib/admin/admin-auth'
import { listEnabledTradingUsers } from '@/app/lib/trading/settings'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

interface UserResult {
  userId: string
  scannerEnabled: boolean
  picksConsidered: number
  picksTriggered: number
  skipped: Array<{ ticker: string; reason: string }>
  triggered: Array<{ ticker: string; composite: number }>
  errors: number
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = req.headers.get('authorization') ?? ''
  const expected = `Bearer ${process.env.CRON_SECRET ?? ''}`
  if (!process.env.CRON_SECRET || auth !== expected) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const startedAt = Date.now()
  const users: UserResult[] = []

  try {
    const enabledUsers = (await listEnabledTradingUsers()).filter(s => s.scannerEnabled)
    console.log(`[scanner-trade cron] ${enabledUsers.length} scanner-enabled users`)

    for (const settings of enabledUsers) {
      const result: UserResult = {
        userId: settings.userId,
        scannerEnabled: true,
        picksConsidered: 0,
        picksTriggered: 0,
        skipped: [],
        triggered: [],
        errors: 0,
      }

      try {
        // Capacity check: count this user's open scanner-source positions
        const openCount = await countOpenScannerPositions(settings.userId)
        const remainingSlots = settings.scannerMaxConcurrent - openCount
        if (remainingSlots <= 0) {
          result.skipped.push({ ticker: '*', reason: `at scanner max (${openCount}/${settings.scannerMaxConcurrent})` })
          users.push(result)
          continue
        }

        // Run the scanner (in-process import to avoid HTTP)
        const { runScan } = await import('@/app/lib/scanner-engine')
        const scan = await runScan({
          universe: 'sp500',
          filter: { minPrice: 5, minVolume: 500_000 },
          mode: 'bullish',
          limit: 50,
          newsBoost: true,
          scanType: 'fast_movers',
          horizon: 'short' as never, // engine accepts the literal; cast for our local import
          priceCeiling: 1_000,
        })
        result.picksConsidered = scan.picks.length

        // Filter to tradeable picks
        const candidates = filterPicks(scan.picks, settings.scannerMinComposite)

        // Dedupe: skip tickers analyzed in the last 4 hours
        const recentTickers = await getRecentlyAnalyzedTickers(settings.userId, 4)
        const fresh = candidates.filter(p => !recentTickers.has(p.ticker.toUpperCase()))

        const toTrigger = fresh.slice(0, remainingSlots)

        for (const pick of toTrigger) {
          try {
            // Internally invoke the analyze pipeline. Use the same wire format
            // as the dashboard does.
            const triggered = await triggerAnalyze(settings.userId, pick.ticker)
            if (triggered) {
              result.picksTriggered++
              result.triggered.push({ ticker: pick.ticker, composite: pick.compositeWithNews ?? pick.compositeScore })
              console.log(`[scanner-trade] queued ${pick.ticker} for user=${settings.userId} (composite=${pick.compositeWithNews ?? pick.compositeScore})`)
            } else {
              result.skipped.push({ ticker: pick.ticker, reason: 'analyze trigger failed (non-200)' })
            }
          } catch (e) {
            result.errors++
            result.skipped.push({
              ticker: pick.ticker,
              reason: e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200),
            })
          }
        }
      } catch (e) {
        result.errors++
        console.error(`[scanner-trade] user=${settings.userId} failed:`, e instanceof Error ? e.message : e)
      }

      users.push(result)
    }
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Server error' }, { status: 500 })
  }

  const durationMs = Date.now() - startedAt
  console.log(`[scanner-trade cron] done in ${durationMs}ms, total triggered=${users.reduce((s, u) => s + u.picksTriggered, 0)}`)
  return NextResponse.json({ users, durationMs })
}

// ─────────────────────────────────────────────────────────────

interface ScannerPick {
  ticker: string
  compositeScore: number
  compositeWithNews?: number
  direction: 'bullish' | 'bearish' | 'mixed'
  priceChange1d: number
  volumeRatio: number
  newsExposureScore?: number
  newsMatchType?: 'direct' | 'sector' | 'digest' | 'none'
  liquidityTier?: string
}

function filterPicks(picks: ScannerPick[], minComposite: number): ScannerPick[] {
  return picks.filter(p => {
    const score = p.compositeWithNews ?? p.compositeScore
    if (p.direction !== 'bullish') return false
    if (score < minComposite) return false
    // % change guardrails: avoid sub-noise and dangerous gappers
    if (p.priceChange1d < 2 || p.priceChange1d > 12) return false
    if (p.volumeRatio < 1.5) return false
    // News quality: direct match preferred
    if (p.newsExposureScore !== undefined && p.newsExposureScore < 60) return false
    if (p.newsMatchType !== undefined && p.newsMatchType !== 'direct') return false
    // Liquidity sanity
    if (p.liquidityTier === 'micro' || p.liquidityTier === 'tiny') return false
    return true
  })
}

async function countOpenScannerPositions(userId: string): Promise<number> {
  const admin = await getSupabaseAdmin()
  // "Open" = filled/partial_fill scanner-origin attempts that haven't closed
  const { count, error } = await admin
    .from('trade_attempts')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('signal_source', 'scanner')
    .in('outcome', ['placed', 'filled', 'partial_fill'])
  if (error) {
    console.warn('[scanner-trade] countOpenScannerPositions failed:', error.message)
    return 0
  }
  return count ?? 0
}

async function getRecentlyAnalyzedTickers(userId: string, hours: number): Promise<Set<string>> {
  const admin = await getSupabaseAdmin()
  const cutoff = new Date(Date.now() - hours * 3_600_000).toISOString()
  const { data, error } = await admin
    .from('verdict_log')
    .select('ticker')
    .eq('user_id', userId)
    .gte('created_at', cutoff)
  if (error || !data) return new Set()
  return new Set((data as Array<{ ticker: string }>).map(r => r.ticker.toUpperCase()))
}

async function triggerAnalyze(userId: string, ticker: string): Promise<boolean> {
  // Call our own /api/analyze. Use APP_BASE_URL since we're server-side.
  const baseUrl = process.env.APP_BASE_URL ?? process.env.NEXT_PUBLIC_APP_BASE_URL ?? ''
  if (!baseUrl) {
    console.warn('[scanner-trade] APP_BASE_URL not set; cannot trigger /api/analyze')
    return false
  }
  // Use the CRON_SECRET as a service-to-service auth, OR a dedicated SERVICE_TOKEN.
  // The analyze route may require a session; we tag the request with X-Service-Trigger
  // so it can recognize internal scanner calls. Customize as needed.
  try {
    const res = await fetch(`${baseUrl}/api/analyze`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Service-Trigger': 'scanner-trade',
        'X-Service-User-Id': userId,
        'Authorization': `Bearer ${process.env.CRON_SECRET ?? ''}`,
      },
      body: JSON.stringify({
        ticker,
        userId,
        source: 'scanner',
        timeframe: '1D',
        persona: 'balanced',
      }),
      // Analyze can take 30-60s
      signal: AbortSignal.timeout(90_000),
    })
    if (!res.ok) {
      const txt = await res.text().catch(() => '')
      console.warn(`[scanner-trade] /api/analyze returned ${res.status} for ${ticker}: ${txt.slice(0, 200)}`)
      return false
    }
    return true
  } catch (e) {
    console.warn(`[scanner-trade] analyze trigger failed for ${ticker}:`, e instanceof Error ? e.message : e)
    return false
  }
}
