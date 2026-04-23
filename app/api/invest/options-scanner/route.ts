// ═════════════════════════════════════════════════════════════
// app/api/invest/options-scanner/route.ts
//
// Budget-aware options scanner. Scans ~100 liquid optionable tickers,
// pre-filters chains for fit-to-budget, then uses Claude to rank the
// best 5-8 option plays.
//
// Also auto-includes tickers from council_candidates (non-NEUTRAL
// verdicts from /api/analyze) so your Council research feeds directly
// into option ideas.
//
// Design choices:
//   - 15-minute cache per (userId, budget_bucket) to avoid rescanning
//   - Parallel batches of 10 for Tradier calls (rate limit friendly)
//   - Pre-filter step narrows 100 tickers to top 30 before Claude sees them
//   - Claude gets macro regime context in prompt
//   - Every pick gets logged to movers_log with source='options_scanner'
// ═════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { createClient } from '@/app/lib/auth/server'
import { createClient as createAdmin } from '@supabase/supabase-js'
import { getOptionChain, getOptionExpirations, isTradierConfigured, getTradierMode, isTradierAuthFailing, type TradierOption } from '@/app/lib/tradier'
import { getUniverseTickers, mergeWithCouncilCandidates, getUniverseEntry } from '@/app/lib/optionable-universe'
import { getActiveCouncilCandidates } from '@/app/lib/council-candidates'
import { getMarketRegime, type MarketRegime } from '@/app/lib/market-regime'
import { autoAddOptionToWatchlist } from '@/app/lib/watchlist-auto-add'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

