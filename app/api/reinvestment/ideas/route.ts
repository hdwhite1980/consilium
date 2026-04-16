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

interface CachedSignal {
  signal: string
  confidence: number
  target: string
  reasoning: string
}

async function getCachedSignal(ticker: string): Promise<CachedSignal | null> {
  try {
    const { data } = await getAdmin()
      .from('analyses')
      .select('result')
      .eq('ticker', ticker.toUpperCase())
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (!data?.result) return null
    const r = data.result as Record<string, unknown>
    const judge = (r.judge ?? r) as Record<string, unknown>
    return {
      signal: String(judge.signal ?? 'NEUTRAL'),
      confidence: Number(judge.confidence ?? 50),
      target: String(judge.target ?? 'N/A'),
      reasoning: String(judge.summary ?? '').slice(0, 150),
    }
  } catch { return null }
}

interface TradeInput {
  ticker: string
  shares: number
  entry_price: number
  exit_price: number | null
  council_signal: string | null
  confidence: number | null
}

interface TradeSummary extends TradeInput {
  currentPrice: number | null
  pnl: number | null
  pnlPct: number | null
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const { trades, availableCash, unrealizedTotal } = await req.json()

  if (!trades?.length) {
    return NextResponse.json({ ideas: [], insights: [], allocation: [], realizedPnL: 0 })
  }

  const openTrades: TradeInput[] = trades.filter((t: TradeInput) => !t.exit_price)
  const closedTrades: TradeInput[] = trades.filter((t: TradeInput) => !!t.exit_price)

  // Get live prices for open trades (skip if summaries already have currentPrice from client)
  const priceMap: Record<string, number | null> = {}
  await Promise.all(openTrades.map(async t => {
    priceMap[t.ticker] = await getLivePrice(t.ticker)
  }))

  // Compute P&L summaries
  const tradeSummaries: TradeSummary[] = openTrades.map(t => {
    const current = priceMap[t.ticker] ?? null
    const pnl = current != null ? (current - t.entry_price) * t.shares : null
    const pnlPct = current != null ? ((current - t.entry_price) / t.entry_price) * 100 : null
    return { ...t, currentPrice: current, pnl, pnlPct }
  })

  const realizedPnL = closedTrades.reduce((sum, t) => {
    const exitP = (t.exit_price ?? t.entry_price)
    return sum + (exitP - t.entry_price) * t.shares
  }, 0)

  // Find candidate reinvestment tickers from peers of profitable trades
  const profitableTickers = tradeSummaries
    .filter(t => (t.pnl ?? 0) > 0)
    .map(t => t.ticker)

  const candidateTickers = new Set<string>()
  for (const ticker of profitableTickers) {
    getPeers(ticker).forEach(p => {
      if (!openTrades.find(t => t.ticker === p)) {
        candidateTickers.add(p)
      }
    })
  }
  // Also suggest adding to existing BULLISH positions that are profitable
  for (const t of tradeSummaries) {
    if (t.council_signal === 'BULLISH' && (t.pnl ?? 0) > 0) {
      candidateTickers.add(t.ticker + ':ADD')
    }
  }

  // Get cached signals for candidate tickers (limit to 6 to control latency)
  const candidates = Array.from(candidateTickers).slice(0, 6)
  const candidateSignals: Record<string, CachedSignal | null> = {}
  await Promise.all(candidates.map(async c => {
    const ticker = c.replace(':ADD', '')
    candidateSignals[c] = await getCachedSignal(ticker)
  }))

  // Build context strings for the AI
  const sf2 = (n: number | null, d = 2) => n != null ? n.toFixed(d) : 'N/A'

  const tradeContext = tradeSummaries.map(t =>
    `${t.ticker}: ${t.shares} shares @ $${sf2(t.entry_price)} entry` +
    (t.currentPrice != null
      ? ` | current $${sf2(t.currentPrice)} | P&L ${(t.pnl ?? 0) >= 0 ? '+' : ''}$${sf2(t.pnl, 0)} (${sf2(t.pnlPct, 1)}%)`
      : ' | price unavailable') +
    ` | Council was ${t.council_signal ?? 'UNKNOWN'} ${t.confidence ?? '?'}%`
  ).join('\n')

  const candidateContext = candidates.map(c => {
    const sig = candidateSignals[c]
    const isAdd = c.endsWith(':ADD')
    const ticker = c.replace(':ADD', '')
    if (!sig) return `${ticker}${isAdd ? ' (add to existing)' : ''}: no recent Consilium analysis`
    return `${ticker}${isAdd ? ' (add to existing)' : ''}: ${sig.signal} ${sig.confidence}% — ${sig.reasoning}`
  }).join('\n')

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

