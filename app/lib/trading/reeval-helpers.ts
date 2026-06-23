// =============================================================
// app/lib/trading/reeval-helpers.ts
//
// Shared helpers for after-hours-reeval and pre-market-reeval crons.
// Both crons need to:
//   1. Fetch open positions from Alpaca
//   2. Fetch open (un-filled) orders from Alpaca — "held" orders
//   3. Run a light material-change check
//   4. Escalate to Council reeval-thesis-check if material
//
// This file is the pure logic. The crons compose it.
// =============================================================

import { getSupabaseAdmin } from '@/app/lib/admin/admin-auth'

export interface AlpacaPos {
  symbol: string
  qty: number
  avg_entry_price: number
  current_price: number
}

export interface AlpacaOrder {
  id: string
  client_order_id: string
  symbol: string
  qty: string
  side: 'buy' | 'sell'
  status: string         // 'new' | 'accepted' | 'held' | 'pending_new' | etc
  order_type: string     // 'market' | 'limit' | 'stop' | ...
  limit_price: string | null
  stop_price: string | null
  legs: AlpacaOrder[] | null  // bracket children
  filled_qty: string
  created_at: string
}

export interface OpenAttemptForReeval {
  id: string
  user_id: string
  ticker: string
  side: 'buy' | 'sell' | null
  qty: number | null
  filled_avg_price: number | null
  entry_price_est: number | null
  stop_price: number | null
  target_price: number | null
  verdict_log_id: number | null
  broker_order_id: string | null
  outcome: string
}

export interface MaterialCheck {
  isMaterial: boolean
  reasons: string[]      // human-readable list of why we think it's material (or not)
  priceGapPct: number | null
  newsHeadlines: string[]
}

/**
 * Decide whether the situation has materially changed enough to warrant
 * a Council reeval. Cheap checks first; expensive Council call only if any fire.
 *
 * Material-change triggers:
 *   1. Price gap > 2% from entry (or from extended-hours quote if we have one)
 *   2. Price has crossed the stop level (for open positions)
 *   3. Price has crossed the target level (for open positions)
 *   4. News headline in last 8 hours containing the ticker + a catalyst keyword
 */
export async function checkMaterialChange(args: {
  ticker: string
  entryPrice: number | null
  currentPrice: number | null
  stopPrice: number | null
  targetPrice: number | null
  side: 'buy' | 'sell' | null
}): Promise<MaterialCheck> {
  const { ticker, entryPrice, currentPrice, stopPrice, targetPrice, side } = args
  const reasons: string[] = []

  // ── Check 1: price gap from entry ──
  let priceGapPct: number | null = null
  if (entryPrice !== null && currentPrice !== null && entryPrice > 0) {
    priceGapPct = ((currentPrice - entryPrice) / entryPrice) * 100
    if (Math.abs(priceGapPct) > 2.0) {
      reasons.push(`price gap ${priceGapPct.toFixed(2)}% from entry $${entryPrice.toFixed(2)}`)
    }
  }

  // ── Check 2: stop crossed ──
  // For a BUY position, stop is below entry; crossed means current <= stop.
  // For a SELL position, stop is above entry; crossed means current >= stop.
  if (currentPrice !== null && stopPrice !== null && side !== null) {
    if (side === 'buy' && currentPrice <= stopPrice) {
      reasons.push(`current $${currentPrice.toFixed(2)} <= stop $${stopPrice.toFixed(2)}`)
    } else if (side === 'sell' && currentPrice >= stopPrice) {
      reasons.push(`current $${currentPrice.toFixed(2)} >= stop $${stopPrice.toFixed(2)}`)
    }
  }

  // ── Check 3: target crossed ──
  if (currentPrice !== null && targetPrice !== null && side !== null) {
    if (side === 'buy' && currentPrice >= targetPrice) {
      reasons.push(`current $${currentPrice.toFixed(2)} >= target $${targetPrice.toFixed(2)}`)
    } else if (side === 'sell' && currentPrice <= targetPrice) {
      reasons.push(`current $${currentPrice.toFixed(2)} <= target $${targetPrice.toFixed(2)}`)
    }
  }

  // ── Check 4: news in last 8 hours ──
  const newsHeadlines = await fetchRecentNewsForTicker(ticker, 8).catch(() => [] as string[])
  const catalystKeywords = [
    'earnings', 'beat', 'miss', 'guidance',
    'downgrade', 'upgrade', 'price target',
    'acquisition', 'acquires', 'merger', 'm&a',
    'halt', 'halted', 'suspended',
    'fraud', 'lawsuit', 'investigation',
    'bankruptcy', 'restructur',
    'fda approval', 'fda rejection', 'clinical',
    'recall',
  ]
  const catalystNews = newsHeadlines.filter(h => {
    const lc = h.toLowerCase()
    return catalystKeywords.some(k => lc.includes(k))
  })
  if (catalystNews.length > 0) {
    reasons.push(`${catalystNews.length} catalyst news headlines`)
  }

  if (reasons.length === 0) {
    reasons.push('no material change detected')
  }

  return {
    isMaterial: reasons.length > 0 && !reasons[0].startsWith('no material'),
    reasons,
    priceGapPct,
    newsHeadlines: catalystNews.slice(0, 5),
  }
}

