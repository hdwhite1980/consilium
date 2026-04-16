import { NextRequest } from 'next/server'
import { createClient } from '@/app/lib/auth/server'
import { createClient as createAdmin } from '@supabase/supabase-js'
import Anthropic from '@anthropic-ai/sdk'

const FINNHUB_KEY = () => process.env.FINNHUB_API_KEY || ''
const ALPACA_HEADERS = {
  'APCA-API-KEY-ID': process.env.ALPACA_API_KEY!,
  'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY!,
}

interface Position {
  ticker: string
  shares: number
  avg_cost: number | null
  position_type?: 'stock' | 'option'
  option_type?: 'call' | 'put' | null
  strike?: number | null
  expiry?: string | null
  contracts?: number | null
  entry_premium?: number | null
  underlying?: string | null
}

interface PositionData {
  ticker: string
  shares: number
  avg_cost: number | null
  currentPrice: number
  marketValue: number
  gainLoss: number | null
  gainLossPct: number | null
  priceChange1D: number
  rsi: number | null
  signal: string
  sma50: number | null
  sma200: number | null
  goldenCross: boolean | null
  earningsDate: string | null
  daysToEarnings: number | null
  sector: string
  analystConsensus: string
  analystTarget: number | null
}

async function fetchQuote(ticker: string): Promise<{ price: number; change1D: number }> {
  try {
    const res = await fetch(
      `https://finnhub.io/api/v1/quote?symbol=${ticker}&token=${FINNHUB_KEY()}`
    )
    if (!res.ok) return { price: 0, change1D: 0 }
    const d = await res.json()
    const change1D = d.pc > 0 ? ((d.c - d.pc) / d.pc) * 100 : 0
    return { price: d.c ?? 0, change1D }
  } catch { return { price: 0, change1D: 0 } }
}

async function fetchBarsForPosition(ticker: string): Promise<{ rsi: number | null; sma50: number | null; sma200: number | null; goldenCross: boolean | null }> {
  try {
    const end = new Date()
    const start = new Date()
    start.setDate(start.getDate() - 420)
    const startStr = start.toISOString().split('T')[0]
    const endStr = end.toISOString().split('T')[0]

    for (const feed of ['sip', 'iex']) {
      const res = await fetch(
        `https://data.alpaca.markets/v2/stocks/${ticker}/bars?timeframe=1Day&start=${startStr}&end=${endStr}&limit=300&adjustment=all&feed=${feed}`,
        { headers: ALPACA_HEADERS }
      )
      if (!res.ok) continue
      const data = await res.json()
      const bars = data.bars ?? []
      if (bars.length < 20) continue

      const closes = bars.map((b: { c: number }) => b.c)

      // RSI
      let rsi = null
      if (closes.length >= 15) {
        let gains = 0, losses = 0
        for (let i = 1; i <= 14; i++) {
          const diff = closes[i] - closes[i - 1]
          if (diff > 0) gains += diff; else losses -= diff
        }
        let avgGain = gains / 14, avgLoss = losses / 14
        for (let i = 15; i < closes.length; i++) {
          const diff = closes[i] - closes[i - 1]
          avgGain = (avgGain * 13 + Math.max(diff, 0)) / 14
          avgLoss = (avgLoss * 13 + Math.max(-diff, 0)) / 14
        }
        rsi = avgLoss === 0 ? 100 : Math.round(100 - 100 / (1 + avgGain / avgLoss))
      }

      const sma = (n: number) => closes.length >= n
        ? closes.slice(-n).reduce((a: number, b: number) => a + b, 0) / n
        : null
      const sma50 = sma(50)
      const sma200 = sma(200)

      return { rsi, sma50, sma200, goldenCross: sma50 && sma200 ? sma50 > sma200 : null }
    }
    return { rsi: null, sma50: null, sma200: null, goldenCross: null }
  } catch { return { rsi: null, sma50: null, sma200: null, goldenCross: null } }
}

async function fetchFundamentalsForPosition(ticker: string, price: number): Promise<{
  earningsDate: string | null; daysToEarnings: number | null
  sector: string; analystConsensus: string; analystTarget: number | null
}> {
  try {
    const [profileRes, calRes, recRes] = await Promise.all([
      fetch(`https://finnhub.io/api/v1/stock/profile2?symbol=${ticker}&token=${FINNHUB_KEY()}`),
      fetch(`https://finnhub.io/api/v1/calendar/earnings?symbol=${ticker}&token=${FINNHUB_KEY()}`),
      fetch(`https://finnhub.io/api/v1/stock/recommendation?symbol=${ticker}&token=${FINNHUB_KEY()}`),
    ])

    const profile = profileRes.ok ? await profileRes.json() : {}
    const cal = calRes.ok ? await calRes.json() : {}
    const rec = recRes.ok ? await recRes.json() : []

    const sector = profile.finnhubIndustry ?? 'Unknown'
    const upcoming = (cal.earningsCalendar ?? []).find((e: { date: string }) => new Date(e.date) >= new Date())
    const earningsDate = upcoming?.date ?? null
    const daysToEarnings = earningsDate
      ? Math.ceil((new Date(earningsDate).getTime() - Date.now()) / 86400000)
      : null

    const latest = Array.isArray(rec) ? rec[0] : null
    const totalRecs = latest ? (latest.buy + latest.strongBuy + latest.hold + latest.sell + latest.strongSell) : 0
    const bullish = latest ? (latest.buy + latest.strongBuy) / totalRecs : 0
    const consensus = bullish > 0.6 ? 'buy' : bullish > 0.4 ? 'hold' : 'sell'

    const priceTargetRes = await fetch(
      `https://finnhub.io/api/v1/stock/price-target?symbol=${ticker}&token=${FINNHUB_KEY()}`
    )
    const pt = priceTargetRes.ok ? await priceTargetRes.json() : {}
    const analystTarget = pt.targetMean ?? null

    return { earningsDate, daysToEarnings, sector, analystConsensus: consensus, analystTarget }
  } catch {
    return { earningsDate: null, daysToEarnings: null, sector: 'Unknown', analystConsensus: 'hold', analystTarget: null }
  }
}

