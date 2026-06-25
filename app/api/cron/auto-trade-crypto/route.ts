// =============================================================
// app/api/cron/auto-trade-crypto/route.ts
//
// Crypto auto-trader. Runs 24/7 (separate cron from stocks).
// Polls verdict_log for TAKE verdicts on crypto symbols,
// places market entries via Alpaca crypto API, then attaches
// a stop-limit child order after entry confirms.
//
// Differences from stocks worker:
//   - 24/7, no market-hours gating
//   - Fractional units (notional sizing)
//   - No bracket orders — entry + separate stop_limit child
//   - Long only (Alpaca crypto disallows shorts)
// =============================================================

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/app/lib/admin/admin-auth'
import {
  listEnabledTradingUsers,
  setVerdictWatermark,
  getRiskPerTradePctForAsset,
  getMaxConcurrentForAsset,
  isAssetClassEnabled,
  type UserTradingSettings,
} from '@/app/lib/trading/settings'
import { loadBrokerCredentialForUse, loadCoinbaseCredential } from '@/app/lib/trading/credentials'
import { makeAlpacaCryptoClient, type AlpacaCryptoClient, type AlpacaCryptoPosition } from '@/app/lib/trading/alpaca-crypto-client'
import { makeCoinbaseClient, type CoinbaseClient, type CoinbasePosition } from '@/app/lib/trading/coinbase-client'
import { computeCryptoSize } from '@/app/lib/trading/crypto-sizing'
import { sizeCryptoTradeForCoinbase } from '@/app/lib/trading/crypto-product-sizing'
import { routeTicker } from '@/app/lib/trading/asset-router'
import { haltUserAccount } from '@/app/lib/trading/kill-switches'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const MAX_VERDICTS_PER_USER = 20
const VERDICT_AGE_HOURS = 4

interface VerdictRow {
  id: number; user_id: string; ticker: string; signal: string
  confidence: number | string | null
  entry_price: number | string | null; stop_loss: number | string | null; take_profit: number | string | null
  trader_decision: string | null; trader_grade: string | null
  trader_position_size: number | string | null
  trader_risk_reward: number | string | null
  trader_pass_reasons: string[] | null
  created_at: string
}

// ─────────────────────────────────────────────────────────────
// Bypass classifiers (mirrors decideForUser stock pipeline)
// ─────────────────────────────────────────────────────────────

type BypassInfo =
  | { category: 'marginal_rr' | 'earnings_window'; rationale: string }
  | { category: 'wait_high_quality'; rationale: string }

/**
 * PASS bypass: marginal R:R [1.0, 1.5) AND/OR earnings_window.
 * Requires ALL reasons be bypassable (no insider/liquidity/confidence-floor blocks).
 */
function classifyPassBypassCrypto(verdict: VerdictRow): BypassInfo | null {
  const reasons = Array.isArray(verdict.trader_pass_reasons) ? verdict.trader_pass_reasons : []
  if (reasons.length === 0) return null
  const rr = verdict.trader_risk_reward !== null && verdict.trader_risk_reward !== undefined
    ? Number(verdict.trader_risk_reward) : null

  const categorize = (r: string): 'marginal_rr' | 'earnings_window' | null => {
    if (typeof r !== 'string') return null
    if (/risk-to-reward|r:r|risk\/reward/i.test(r)) {
      if (rr !== null && Number.isFinite(rr) && rr >= 1.0 && rr < 1.5) return 'marginal_rr'
      return null
    }
    if (/earnings/i.test(r)) return 'earnings_window'
    return null
  }
  const cats = reasons.map(categorize)
  if (cats.some(c => c === null)) return null
  if (cats.includes('marginal_rr')) {
    return {
      category: 'marginal_rr',
      rationale: `marginal-R:R bypass: ${rr?.toFixed(2) ?? '?'}:1 in [1.0, 1.5), half size`,
    }
  }
  return {
    category: 'earnings_window',
    rationale: 'earnings-window bypass: timing only, half size',
  }
}

/**
 * WAIT bypass: take WAIT verdicts at half size when conf >= 65 AND R:R >= 1.3.
 */