/**
 * Fetch recent news headlines mentioning a ticker.
 *
 * TODO (2026-06-22): the news_cache table is a JSONB blob cache keyed by
 * cache_key, NOT a structured news feed with per-row headline + timestamp.
 * The active-stories cron uses fetchMultiSourceNews() from
 * @/app/lib/multi-source-news for live news pulls. Wiring that into the
 * reeval crons would add ~1-3s per ticker (live API fetch) and an external
 * dependency on each cron run.
 *
 * For now this function returns []. Material-change detection still works
 * on price gap (>2%) and stop/target crossing — those catch real moves
 * regardless of news cause. The news catalyst path is a future enhancement.
 *
 * To wire later: import fetchMultiSourceNews, call with the ticker, filter
 * results by ticker mention + last N hours, return headlines.
 */
async function fetchRecentNewsForTicker(_ticker: string, _hoursBack: number): Promise<string[]> {
  return []
}

/**
 * Fetch the latest quote from Alpaca's market data API. Returns null on failure.
 * Falls back gracefully if the user's data subscription doesn't include
 * extended-hours quotes.
 */
export async function fetchLatestQuote(
  alpaca: unknown,
  symbol: string,
): Promise<{ price: number | null; isExtendedHours: boolean }> {
  const callAlpaca = (m: string, p: string): Promise<unknown> =>
    (alpaca as { request: (m: string, p: string) => Promise<unknown> }).request(m, p)

  try {
    // Use SIP feed (Algo Trader Plus subscription) for full market coverage
    // including extended-hours data. If subscription changes, swap to 'iex'.
    const resp = await callAlpaca('GET', `/v2/stocks/${encodeURIComponent(symbol)}/quotes/latest?feed=sip`) as {
      quote?: { ap?: number; bp?: number; t?: string }
    }
    if (!resp?.quote) return { price: null, isExtendedHours: false }
    // Use midpoint of bid/ask if both available, else whichever is non-zero
    const ap = resp.quote.ap ?? 0
    const bp = resp.quote.bp ?? 0
    let price: number | null = null
    if (ap > 0 && bp > 0) price = (ap + bp) / 2
    else if (ap > 0) price = ap
    else if (bp > 0) price = bp

    // Heuristic: if the quote timestamp is outside regular hours (13:30-21:00 UTC), flag it
    const tsMs = resp.quote.t ? new Date(resp.quote.t).getTime() : 0
    const tsUtcHour = tsMs > 0 ? new Date(tsMs).getUTCHours() : -1
    const isExtendedHours = tsUtcHour >= 0 && (tsUtcHour < 13 || tsUtcHour >= 21)

    return { price, isExtendedHours }
  } catch {
    return { price: null, isExtendedHours: false }
  }
}

/**
 * Fetch all held/open orders (not yet filled) for a symbol. Useful to detect
 * the bracket parent that's queued waiting for market open.
 */
export async function fetchHeldOrders(alpaca: unknown): Promise<AlpacaOrder[]> {
  const callAlpaca = (m: string, p: string): Promise<unknown> =>
    (alpaca as { request: (m: string, p: string) => Promise<unknown> }).request(m, p)

  try {
    const resp = await callAlpaca('GET', '/v2/orders?status=open&limit=100&nested=true') as AlpacaOrder[] | { orders?: AlpacaOrder[] }
    if (Array.isArray(resp)) return resp
    if (resp && Array.isArray((resp as { orders?: AlpacaOrder[] }).orders)) {
      return (resp as { orders: AlpacaOrder[] }).orders
    }
    return []
  } catch {
    return []
  }
}

