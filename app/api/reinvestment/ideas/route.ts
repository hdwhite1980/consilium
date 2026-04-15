import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/app/lib/auth/server'
import { createClient as createAdmin } from '@supabase/supabase-js'
import Anthropic from '@anthropic-ai/sdk'

const getAdmin = () => createAdmin(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const SECTOR_PEERS: Record<string, string[]> = {
  NVDA: ['AMD','INTC','AVGO','QCOM','TSM'],
  AMD:  ['NVDA','INTC','QCOM','AVGO','MU'],
  AAPL: ['MSFT','GOOGL','META','AMZN','DELL'],
  MSFT: ['AAPL','GOOGL','AMZN','CRM','ORCL'],
  GOOGL:['MSFT','META','AMZN','SNAP','TTD'],
  META: ['GOOGL','SNAP','PINS','AMZN','TTD'],
  TSLA: ['RIVN','F','GM','NIO','LCID'],
  AMZN: ['MSFT','GOOGL','SHOP','WMT','TGT'],
  JPM:  ['BAC','GS','MS','WFC','C'],
  BAC:  ['JPM','WFC','C','GS','USB'],
  XOM:  ['CVX','COP','SLB','EOG','PXD'],
  CVX:  ['XOM','COP','EOG','SLB','MPC'],
  JNJ:  ['PFE','MRK','ABT','BMY','LLY'],
  PFE:  ['JNJ','MRK','BMY','ABBV','LLY'],
  DEFAULT: ['SPY','QQQ','IWM','GLD','TLT'],
}

function getPeers(ticker: string): string[] {
  return SECTOR_PEERS[ticker.toUpperCase()] ?? SECTOR_PEERS.DEFAULT
}

async function getLivePrice(ticker: string): Promise<number | null> {
  try {
    const key = process.env.FINNHUB_API_KEY
    if (!key) return null
    const res = await fetch(
      `https://finnhub.io/api/v1/quote?symbol=${ticker}&token=${key}`,
      { next: { revalidate: 300 } }
    )
    if (!res.ok) return null
    const data = await res.json()
    return data.c > 0 ? data.c : null
  } catch { return null }
}

async function getCachedSignal(ticker: string): Promise<{ signal: string; confidence: number; target: string; reasoning: string } | null> {
  try {
    const { data } = await getAdmin()
      .from('analyses')
      .select('result')
      .eq('ticker', ticker.toUpperCase())
      .order('created_at', { ascending: false })
      .limit(1)
      .single()

    if (!data?.result) return null
    const r = data.result as Record<string, unknown>
    const judge = (r.judge ?? r) as Record<string, unknown>
    return {
      signal: String(judge.signal ?? 'NEUTRAL'),
      confidence: Number(judge.confidence ?? 50),
      target: String(judge.target ?? 'N/A'),
      reasoning: String(judge.summary ?? ''),
    }
  } catch { return null }
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const { trades, availableCash } = await req.json()

  if (!trades?.length) {
    return NextResponse.json({ ideas: [], insights: [] })
  }

  // Build context about user's trades for the AI
  const openTrades = trades.filter((t: { exit_price: number | null }) => !t.exit_price)
  const closedTrades = trades.filter((t: { exit_price: number | null; entry_price: number; shares: number }) => t.exit_price)

  // Get live prices for open trades
  const priceMap: Record<string, number | null> = {}
  await Promise.all(openTrades.map(async (t: { ticker: string }) => {
    priceMap[t.ticker] = await getLivePrice(t.ticker)
  }))

  // Compute P&L
  const tradeSummaries = openTrades.map((t: { ticker: string; shares: number; entry_price: number; council_signal: string; confidence: number; persona: string }) => {
    const current = priceMap[t.ticker]
    const pnl = current ? (current - t.entry_price) * t.shares : null
    const pnlPct = current ? ((current - t.entry_price) / t.entry_price) * 100 : null
    return { ...t, currentPrice: current, pnl, pnlPct }
  })

  const realizedPnL = closedTrades.reduce((sum: number, t: { exit_price: number; entry_price: number; shares: number }) => {
    return sum + (t.exit_price - t.entry_price) * t.shares
  }, 0)

  // Find candidate reinvestment tickers from peers of profitable trades
  const profitableTickers = tradeSummaries
    .filter((t: { pnl: number | null }) => (t.pnl ?? 0) > 0)
    .map((t: { ticker: string }) => t.ticker)

  const candidateTickers = new Set<string>()
  for (const ticker of profitableTickers) {
    getPeers(ticker).forEach(p => {
      if (!openTrades.find((t: { ticker: string }) => t.ticker === p)) {
        candidateTickers.add(p)
      }
    })
  }
  // Also add adding-to-existing as candidates for BULLISH open trades
  for (const t of tradeSummaries) {
    if (t.council_signal === 'BULLISH' && (t.pnl ?? 0) > 0) {
      candidateTickers.add(t.ticker + ':ADD')
    }
  }

  // Get cached signals for candidates (limit to 6)
  const candidates = Array.from(candidateTickers).slice(0, 6)
  const candidateSignals: Record<string, ReturnType<typeof getCachedSignal> extends Promise<infer T> ? T : never> = {}
  await Promise.all(candidates.map(async c => {
    const ticker = c.replace(':ADD', '')
    candidateSignals[c] = await getCachedSignal(ticker)
  }))

  // Build AI prompt
  const tradeContext = tradeSummaries.map((t: { ticker: string; shares: number; entry_price: number; currentPrice: number | null; pnl: number | null; pnlPct: number | null; council_signal: string; confidence: number }) =>
    `${t.ticker}: ${t.shares} shares @ $${t.entry_price.toFixed(2)} entry` +
    (t.currentPrice ? ` | current $${t.currentPrice.toFixed(2)} | P&L ${t.pnl! >= 0 ? '+' : ''}$${t.pnl!.toFixed(0)} (${t.pnlPct!.toFixed(1)}%)` : ' | price unavailable') +
    ` | Council was ${t.council_signal} ${t.confidence}%`
  ).join('\n')

  const candidateContext = candidates.map(c => {
    const sig = candidateSignals[c]
    const isAdd = c.endsWith(':ADD')
    const ticker = c.replace(':ADD', '')
    if (!sig) return `${ticker}${isAdd ? ' (add to existing)' : ''}: no recent analysis`
    return `${ticker}${isAdd ? ' (add to existing)' : ''}: ${sig.signal} ${sig.confidence}% — ${sig.reasoning.slice(0, 120)}`
  }).join('\n')

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

  const msg = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1200,
    system: `You are the Reinvestment Council for a retail trader. Your job is to analyze their trade history and available cash, then recommend where to redeploy gains. Be specific, contextual, and honest about risk. Reference their actual trades by ticker. Allocate the available cash across 2-3 ideas with specific dollar amounts that sum to the available cash. Write for someone who trusts data over hype.`,
    messages: [{
      role: 'user',
      content: `TRADER'S OPEN TRADES:
${tradeContext}

REALIZED GAINS FROM CLOSED TRADES: $${realizedPnL.toFixed(0)}
AVAILABLE CASH TO REINVEST: $${(availableCash ?? 0).toFixed(0)}

CANDIDATE REINVESTMENT TICKERS (from sector peers + add-to-existing):
${candidateContext}

Based on the trader's history, gains, risk exposure, and the council signals above, generate:
1. 3 specific reinvestment ideas with rationale tied to their actual gains
2. 3-4 council insights about their overall trade performance and what to do next
3. Suggested allocation of available cash across the ideas

JSON ONLY:
{
  "ideas": [
    {
      "ticker": "AMD",
      "isAddToExisting": false,
      "signal": "BULLISH",
      "confidence": 72,
      "rationale": "2-3 sentences connecting this idea to their specific gains and why it makes sense given what they already hold",
      "suggestedAmount": 2170,
      "suggestedShares": "~14 shares",
      "risk": "medium",
      "timeframe": "2-4 weeks"
    }
  ],
  "insights": [
    {
      "type": "success|warning|info",
      "text": "Specific insight about their trades referencing actual tickers and numbers"
    }
  ],
  "allocation": [
    { "label": "AMD", "pct": 50, "amount": 2170, "color": "blue" },
    { "label": "MSFT add", "pct": 28, "amount": 1200, "color": "green" }
  ]
}`
    }]
  })

  try {
    const text = (msg.content[0] as { text: string }).text
    const clean = text.replace(/```json|```/g, '').trim()
    const result = JSON.parse(clean)

    // Enrich ideas with live prices
    for (const idea of result.ideas ?? []) {
      const ticker = idea.ticker.replace(':ADD', '')
      if (!priceMap[ticker]) {
        priceMap[ticker] = await getLivePrice(ticker)
      }
      idea.currentPrice = priceMap[ticker]
    }

    return NextResponse.json({
      ideas: result.ideas ?? [],
      insights: result.insights ?? [],
      allocation: result.allocation ?? [],
      tradeSummaries,
      realizedPnL,
    })
  } catch {
    return NextResponse.json({ error: 'Failed to parse AI response' }, { status: 500 })
  }
}
