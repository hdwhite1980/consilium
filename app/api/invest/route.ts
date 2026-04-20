import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/app/lib/auth/server'
import Anthropic from '@anthropic-ai/sdk'
import { getVolumeMoversEnhanced } from '@/app/lib/data/screener'

const STAGE_CONFIG = [
  { name: 'Spark',   min: 0,      max: 10,     maxPositions: 2, stopPct: '20–30%', targetPct: '40–80%', strategy: 'momentum and volume spike plays on micro-cap stocks' },
  { name: 'Ember',   min: 10,     max: 50,     maxPositions: 2, stopPct: '18–25%', targetPct: '35–70%', strategy: 'momentum with early technical confirmation' },
  { name: 'Flame',   min: 50,     max: 200,    maxPositions: 3, stopPct: '15–20%', targetPct: '30–60%', strategy: 'technical setups with catalyst awareness' },
  { name: 'Blaze',   min: 200,    max: 1000,   maxPositions: 4, stopPct: '10–15%', targetPct: '20–40%', strategy: 'fundamentally-supported technical breakouts' },
  { name: 'Inferno', min: 1000,   max: 10000,  maxPositions: 5, stopPct: '8–12%',  targetPct: '15–30%', strategy: 'high-conviction full debate analysis' },
  { name: 'Free',    min: 10000,  max: Infinity, maxPositions: 10, stopPct: '5–10%', targetPct: '10–25%', strategy: 'diversified conviction-weighted portfolio' },
]

function getStage(totalValue: number) {
  return STAGE_CONFIG.find(s => totalValue >= s.min && totalValue < s.max) ?? STAGE_CONFIG[0]
}

// ── Tier gate for options eligibility ────────────────────────
// MUST match the TIERS array in /api/invest/journey. Options unlock at Operator+.
// Below Operator ($200), we skip option generation entirely.
const OPTIONS_MIN_VALUE = 200

// ── Options budget heuristic ─────────────────────────────────
// Per-position budget × N = max premium per contract. Tighter caps for larger
// accounts (where absolute dollar amounts matter more), looser for smaller
// accounts (where a tight cap forces Claude into unrealistic deep-OTM strikes).
//
// At $1000 account / 5 positions = $200/pos:
//   OLD: 20% → $40 cap → Claude often proposes $0.50+ premiums → filtered out
//   NEW: 40% → $80 cap → Claude can propose normal ATM strikes on cheap stocks
//
// At $50k account / 10 positions = $5k/pos:
//   20% → $1k cap — reasonable for real option sizing discipline
function getOptionBudget(deployable: number, maxPositions: number): { maxPremiumPerContract: number; capPct: number } {
  const perPosition = deployable / Math.max(1, maxPositions)
  // Looser cap at small accounts because premium dollars are tiny either way,
  // and a tight cap just causes Claude to return 0 valid options most of the time.
  const capPct = deployable < 5000 ? 0.40 : 0.20
  const cap = perPosition * capPct
  return { maxPremiumPerContract: cap, capPct }
}