const getAdmin = () => createAdmin(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

// ─────────────────────────────────────────────────────────────
// In-memory cache per (userId, budget bucket). 15 minute TTL.
// Budget bucketed to nearest $500 so small variations still hit cache.
// ─────────────────────────────────────────────────────────────
interface CacheEntry {
  result: ScannerResult
  fetchedAt: number
}
const scanCache = new Map<string, CacheEntry>()
const CACHE_TTL_MS = 15 * 60 * 1000

function budgetBucket(budget: number): number {
  return Math.floor(budget / 500) * 500
}

function cacheKey(userId: string, budget: number, horizon: string): string {
  return `${userId}:${budgetBucket(budget)}:${horizon}`
}

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────
interface CandidateContract {
  ticker: string
  sector?: string
  optionType: 'call' | 'put'
  strike: number
  expiration: string
  dte: number
  premium: number
  delta: number | null
  iv: number | null
  bid: number
  ask: number
  volume: number
  openInterest: number
  optionSymbol: string
  contractCost: number       // premium × 100
  budgetFitPct: number       // contractCost / budget × 100
  liquidityScore: number     // internal score for ranking
  // Optional Council context if ticker is in council_candidates
  councilSignal?: 'BULLISH' | 'BEARISH'
  councilConfidence?: number
  councilVerdictCount?: number
}

interface ScannerPick {
  ticker: string
  companyName?: string
  optionType: 'call' | 'put'
  strike: number
  expiration: string
  dte: number
  premium: number
  contractCost: number
  delta: number | null
  iv: number | null
  breakeven: number
  maxLoss: number
  confidence: number        // Claude's 0-100 conviction
  thesis: string            // Plain English reasoning
  horizon: 'short' | 'swing' | 'monthly'
  riskLevel: 'high' | 'medium' | 'low'
  catalyst: string
  sourceBadge: 'council' | 'macro' | 'universe'  // Why this was picked
  optionSymbol: string
  dataSource: 'tradier'
}

interface ScannerResult {
  budget: number
  horizon: string
  scannedTickers: number
  chainsRetrieved: number
  candidatesAfterFilter: number
  picks: ScannerPick[]
  regime: {
    label: 'risk-on' | 'risk-off' | 'mixed'
    spyChangePct: number | null
    vixLevel: number | null
    context: string
  }
  councilCandidateCount: number
  generatedAt: string
  elapsedMs: number
  cached: boolean
  ageMinutes?: number
  tradierMode: 'sandbox' | 'production'
}

// ─────────────────────────────────────────────────────────────
// Chain fetcher with parallel batches
// ─────────────────────────────────────────────────────────────
async function fetchChainsForTickers(tickers: string[]): Promise<Map<string, TradierOption[]>> {
  const results = new Map<string, TradierOption[]>()
  const BATCH_SIZE = 10
  const BATCH_DELAY_MS = 200  // avoid hitting Tradier rate limits

  for (let i = 0; i < tickers.length; i += BATCH_SIZE) {
    const batch = tickers.slice(i, i + BATCH_SIZE)

    const batchResults = await Promise.all(batch.map(async (ticker) => {
      try {
        // Get expirations first
        const expirations = await getOptionExpirations(ticker)
        if (expirations.length === 0) return { ticker, chain: [] as TradierOption[] }

        // Pick expirations near our target horizons
        // (we want variety: one near-week, one two-week, one monthly)
        const now = Date.now()
        const targetDays = [7, 14, 30]
        const pickedExps = new Set<string>()

        for (const target of targetDays) {
          let best: string | null = null
          let bestDiff = Infinity
          for (const exp of expirations) {
            const t = new Date(exp + 'T00:00:00Z').getTime()
            if (!Number.isFinite(t)) continue
            const daysOut = (t - now) / (1000 * 60 * 60 * 24)
            if (daysOut < 1) continue   // skip same-day
            const diff = Math.abs(daysOut - target)
            if (diff < bestDiff) { bestDiff = diff; best = exp }
          }
          if (best) pickedExps.add(best)
        }

        // Fetch chains for picked expirations, merge
        const allOptions: TradierOption[] = []
        for (const exp of pickedExps) {
          const chain = await getOptionChain(ticker, exp)
          allOptions.push(...chain)
        }
        return { ticker, chain: allOptions }
      } catch {
        return { ticker, chain: [] as TradierOption[] }
      }
    }))

    for (const r of batchResults) {
      if (r.chain.length > 0) results.set(r.ticker, r.chain)
    }

    if (i + BATCH_SIZE < tickers.length) {
      await new Promise(r => setTimeout(r, BATCH_DELAY_MS))
    }
  }

  return results
}

// ─────────────────────────────────────────────────────────────
// Pre-filter: score each option chain, pick best candidates per ticker
// ─────────────────────────────────────────────────────────────
function preFilterChains(
  chains: Map<string, TradierOption[]>,
  budget: number,
  councilLookup: Map<string, { signal: 'BULLISH' | 'BEARISH'; confidence: number; verdictCount: number }>,
): CandidateContract[] {
  const candidates: CandidateContract[] = []
  const maxContractCost = budget * 0.5  // allow up to 50% of budget per contract at this stage

  for (const [ticker, chain] of chains) {
    const council = councilLookup.get(ticker)
    const sector = getUniverseEntry(ticker)?.sector

    for (const opt of chain) {
      // Compute mid premium
      let premium: number
      if (opt.bid > 0 && opt.ask > 0) premium = (opt.bid + opt.ask) / 2
      else if (opt.last && opt.last > 0) premium = opt.last
      else continue

      const contractCost = premium * 100
      if (contractCost < 15) continue        // skip pennies (<$15 contracts)
      if (contractCost > maxContractCost) continue

      const dte = Math.max(0, Math.round(
        (new Date(opt.expiration_date + 'T00:00:00Z').getTime() - Date.now()) / (1000 * 60 * 60 * 24)
      ))
      if (dte < 2 || dte > 60) continue      // reasonable window

      // Council-filtered ticker: only allow the matching direction
      if (council) {
        if (council.signal === 'BULLISH' && opt.option_type !== 'call') continue
        if (council.signal === 'BEARISH' && opt.option_type !== 'put') continue
      }

      const bidAskSpread = opt.ask > 0 && opt.bid > 0 ? (opt.ask - opt.bid) / opt.ask : 1
      const openInterest = opt.open_interest ?? 0
      const volume = opt.volume ?? 0

      // Liquidity score — high OI + low spread + decent volume
      const liquidityScore =
        Math.min(openInterest / 500, 1) * 40 +
        Math.max(0, 1 - bidAskSpread * 20) * 40 +
        Math.min(volume / 100, 1) * 20

      // Skip illiquid options
      if (liquidityScore < 20) continue

      candidates.push({
        ticker,
        sector,
        optionType: opt.option_type,
        strike: opt.strike,
        expiration: opt.expiration_date,
        dte,
        premium: Math.round(premium * 100) / 100,
        delta: opt.greeks?.delta ?? null,
        iv: opt.greeks?.mid_iv ?? null,
        bid: opt.bid,
        ask: opt.ask,
        volume,
        openInterest,
        optionSymbol: opt.symbol,
        contractCost: Math.round(contractCost * 100) / 100,
        budgetFitPct: Math.round(contractCost / budget * 1000) / 10,
        liquidityScore: Math.round(liquidityScore),
        councilSignal: council?.signal,
        councilConfidence: council?.confidence,
        councilVerdictCount: council?.verdictCount,
      })
    }
  }

  // Rank: council picks first, then by liquidity score, cap at 30
  candidates.sort((a, b) => {
    if (a.councilSignal && !b.councilSignal) return -1
    if (!a.councilSignal && b.councilSignal) return 1
    return b.liquidityScore - a.liquidityScore
  })

  return candidates.slice(0, 30)
}

// ─────────────────────────────────────────────────────────────
// Format candidates for Claude prompt
// ─────────────────────────────────────────────────────────────
function formatCandidatesForPrompt(candidates: CandidateContract[]): string {
  return candidates.map((c, i) => {
    const council = c.councilSignal ? ` [COUNCIL: ${c.councilSignal} ${c.councilConfidence}%]` : ''
    const greeks = c.delta !== null ? ` delta=${c.delta.toFixed(2)}` : ''
    const iv = c.iv !== null ? ` IV=${(c.iv * 100).toFixed(0)}%` : ''
    return `[${i + 1}] ${c.ticker} ${c.optionType.toUpperCase()} $${c.strike} exp ${c.expiration} (DTE ${c.dte}) — premium $${c.premium} (cost $${c.contractCost}, ${c.budgetFitPct}% of budget)${greeks}${iv} liq=${c.liquidityScore}${council}`
  }).join('\n')
}

// ─────────────────────────────────────────────────────────────
// Claude picks the best 5-8
// ─────────────────────────────────────────────────────────────
async function claudePickTopOptions(params: {
  candidates: CandidateContract[]
  budget: number
  regime: MarketRegime
  horizon: string
}): Promise<ScannerPick[]> {
  const { candidates, budget, regime, horizon } = params
  if (candidates.length === 0) return []

  const horizonNote = horizon === 'short' ? 'short-term momentum (DTE 3-10 preferred, higher delta)' :
    horizon === 'swing' ? 'swing trades (DTE 14-30 preferred, moderate delta)' :
    'auto-pick the best horizon per setup — can mix short-term and swing'

  const system = `You are an options strategist. Your job: pick the BEST 5-8 option plays from a pre-filtered candidate list given the user's budget and current market regime.

Selection criteria in order:
  1. Risk/reward — is max loss acceptable for potential upside?
  2. Regime alignment — bullish plays in risk-on, bearish in risk-off (unless contrarian thesis is strong)
  3. Council alignment — if ticker has a Council verdict, that's independent research confirming the direction
  4. Liquidity — tight spreads, reasonable DTE
  5. Diversification — don't pick 5 tech calls; spread across sectors/directions when possible

Every pick gets a confidence score 0-100 representing your conviction it'll be profitable by expiration.
  - 80+ high conviction (strong catalyst + regime alignment + Council backing)
  - 65-79 solid conviction (clear setup)
  - 60-64 moderate conviction
  - <60 don't include

Target horizon: ${horizonNote}

Output is JSON only, no preamble, no markdown.`

  const user = `BUDGET: $${budget}
MARKET REGIME: ${regime.contextParagraph}

CANDIDATE OPTIONS (pre-filtered for budget fit, liquidity, and direction match with Council):
${formatCandidatesForPrompt(candidates)}

Pick the 5-8 BEST plays. Explain each pick in plain English for a beginner.

For each pick, return:
{
  "ticker": "SYMBOL",
  "optionType": "call|put",
  "strike": <number>,
  "expiration": "YYYY-MM-DD",
  "confidence": <0-100>,
  "thesis": "2-3 sentences plain English — why this setup, what's the catalyst, what's the risk",
  "horizon": "short|swing|monthly",
  "riskLevel": "high|medium|low",
  "catalyst": "specific catalyst (e.g. 'earnings Thursday after-hours', 'Fed meeting Wednesday', 'technical breakout')",
  "sourceBadge": "council|macro|universe"
}

Rules:
- sourceBadge "council" ONLY if the candidate had [COUNCIL] tag in the list
- sourceBadge "macro" if the pick is driven primarily by the regime context (SPY/VIX/sector)
- sourceBadge "universe" otherwise
- Only pick from the candidates provided — do NOT invent tickers or strikes
- Confidence must be >= 60
- Respond with JSON:
{
  "picks": [ {...}, {...} ]
}`

  try {
    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4000,
      system,
      messages: [{ role: 'user', content: user }],
    })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const text = (msg.content[0] as any).text as string
    const clean = text.replace(/```json|```/g, '').trim()
    const start = clean.indexOf('{')
    const end = clean.lastIndexOf('}')
    if (start === -1 || end === -1) return []

    const parsed = JSON.parse(clean.slice(start, end + 1))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rawPicks: any[] = Array.isArray(parsed.picks) ? parsed.picks : []

    // Enrich each pick with the original candidate's data (authoritative)
    const picks: ScannerPick[] = []
    for (const p of rawPicks) {
      if (!p?.ticker || !p?.optionType || typeof p?.strike !== 'number') continue
      const match = candidates.find(c =>
        c.ticker === p.ticker.toUpperCase() &&
        c.optionType === p.optionType &&
        Math.abs(c.strike - p.strike) < 0.01 &&
        c.expiration === p.expiration
      )
      if (!match) {
        console.warn(`[options-scanner] Claude picked ${p.ticker} ${p.optionType} ${p.strike} but not in candidates — skipping`)
        continue
      }
      if (typeof p.confidence !== 'number' || p.confidence < 60) continue

      const breakeven = match.optionType === 'call'
        ? match.strike + match.premium
        : match.strike - match.premium

      picks.push({
        ticker: match.ticker,
        optionType: match.optionType,
        strike: match.strike,
        expiration: match.expiration,
        dte: match.dte,
        premium: match.premium,
        contractCost: match.contractCost,
        delta: match.delta,
        iv: match.iv,
        breakeven: Math.round(breakeven * 100) / 100,
        maxLoss: match.contractCost,
        confidence: Math.round(p.confidence),
        thesis: typeof p.thesis === 'string' ? p.thesis.slice(0, 400) : '',
        horizon: ['short', 'swing', 'monthly'].includes(p.horizon) ? p.horizon : 'swing',
        riskLevel: ['high', 'medium', 'low'].includes(p.riskLevel) ? p.riskLevel : 'medium',
        catalyst: typeof p.catalyst === 'string' ? p.catalyst.slice(0, 250) : '',
        sourceBadge: ['council', 'macro', 'universe'].includes(p.sourceBadge) ? p.sourceBadge : 'universe',
        optionSymbol: match.optionSymbol,
        dataSource: 'tradier',
      })
    }

    // Sort by confidence desc, cap 8
    picks.sort((a, b) => b.confidence - a.confidence)
    return picks.slice(0, 8)
  } catch (e) {
    console.warn('[options-scanner] Claude pick failed:', (e as Error).message?.slice(0, 100))
    return []
  }
}

