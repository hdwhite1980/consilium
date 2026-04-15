import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/app/lib/auth/server'
import Anthropic from '@anthropic-ai/sdk'

const STAGE_CONFIG = [
  { name: 'Spark',   min: 0,      max: 10,     priceRange: '$1–$5',   maxPositions: 2, stopPct: '20–30%', targetPct: '40–80%', strategy: 'momentum and volume spike plays' },
  { name: 'Ember',   min: 10,     max: 50,     priceRange: '$1–$8',   maxPositions: 2, stopPct: '18–25%', targetPct: '35–70%', strategy: 'momentum with early technical confirmation' },
  { name: 'Flame',   min: 50,     max: 200,    priceRange: '$1–$15',  maxPositions: 3, stopPct: '15–20%', targetPct: '30–60%', strategy: 'technical setups with catalyst awareness' },
  { name: 'Blaze',   min: 200,    max: 1000,   priceRange: '$2–$50',  maxPositions: 4, stopPct: '10–15%', targetPct: '20–40%', strategy: 'fundamentally-supported technical breakouts' },
  { name: 'Inferno', min: 1000,   max: 10000,  priceRange: '$5–$200', maxPositions: 5, stopPct: '8–12%',  targetPct: '15–30%', strategy: 'high-conviction full debate analysis' },
  { name: 'Free',    min: 10000,  max: Infinity, priceRange: 'any',   maxPositions: 10, stopPct: '5–10%', targetPct: '10–25%', strategy: 'diversified conviction-weighted portfolio' },
]

function getStage(totalValue: number) {
  return STAGE_CONFIG.find(s => totalValue >= s.min && totalValue < s.max) ?? STAGE_CONFIG[0]
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const { totalValue, openTrades, startingBalance } = await req.json()
  const stage = getStage(totalValue ?? 0)
  const deployable = Math.max(0, (totalValue ?? 0) - openTrades?.reduce((s: number, t: { entry_price: number; shares: number }) => s + t.entry_price * t.shares, 0))
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

  const msg = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1200,
    system: `You are the Consilium Investment Council's journey guide. You help people grow small amounts of money through disciplined trading. Be honest, specific, and stage-appropriate. Never recommend stocks above the stage's price range. All suggestedAmount values must be plain numbers.`,
    messages: [{
      role: 'user',
      content: `TRADER PROFILE:
Stage: ${stage.name} (${stage.min === 0 ? '$0' : '$' + stage.min}–$${stage.max === Infinity ? '∞' : stage.max})
Total portfolio value: $${(totalValue ?? 0).toFixed(2)}
Starting balance: $${(startingBalance ?? 0).toFixed(2)}
Available to deploy: $${deployable.toFixed(2)}
Open positions: ${openTrades?.length ?? 0}

STAGE RULES for ${stage.name}:
- Stock price range: ${stage.priceRange}
- Max simultaneous positions: ${stage.maxPositions}
- Suggested stop loss: ${stage.stopPct}
- Suggested target: ${stage.targetPct}
- Strategy focus: ${stage.strategy}

Generate 2 specific stock ideas appropriate for this stage. Each idea must:
1. Be priced within ${stage.priceRange}
2. Have a specific catalyst or technical reason RIGHT NOW (volume spike, earnings beat, oversold bounce, short squeeze setup)
3. Size the position to the available capital ($${deployable.toFixed(2)}) — suggest exact share count
4. Include wide stops appropriate for small-cap volatility

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
      "catalyst": "one sentence — the specific reason to buy RIGHT NOW",
      "rationale": "2 sentences connecting the setup to their journey stage",
      "suggestedAmount": 3.68,
      "suggestedShares": 2,
      "entry": "$1.80–1.90",
      "stop": "$1.45",
      "stopPct": 21,
      "target": "$2.80",
      "targetPct": 52,
      "risk": "high",
      "timeframe": "1–3 weeks",
      "volumeNote": "volume 4.2× average today"
    }
  ],
  "journeyNote": "One sentence of encouragement specific to their progress — e.g. 'You are $2.57 away from Ember status'",
  "stageAdvice": "One tactical tip specific to trading at the ${stage.name} stage"
}`
    }]
  })

  try {
    const text = (msg.content[0] as { type: string; text: string }).text
    const clean = text.replace(/```json|```/g, '').trim()
    const result = JSON.parse(clean)

    // Fetch live prices for suggested tickers
    const finnhubKey = process.env.FINNHUB_API_KEY
    for (const idea of result.ideas ?? []) {
      if (!idea.ticker || !finnhubKey) continue
      try {
        const res = await fetch(`https://finnhub.io/api/v1/quote?symbol=${idea.ticker}&token=${finnhubKey}`, { cache: 'no-store' })
        if (res.ok) {
          const q = await res.json()
          if (q.c > 0) idea.livePrice = q.c
        }
      } catch { /* ignore */ }
    }

    return NextResponse.json({ ...result, stage: stage.name, stageConfig: stage })
  } catch (err) {
    console.error('Invest ideas error:', err)
    return NextResponse.json({ error: 'Failed to generate ideas' }, { status: 500 })
  }
}