// ═════════════════════════════════════════════════════════════
// Options idea generator (Phase 1 — Claude estimates only)
//
// Called after stock ideas are generated. Asks Claude to propose 2-3 option
// plays based on the top stock ideas (mirror pattern). Every numeric field
// (strike, premium, delta, breakeven, maxLoss) is a MODEL ESTIMATE — real
// market prices will differ. Phase 2 (deferred) will enrich with Tradier.
//
// All option ideas are cost-capped: contract cost ≤ maxPremiumPerContract * 100.
// Post-generation filter rejects anything over budget.
// ═════════════════════════════════════════════════════════════
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function generateOptionIdeas(params: {
  anthropic: Anthropic
  topStockIdeas: any[]  // eslint-disable-line @typescript-eslint/no-explicit-any
  maxPremiumPerContract: number
  perPositionBudget: number
  stageName: string
  marketContext: string
// eslint-disable-next-line @typescript-eslint/no-explicit-any
}): Promise<any[]> {
  const { anthropic, topStockIdeas, maxPremiumPerContract, perPositionBudget, stageName, marketContext } = params

  if (topStockIdeas.length === 0) return []

  // Mirror pattern: only propose options for the top 3 highest-confidence bullish stock ideas.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const candidates = topStockIdeas
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .filter((i: any) => i.ticker && typeof i.confidence === 'number')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .sort((a: any, b: any) => (b.confidence ?? 0) - (a.confidence ?? 0))
    .slice(0, 3)

  if (candidates.length === 0) return []

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const candidatesDesc = candidates.map((i: any) =>
    `${i.ticker} @ ~$${i.price?.toFixed(2) ?? '?'} — ${i.signal} ${i.confidence}% — ${i.catalyst ?? 'no catalyst'}`
  ).join('\n')

  const maxContractCost = maxPremiumPerContract * 100
  const maxPremiumSh = maxPremiumPerContract.toFixed(2)

  const prompt = `You are proposing OPTION plays that mirror the top stock ideas already selected by the Wali-OS AI Council. This is Phase 1 — you are ESTIMATING strikes, premiums, deltas, and breakevens. These numbers are not from a real options chain.

CANDIDATE UNDERLYINGS (from top-confidence stock ideas):
${candidatesDesc}

TRADER CONTEXT:
- Stage: ${stageName}
- Per-position budget: ~$${perPositionBudget.toFixed(2)}
- HARD CAP: max premium per contract = $${maxPremiumSh}/share (total contract cost ≤ $${maxContractCost.toFixed(2)})
- Market context: ${marketContext || 'mixed'}

INSTRUCTIONS:
1. Generate 1-3 option ideas. Each MUST be on one of the candidate underlyings listed above.
2. Choose option_type based on the stock signal: BULLISH → call, BEARISH → put.
3. HARD CAP: estimated_premium × 100 MUST be ≤ $${maxContractCost.toFixed(2)}. This is non-negotiable — any option exceeding this will be rejected.

   STRIKE SELECTION STRATEGY TO HIT THE CAP:
   - If the underlying is cheap (<$5), ATM options may fit the cap. Check: ATM premium on a $2 stock is typically $0.10-$0.25 for 30 DTE.
   - If the underlying is mid-price ($5-$30), you likely need slightly OTM strikes (5-15% OTM) with 20-45 DTE.
   - If the underlying is expensive (>$30), you'll need deeper OTM strikes (15-30% OTM) or short DTE (7-21 days) to fit a tight budget.
   - When in doubt, go FURTHER OTM rather than closer to ATM — deeper OTM = cheaper premium = fits the cap.
   - If you cannot find a valid strike for a ticker at this premium cap, SKIP that ticker. Better to return 1 valid option than 3 that get filtered out.

4. Estimate delta: calls are positive (0.15-0.80), puts negative (-0.15 to -0.80). ATM = ~0.50. Deep OTM = 0.15-0.30.
5. Calculate breakeven: calls = strike + premium, puts = strike - premium.
6. Calculate max_loss: premium × 100 × number_of_contracts (always 1 contract in this flow).

Return JSON ONLY — no markdown:
{
  "options": [
    {
      "underlying": "SNDL",
      "ticker": "SNDL",
      "optionType": "call",
      "positionType": "option",
      "strike": 2.0,
      "expiry": "2026-05-16",
      "dte": 26,
      "estimatedPremium": 0.15,
      "delta": 0.42,
      "breakeven": 2.15,
      "cost": 15.00,
      "maxLoss": 15.00,
      "signal": "BULLISH",
      "confidence": 68,
      "suggestedShares": 1,
      "catalyst": "Mirrors stock idea — leveraged play on the same thesis",
      "rationale": "One sentence on why options make sense here vs shares",
      "price": 1.84,
      "underlyingPrice": 1.84
    }
  ]
}

If none of the candidates fit the premium budget, return: { "options": [] }`

  try {
    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1500,
      system: 'You estimate option plays. All numeric fields are plain numbers — no $ signs, no commas.',
      messages: [{ role: 'user', content: prompt }],
    })

    const text = (msg.content[0] as { type: string; text: string }).text
    const clean = text.replace(/```json|```/g, '').trim()
    const parsed = JSON.parse(clean)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rawOptions: any[] = Array.isArray(parsed.options) ? parsed.options : []

    // Post-generation filter: enforce the premium cap and basic sanity
    const filtered = rawOptions.filter((o) => {
      if (!o || typeof o !== 'object') return false
      if (!o.underlying || !o.strike || !o.expiry) return false
      if (o.optionType !== 'call' && o.optionType !== 'put') return false
      const premium = Number(o.estimatedPremium)
      if (!Number.isFinite(premium) || premium <= 0) return false
      const contractCost = premium * 100
      if (contractCost > maxContractCost * 1.02) {
        // 2% tolerance for rounding
        console.warn(`[options] filtering out ${o.ticker}: cost $${contractCost.toFixed(2)} exceeds cap $${maxContractCost.toFixed(2)}`)
        return false
      }
      // Sanity: require underlying to be one of our candidates
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (!candidates.some((c: any) => c.ticker === o.underlying || c.ticker === o.ticker)) {
        console.warn(`[options] filtering out ${o.ticker}: not in candidate list`)
        return false
      }
      return true
    })

    // Diagnostic summary — helps identify when Claude's estimates miss the cap
    console.log(`[options] generated ${rawOptions.length} raw → ${filtered.length} after filter (cap $${maxContractCost.toFixed(2)}, candidates: ${candidates.map(c => c.ticker).join(',')})`)

    // Normalise numeric fields
    return filtered.map((o) => ({
      ...o,
      positionType: 'option' as const,
      strike: Number(o.strike),
      estimatedPremium: Number(o.estimatedPremium),
      delta: typeof o.delta === 'number' ? Number(o.delta) : null,
      breakeven: Number(o.breakeven ?? (o.optionType === 'call' ? o.strike + o.estimatedPremium : o.strike - o.estimatedPremium)),
      cost: Number(o.cost ?? Number(o.estimatedPremium) * 100),
      maxLoss: Number(o.maxLoss ?? Number(o.estimatedPremium) * 100),
      dte: Number(o.dte ?? 0),
      confidence: Math.round(Number(o.confidence ?? 60)),
      suggestedShares: 1,
      isEstimated: true,  // Flag for UI to display "estimated" badge
    })).slice(0, 3)

  } catch (err) {
    console.error('[options] generation failed:', (err as Error).message)
    return []
  }
}

