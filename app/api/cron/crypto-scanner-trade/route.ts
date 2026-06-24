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
import { runCryptoScan, type CryptoTickerStats } from '@/app/lib/trading/crypto-scanner'
import { fetchCryptoBars } from '@/app/lib/trading/crypto-bars'
import { calculateTechnicals, type TechnicalSignals } from '@/app/lib/signals/technicals'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

// Quality thresholds. Picks must clear ALL of these to trigger Council analysis.
// These are deliberately strict so we don't burn Council tokens on overbought
// blow-offs (e.g. RSI 71 + CCI 358 on a 10% down day) or low-volume meme spikes.
const MIN_TECHNICAL_SCORE = 50      // -100..+100 scale; need clearly bullish bias
const REQUIRE_BIAS = 'BULLISH' as const  // technicalBias must equal this
const MAX_RSI = 78                  // skip if RSI extreme (overbought blow-off risk)
const MIN_VOLUME_USD_FOR_TRADING = 10_000_000  // $10M+ — quality liquidity for real money

interface UserResult {
  userId: string
  picksConsidered: number
  picksTriggered: number
  skipped: Array<{ ticker: string; reason: string }>
  triggered: Array<{ ticker: string; composite: number; techScore: number; bias: string }>
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = req.headers.get('authorization') ?? ''
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const startedAt = Date.now()
  const users: UserResult[] = []
  // Surfaced in the response so we can see WHERE discovery stalls:
  //   universeSize 0           → Coinbase product fetch returned nothing (auth/endpoint)
  //   universeSize>0, postFilter 0 → coins found, but filters (bullish/composite/movement) rejected all
  let scanDiag: Record<string, unknown> | null = null

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

    scanDiag = {
      universeSize: scan.universeSize,
      postFilterSize: scan.postFilterSize,
      picks: scan.picks.length,
      authedPath: scan.authedPath,
      fromCache: scan.fromCache,
      universeAgeMs: scan.universeAgeMs,
      errors: scan.errors,
      topPicks: scan.picks.slice(0, 5).map(p => ({
        symbol: p.symbol,
        composite: p.composite,
        direction: p.direction,
        change24h: Number(p.priceChange24h.toFixed(2)),
        volUsdM: Number((p.volumeUsd24h / 1e6).toFixed(1)),
      })),
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
        const fresh = scan.picks.filter(p => !recent.has(toCouncilSymbol(p.symbol)))
        // Bullish only (we don't short crypto)
        const directional = fresh.filter(p => p.direction === 'bullish')

        // Volume gate for trading (separate from discovery $1M floor in scan)
        const liquid = directional.filter(p => {
          if (p.volumeUsd24h < MIN_VOLUME_USD_FOR_TRADING) {
            result.skipped.push({
              ticker: p.symbol,
              reason: `volume $${(p.volumeUsd24h / 1e6).toFixed(1)}M < $${MIN_VOLUME_USD_FOR_TRADING / 1e6}M trading floor`,
            })
            return false
          }
          return true
        })

        // ── Technical-score gate ──────────────────────────────────
        // For each remaining pick, fetch 15m bars and compute full technicals.
        // Reject if technicalScore < threshold, bias != BULLISH, or RSI extreme.
        // This prevents triggering Council on overbought blow-offs, fading
        // dead-cat bounces, or thin-volume parabolic spikes.
        const technicallyValid: Array<CryptoTickerStats & { techScore: number; bias: string }> = []
        for (const pick of liquid) {
          try {
            const bars = await fetchCryptoBars({
              symbol: pick.symbol,
              granularity: 'FIFTEEN_MINUTE',
              limit: 200,
            })
            if (bars.length < 30) {
              result.skipped.push({
                ticker: pick.symbol,
                reason: `only ${bars.length} bars (need 30+ for technicals)`,
              })
              continue
            }
            const t = calculateTechnicals(bars)
            if (t.technicalScore < MIN_TECHNICAL_SCORE) {
              result.skipped.push({
                ticker: pick.symbol,
                reason: `techScore ${t.technicalScore} < ${MIN_TECHNICAL_SCORE}`,
              })
              continue
            }
            if (t.technicalBias !== REQUIRE_BIAS) {
              result.skipped.push({
                ticker: pick.symbol,
                reason: `bias ${t.technicalBias} != ${REQUIRE_BIAS}`,
              })
              continue
            }
            if (t.rsi > MAX_RSI) {
              result.skipped.push({
                ticker: pick.symbol,
                reason: `RSI ${t.rsi.toFixed(1)} > ${MAX_RSI} (overbought blow-off risk)`,
              })
              continue
            }
            technicallyValid.push({
              ...pick,
              techScore: t.technicalScore,
              bias: t.technicalBias,
            })
          } catch (e) {
            result.skipped.push({
              ticker: pick.symbol,
              reason: `technicals fetch failed: ${e instanceof Error ? e.message.slice(0, 80) : 'unknown'}`,
            })
          }
        }

        const toTrigger = technicallyValid.slice(0, Math.max(0, settings.maxConcurrentPos - openCount))

        for (const pick of toTrigger) {
          try {
            const triggered = await triggerAnalyze(settings.userId, toCouncilSymbol(pick.symbol))
            if (triggered) {
              result.picksTriggered++
              result.triggered.push({
                ticker: pick.symbol,
                composite: pick.composite,
                techScore: pick.techScore,
                bias: pick.bias,
              })
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
  return NextResponse.json({ users, durationMs, scan: scanDiag })
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

// The Council / ticker-gate canonical crypto form is concatenated BASE+USD
// (e.g. "BTCUSD") — NOT Coinbase's product id "BTC-USD" (the gate rejects
// hyphens) and NOT the slash form. The quote is normalized to USD because
// USDC/USD are equivalent for analysis; the trader re-derives the exact broker
// product (BTC-USD for Coinbase, BTC/USD for Alpaca) at execution time.
function toCouncilSymbol(productId: string): string {
  const base = (productId.split('-')[0] ?? productId).toUpperCase()
  return `${base}USD`
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