function classifyWaitBypassCrypto(verdict: VerdictRow): BypassInfo | null {
  const conf = verdict.confidence !== null && verdict.confidence !== undefined
    ? Number(verdict.confidence) : null
  const rr = verdict.trader_risk_reward !== null && verdict.trader_risk_reward !== undefined
    ? Number(verdict.trader_risk_reward) : null
  if (conf === null || !Number.isFinite(conf)) return null
  if (rr === null || !Number.isFinite(rr)) return null
  const MIN_CONF = 65
  const MIN_RR = 1.3
  if (conf < MIN_CONF) return null
  if (rr < MIN_RR) return null
  return {
    category: 'wait_high_quality',
    rationale: `wait-bypass: conf=${conf}% >= ${MIN_CONF}% AND R:R=${rr.toFixed(2)} >= ${MIN_RR}, half size`,
  }
}


// ─────────────────────────────────────────────────────────────
// Broker abstraction
//
// Both Alpaca and Coinbase crypto clients support a common set of methods
// (account, positions, assetTradable, marketEntry, getOrder, cancelOrder).
// CryptoBroker is the union we route through so the cron is broker-agnostic.
//
// Selection logic per user (see selectCryptoBroker):
//   1. If user has Coinbase credential → use Coinbase (single broker, live only)
//   2. Else if user has Alpaca crypto credential → use Alpaca
//   3. Else → no broker, skip user
// ─────────────────────────────────────────────────────────────

type BrokerKind = 'alpaca' | 'coinbase'

interface CryptoBrokerHandle {
  kind: BrokerKind
  brokerName: 'alpaca' | 'coinbase'
  effectiveMode: 'paper' | 'live'
  symbolFor(canonicalSymbol: string): string
  client: AlpacaCryptoClient | CoinbaseClient
  account: () => Promise<{ status: string; cash: number; equity: number }>
  positions: () => Promise<Array<{ symbol: string; qty: number }>>
  assetTradable: (sym: string) => Promise<{ tradable: boolean; reason?: string }>
  marketEntry: (input: { symbol: string; notionalUsd: number; side: 'buy'; clientOrderId: string }) => Promise<{ id: string; client_order_id: string }>
}

/**
 * Select the crypto broker for a user. Coinbase takes precedence if
 * configured because it's the user's explicit opt-in to live crypto
 * trading; Alpaca crypto is the legacy default. Returns null if no
 * crypto broker is configured.
 *
 * Coinbase mode override: Coinbase has no paper environment. If a user's
 * settings.mode is 'paper' but they're using Coinbase, we still trade
 * LIVE — but we explicitly require tradeCrypto AND a present Coinbase
 * credential to confirm intent. The mode reported in trade_attempts.mode
 * is set to 'live' for Coinbase trades regardless of settings.mode.
 */
