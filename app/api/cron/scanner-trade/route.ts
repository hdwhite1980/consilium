// =============================================================
// app/api/cron/scanner-trade/route.ts
//
// Scanner-feeds-Council worker. Every 5 min during market hours:
//   1. For each scanner-enabled user
//   2. Read live Alpaca equity → compute scanner priceMax
//      (equity × scannerMaxPositionPct, default 20%)
//   3. Run the scanner with the priceMax filter so we only get
//      stocks the account can actually afford
//   4. Filter picks: composite >= scannerMinComposite, news direct,
//      price change in safe range, dedupe against recent verdicts
//   5. For top picks, POST internally to /api/analyze
//   6. Existing auto-trade worker picks up TAKE verdicts naturally
//
// We don't place orders here directly — the analyze route writes to
// verdict_log, and the existing auto-trade cron picks them up. This
// keeps scanner trades on the same discipline path as Council trades.
//
// Capital-awareness (added with scanner_max_position_pct column):
//   - Tiny account ($100, ceiling $20): scanner finds stocks $5-$20
//   - Mid account ($10k, ceiling $2k): scanner finds stocks $5-$2k
//   - Council still applies its own per-trade discipline; the
//     scanner ceiling is a DISCOVERY filter, not a sizing limit.
//   - If equity × pct < $5 (the priceMin floor), the scanner
//     returns nothing for that user; we log clearly and skip.
// =============================================================

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/app/lib/admin/admin-auth'
import { listEnabledTradingUsers, computeScannerPriceCeiling } from '@/app/lib/trading/settings'
import { loadBrokerCredentialForUse } from '@/app/lib/trading/credentials'
import { AlpacaClient } from '@/app/lib/trading/alpaca-client'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

interface UserResult {
  userId: string
  scannerEnabled: boolean
  equity: number | null
  scannerMaxPositionPct: number
  priceMaxComputed: number | null
  priceMaxApplied: number | null
  picksConsidered: number
  picksTriggered: number
  skipped: Array<{ ticker: string; reason: string }>
  triggered: Array<{ ticker: string; composite: number }>
  errors: number
}

// Fixed floor — avoid pump-and-dump pennies regardless of account size.
const PRICE_MIN_FLOOR = 5

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
        equity: null,
        scannerMaxPositionPct: settings.scannerMaxPositionPct,
        priceMaxComputed: null,
        priceMaxApplied: null,
        picksConsidered: 0,
        picksTriggered: 0,
        skipped: [],
        triggered: [],
        errors: 0,
      }

      try {
        // ── Capacity check: count this user's open scanner-source positions
        const openCount = await countOpenScannerPositions(settings.userId)
        const remainingSlots = settings.scannerMaxConcurrent - openCount
        if (remainingSlots <= 0) {
          result.skipped.push({ ticker: '*', reason: `at scanner max (${openCount}/${settings.scannerMaxConcurrent})` })
          users.push(result)
          continue
        }

        // ── Read live Alpaca equity to compute the price ceiling ──
        // Best effort: if equity lookup fails (creds missing, Alpaca down),
        // we DON'T skip the user — we fall back to no price ceiling and let
        // the existing scanner defaults run. The user gets logged so it's
        // visible Monday morning.
        const equity = await fetchAccountEquity(settings.userId, settings.mode)
        result.equity = equity

        let priceMax: number | null = null
        if (equity !== null && equity > 0) {
          const ceiling = computeScannerPriceCeiling(equity, settings)
          result.priceMaxComputed = ceiling
          if (ceiling < PRICE_MIN_FLOOR) {
            // Account too small for the floor — scanner won't find anything.
            // Skip with a clear log so the user (you) sees this Monday morning.
            result.skipped.push({
              ticker: '*',
              reason: `account too small: equity $${equity.toFixed(2)} × ${(settings.scannerMaxPositionPct * 100).toFixed(0)}% = $${ceiling.toFixed(2)} ceiling < $${PRICE_MIN_FLOOR} floor. Increase equity or scannerMaxPositionPct.`,
            })
            users.push(result)
            continue
          }
          priceMax = ceiling
          result.priceMaxApplied = ceiling
          console.log(`[scanner-trade] user=${settings.userId} equity=$${equity.toFixed(2)} × ${(settings.scannerMaxPositionPct * 100).toFixed(0)}% → priceMax=$${ceiling.toFixed(2)}`)
        } else {
          console.warn(`[scanner-trade] user=${settings.userId} no equity available; running scanner without priceMax (Alpaca creds missing or fetch failed)`)
        }

        // ── Run the scanner with the computed price ceiling ──
        const { runScan } = await import('@/app/lib/scanner-engine')
        const scan = await runScan({
          universe: 'sp500',
          filter: {
            priceMin: PRICE_MIN_FLOOR,
            ...(priceMax !== null ? { priceMax } : {}),
          },
          mode: 'bullish',
          limit: 50,
          newsBoost: true,
          scanType: 'fast_movers',
          horizon: 'day',
          priceCeiling: priceMax ?? 1_000,
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

/**
 * Fetch the user's live Alpaca account equity.
 * Returns null if creds missing, broker unavailable, or fetch fails.
 *
 * The mode argument routes to paper vs live Alpaca API endpoints — handled
 * by the AlpacaClient constructor.
 */
async function fetchAccountEquity(userId: string, mode: 'paper' | 'live'): Promise<number | null> {
  try {
    const creds = await loadBrokerCredentialForUse(userId, 'alpaca', mode, 'stock')
    if (!creds) return null
    const client = new AlpacaClient({
      keyId: creds.keyId,
      secret: creds.secret,
      mode,
    })
    const account = await client.account()
    const equity = Number(account.equity)
    return Number.isFinite(equity) && equity > 0 ? equity : null
  } catch (e) {
    console.warn(`[scanner-trade] equity fetch failed for user=${userId}:`, e instanceof Error ? e.message : e)
    return null
  }
}

async function countOpenScannerPositions(userId: string): Promise<number> {
  const admin = await getSupabaseAdmin()
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
  const baseUrl = process.env.APP_BASE_URL ?? process.env.NEXT_PUBLIC_APP_BASE_URL ?? ''
  if (!baseUrl) {
    console.warn('[scanner-trade] APP_BASE_URL not set; cannot trigger /api/analyze')
    return false
  }
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