// Calculate ideal price range based on deployable cash
// Target: each position should buy 10–50 shares (feels like a real holding)
// Per-position capital = deployable / max positions
// ideal price = per-position capital / target shares
function getPriceRange(deployable: number, maxPositions: number): { minPrice: number; maxPrice: number; targetShares: number } {
  const perPosition = deployable / Math.max(1, maxPositions)

  if (perPosition <= 5) {
    // Under $5/position — buy fractional or 1-3 shares of $1-3 stocks
    return { minPrice: 0.5, maxPrice: 5, targetShares: Math.max(1, Math.floor(perPosition)) }
  } else if (perPosition <= 20) {
    // $5-20/position — $1-8 stocks, 3-15 shares
    return { minPrice: 1, maxPrice: Math.min(8, perPosition * 0.7), targetShares: 5 }
  } else if (perPosition <= 100) {
    // $20-100/position — $3-25 stocks, 5-20 shares
    return { minPrice: 2, maxPrice: Math.min(25, perPosition * 0.6), targetShares: 10 }
  } else if (perPosition <= 500) {
    // $100-500/position — $5-60 stocks, 10-30 shares
    return { minPrice: 5, maxPrice: Math.min(60, perPosition * 0.5), targetShares: 15 }
  } else if (perPosition <= 2000) {
    // $500-2000/position — $10-150 stocks
    return { minPrice: 10, maxPrice: Math.min(150, perPosition * 0.4), targetShares: 20 }
  } else {
    // $2000+/position — any price, 20-50 shares
    return { minPrice: 20, maxPrice: Math.min(500, perPosition * 0.3), targetShares: 30 }
  }
}

// Small-cap stocks by sector — known to trade in lower price ranges
const SECTOR_SMALLCAPS: Record<string, string[]> = {
  'Technology':       ['SSYS', 'NAOV', 'CIFS', 'GPRO', 'VUZI', 'AEYE', 'IDEX', 'INPX', 'DLPN', 'GXII'],
  'Healthcare':       ['CLOV', 'OCGN', 'SNGX', 'MESO', 'NRXP', 'IPHA', 'ATOS', 'IMVT', 'VVOS', 'BFRI'],
  'Energy':           ['TELL', 'NEXT', 'GENIE', 'MNRL', 'AMMO', 'ZOM', 'SWN', 'RIG', 'CEQP', 'BORR'],
  'Financials':       ['NEGG', 'NRDS', 'CURO', 'ELAN', 'HMST', 'PFBC', 'GDOT', 'CARE', 'ASRV', 'BSVN'],
  'Consumer Disc.':   ['WKHS', 'GOEV', 'RIDE', 'SOLO', 'NKLA', 'MULN', 'IDEANOMICS', 'XPEV', 'XPOA', 'BLNK'],
  'Consumer Staples': ['FLGC', 'IIPR', 'CCHWF', 'CURLF', 'ACB', 'SNDL', 'TLRY', 'CGC', 'OGI', 'APHA'],
  'Industrials':      ['BLPG', 'SHIP', 'SINO', 'GATO', 'VERB', 'FRMO', 'ILUS', 'USDR', 'CTXR', 'ATXI'],
  'Materials':        ['GATO', 'HUSA', 'NXE', 'URG', 'DNN', 'UEC', 'FSM', 'AG', 'GPL', 'EXK'],
  'Real Estate':      ['SQFT', 'KREF', 'NREF', 'REFI', 'BRMK', 'BRSP', 'GPMT', 'TRTX', 'BXMT', 'ARI'],
  'Utilities':        ['GENIE', 'SPKE', 'AMRC', 'PEGI', 'NOVA', 'SHLS', 'FTCI', 'REGI', 'CLFD', 'ARRY'],
  'Comm. Services':   ['PHUN', 'ATUS', 'MINM', 'SOPA', 'GFAI', 'AEAC', 'CIDM', 'MFAC', 'LIQT', 'CODA'],
}

