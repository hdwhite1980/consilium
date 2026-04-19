import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/app/lib/auth/server'
import Anthropic from '@anthropic-ai/sdk'
import { getVolumeMoversEnhanced } from '@/app/lib/data/screener'

// ── Tier config — matches app/api/invest/route.ts exactly ───
const TIER_CONFIG = [
  { name: 'Buyer',     min: 1,     max: 50,       maxPositions: 2,  color: '#14b8a6',
    stopPct: '20–30%', targetPct: '40–80%',
    strategy: 'first-position practice — simple momentum or breakout entries, tight discipline on stops',
    optionsUnlocked: false },
  { name: 'Builder',   min: 50,    max: 200,      maxPositions: 3,  color: '#3b82f6',
    stopPct: '15–20%', targetPct: '30–60%',
    strategy: 'technical setups with catalyst awareness — building a real book',
    optionsUnlocked: false },
  { name: 'Operator',  min: 200,   max: 1000,     maxPositions: 4,  color: '#6366f1',
    stopPct: '12–18%', targetPct: '25–50%',
    strategy: 'full-debate analysis — running the book with intent; options unlocked with strict sizing',
    optionsUnlocked: true },
  { name: 'Principal', min: 1000,  max: 10000,    maxPositions: 5,  color: '#d4a857',
    stopPct: '8–12%',  targetPct: '15–30%',
    strategy: 'high-conviction plays with real weight — decision quality matters',
    optionsUnlocked: true },
  { name: 'Sovereign', min: 10000, max: Infinity, maxPositions: 10, color: '#f5f5f5',
    stopPct: '5–10%',  targetPct: '10–25%',
    strategy: 'diversified conviction-weighted — any instrument, complete capital authority',
    optionsUnlocked: true },
]

function getTier(totalValue: number) {
  return TIER_CONFIG.find(t => totalValue >= t.min && totalValue < t.max) ?? TIER_CONFIG[0]
}

// ── Stock price range logic (unchanged from prior implementation) ───
function getPriceRange(deployable: number, maxPositions: number): { minPrice: number; maxPrice: number; targetShares: number } {
  const perPosition = deployable / Math.max(1, maxPositions)

  if (perPosition <= 5) {
    return { minPrice: 0.5, maxPrice: 5, targetShares: Math.max(1, Math.floor(perPosition)) }
  } else if (perPosition <= 20) {
    return { minPrice: 1, maxPrice: Math.min(8, perPosition * 0.7), targetShares: 5 }
  } else if (perPosition <= 100) {
    return { minPrice: 2, maxPrice: Math.min(25, perPosition * 0.6), targetShares: 10 }
  } else if (perPosition <= 500) {
    return { minPrice: 5, maxPrice: Math.min(60, perPosition * 0.5), targetShares: 15 }
  } else if (perPosition <= 2000) {
    return { minPrice: 10, maxPrice: Math.min(150, perPosition * 0.4), targetShares: 20 }
  } else {
    return { minPrice: 20, maxPrice: Math.min(500, perPosition * 0.3), targetShares: 30 }
  }
}

// Small-cap catalogs for backup candidate pool (when live movers empty)
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

// Liquid large-cap names with reliable options chains for Operator+ option ideas.
// These are used as the candidate pool when generating option setups.
const OPTIONS_LIQUID_UNIVERSE = [
  'AAPL', 'MSFT', 'NVDA', 'GOOGL', 'AMZN', 'META', 'TSLA', 'AMD',
  'NFLX', 'CRM', 'ADBE', 'AVGO', 'INTC', 'QCOM', 'MU', 'PLTR',
  'SPY', 'QQQ', 'IWM', 'DIA',
  'XLK', 'XLE', 'XLF', 'XLV', 'XLI', 'XLY', 'XLU', 'XLRE', 'XLP',
  'JPM', 'BAC', 'WFC', 'GS', 'C',
  'BA', 'CAT', 'GE', 'F', 'GM',
  'WMT', 'COST', 'HD', 'LOW', 'TGT',
  'PFE', 'JNJ', 'UNH', 'LLY', 'MRK',
  'XOM', 'CVX', 'COP',
  'DIS', 'UBER', 'ABNB', 'HOOD', 'COIN', 'SHOP',
]

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