async function selectCryptoBroker(settings: UserTradingSettings): Promise<CryptoBrokerHandle | null> {
  const coinbase = await loadCoinbaseCredential(settings.userId)
  if (coinbase) {
    const client = makeCoinbaseClient(coinbase.keyName, coinbase.privateKey)
    return {
      kind: 'coinbase',
      brokerName: 'coinbase',
      effectiveMode: 'live',  // Coinbase is always live
      symbolFor: (canonical: string) => canonical.replace('/', '-'),  // BTC/USD → BTC-USD
      client,
      account: async () => {
        const a = await client.account()
        return { status: a.status, cash: a.cash, equity: a.equity }
      },
      positions: async () => {
        const pos = await client.positions()
        return pos.map(p => ({ symbol: p.symbol, qty: p.qty }))
      },
      assetTradable: (sym: string) => client.assetTradable(sym),
      marketEntry: async (input) => {
        const order = await client.marketEntry({
          symbol: input.symbol,
          notionalUsd: input.notionalUsd,
          side: 'buy',
          clientOrderId: input.clientOrderId,
        })
        return { id: order.id, client_order_id: order.client_order_id }
      },
    }
  }

  const alpacaCred = await loadBrokerCredentialForUse(settings.userId, 'alpaca', settings.mode, 'crypto')
  if (alpacaCred) {
    const client = makeAlpacaCryptoClient(alpacaCred.keyId, alpacaCred.secret, settings.mode)
    return {
      kind: 'alpaca',
      brokerName: 'alpaca',
      effectiveMode: settings.mode,
      symbolFor: (canonical: string) => canonical,  // BTC/USD stays BTC/USD on Alpaca
      client,
      account: async () => {
        const a = await client.account()
        return { status: a.status, cash: a.cash, equity: a.equity }
      },
      positions: async () => {
        const pos = await client.positions()
        return pos.map((p: AlpacaCryptoPosition) => ({ symbol: p.symbol, qty: p.qty }))
      },
      assetTradable: (sym: string) => client.assetTradable(sym),
      marketEntry: async (input) => {
        const order = await client.marketEntry({
          symbol: input.symbol,
          notionalUsd: input.notionalUsd,
          side: 'buy',
          clientOrderId: input.clientOrderId,
        })
        return { id: order.id, client_order_id: order.client_order_id }
      },
    }
  }

  return null
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = req.headers.get('authorization') ?? ''
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const startedAt = Date.now()
  const summary = { users: 0, considered: 0, placed: 0, skipped: 0, errors: 0, durationMs: 0 }

  try {
    const users = (await listEnabledTradingUsers())
      .filter(s => isAssetClassEnabled(s, 'crypto'))
    summary.users = users.length

    for (const settings of users) {
      try {
        // Select crypto broker (Coinbase preferred if configured, else Alpaca crypto)
        const broker = await selectCryptoBroker(settings)
        if (!broker) {
          // Quiet log — this is expected when user hasn't enabled crypto trading
          // (no need to scream every cycle; warn was creating noise per memory)
          continue
        }
        console.log(`[auto-trade-crypto] user=${settings.userId} broker=${broker.brokerName} mode=${broker.effectiveMode}`)

        // Check concurrent crypto positions
        const openCount = await countOpenCryptoAttempts(settings.userId)
        const cap = getMaxConcurrentForAsset(settings, 'crypto')
        if (openCount >= cap) {
          continue
        }

        // Fetch new crypto verdicts using the CRYPTO watermark (not the shared
        // stock pointer — that's the bug that starved crypto of its verdicts).
        const verdicts = await fetchNewCryptoVerdicts(settings.userId, settings.cryptoLastProcessedVerdictId ?? 0)
        summary.considered += verdicts.length

        let maxId = settings.cryptoLastProcessedVerdictId ?? 0
        for (const verdict of verdicts) {
          maxId = Math.max(maxId, verdict.id)

          // Route + filter
          const route = routeTicker(verdict.ticker)
          if (route.assetClass !== 'crypto') continue   // someone else's job

          // ── Verdict eligibility: TAKE / PASS bypass / WAIT bypass
          let bypass: BypassInfo | null = null
          if (verdict.trader_decision === 'TAKE') {
            // Normal path
          } else if (verdict.trader_decision === 'PASS') {
            bypass = classifyPassBypassCrypto(verdict)
            if (!bypass) {
              await logSkipped(verdict, settings, `PASS and not bypass-eligible`)
              summary.skipped++
              continue
            }
          } else if (verdict.trader_decision === 'WAIT') {
            bypass = classifyWaitBypassCrypto(verdict)
            if (!bypass) {
              await logSkipped(verdict, settings, `WAIT and not bypass-eligible (need conf>=65 AND R:R>=1.3)`)
              summary.skipped++
              continue
            }
          } else {
            await logSkipped(verdict, settings, `not a TAKE/PASS/WAIT (${verdict.trader_decision})`)
            summary.skipped++
            continue
          }

          // Grade floor — bypassed verdicts default to C (the bypass IS the qualification)
          const effGrade = verdict.trader_grade ?? (bypass ? 'C' : null)
          if (!effGrade || gradeRank(effGrade) < gradeRank(settings.minGrade)) {
            await logSkipped(verdict, settings, `grade ${effGrade ?? 'null'} below floor ${settings.minGrade}`)
            summary.skipped++
            continue
          }
          // Age check
          const ageH = (Date.now() - new Date(verdict.created_at).getTime()) / 3_600_000
          if (ageH > VERDICT_AGE_HOURS) {
            await logSkipped(verdict, settings, `verdict ${ageH.toFixed(1)}h old`)
            summary.skipped++
            continue
          }
          // Sell-side: Alpaca crypto doesn't support shorts; can only place SELL on existing position
          if (verdict.signal === 'BEARISH') {
            await logSkipped(verdict, settings, 'BEARISH crypto not tradeable (no shorting)')
            summary.skipped++
            continue
          }
          if (verdict.signal !== 'BULLISH') {
            await logSkipped(verdict, settings, `signal ${verdict.signal} not actionable`)
            summary.skipped++
            continue
          }

          // Trade plan
          const entry = verdict.entry_price !== null ? Number(verdict.entry_price) : NaN
          const stop = verdict.stop_loss !== null ? Number(verdict.stop_loss) : NaN
          const target = verdict.take_profit !== null ? Number(verdict.take_profit) : NaN
          if (!Number.isFinite(entry) || !Number.isFinite(stop) || !Number.isFinite(target)) {
            await logSkipped(verdict, settings, 'missing or invalid entry/stop/target')
            summary.skipped++
            continue
          }
          if (stop >= entry) {
            await logSkipped(verdict, settings, `stop (${stop}) >= entry (${entry}) on BULLISH`)
            summary.skipped++
            continue
          }

          // Convert symbol to broker-specific form (BTC/USD → BTC-USD for Coinbase)
          let brokerSymbol = broker.symbolFor(route.normalizedSymbol)

          // Verify tradability via the active broker
          let tradable = await broker.assetTradable(brokerSymbol)

          // USDC-only fallback: some coins (often newer / less-public) are listed
          // on Coinbase ONLY as BASE-USDC, not BASE-USD. If the -USD product
          // isn't tradable, retry the -USDC product and trade whichever exists.
          // Mirrors the data layer's -USD → -USDC fallback so analysis and
          // execution resolve to the same product.
          if (!tradable.tradable && broker.brokerName === 'coinbase' && brokerSymbol.endsWith('-USD')) {
            const usdcSymbol = brokerSymbol.replace(/-USD$/, '-USDC')
            const usdcTradable = await broker.assetTradable(usdcSymbol)
            if (usdcTradable.tradable) {
              brokerSymbol = usdcSymbol
              tradable = usdcTradable
              console.log(`[auto-trade-crypto] ${verdict.ticker} resolved to USDC product ${usdcSymbol}`)
            }
          }
          if (!tradable.tradable) {
            await logSkipped(verdict, settings, `${broker.brokerName} crypto: ${tradable.reason ?? 'not tradable'}`)
            summary.skipped++
            continue
          }

          // Sizing
          //
          // Audit Finding 1: account.equity may include unrealized P&L on
          // open crypto positions. cash is deployable capital (crypto is
          // unmargined for retail). min() defends against winning-streak
          // inflation. Coinbase returns equity = cash for simplicity so
          // the min is just cash; Alpaca differs when positions are open.
          const account = await broker.account().catch(() => null)
          if (!account || account.equity <= 0) {
            await haltUserAccount(settings.userId, `${broker.brokerName} crypto account fetch failed or equity <= 0`)
            summary.errors++
            break
          }
          const effectiveEquity = Math.min(account.equity, account.cash)
          if (effectiveEquity <= 0) {
            await logSkipped(verdict, settings, `${broker.brokerName} crypto effectiveEquity ${effectiveEquity} <= 0`)
            summary.skipped++
            continue
          }

          // Per-trade bounds from settings (Audit Phase 2).
          // Bypass: halve the position size when this is a PASS/WAIT bypass.
          const traderSize = verdict.trader_position_size !== null
            ? Math.min(1, Math.max(0.1, Number(verdict.trader_position_size)))
            : 1
          const sizeMultiplier = bypass ? 0.5 : 1.0
          const effectiveTraderSize = Math.min(1, Math.max(0.05, traderSize * sizeMultiplier))

          const sizingInput = {
            accountEquity: effectiveEquity,
            riskPerTradePct: getRiskPerTradePctForAsset(settings, 'crypto'),
            maxPositionPct: settings.maxPositionPct,
            entryPrice: entry,
            stopPrice: stop,
            traderPositionSizePct: effectiveTraderSize > 0 ? effectiveTraderSize : 1,
            minDollarRiskPerTrade: settings.minDollarRiskPerTrade,
            maxDollarRiskPerTrade: settings.maxDollarRiskPerTrade,
            minTradeNotional: settings.minTradeNotional,
            maxTradeNotional: settings.maxTradeNotional,
            qualityGrade: (effGrade === 'A' || effGrade === 'B' || effGrade === 'C') ? effGrade as 'A' | 'B' | 'C' : null,
            qualityConfidence: verdict.confidence !== null ? Number(verdict.confidence) : null,
            qualityRiskReward: verdict.trader_risk_reward !== null && verdict.trader_risk_reward !== undefined
              ? Number(verdict.trader_risk_reward) : null,
          }

          // Use Coinbase-product-aware sizing when broker is Coinbase.
          // This pre-flights against base_increment, base_min_size, quote_min_size,
          // and rounds quantities to valid increments. For Alpaca crypto, fall
          // back to generic sizing (Alpaca handles increments server-side).
          let sizing
          let coinbaseAdjustedStop: number | undefined
          if (broker.kind === 'coinbase') {
            const coinbaseSizing = await sizeCryptoTradeForCoinbase({
              ...sizingInput,
              symbol: brokerSymbol,
              coinbaseClient: broker.client as CoinbaseClient,
            })
            sizing = coinbaseSizing
            if (coinbaseSizing.ok) {
              coinbaseAdjustedStop = coinbaseSizing.adjustedStop
            }
          } else {
            sizing = computeCryptoSize(sizingInput)
          }

          if (!sizing.ok) {
            await logSkipped(verdict, settings, `crypto sizing: ${sizing.reason}`)
            summary.skipped++
            continue
          }

          // If Coinbase adjusted the stop to a valid quote_increment, use the
          // adjusted value going forward instead of the verdict's raw stop.
          const effectiveStop = coinbaseAdjustedStop ?? stop

          // Pre-place buying-power gate (Audit Phase 3).
          // For Alpaca crypto, available capital = account.cash (unmargined).
          // 5% safety margin covers market fill slippage above entry estimate.
          const CRYPTO_BUYING_POWER_SAFETY_MARGIN = 0.95
          const cryptoSafeCash = account.cash * CRYPTO_BUYING_POWER_SAFETY_MARGIN
          if (sizing.notionalUsd > cryptoSafeCash) {
            await logSkipped(verdict, settings,
              `pre-place gate: notional $${sizing.notionalUsd.toFixed(2)} > safe cash $${cryptoSafeCash.toFixed(2)} (raw: $${account.cash.toFixed(2)})`)
            summary.skipped++
            continue
          }

          // Re-check capacity (per-asset + total)
          const stillOpen = await countOpenCryptoAttempts(settings.userId)
          if (stillOpen >= cap) {
            await logSkipped(verdict, settings, `at max crypto positions (${stillOpen}/${cap})`)
            summary.skipped++
            continue
          }
          const totalOpen = await countAllOpenAttempts(settings.userId)
          if (totalOpen >= settings.totalMaxConcurrent) {
            await logSkipped(verdict, settings, `at total max positions (${totalOpen}/${settings.totalMaxConcurrent})`)
            summary.skipped++
            continue
          }

          // Place market entry via the active broker
          // Deterministic client_order_id (keyed on verdict id) so a re-run
          // can't double-place if the watermark write is lost mid-run.
          const clientOrderId = `wos-c-${verdict.id}`
          try {
            const order = await broker.marketEntry({
              symbol: brokerSymbol,
              notionalUsd: sizing.notionalUsd,
              side: 'buy',
              clientOrderId,
            })
            await logPlaced(verdict, settings, {
              clientOrderId,
              brokerOrderId: order.id,
              units: sizing.units,
              notionalUsd: sizing.notionalUsd,
              entryPrice: entry,
              stopPrice: effectiveStop,
              targetPrice: target,
              dollarRisk: sizing.dollarRisk,
              accountEquity: effectiveEquity,
              normalizedSymbol: brokerSymbol,
              brokerName: broker.brokerName,
              effectiveMode: broker.effectiveMode,
            })
            summary.placed++
            console.log(`[auto-trade-crypto] PLACED user=${settings.userId} broker=${broker.brokerName} BUY $${sizing.notionalUsd.toFixed(2)} ${brokerSymbol} stop=${effectiveStop} tp=${target} mode=${broker.effectiveMode}`)
          } catch (e) {
            await logRejected(verdict, settings, clientOrderId, e instanceof Error ? e.message : String(e), broker.brokerName)
            summary.errors++
          }
        }

        if (maxId > (settings.cryptoLastProcessedVerdictId ?? 0)) {
          // Advance the CRYPTO watermark only — independent of the stock pointer.
          await setVerdictWatermark(settings.userId, 'crypto', maxId)
        }
      } catch (e) {
        summary.errors++
        console.error(`[auto-trade-crypto] user=${settings.userId} failed:`, e instanceof Error ? e.message : e)
      }
    }
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Server error' }, { status: 500 })
  }

  summary.durationMs = Date.now() - startedAt
  console.log(`[auto-trade-crypto cron] done in ${summary.durationMs}ms placed=${summary.placed} skipped=${summary.skipped}`)
  return NextResponse.json(summary)
}