// Fetch current sector performance from macro data
async function fetchSectorPerformance(): Promise<Array<{ name: string; signal: string; change1D: number; etf: string }>> {
  try {
    const res = await fetch(`${process.env.NEXT_PUBLIC_APP_URL}/api/macro`, {
      cache: 'no-store',
      headers: { 'x-internal': '1' },
    })
    if (!res.ok) return []
    const data = await res.json()
    return (data.sectors ?? []).map((s: { name: string; signal: string; change1D: number; etf: string }) => ({
      name: s.name,
      signal: s.signal,
      change1D: s.change1D,
      etf: s.etf,
    }))
  } catch { return [] }
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const { totalValue, openTrades, startingBalance, cashRemaining } = await req.json()
  const stage = getStage(totalValue ?? 0)
  const deployable = cashRemaining ?? Math.max(0,
    (totalValue ?? 0) - (openTrades?.reduce((s: number, t: { entry_price: number; shares: number }) => s + t.entry_price * t.shares, 0) ?? 0)
  )

  // Dynamic price range based on how much they can actually deploy
  const priceRange = getPriceRange(deployable, stage.maxPositions)
  const minPrice = priceRange.minPrice
  const maxPrice = priceRange.maxPrice
  const targetShares = priceRange.targetShares

  // Pick candidate tickers from the right price tier
  const SMALL_CAP_BY_PRICE: Record<string, string[]> = {
    'under5':   ['SNDL','CLOV','MVIS','WKHS','GOEV','RIDE','NKLA','PHUN','BBIG','ILUS','AMC','CMAX','NRXP','OCGN','TELL'],
    'under15':  ['GPRO','LAZR','LIDR','BLNK','PLUG','FCEL','HYLN','SOLO','XPEV','NIO','GOTU','GRAB','ACHR','JOBY','ARCHER'],
    'under30':  ['F','BAC','T','ITUB','VALE','SWN','RIG','NOK','ERIC','GOLD','AG','FSM','MRO','APA','BORR'],
    'under75':  ['SNAP','LYFT','RIVN','LCID','SOFI','OPEN','UWMC','VUZI','NAOV','SPCE','PTRA','DKNG','PENN','MGAM','AGS'],
    'under200': ['UBER','HOOD','COIN','RBLX','PLTR','MARA','RIOT','HUT','BITF','CLSK','IREN','WULF','BTBT','CIFR','CORZ'],
    'any':      ['AMD','NVDA','META','GOOGL','MSFT','AAPL','AMZN','TSLA','JPM','GS'],
  }

  const priceTier = maxPrice <= 5 ? 'under5' : maxPrice <= 15 ? 'under15' : maxPrice <= 30 ? 'under30' : maxPrice <= 75 ? 'under75' : maxPrice <= 200 ? 'under200' : 'any'
  const priceTierTickers = SMALL_CAP_BY_PRICE[priceTier] ?? []

  // Fetch live sector performance
  const sectors = await fetchSectorPerformance()

  // Rank: BULLISH first, then by change1D descending
  const ranked = [...sectors].sort((a, b) => {
    const sigScore = (s: string) => s === 'BULLISH' ? 2 : s === 'NEUTRAL' ? 1 : 0
    if (sigScore(b.signal) !== sigScore(a.signal)) return sigScore(b.signal) - sigScore(a.signal)
    return b.change1D - a.change1D
  })

  // Take top 5 sectors (or all if fewer)
  const topSectors = ranked.slice(0, 5)
  const bullishSectors = topSectors.filter(s => s.signal === 'BULLISH')
  const allTopNames = topSectors.map(s => s.name)

  // Build sector context for the AI
  const sectorContext = topSectors.map(s =>
    `${s.name}: ${s.signal} (${s.change1D >= 0 ? '+' : ''}${s.change1D.toFixed(2)}% today)`
  ).join('\n')

  // Gather candidate tickers from top sectors
  const candidateTickers: string[] = []
  for (const sector of topSectors) {
    const tickers = SECTOR_SMALLCAPS[sector.name] ?? []
    candidateTickers.push(...tickers.slice(0, 4))
  }

  // ── Step 1: Get real volume movers in the price range ────────
  // These are actual stocks moving TODAY with real volume data
  const realMovers = await getVolumeMoversEnhanced(minPrice, maxPrice, 10)

  // Format movers for AI context
  const moversContext = realMovers.length > 0
    ? `TODAY'S REAL VOLUME MOVERS in the $${minPrice.toFixed(2)}–$${maxPrice.toFixed(2)} range (from Alpaca screener):\n` +
      realMovers.map(m =>
        `${m.ticker}: $${m.price.toFixed(2)}, ${m.changePercent >= 0 ? '+' : ''}${m.changePercent.toFixed(1)}% today, volume moving`
      ).join('\n')
    : `No screener data available — use your knowledge of current $${minPrice.toFixed(2)}–$${maxPrice.toFixed(2)} stocks`

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

  const msg = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 2000,
    system: `You are the Wali-OS AI Council's journey guide for investors at all levels. You recommend stage-appropriate stocks using live sector performance data.

CRITICAL PRICE RULE: Every stock you recommend MUST currently trade between $${minPrice.toFixed(2)} and $${maxPrice.toFixed(2)}. This range is calculated from the user's available capital so each position feels meaningful — around ${targetShares} shares per position. A $${maxPrice.toFixed(0)} stock with ${targetShares} shares = $${(maxPrice * targetShares).toFixed(0)} which is appropriate for their balance. Do NOT recommend stocks outside this range.

All numeric fields must be plain numbers — no $ signs, no commas.`,
    messages: [{
      role: 'user',
      content: `TRADER PROFILE:
Stage: ${stage.name} — total portfolio $${(totalValue ?? 0).toFixed(2)}, cash to deploy: $${deployable.toFixed(2)}
STOCK PRICE RANGE: $${minPrice.toFixed(2)}–$${maxPrice.toFixed(2)} (sized so they can buy ~${targetShares} shares per position)
Per-position budget: ~$${(deployable / stage.maxPositions).toFixed(2)}
Strategy: ${stage.strategy}
Stop range: ${stage.stopPct} | Target range: ${stage.targetPct}

${moversContext}

TODAY'S SECTOR PERFORMANCE:
${sectorContext || 'Sector data unavailable — use broad market context'}

STRONGEST SECTORS TODAY: ${allTopNames.slice(0, 3).join(', ')}
BULLISH SECTORS: ${bullishSectors.map(s => s.name).join(', ') || 'None — market is mixed/bearish'}

BACKUP CANDIDATE TICKERS (only use if real movers list is empty):
${candidateTickers.slice(0, 10).join(', ')}, ${priceTierTickers.slice(0, 8).join(', ')}

INSTRUCTION: Use the REAL VOLUME MOVERS above as your primary source — these are confirmed to be trading in range TODAY. For each, explain the technical setup and why the sector conditions support it. Only use backup candidates if the movers list is empty.

Generate EXACTLY 5 stock ideas. Each must:
1. Trade between $${minPrice.toFixed(2)} and $${maxPrice.toFixed(2)} — prefer stocks from the real movers list
2. Come from a top-performing sector where possible
3. Have a specific catalyst or technical reason RIGHT NOW
4. Suggest ~${targetShares} shares for ~$${(deployable / stage.maxPositions).toFixed(2)} per-position budget

Return JSON ONLY — no markdown, no backticks:
{
  "ideas": [
    {
      "ticker": "SNDL",
      "companyName": "Sundial Growers",
      "sector": "Consumer Staples",
      "sectorSignal": "BULLISH",
      "price": 1.84,
      "signal": "BULLISH",
      "confidence": 71,
      "catalyst": "One specific reason to buy this week",
      "rationale": "2 sentences — why this fits their $${(deployable / stage.maxPositions).toFixed(2)} per-position budget and sector momentum",
      "suggestedAmount": 3.68,
      "suggestedShares": ${targetShares},
      "entry": "$1.80–1.90",
      "stop": "$1.45",
      "stopPct": 21,
      "target": "$2.80",
      "targetPct": 52,
      "risk": "high",
      "timeframe": "1–3 weeks",
      "volumeNote": "volume 4.2× average"
    }
  ],
  "journeyNote": "One sentence referencing their ${stage.name} stage progress and today's market",
  "stageAdvice": "One practical tip for the ${stage.name} stage today",
  "marketContext": "One sentence on overall market conditions from the sector data"
}`
    }]
  })

  try {
    const text = (msg.content[0] as { type: string; text: string }).text
    const clean = text.replace(/```json|```/g, '').trim()
    const result = JSON.parse(clean)

    const finnhubKey = process.env.FINNHUB_API_KEY
    const validIdeas = []

    for (const idea of (result.ideas ?? [])) {
      if (!idea.ticker) continue

      // Fetch live price
      let livePrice: number | null = null
      if (finnhubKey) {
        try {
          const res = await fetch(`https://finnhub.io/api/v1/quote?symbol=${idea.ticker}&token=${finnhubKey}`, { cache: 'no-store' })
          if (res.ok) {
            const q = await res.json()
            if (q.c > 0) livePrice = q.c
          }
        } catch { /* ignore */ }
      }

      const displayPrice = livePrice ?? idea.price ?? 0

      // Hard reject if outside dynamic price range
      if (livePrice && (livePrice > maxPrice || livePrice < minPrice)) {
        continue
      }

      // Normalise numeric fields
      idea.suggestedAmount = typeof idea.suggestedAmount === 'string'
        ? parseFloat(String(idea.suggestedAmount).replace(/[^0-9.-]/g, '')) || 0
        : (idea.suggestedAmount ?? 0)
      idea.suggestedShares = typeof idea.suggestedShares === 'string'
        ? parseFloat(String(idea.suggestedShares)) || 1
        : (idea.suggestedShares ?? 1)
      idea.livePrice = livePrice
      idea.price = displayPrice

      // Recalculate based on live price
      if (livePrice && idea.suggestedShares > 0) {
        idea.suggestedAmount = parseFloat((livePrice * idea.suggestedShares).toFixed(2))
      }

      validIdeas.push(idea)
    }

    // ── Phase 1: Options generation ─────────────────────────
    // Only generate options when the account is at Operator+ tier ($200+).
    // Below that, tiers are still learning stock discipline.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let optionIdeas: any[] = []
    let optionsBudgetWarning: string | null = null

    const accountTotalValue = totalValue ?? 0
    if (accountTotalValue >= OPTIONS_MIN_VALUE && validIdeas.length > 0) {
      const optionBudget = getOptionBudget(deployable, stage.maxPositions)
      const perPositionBudget = deployable / Math.max(1, stage.maxPositions)

      optionIdeas = await generateOptionIdeas({
        anthropic,
        topStockIdeas: validIdeas,
        maxPremiumPerContract: optionBudget.maxPremiumPerContract,
        perPositionBudget,
        stageName: stage.name,
        marketContext: result.marketContext ?? '',
      })

      // Warn when account is small relative to options risk, even though we allow it
      if (accountTotalValue < 5000 && optionIdeas.length > 0) {
        optionsBudgetWarning = `Your account is under $5,000 — option premiums will be small and leverage is limited. Consider growing the account before committing real capital to options. All prices shown are estimates.`
      } else if (optionIdeas.length > 0) {
        optionsBudgetWarning = `Strike prices, premiums, deltas and breakevens shown are AI estimates — real market prices will differ. Verify on a real broker before trading.`
      }
    }

    return NextResponse.json({
      ideas: validIdeas,
      options: optionIdeas,
      optionsBudgetWarning,
      journeyNote: result.journeyNote ?? '',
      stageAdvice: result.stageAdvice ?? '',
      marketContext: result.marketContext ?? '',
      topSectors: topSectors.map(s => ({ name: s.name, signal: s.signal, change1D: s.change1D })),
      stage: stage.name,
      stageConfig: stage,
    })
  } catch (err) {
    console.error('Invest ideas error:', err)
    return NextResponse.json({ error: 'Failed to generate ideas' }, { status: 500 })
  }
}