/**
 * Cancel an Alpaca order. Returns true on success.
 * For a bracket parent that's never filled, this cancels the parent AND
 * the children automatically.
 */
export async function cancelOrder(alpaca: unknown, orderId: string): Promise<{ ok: boolean; reason?: string }> {
  const callAlpaca = (m: string, p: string): Promise<unknown> =>
    (alpaca as { request: (m: string, p: string) => Promise<unknown> }).request(m, p)

  try {
    await callAlpaca('DELETE', `/v2/orders/${encodeURIComponent(orderId)}`)
    return { ok: true }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ok: false, reason: msg.slice(0, 300) }
  }
}

/**
 * Call /api/reeval-thesis-check with a given trigger. Returns the response
 * action or null on failure. The cron decides what to do with the action.
 */
export async function callReevalThesisCheck(args: {
  baseUrl: string
  cronSecret: string
  userId: string
  verdictId: number
  currentPrice: number
  unrealizedPnlPct: number
  triggers: string[]
  triggerSource: string         // 'after_hours_reeval' | 'pre_market_reeval'
}): Promise<{
  action: string | null
  thesisStatus: string | null
  rationale: string
  confidence: number
  error?: string
}> {
  try {
    const res = await fetch(`${args.baseUrl}/api/reeval-thesis-check`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${args.cronSecret}`,
        'x-service-trigger': args.triggerSource,
        'x-service-user-id': args.userId,
      },
      body: JSON.stringify({
        verdictId: args.verdictId,
        currentPrice: args.currentPrice,
        unrealizedPnlPct: args.unrealizedPnlPct,
        triggersFired: args.triggers,
      }),
      signal: AbortSignal.timeout(90_000),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      return {
        action: null, thesisStatus: null, rationale: '',
        confidence: 0,
        error: `thesis-check ${res.status}: ${body.slice(0, 150)}`,
      }
    }
    const data = await res.json() as {
      action?: string
      thesisStatus?: string
      rationale?: string
      confidence?: number
    }
    return {
      action: (data.action ?? 'HOLD').toUpperCase(),
      thesisStatus: data.thesisStatus ?? null,
      rationale: (data.rationale ?? '').slice(0, 500),
      confidence: data.confidence ?? 0,
    }
  } catch (e) {
    return {
      action: null, thesisStatus: null, rationale: '',
      confidence: 0,
      error: e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200),
    }
  }
}

/**
 * Fetch open trade_attempts for a user (used by both crons to find what's
 * managed by our system). Same pattern as position-monitor.
 */
export async function fetchOpenAttempts(userId: string): Promise<OpenAttemptForReeval[]> {
  const admin = await getSupabaseAdmin()
  const cutoff = new Date(Date.now() - 30 * 24 * 3_600_000).toISOString()
  const { data, error } = await admin
    .from('trade_attempts')
    .select('id, user_id, ticker, side, qty, filled_avg_price, entry_price_est, stop_price, target_price, verdict_log_id, broker_order_id, outcome')
    .eq('user_id', userId)
    .or('asset_class.is.null,asset_class.eq.stock,asset_class.eq.stocks')
    .in('outcome', ['placed', 'filled', 'partial_fill'])
    .gte('created_at', cutoff)

  if (error) {
    console.warn(`[reeval-helpers] fetchOpenAttempts user=${userId} failed: ${error.message}`)
    return []
  }
  const rows = (data ?? []) as Array<Record<string, unknown>>
  return rows.map(row => ({
    id: String(row.id),
    user_id: String(row.user_id),
    ticker: String(row.ticker),
    side: (row.side as 'buy' | 'sell' | null) ?? null,
    qty: row.qty !== null && row.qty !== undefined ? Number(row.qty) : null,
    filled_avg_price: row.filled_avg_price !== null && row.filled_avg_price !== undefined ? Number(row.filled_avg_price) : null,
    entry_price_est: row.entry_price_est !== null && row.entry_price_est !== undefined ? Number(row.entry_price_est) : null,
    stop_price: row.stop_price !== null && row.stop_price !== undefined ? Number(row.stop_price) : null,
    target_price: row.target_price !== null && row.target_price !== undefined ? Number(row.target_price) : null,
    verdict_log_id: row.verdict_log_id !== null && row.verdict_log_id !== undefined ? Number(row.verdict_log_id) : null,
    broker_order_id: row.broker_order_id !== null && row.broker_order_id !== undefined ? String(row.broker_order_id) : null,
    outcome: String(row.outcome),
  }))
}