// ─────────────────────────────────────────────────────────────

function gradeRank(g: string): number {
  return g === 'A' ? 3 : g === 'B' ? 2 : g === 'C' ? 1 : 0
}

async function fetchNewCryptoVerdicts(userId: string, watermark: number): Promise<VerdictRow[]> {
  const admin = await getSupabaseAdmin()
  const cutoff = new Date(Date.now() - VERDICT_AGE_HOURS * 3_600_000).toISOString()
  const { data, error } = await admin
    .from('verdict_log')
    .select('id, user_id, ticker, signal, confidence, entry_price, stop_loss, take_profit, trader_decision, trader_grade, trader_position_size, trader_risk_reward, trader_pass_reasons, created_at')
    .eq('user_id', userId)
    .gt('id', watermark)
    .in('trader_decision', ['TAKE', 'PASS', 'WAIT'])
    .gte('created_at', cutoff)
    .order('id', { ascending: true })
    .limit(MAX_VERDICTS_PER_USER)
  if (error) return []
  return (data ?? []) as VerdictRow[]
}

async function countOpenCryptoAttempts(userId: string): Promise<number> {
  const admin = await getSupabaseAdmin()
  const { count } = await admin
    .from('trade_attempts')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('asset_class', 'crypto')
    .in('outcome', ['placed', 'filled', 'partial_fill'])
  return count ?? 0
}

