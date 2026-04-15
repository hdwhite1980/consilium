import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/app/lib/auth/server'
import Anthropic from '@anthropic-ai/sdk'

const STAGE_CONFIG = [
  { name: 'Spark',   min: 0,      max: 10,     maxPrice: 5,   minPrice: 1,  maxPositions: 2, stopPct: '20–30%', targetPct: '40–80%', strategy: 'momentum and volume spike plays' },
  { name: 'Ember',   min: 10,     max: 50,     maxPrice: 8,   minPrice: 1,  maxPositions: 2, stopPct: '18–25%', targetPct: '35–70%', strategy: 'momentum with early technical confirmation' },
  { name: 'Flame',   min: 50,     max: 200,    maxPrice: 15,  minPrice: 1,  maxPositions: 3, stopPct: '15–20%', targetPct: '30–60%', strategy: 'technical setups with catalyst awareness' },
  { name: 'Blaze',   min: 200,    max: 1000,   maxPrice: 50,  minPrice: 2,  maxPositions: 4, stopPct: '10–15%', targetPct: '20–40%', strategy: 'fundamentally-supported technical breakouts' },
  { name: 'Inferno', min: 1000,   max: 10000,  maxPrice: 200, minPrice: 5,  maxPositions: 5, stopPct: '8–12%',  targetPct: '15–30%', strategy: 'high-conviction full debate analysis' },
  { name: 'Free',    min: 10000,  max: Infinity, maxPrice: 99999, minPrice: 1, maxPositions: 10, stopPct: '5–10%', targetPct: '10–25%', strategy: 'diversified conviction-weighted portfolio' },
]

function getStage(totalValue: number) {
  return STAGE_CONFIG.find(s => totalValue >= s.min && totalValue < s.max) ?? STAGE_CONFIG[0]
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

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

  const msg = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 2000,
    system: `You are the Consilium Investment Council's journey guide for small investors. You recommend stage-appropriate stocks using live sector performance data.

CRITICAL PRICE RULE: Every stock you recommend MUST currently trade between $${stage.minPrice} and $${stage.maxPrice}. This is absolute. Do not recommend any stock trading outside this range.

All numeric fields (price, suggestedAmount, suggestedShares, stopPct, targetPct, confidence) must be plain numbers.`,
    messages: [{
      role: 'user',
      content: `TRADER PROFILE:
Stage: ${stage.name} — portfolio value $${(totalValue ?? 0).toFixed(2)}, cash to deploy: $${deployable.toFixed(2)}
Stock price range: $${stage.minPrice}–$${stage.maxPrice} ONLY
Strategy: ${stage.strategy}
Stop range: ${stage.stopPct} | Target range: ${stage.targetPct}

TODAY'S SECTOR PERFORMANCE (use this to select sectors):
${sectorContext || 'Sector data unavailable — use broad market context'}

STRONGEST SECTORS TODAY: ${allTopNames.slice(0, 3).join(', ')}
BULLISH SECTORS: ${bullishSectors.map(s => s.name).join(', ') || 'None — market is mixed/bearish'}

CANDIDATE TICKERS IN TOP SECTORS (verify these are in the $${stage.minPrice}–$${stage.maxPrice} range):
${candidateTickers.join(', ')}

Generate EXACTLY 5 stock ideas — one per top sector where possible. Each must:
1. Trade between $${stage.minPrice} and $${stage.maxPrice}
2. Come from one of today's top-performing sectors
3. Have a specific catalyst RIGHT NOW
4. Be sized to the $${deployable.toFixed(2)} available capital

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
      "rationale": "2 sentences — why this fits the stage and sector momentum",
      "suggestedAmount": 3.68,
      "suggestedShares": 2,
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
  "journeyNote": "One sentence referencing their progress and the market context today",
  "stageAdvice": "One practical tip for trading at the ${stage.name} stage today",
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

      // Hard reject if outside price range
      if (livePrice && (livePrice > stage.maxPrice || livePrice < stage.minPrice)) {
        console.log(`Rejected ${idea.ticker}: $${livePrice} outside $${stage.minPrice}–$${stage.maxPrice}`)
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