// ─────────────────────────────────────────────────────────────
// Telemetry: log picks to movers_log with source='options_scanner'
// ─────────────────────────────────────────────────────────────
function logPicksToDb(picks: ScannerPick[], regime: MarketRegime): void {
  if (picks.length === 0) return
  void (async () => {
    try {
      const admin = getAdmin()
      const rows = picks.map(p => ({
        source: 'options_scanner',
        ticker: p.ticker,
        asset_type: 'stock',
        signal: p.optionType === 'call' ? 'BULLISH' : 'BEARISH',
        magnitude: p.confidence >= 80 ? 'high' : p.confidence >= 65 ? 'medium' : 'low',
        confidence: p.confidence,
        timeframe: p.horizon,
        headline: `${p.optionType.toUpperCase()} $${p.strike} exp ${p.expiration}`,
        catalyst: p.catalyst,
        reason: p.thesis,
        classification_model: 'claude-sonnet-4-options-scanner',
        verification_status: 'skipped',
        market_regime: regime.regime,
        spy_change_pct: regime.spyChangePct,
        vix_level: regime.vixLevel,
        price_at_flag: null,   // option scanner uses strike, not underlying price — set null
      }))
      const { error } = await admin.from('movers_log').insert(rows)
      if (error) console.warn('[options-scanner/log] insert failed:', error.message)
    } catch (e) {
      console.warn('[options-scanner/log] fire-and-forget failed:', (e as Error).message?.slice(0, 100))
    }
  })()
}