async function countAllOpenAttempts(userId: string): Promise<number> {
  const admin = await getSupabaseAdmin()
  const { count } = await admin
    .from('trade_attempts')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .in('outcome', ['placed', 'filled', 'partial_fill'])
  return count ?? 0
}

async function logSkipped(verdict: VerdictRow, settings: UserTradingSettings, reason: string): Promise<void> {
  const admin = await getSupabaseAdmin()
  await admin.from('trade_attempts').insert({
    user_id: settings.userId,
    verdict_log_id: verdict.id,
    ticker: verdict.ticker,
    asset_class: 'crypto',
    council_signal: verdict.signal,
    outcome: 'skipped',
    reject_reason: reason,
    mode: settings.mode,
    broker: 'alpaca',
    signal_source: 'council',
  })
}

async function logPlaced(
  verdict: VerdictRow,
  settings: UserTradingSettings,
  details: {
    clientOrderId: string; brokerOrderId: string
    units: number; notionalUsd: number
    entryPrice: number; stopPrice: number; targetPrice: number
    dollarRisk: number; accountEquity: number; normalizedSymbol: string
    brokerName: 'alpaca' | 'coinbase'
    effectiveMode: 'paper' | 'live'
  },
): Promise<void> {
  const admin = await getSupabaseAdmin()
  await admin.from('trade_attempts').insert({
    user_id: settings.userId,
    verdict_log_id: verdict.id,
    ticker: details.normalizedSymbol,
    asset_class: 'crypto',
    council_signal: verdict.signal,
    council_confidence: verdict.confidence !== null ? Math.round(Number(verdict.confidence)) : null,
    council_entry: details.entryPrice,
    council_stop: details.stopPrice,
    council_target: details.targetPrice,
    outcome: 'placed',
    mode: details.effectiveMode,
    broker: details.brokerName,
    broker_order_id: details.brokerOrderId,
    broker_client_id: details.clientOrderId,
    side: 'buy',
    qty: details.units,
    entry_price_est: details.entryPrice,
    stop_price: details.stopPrice,
    target_price: details.targetPrice,
    risk_dollar_amount: details.dollarRisk,
    account_equity_at: details.accountEquity,
    signal_source: 'council',
  })
}

async function logRejected(
  verdict: VerdictRow,
  settings: UserTradingSettings,
  clientOrderId: string,
  msg: string,
  brokerName: 'alpaca' | 'coinbase' = 'alpaca',
): Promise<void> {
  const admin = await getSupabaseAdmin()
  await admin.from('trade_attempts').insert({
    user_id: settings.userId,
    verdict_log_id: verdict.id,
    ticker: verdict.ticker,
    asset_class: 'crypto',
    council_signal: verdict.signal,
    outcome: 'rejected',
    reject_reason: msg.slice(0, 500),
    mode: brokerName === 'coinbase' ? 'live' : settings.mode,
    broker: brokerName,
    broker_client_id: clientOrderId,
    signal_source: 'council',
  })
}