// Shared: live Finnhub price lookup
async function fetchLivePrice(ticker: string): Promise<number | null> {
  const key = process.env.FINNHUB_API_KEY
  if (!key) return null
  try {
    const res = await fetch(
      `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(ticker)}&token=${key}`,
      { cache: 'no-store' }
    )
    if (!res.ok) return null
    const q = await res.json()
    return (q.c && q.c > 0) ? Number(q.c) : null
  } catch { return null }
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const { totalValue, openTrades, cashRemaining } = await req.json()
  const tier = getTier(totalValue ?? 0)
  const deployable = cashRemaining ?? Math.max(0,
    (totalValue ?? 0) - (openTrades?.reduce((s: number, t: { entry_price: number; shares: number }) => s + t.entry_price * t.shares, 0) ?? 0)
  )

  const priceRange = getPriceRange(deployable, tier.maxPositions)
  const { minPrice, maxPrice, targetShares } = priceRange

  const priceTierTickers = (() => {
    const POOL: Record<string, string[]> = {
      'under5':   ['SNDL','CLOV','MVIS','WKHS','GOEV','RIDE','NKLA','PHUN','BBIG','ILUS','AMC','CMAX','NRXP','OCGN','TELL'],
      'under15':  ['GPRO','LAZR','LIDR','BLNK','PLUG','FCEL','HYLN','SOLO','XPEV','NIO','GOTU','GRAB','ACHR','JOBY'],
      'under30':  ['F','BAC','T','ITUB','VALE','SWN','RIG','NOK','ERIC','GOLD','AG','FSM','MRO','APA','BORR'],
      'under75':  ['SNAP','LYFT','RIVN','LCID','SOFI','OPEN','UWMC','VUZI','NAOV','SPCE','PTRA','DKNG','PENN','MGAM','AGS'],
      'under200': ['UBER','HOOD','COIN','RBLX','PLTR','MARA','RIOT','HUT','BITF','CLSK','IREN','WULF','BTBT','CIFR','CORZ'],
      'any':      ['AMD','NVDA','META','GOOGL','MSFT','AAPL','AMZN','TSLA','JPM','GS'],
    }
    const key = maxPrice <= 5 ? 'under5' : maxPrice <= 15 ? 'under15' : maxPrice <= 30 ? 'under30' : maxPrice <= 75 ? 'under75' : maxPrice <= 200 ? 'under200' : 'any'
    return POOL[key] ?? []
  })()

  // Sector performance
  const sectors = await fetchSectorPerformance()
  const ranked = [...sectors].sort((a, b) => {
    const sigScore = (s: string) => s === 'BULLISH' ? 2 : s === 'NEUTRAL' ? 1 : 0
    if (sigScore(b.signal) !== sigScore(a.signal)) return sigScore(b.signal) - sigScore(a.signal)
    return b.change1D - a.change1D
  })
  const topSectors = ranked.slice(0, 5)
  const bullishSectors = topSectors.filter(s => s.signal === 'BULLISH')
  const bearishSectors = ranked.filter(s => s.signal === 'BEARISH').slice(0, 3)

  const sectorContext = topSectors.map(s =>
    `${s.name}: ${s.signal} (${s.change1D >= 0 ? '+' : ''}${s.change1D.toFixed(2)}% today)`
  ).join('\n')

  // Candidate ticker pool
  const candidateTickers: string[] = []
  for (const sector of topSectors) {
    const tickers = SECTOR_SMALLCAPS[sector.name] ?? []
    candidateTickers.push(...tickers.slice(0, 4))
  }

  // Real volume movers from screener
  const realMovers = await getVolumeMoversEnhanced(minPrice, maxPrice, 10)
  const moversContext = realMovers.length > 0
    ? `TODAY'S REAL VOLUME MOVERS in the $${minPrice.toFixed(2)}–$${maxPrice.toFixed(2)} range:\n` +
      realMovers.map(m =>
        `${m.ticker}: $${m.price.toFixed(2)}, ${m.changePercent >= 0 ? '+' : ''}${m.changePercent.toFixed(1)}% today`
      ).join('\n')
    : `No screener data available — use knowledge of current $${minPrice.toFixed(2)}–$${maxPrice.toFixed(2)} stocks`

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

  // ── STOCK IDEAS (always generated) ──────────────────────────
  const stockPrompt = `You are the Wali-OS Council — a journey guide for investors at all tiers. Recommend tier-appropriate stocks based on live sector data.

CRITICAL PRICE RULE: Every stock you recommend MUST currently trade between $${minPrice.toFixed(2)} and $${maxPrice.toFixed(2)}. This is calculated from the user's capital so each position is ~${targetShares} shares and feels meaningful. Do NOT recommend stocks outside this range.

TRADER PROFILE:
Tier: ${tier.name} — total portfolio $${(totalValue ?? 0).toFixed(2)}, cash to deploy: $${deployable.toFixed(2)}
Price range: $${minPrice.toFixed(2)}–$${maxPrice.toFixed(2)} (target ~${targetShares} shares/position)
Per-position budget: ~$${(deployable / tier.maxPositions).toFixed(2)}
Strategy: ${tier.strategy}
Stop range: ${tier.stopPct} | Target range: ${tier.targetPct}

${moversContext}

TODAY'S SECTORS:
${sectorContext || 'Sector data unavailable — use broad market context'}

STRONGEST BULLISH: ${bullishSectors.map(s => s.name).join(', ') || 'None — market is mixed/bearish'}

BACKUP CANDIDATE TICKERS:
${candidateTickers.slice(0, 10).join(', ')}, ${priceTierTickers.slice(0, 8).join(', ')}

Generate EXACTLY 5 stock ideas. Each must:
1. Trade between $${minPrice.toFixed(2)} and $${maxPrice.toFixed(2)} — prefer real movers
2. Come from a top-performing sector
3. Have a specific catalyst RIGHT NOW
4. Suggest ~${targetShares} shares for ~$${(deployable / tier.maxPositions).toFixed(2)} per-position

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
      "rationale": "2 sentences on why this fits the ${tier.name}-tier per-position budget and sector momentum",
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
  "journeyNote": "One sentence referencing their ${tier.name} tier progress and today's market",
  "stageAdvice": "One practical tip for the ${tier.name} tier today",
  "marketContext": "One sentence on overall market conditions"
}`

  let stockIdeas: Array<Record<string, unknown>> = []
  let stockJourneyNote = ''
  let stockAdvice = ''
  let marketContext = ''

  try {
    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      system: `You are the Wali-OS Council — recommend only stocks currently trading in the specified price band. All numeric fields are plain numbers (no $, no commas).`,
      messages: [{ role: 'user', content: stockPrompt }],
    })

    const text = (msg.content[0] as { type: string; text: string }).text
    const clean = text.replace(/```json|```/g, '').trim()
    const result = JSON.parse(clean)

    // Validate + enrich with live prices
    for (const idea of (result.ideas ?? [])) {
      if (!idea.ticker) continue
      const livePrice = await fetchLivePrice(idea.ticker)
      const displayPrice = livePrice ?? idea.price ?? 0
      if (livePrice && (livePrice > maxPrice || livePrice < minPrice)) continue

      idea.suggestedAmount = typeof idea.suggestedAmount === 'string'
        ? parseFloat(String(idea.suggestedAmount).replace(/[^0-9.-]/g, '')) || 0
        : (idea.suggestedAmount ?? 0)
      idea.suggestedShares = typeof idea.suggestedShares === 'string'
        ? parseFloat(String(idea.suggestedShares)) || 1
        : (idea.suggestedShares ?? 1)
      idea.livePrice = livePrice
      idea.price = displayPrice
      idea.positionType = 'stock'

      if (livePrice && idea.suggestedShares > 0) {
        idea.suggestedAmount = parseFloat((livePrice * idea.suggestedShares).toFixed(2))
      }
      stockIdeas.push(idea)
    }
    stockJourneyNote = result.journeyNote ?? ''
    stockAdvice = result.stageAdvice ?? ''
    marketContext = result.marketContext ?? ''
  } catch (err) {
    console.error('[ideas] stock generation failed:', err)
  }

  // ── OPTIONS IDEAS (Operator+ only) ──────────────────────────
  let optionIdeas: Array<Record<string, unknown>> = []

  if (tier.optionsUnlocked) {
    // Per-contract budget = 2% of account (beginner-safe at Operator).
    // Contracts are 100 shares × premium, so max premium/share = budget / 100.
    const optionsBudget = Math.max(5, Math.floor((totalValue ?? 0) * 0.02))
    const maxPremiumPerShare = optionsBudget / 100

    // Pick underlying from liquid universe that aligns with a strong sector.
    // For simplicity we pass the whole liquid universe and let the model match sectors.
    const liquidPool = OPTIONS_LIQUID_UNIVERSE.slice(0, 30).join(', ')

    const optionsPrompt = `You are the Wali-OS options desk. Recommend 2 option setups ONLY — long calls or long puts, no spreads, no selling options.

TRADER PROFILE:
Tier: ${tier.name} — total portfolio $${(totalValue ?? 0).toFixed(2)}
Options budget: $${optionsBudget} per contract MAX (2% of account at Operator safety level)
This means MAXIMUM premium/share = $${maxPremiumPerShare.toFixed(2)} (since 1 contract = 100 shares × premium)

CRITICAL RULES:
1. Only long calls or long puts (no spreads, no complex structures)
2. Expiration: 30–45 DTE (no weeklies, no 0DTE)
3. Strike: pick moneyness that yields premium ≤ $${maxPremiumPerShare.toFixed(2)}/share so total cost fits budget
4. Avoid earnings within expiry window (IV crush risk)
5. Only liquid underlyings

LIQUID UNDERLYINGS TO CHOOSE FROM:
${liquidPool}

TODAY'S SECTORS (match option directionally to sector signal):
${sectorContext}

BULLISH SECTORS → look for CALL setups on names in these sectors
BEARISH SECTORS (${bearishSectors.map(s => s.name).join(', ') || 'none'}) → look for PUT setups on names in these sectors

Generate EXACTLY 2 option ideas. One CALL and one PUT if both sector directions present, otherwise 2 of the dominant direction.

Return JSON ONLY — no markdown:
{
  "options": [
    {
      "underlying": "AAPL",
      "companyName": "Apple Inc",
      "sector": "Technology",
      "sectorSignal": "BULLISH",
      "underlyingPrice": 178.50,
      "optionType": "call",
      "strike": 180,
      "expiry": "2026-05-22",
      "dte": 31,
      "estimatedPremium": 3.25,
      "delta": 0.48,
      "cost": 325,
      "breakeven": 183.25,
      "maxLoss": 325,
      "signal": "BULLISH",
      "confidence": 68,
      "catalyst": "Earnings beat yesterday, sector rotating into tech",
      "rationale": "2 sentences — why this strike/expiry for ${tier.name} tier; how the sector supports direction",
      "risk": "medium",
      "timeframe": "close by 10 DTE or at 50% profit"
    }
  ]
}`

    try {
      const msg = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1500,
        system: `You are a conservative options educator for a retail platform. You only recommend long calls and long puts, never complex structures. All numeric fields are plain numbers. Expiry dates use YYYY-MM-DD format. Cost = estimatedPremium × 100.`,
        messages: [{ role: 'user', content: optionsPrompt }],
      })

      const text = (msg.content[0] as { type: string; text: string }).text
      const clean = text.replace(/```json|```/g, '').trim()
      const result = JSON.parse(clean)

      for (const opt of (result.options ?? [])) {
        if (!opt.underlying || !opt.strike || !opt.expiry) continue

        // Validate budget
        const estCost = (opt.estimatedPremium ?? 0) * 100
        if (estCost > optionsBudget * 1.25) continue // allow 25% slippage buffer

        // Enrich with current underlying price
        const livePrice = await fetchLivePrice(opt.underlying)
        if (livePrice) opt.underlyingPrice = livePrice

        opt.positionType = 'option'
        opt.cost = estCost
        // Normalize for display in signals grid
        opt.ticker = opt.underlying
        opt.price = opt.underlyingPrice
        opt.suggestedShares = 1  // 1 contract
        opt.suggestedAmount = estCost

        optionIdeas.push(opt)
      }
    } catch (err) {
      console.error('[ideas] options generation failed:', err)
    }
  }

  return NextResponse.json({
    ideas: stockIdeas,
    options: optionIdeas,
    journeyNote: stockJourneyNote,
    stageAdvice: stockAdvice,
    marketContext,
    topSectors: topSectors.map(s => ({ name: s.name, signal: s.signal, change1D: s.change1D })),
    tier: tier.name,
    tierConfig: {
      name: tier.name,
      maxPositions: tier.maxPositions,
      stopPct: tier.stopPct,
      targetPct: tier.targetPct,
      strategy: tier.strategy,
      optionsUnlocked: tier.optionsUnlocked,
    },
  })
}