// ═════════════════════════════════════════════════════════════
// Route handler
// ═════════════════════════════════════════════════════════════
export async function POST(req: NextRequest) {
  const started = Date.now()
  console.log('[options-scanner] START')

  try {
    // Auth
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    // Parse body
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body: any = await req.json().catch(() => ({}))
    const budget = Number(body?.budget)
    const horizon = ['short', 'swing', 'any'].includes(body?.horizon) ? body.horizon : 'any'

    if (!Number.isFinite(budget) || budget < 100) {
      return NextResponse.json({ error: 'budget must be a number >= 100' }, { status: 400 })
    }
    if (budget > 1_000_000) {
      return NextResponse.json({ error: 'budget too large' }, { status: 400 })
    }

    // Gate: Tradier must be configured
    if (!isTradierConfigured()) {
      return NextResponse.json({
        error: 'Options scanner requires Tradier API key. Set TRADIER_API_KEY in environment.'
      }, { status: 503 })
    }

    // Cache check
    const key = cacheKey(user.id, budget, horizon)
    const cached = scanCache.get(key)
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      const age = Math.round((Date.now() - cached.fetchedAt) / 60000)
      console.log(`[options-scanner] cache hit (age ${age}m) in ${Date.now() - started}ms`)
      return NextResponse.json({ ...cached.result, cached: true, ageMinutes: age })
    }

    // ── Fetch inputs in parallel ──────────────────────────────
    const [regime, councilCandidates] = await Promise.all([
      getMarketRegime(),
      getActiveCouncilCandidates(user.id, 14),
    ])

    // Build universe: Council candidates prioritized, then static list
    const councilTickers = councilCandidates.map(c => c.ticker)
    const staticUniverse = getUniverseTickers()
    const tickers = mergeWithCouncilCandidates(staticUniverse, councilTickers)
    console.log(`[options-scanner] universe: ${tickers.length} tickers (${councilTickers.length} from Council)`)

    // Council lookup for fast access during pre-filter
    const councilLookup = new Map<string, { signal: 'BULLISH' | 'BEARISH'; confidence: number; verdictCount: number }>()
    for (const c of councilCandidates) {
      councilLookup.set(c.ticker, { signal: c.signal, confidence: c.confidence, verdictCount: c.verdictCount })
    }

    // ── Fetch option chains (parallel batches) ────────────────
    const chainStart = Date.now()
    const chains = await fetchChainsForTickers(tickers)
    console.log(`[options-scanner] chains: fetched ${chains.size}/${tickers.length} in ${Date.now() - chainStart}ms`)

    // Detect systemic Tradier auth failure (every call returning 401)
    // This would otherwise manifest as "no options found" which is misleading.
    const authStatus = isTradierAuthFailing()
    if (authStatus.failing && chains.size === 0) {
      console.error(`[options-scanner] TRADIER AUTH FAILING: ${authStatus.recent401s}/${authStatus.total} requests failed (${authStatus.lastError})`)
      return NextResponse.json({
        error: 'Tradier API authentication failed',
        details: `${authStatus.recent401s} of ${authStatus.total} recent requests returned 401 Unauthorized. Check that TRADIER_API_KEY is set correctly in Railway env and matches the TRADIER_ENV mode (sandbox tokens don't work in production and vice versa).`,
        tradierMode: getTradierMode(),
      }, { status: 503 })
    }

    // If chains are ALL empty but no auth issue, Tradier coverage is simply absent for these tickers
    if (chains.size === 0) {
      return NextResponse.json({
        budget,
        horizon,
        scannedTickers: tickers.length,
        chainsRetrieved: 0,
        candidatesAfterFilter: 0,
        picks: [],
        regime: {
          label: regime.regime,
          spyChangePct: regime.spyChangePct,
          vixLevel: regime.vixLevel,
          context: regime.contextParagraph,
        },
        councilCandidateCount: councilCandidates.length,
        generatedAt: new Date().toISOString(),
        elapsedMs: Date.now() - started,
        cached: false,
        tradierMode: getTradierMode(),
        message: `Tradier returned no option chains for any of the ${tickers.length} tickers. This may be a temporary outage or sandbox coverage gap. Try again in a few minutes.`,
      })
    }

    // ── Pre-filter to top 30 candidates ───────────────────────
    const filterStart = Date.now()
    const candidates = preFilterChains(chains, budget, councilLookup)
    console.log(`[options-scanner] pre-filter: ${candidates.length} candidates in ${Date.now() - filterStart}ms`)

    if (candidates.length === 0) {
      return NextResponse.json({
        budget,
        horizon,
        scannedTickers: tickers.length,
        chainsRetrieved: chains.size,
        candidatesAfterFilter: 0,
        picks: [],
        regime: {
          label: regime.regime,
          spyChangePct: regime.spyChangePct,
          vixLevel: regime.vixLevel,
          context: regime.contextParagraph,
        },
        councilCandidateCount: councilCandidates.length,
        generatedAt: new Date().toISOString(),
        elapsedMs: Date.now() - started,
        cached: false,
        tradierMode: getTradierMode(),
        message: 'No option contracts matched your budget and liquidity filters. Try increasing the budget or check that Tradier coverage is available.',
      })
    }

    // ── Claude picks top 5-8 ──────────────────────────────────
    const claudeStart = Date.now()
    const picks = await claudePickTopOptions({ candidates, budget, regime, horizon })
    console.log(`[options-scanner] Claude picks: ${picks.length} in ${Date.now() - claudeStart}ms`)

    // ── Telemetry + cache ─────────────────────────────────────
    logPicksToDb(picks, regime)

    // Auto-add high-confidence picks to user's watchlist
    // Only picks with confidence >= 70 auto-add (lower ones are just browsing)
    for (const pick of picks) {
      if (pick.confidence >= 70) {
        autoAddOptionToWatchlist({
          userId: user.id,
          ticker: pick.ticker,
          optionSymbol: pick.optionSymbol,
          optionType: pick.optionType,
          strike: pick.strike,
          expiration: pick.expiration,
          premiumAtAdd: pick.premium,
          deltaAtAdd: pick.delta ?? undefined,
          ivAtAdd: pick.iv ?? undefined,
          source: 'invest',
        })
      }
    }

    const result: ScannerResult = {
      budget,
      horizon,
      scannedTickers: tickers.length,
      chainsRetrieved: chains.size,
      candidatesAfterFilter: candidates.length,
      picks,
      regime: {
        label: regime.regime,
        spyChangePct: regime.spyChangePct,
        vixLevel: regime.vixLevel,
        context: regime.contextParagraph,
      },
      councilCandidateCount: councilCandidates.length,
      generatedAt: new Date().toISOString(),
      elapsedMs: Date.now() - started,
      cached: false,
      tradierMode: getTradierMode(),
    }

    scanCache.set(key, { result, fetchedAt: Date.now() })

    console.log(`[options-scanner] TOTAL ${result.elapsedMs}ms (${(result.elapsedMs / 1000).toFixed(1)}s)`)
    return NextResponse.json(result)
  } catch (e) {
    console.error('[options-scanner] error:', e)
    return NextResponse.json({
      error: (e as Error).message?.slice(0, 300) ?? 'scanner failed',
    }, { status: 500 })
  }
}

// Also support GET for a status/health check
export async function GET() {
  return NextResponse.json({
    ready: isTradierConfigured(),
    tradierMode: getTradierMode(),
    universeSize: getUniverseTickers().length,
    cacheEntries: scanCache.size,
  })
}
