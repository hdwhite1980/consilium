// =============================================================
// app/api/cron/crypto-scanner-trade/route.ts
//
// Parallels scanner-trade for stocks. Every 5 min during 24/7 crypto market:
//   1. For each crypto-enabled user
//   2. Run the crypto scanner (Coinbase public endpoint)
//   3. Filter picks by composite, direction, liquidity, dedup
//   4. POST to /api/analyze for top picks
//   5. Existing auto-trade-crypto cron picks up resulting TAKE/PASS/WAIT verdicts
// =============================================================

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/app/lib/admin/admin-auth'
import { listEnabledTradingUsers, isAssetClassEnabled, type UserTradingSettings } from '@/app/lib/trading/settings'
import { runCryptoScan } from '@/app/lib/trading/crypto-scanner'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

interface UserResult {
  userId: string
  picksConsidered: number
  picksTriggered: number
  skipped: Array<{ ticker: string; reason: string }>
  triggered: Array<{ ticker: string; composite: number }>
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = req.headers.get('authorization') ?? ''
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const startedAt = Date.now()
  const users: UserResult[] = []

  try {
    const enabledUsers = (await listEnabledTradingUsers())
      .filter(s => isAssetClassEnabled(s, 'crypto'))

    // Run scanner per-user so the authenticated path activates when creds
    // are available (single Coinbase list call, then filter client-side).
    // STRICTER thresholds for trading vs discovery:
    //   - minComposite: 65 (was a guess but matches prior threshold)
    //   - minMovement: 2.0 (% — only meaningful movers)
    //   - minVolume: 1_000_000 ($1M+ daily — quality liquidity)
    let scan
    if (enabledUsers.length > 0) {
      scan = await runCryptoScan({
        userId: enabledUsers[0].userId,
        minComposite: 65,
        minMovement: 2.0,
        minVolume: 1_000_000,
        limit: 10,
        direction: 'bullish',
      })
    } else {
      scan = await runCryptoScan({
        minComposite: 65,
        minMovement: 2.0,
        minVolume: 1_000_000,
        limit: 10,
        direction: 'bullish',
      })
    }

    for (const settings of enabledUsers) {
      const result: UserResult = {
        userId: settings.userId,
        picksConsidered: scan.picks.length,
        picksTriggered: 0,
        skipped: [],
        triggered: [],
      }
      try {
        // Skip if user has no crypto capacity
        const openCount = await countOpenCryptoAttempts(settings.userId)
        // Reuse maxConcurrentPos as a global cap — crypto positions count
        // against total along with stocks
        if (openCount >= settings.maxConcurrentPos) {
          result.skipped.push({ ticker: '*', reason: `at total max positions (${openCount}/${settings.maxConcurrentPos})` })
          users.push(result)
          continue
        }

        // Dedup: skip tickers analyzed for this user in last 4 hours
        const recent = await getRecentlyAnalyzed(settings.userId, 4)
        const fresh = scan.picks.filter(p => !recent.has(p.symbol.toUpperCase()))
        // Bullish only (we don't short crypto)
        const directional = fresh.filter(p => p.direction === 'bullish')
        const toTrigger = directional.slice(0, Math.max(0, settings.maxConcurrentPos - openCount))

        for (const pick of toTrigger) {
          try {
            const triggered = await triggerAnalyze(settings.userId, pick.symbol)
            if (triggered) {
              result.picksTriggered++
              result.triggered.push({ ticker: pick.symbol, composite: pick.composite })
            } else {
              result.skipped.push({ ticker: pick.symbol, reason: 'analyze trigger failed' })
            }
          } catch (e) {
            result.skipped.push({
              ticker: pick.symbol,
              reason: e instanceof Error ? e.message.slice(0, 100) : String(e).slice(0, 100),
            })
          }
        }
      } catch (e) {
        console.error(`[crypto-scanner-trade] user=${settings.userId} failed:`, e instanceof Error ? e.message : e)
      }
      users.push(result)
    }
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Server error' }, { status: 500 })
  }

  const durationMs = Date.now() - startedAt
  console.log(`[crypto-scanner-trade cron] done in ${durationMs}ms, triggered=${users.reduce((s, u) => s + u.picksTriggered, 0)}`)
  return NextResponse.json({ users, durationMs })
}

async function countOpenCryptoAttempts(userId: string): Promise<number> {
  const admin = await getSupabaseAdmin()
  const { count } = await admin
    .from('trade_attempts')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .in('outcome', ['placed', 'filled', 'partial_fill'])
  return count ?? 0
}

async function getRecentlyAnalyzed(userId: string, hours: number): Promise<Set<string>> {
  const admin = await getSupabaseAdmin()
  const cutoff = new Date(Date.now() - hours * 3_600_000).toISOString()
  const { data } = await admin
    .from('verdict_log')
    .select('ticker')
    .eq('user_id', userId)
    .gte('created_at', cutoff)
  if (!data) return new Set()
  return new Set((data as Array<{ ticker: string }>).map(r => r.ticker.toUpperCase()))
}

async function triggerAnalyze(userId: string, ticker: string): Promise<boolean> {
  const rawBase = (process.env.APP_BASE_URL ?? '').replace(/\/$/, '')
  if (!rawBase) {
    console.warn('[crypto-scanner-trade] APP_BASE_URL not set')
    return false
  }
  const baseUrl = /^https?:\/\//.test(rawBase) ? rawBase : `https://${rawBase}`
  try {
    const res = await fetch(`${baseUrl}/api/analyze`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Service-Trigger': 'crypto-scanner-trade',
        'X-Service-User-Id': userId,
        'Authorization': `Bearer ${process.env.CRON_SECRET ?? ''}`,
      },
      body: JSON.stringify({
        ticker,
        userId,
        source: 'crypto_scanner',
        timeframe: '1D',
        persona: 'balanced',
      }),
      signal: AbortSignal.timeout(90_000),
    })
    return res.ok
  } catch (e) {
    console.warn(`[crypto-scanner-trade] analyze trigger failed for ${ticker}:`, e instanceof Error ? e.message : e)
    return false
  }
}