function deriveTechSignal(rsi: number | null, goldenCross: boolean | null, priceChange1D: number): string {
  let score = 0
  if (rsi !== null) {
    if (rsi > 70) score -= 1
    else if (rsi < 30) score += 2
    else if (rsi > 50) score += 1
  }
  if (goldenCross === true) score += 2
  else if (goldenCross === false) score -= 2
  if (priceChange1D > 2) score += 1
  else if (priceChange1D < -2) score -= 1
  return score >= 2 ? 'BULLISH' : score <= -2 ? 'BEARISH' : 'NEUTRAL'
}

export async function POST(req: NextRequest) {
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) =>
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))

      try {
        const supabase = await createClient()
        const { data: { user } } = await supabase.auth.getUser()
        if (!user) { send('error', { message: 'Not authenticated' }); return }

        const { positions }: { positions: Position[] } = await req.json()
        if (!positions?.length) { send('error', { message: 'No positions provided' }); return }

        send('status', { message: `Analyzing ${positions.length} positions...` })

        // Fetch data for all positions in parallel
        const positionData: PositionData[] = await Promise.all(
          positions.map(async (pos) => {
            const isOption = pos.position_type === 'option'
            // For options, use the underlying ticker for price/technical data
            const analysisTicker = isOption ? (pos.underlying ?? pos.ticker) : pos.ticker

            const [quote, bars, fundamentals] = await Promise.all([
              fetchQuote(analysisTicker),
              fetchBarsForPosition(analysisTicker),
              fetchFundamentalsForPosition(analysisTicker, 0),
            ])

            const currentPrice = quote.price

            // Options P&L uses entry premium vs current option price (approximated)
            // Since we don't have live option price here, use entry_premium as cost basis
            let marketValue: number, gainLoss: number | null, gainLossPct: number | null
            if (isOption && pos.entry_premium && pos.contracts) {
              const totalPremiumPaid = pos.entry_premium * pos.contracts * 100
              // Approximate current value using underlying price change
              const underlyingChange = currentPrice > 0 && pos.strike
                ? (pos.option_type === 'call'
                    ? Math.max(0, currentPrice - pos.strike) * pos.contracts * 100
                    : Math.max(0, pos.strike - currentPrice) * pos.contracts * 100)
                : totalPremiumPaid
              marketValue = underlyingChange > 0 ? underlyingChange : totalPremiumPaid * 0.5
              gainLoss = marketValue - totalPremiumPaid
              gainLossPct = ((marketValue - totalPremiumPaid) / totalPremiumPaid) * 100
            } else {
              marketValue = currentPrice * pos.shares
              gainLoss = pos.avg_cost ? (currentPrice - pos.avg_cost) * pos.shares : null
              gainLossPct = pos.avg_cost ? ((currentPrice - pos.avg_cost) / pos.avg_cost) * 100 : null
            }

            return {
              ticker: pos.ticker,
              shares: pos.shares,
              avg_cost: isOption ? (pos.entry_premium ?? null) as number | null : pos.avg_cost,
              currentPrice,
              marketValue,
              gainLoss,
              gainLossPct,
              priceChange1D: quote.change1D,
              rsi: bars.rsi,
              signal: deriveTechSignal(bars.rsi, bars.goldenCross, quote.change1D),
              sma50: bars.sma50,
              sma200: bars.sma200,
              goldenCross: bars.goldenCross,
              ...fundamentals,
            }
          })
        )

        send('status', { message: 'Running portfolio AI analysis...' })
        send('position_data', positionData)

        // Calculate portfolio metrics
        const totalValue = positionData.reduce((s, p) => s + p.marketValue, 0)
        const totalGainLoss = positionData.reduce((s, p) => s + (p.gainLoss ?? 0), 0)
        const totalCost = positionData.reduce((s, p) => s + (p.avg_cost && p.avg_cost > 0 ? p.avg_cost * p.shares : p.marketValue), 0)
        const totalGainLossPct = totalCost > 0 ? (totalGainLoss / totalCost) * 100 : 0

        // Sector concentration
        const sectorMap: Record<string, number> = {}
        positionData.forEach(p => {
          sectorMap[p.sector] = (sectorMap[p.sector] ?? 0) + p.marketValue
        })
        const sectorConcentration = Object.entries(sectorMap)
          .map(([sector, value]) => ({ sector, pct: (value / totalValue) * 100 }))
          .sort((a, b) => b.pct - a.pct)

        // Earnings risk
        const upcomingEarnings = positionData
          .filter(p => p.daysToEarnings !== null && p.daysToEarnings <= 30)
          .sort((a, b) => (a.daysToEarnings ?? 99) - (b.daysToEarnings ?? 99))

        // Signal breakdown
        const signals = { BULLISH: 0, BEARISH: 0, NEUTRAL: 0 }
        positionData.forEach(p => { signals[p.signal as keyof typeof signals]++ })

        // AI holistic analysis
        const anthropic = new Anthropic()
        const positionSummary = positionData.map(p =>
          `${p.ticker}: $${p.currentPrice.toFixed(2)} (${p.priceChange1D >= 0 ? '+' : ''}${p.priceChange1D.toFixed(1)}% today) | ${(p.marketValue/totalValue*100).toFixed(1)}% of portfolio | RSI ${p.rsi ?? 'N/A'} | ${p.signal} | ${p.goldenCross ? 'Golden cross' : p.goldenCross === false ? 'Death cross' : 'N/A'} | Sector: ${p.sector}${p.daysToEarnings !== null ? ` | EARNINGS IN ${p.daysToEarnings}d` : ''}`
        ).join('\n')

        const msg = await anthropic.messages.create({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 1500,
          system: `You are a portfolio analyst providing holistic analysis of a user's stock portfolio. Be specific, use actual numbers from the data, and give actionable insights. Write for someone who understands investing but wants clear guidance.`,
          messages: [{
            role: 'user',
            content: `PORTFOLIO SUMMARY:
Total value: $${totalValue.toLocaleString('en-US', { maximumFractionDigits: 0 })}
Total gain/loss: ${totalGainLoss >= 0 ? '+' : ''}$${totalGainLoss.toLocaleString('en-US', { maximumFractionDigits: 0 })} (${totalGainLossPct >= 0 ? '+' : ''}${totalGainLossPct.toFixed(1)}%)
Signals: ${signals.BULLISH} BULLISH, ${signals.NEUTRAL} NEUTRAL, ${signals.BEARISH} BEARISH
Top sectors: ${sectorConcentration.slice(0, 3).map(s => `${s.sector} ${s.pct.toFixed(0)}%`).join(', ')}
Earnings risk: ${upcomingEarnings.length} positions reporting in next 30 days

POSITIONS:
${positionSummary}

Provide a holistic portfolio analysis in JSON only (no markdown):
{
  "overallSignal": "BULLISH|BEARISH|NEUTRAL",
  "overallConviction": "high|medium|low",
  "headline": "one punchy sentence summarizing the portfolio's current state e.g. 'Tech-heavy portfolio faces near-term headwinds with 3 earnings events in 14 days'",
  "summary": "3-4 sentences. Cover overall direction, biggest risks, and what's working. Use specific tickers and numbers.",
  "topRisks": [
    {"risk": "specific risk", "tickers": ["TICKER"], "severity": "high|medium|low"}
  ],
  "opportunities": [
    {"opportunity": "specific opportunity", "tickers": ["TICKER"]}
  ],
  "sectorAnalysis": "2 sentences on sector concentration — is it too concentrated? Any rotation needed?",
  "earningsWatch": "specific guidance on upcoming earnings — which ones matter most and why",
  "rebalancingSuggestions": "2-3 specific, actionable rebalancing suggestions based on the signals",
  "actionPlan": "3-4 clear steps the investor should consider taking in the next 2 weeks",
  "portfolioScore": <0-100>
}`
          }]
        })

        const text = (msg.content[0] as { text: string }).text
        const clean = text.replace(/```json|```/g, '').trim()
        const analysis = JSON.parse(clean)

        const result = {
          positionData,
          metrics: {
            totalValue,
            totalGainLoss,
            totalGainLossPct,
            sectorConcentration,
            upcomingEarnings,
            signals,
          },
          analysis,
        }

        // Cache the analysis
        const admin = createAdmin(
          process.env.NEXT_PUBLIC_SUPABASE_URL!,
          process.env.SUPABASE_SERVICE_ROLE_KEY!
        )
        const { data: portfolio } = await admin
          .from('portfolios')
          .select('id')
          .eq('user_id', user.id)
          .maybeSingle()

        if (portfolio) {
          await admin.from('portfolio_analyses').insert({
            portfolio_id: portfolio.id,
            user_id: user.id,
            analysis: result,
          })
        }

        send('complete', result)
      } catch (err) {
        console.error('Portfolio analysis error:', err)
        send('error', { message: err instanceof Error ? err.message : 'Analysis failed' })
      } finally {
        controller.close()
      }
    }
  })

  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' }
  })
}