  const msg = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1800,
    system: `You are the Reinvestment Council for a retail trader. Give three reinvestment strategies at different commitment levels: Aggressive (deploy 50%+ of gains into a high-conviction idea), Moderate (deploy 25-40% into a strategic play), and Conservative (deploy 10-20% into a lower-risk option). Each strategy must have a clear REASON (partial profit-taking, sector rotation, diversification, add to winner, hedge, etc.) and a specific entry/stop/target. Reference their actual tickers and P&L numbers. All suggestedAmount and pctOfGains values must be plain numbers.`,
    messages: [{
      role: 'user',
      content: `TRADER'S OPEN POSITIONS:
${tradeContext || 'No open trades'}

REALIZED CASH: $${realizedPnL.toFixed(0)}
UNREALIZED GAINS: $${(unrealizedTotal ?? 0).toFixed(0)}
DEPLOYABLE CAPITAL: $${(availableCash ?? 0).toFixed(0)}

CANDIDATE TICKERS WITH RECENT COUNCIL SIGNALS:
${candidateContext || 'No recent analyses found — use broad market ideas'}

Generate EXACTLY 3 ideas: one Aggressive, one Moderate, one Conservative.
Consider strategies like: partial profit-taking, sector rotation, adding to winners on dips, diversifying into uncorrelated sectors, hedging with defensive names, options strategies when gains are large.
Return JSON ONLY — no markdown, no backticks:
{
  "ideas": [
    {
      "label": "Aggressive",
      "tierColor": "#f87171",
      "strategy": "Sector rotation into AI infrastructure",
      "strategyNote": "One sentence on WHY this strategy fits their specific situation right now",
      "ticker": "AMD",
      "isAddToExisting": false,
      "signal": "BULLISH",
      "confidence": 72,
      "rationale": "2-3 sentences directly referencing their gains and why AMD makes sense given their META/NVDA exposure",
      "suggestedAmount": 3000,
      "suggestedShares": "~19 shares at current price",
      "pctOfGains": 50,
      "risk": "high",
      "timeframe": "2-4 weeks",
      "entryNote": "Buy near $155 support or on pullback from current levels",
      "stopNote": "Stop $148 — below 50-day SMA, ~4.5% risk",
      "targetNote": "$168 first target (ATR-based), $178 full exit"
    },
    {
      "label": "Moderate",
      "tierColor": "#a78bfa",
      "strategy": "Add to existing winner on dip",
      "strategyNote": "One sentence why adding to a winner is smarter than chasing new names",
      "ticker": "META",
      "isAddToExisting": true,
      "signal": "BULLISH",
      "confidence": 65,
      "rationale": "...",
      "suggestedAmount": 1500,
      "suggestedShares": "~2 shares",
      "pctOfGains": 25,
      "risk": "medium",
      "timeframe": "3-6 weeks",
      "entryNote": "Add on any pullback to $650-660 range",
      "stopNote": "Stop $635 — consolidates your average cost basis risk",
      "targetNote": "$710 first profit zone"
    },
    {
      "label": "Conservative",
      "tierColor": "#34d399",
      "strategy": "Defensive diversification",
      "strategyNote": "One sentence on why balancing tech gains with a non-correlated position makes sense",
      "ticker": "SPY",
      "isAddToExisting": false,
      "signal": "BULLISH",
      "confidence": 55,
      "rationale": "...",
      "suggestedAmount": 800,
      "suggestedShares": "~2 shares",
      "pctOfGains": 13,
      "risk": "low",
      "timeframe": "hold long term",
      "entryNote": "Buy any time — broad market ETF, no timing needed",
      "stopNote": "No stop — long-term hold",
      "targetNote": "Park gains safely while staying invested"
    }
  ],
  "insights": [
    {
      "type": "success",
      "text": "Specific insight with **bold** tickers and numbers"
    }
  ],
  "allocation": [
    { "label": "Aggressive", "pct": 50, "amount": 3000, "color": "red" },
    { "label": "Moderate", "pct": 25, "amount": 1500, "color": "purple" },
    { "label": "Conservative", "pct": 13, "amount": 800, "color": "green" },
    { "label": "Hold", "pct": 12, "amount": 700, "color": "amber" }
  ]
}`
    }]
  })

  try {
    const text = (msg.content[0] as { type: string; text: string }).text
    const clean = text.replace(/```json|```/g, '').trim()
    const result = JSON.parse(clean)

    // Enrich ideas with live prices
    for (const idea of (result.ideas ?? [])) {
      if (!idea.ticker) continue
      const ticker = String(idea.ticker).replace(':ADD', '')
      if (priceMap[ticker] === undefined) {
        priceMap[ticker] = await getLivePrice(ticker)
      }
      idea.currentPrice = priceMap[ticker] ?? null
      // Ensure numeric fields are numbers
      if (typeof idea.suggestedAmount === 'string') {
        idea.suggestedAmount = parseFloat(String(idea.suggestedAmount).replace(/[^0-9.-]/g, '')) || 0
      }
      if (typeof idea.pctOfGains === 'string') {
        idea.pctOfGains = parseFloat(String(idea.pctOfGains)) || 0
      }
      if (typeof idea.confidence === 'string') {
        idea.confidence = parseInt(String(idea.confidence)) || 50
      }
    }

    return NextResponse.json({
      ideas: result.ideas ?? [],
      insights: result.insights ?? [],
      allocation: result.allocation ?? [],
      tradeSummaries,
      realizedPnL,
    })
  } catch (err) {
    console.error('Ideas parse error:', err)
    return NextResponse.json({ error: 'Failed to generate ideas' }, { status: 500 })
  }
}
