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

    return NextResponse.json({
      ideas: validIdeas,
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
