import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/app/lib/auth/server'
import Anthropic from '@anthropic-ai/sdk'

const STAGE_CONFIG = [
  { name: 'Spark',   min: 0,      max: 10,     maxPrice: 5,   minPrice: 1,  maxPositions: 2, stopPct: '20–30%', targetPct: '40–80%', strategy: 'momentum and volume spike plays on small-cap stocks' },
  { name: 'Ember',   min: 10,     max: 50,     maxPrice: 8,   minPrice: 1,  maxPositions: 2, stopPct: '18–25%', targetPct: '35–70%', strategy: 'momentum with early technical confirmation' },
  { name: 'Flame',   min: 50,     max: 200,    maxPrice: 15,  minPrice: 1,  maxPositions: 3, stopPct: '15–20%', targetPct: '30–60%', strategy: 'technical setups with catalyst awareness' },
  { name: 'Blaze',   min: 200,    max: 1000,   maxPrice: 50,  minPrice: 2,  maxPositions: 4, stopPct: '10–15%', targetPct: '20–40%', strategy: 'fundamentally-supported technical breakouts' },
  { name: 'Inferno', min: 1000,   max: 10000,  maxPrice: 200, minPrice: 5,  maxPositions: 5, stopPct: '8–12%',  targetPct: '15–30%', strategy: 'high-conviction full debate analysis' },
  { name: 'Free',    min: 10000,  max: Infinity, maxPrice: 99999, minPrice: 1, maxPositions: 10, stopPct: '5–10%', targetPct: '10–25%', strategy: 'diversified conviction-weighted portfolio' },
]

function getStage(totalValue: number) {
  return STAGE_CONFIG.find(s => totalValue >= s.min && totalValue < s.max) ?? STAGE_CONFIG[0]
}

// Well-known $1–5 stocks by stage for grounding the AI
const STAGE_EXAMPLES: Record<string, string> = {
  Spark: 'Examples of stocks currently in the $1–$5 range: SNDL, CLOV, MVIS, WKHS, NKLA, RIDE, GOEV, ILUS, BBIG, PHUN. Only use real tickers you are confident trade in this price range.',
  Ember: 'Examples of stocks in the $1–$8 range: SNDL, CLOV, MVIS, WKHS, NKLA, RIDE, GOEV, BBIG, PHUN, ILUS. Only use real tickers you are confident trade in this price range.',
  Flame: 'Examples of stocks in the $1–$15 range: AMC, BBBY, CLOV, SNDL, WKHS, NKLA, LAZR, LIDR, VERB, NCTY. Only use real tickers you are confident trade in this price range.',
  Blaze: 'Focus on small-cap stocks under $50. Examples: F, BAC, T, PLUG, FCEL, ITUB, NIO, VALE, GRAB, GOTU.',
  Inferno: 'Focus on stocks under $200. Use any ticker you have high conviction on.',
  Free: 'Use any stock.',
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const { totalValue, openTrades, startingBalance, cashRemaining } = await req.json()
  const stage = getStage(totalValue ?? 0)
  const deployable = cashRemaining ?? Math.max(0, (totalValue ?? 0) - (openTrades?.reduce((s: number, t: { entry_price: number; shares: number }) => s + t.entry_price * t.shares, 0) ?? 0))

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

  const msg = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1400,
    system: `You are the Consilium Investment Council's journey guide. You help people grow small amounts of money into larger amounts through disciplined, stage-appropriate trading.

CRITICAL RULE: You MUST only recommend stocks that currently trade between $${stage.minPrice} and $${stage.maxPrice}. This is a HARD limit. Do not recommend any stock trading above $${stage.maxPrice} under ANY circumstances. If you are not certain a stock currently trades within this range, do not recommend it.

${STAGE_EXAMPLES[stage.name] ?? ''}

All suggestedAmount and suggestedShares values must be plain numbers.`,
    messages: [{
      role: 'user',
      content: `TRADER PROFILE:
Stage: ${stage.name}
Total portfolio value: $${(totalValue ?? 0).toFixed(2)}
Starting balance: $${(startingBalance ?? 0).toFixed(2)}
Cash available to deploy right now: $${deployable.toFixed(2)}
Open positions: ${openTrades?.length ?? 0}

HARD CONSTRAINTS — violating these makes the response useless:
- Stock price MUST be between $${stage.minPrice} and $${stage.maxPrice}
- Suggested shares must cost no more than the available cash ($${deployable.toFixed(2)})
- If available cash is less than $${stage.minPrice}, suggest fractional shares or the smallest possible position

STAGE RULES:
- Stop loss range: ${stage.stopPct} (wide stops are correct for this price range)
- Target range: ${stage.targetPct}
- Strategy: ${stage.strategy}
- Max positions: ${stage.maxPositions}

Generate exactly 2 stock ideas. Each must have a specific catalyst happening RIGHT NOW — not general bull thesis.

Return JSON ONLY — no markdown, no backticks:
{
  "ideas": [
    {
      "ticker": "SNDL",
      "companyName": "Sundial Growers",
      "price": 1.84,
      "sector": "Cannabis",
      "signal": "BULLISH",
      "confidence": 71,
      "catalyst": "One sentence — the specific reason to buy this week (volume spike, earnings catalyst, technical breakout, short squeeze setup)",
      "rationale": "2 sentences — why this fits the ${stage.name} stage strategy and their $${deployable.toFixed(2)} available capital",
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
  "journeyNote": "One sentence of encouragement referencing their exact progress — e.g. how far they are from the next milestone",
  "stageAdvice": "One practical tip specific to the ${stage.name} stage"
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

      // Fetch live price and validate against stage price cap
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

      // Hard reject: if live price exceeds the stage max, skip this idea
      if (livePrice && livePrice > stage.maxPrice) {
        console.log(`Rejected ${idea.ticker}: live price $${livePrice} exceeds stage max $${stage.maxPrice}`)
        continue
      }

      // Ensure numeric fields
      idea.suggestedAmount = typeof idea.suggestedAmount === 'string'
        ? parseFloat(idea.suggestedAmount.replace(/[^0-9.-]/g, '')) || 0
        : (idea.suggestedAmount ?? 0)
      idea.suggestedShares = typeof idea.suggestedShares === 'string'
        ? parseFloat(idea.suggestedShares) || 1
        : (idea.suggestedShares ?? 1)
      idea.livePrice = livePrice
      idea.price = displayPrice

      // Recalculate suggested amount using live price
      if (livePrice && idea.suggestedShares > 0) {
        idea.suggestedAmount = parseFloat((livePrice * idea.suggestedShares).toFixed(2))
      }

      validIdeas.push(idea)
    }

    // If all ideas were rejected, return a helpful message
    if (validIdeas.length === 0) {
      return NextResponse.json({
        ideas: [],
        journeyNote: `The council couldn't find verified $${stage.minPrice}–$${stage.maxPrice} picks right now. Try running a manual analysis on a specific ticker.`,
        stageAdvice: result.stageAdvice ?? '',
        stage: stage.name,
        stageConfig: stage,
      })
    }

    return NextResponse.json({
      ideas: validIdeas,
      journeyNote: result.journeyNote ?? '',
      stageAdvice: result.stageAdvice ?? '',
      stage: stage.name,
      stageConfig: stage,
    })
  } catch (err) {
    console.error('Invest ideas error:', err)
    return NextResponse.json({ error: 'Failed to generate ideas' }, { status: 500 })
  }
}
