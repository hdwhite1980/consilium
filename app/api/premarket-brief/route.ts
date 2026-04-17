import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/app/lib/auth/server'
import { createClient as createAdmin } from '@supabase/supabase-js'
import { GoogleGenerativeAI } from '@google/generative-ai'
import { getActiveThemes } from '@/app/lib/macro-intelligence'

function getAdmin() {
  return createAdmin(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
}

// GET — fetch or generate today's brief for the current user
export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const admin = getAdmin()
  const today = new Date().toISOString().split('T')[0]

  // Check for cached brief
  const { data: cached } = await admin
    .from('premarket_briefs')
    .select('*')
    .eq('user_id', user.id)
    .eq('brief_date', today)
    .maybeSingle()

  if (cached) return NextResponse.json({ brief: cached, fresh: false })

  // Generate fresh brief
  const brief = await generateBrief(user.id, admin)
  return NextResponse.json({ brief, fresh: true })
}

async function generateBrief(userId: string, admin: any) {
  const today = new Date().toISOString().split('T')[0]

  // Get user's portfolio tickers for personalized alerts
  const { data: positions } = await admin
    .from('portfolios')
    .select('ticker, shares, cost_basis')
    .eq('user_id', userId)
    .limit(15)

  const tickers = (positions || []).map((p: any) => p.ticker)

  // Get active macro themes
  const themes = await getActiveThemes()

  // Get recent verdicts for context
  const { data: recentVerdicts } = await admin
    .from('verdict_log')
    .select('ticker, signal, confidence, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(5)

  // Fetch live quotes for portfolio tickers
  const portfolioContext: string[] = []
  if (tickers.length > 0 && process.env.FINNHUB_API_KEY) {
    for (const ticker of tickers.slice(0, 8)) {
      try {
        const res = await fetch(`https://finnhub.io/api/v1/quote?symbol=${ticker}&token=${process.env.FINNHUB_API_KEY}`)
        if (res.ok) {
          const q = await res.json()
          if (q.dp != null) {
            portfolioContext.push(`${ticker}: ${q.dp > 0 ? '+' : ''}${q.dp.toFixed(1)}% pre-market`)
          }
        }
      } catch { /* skip */ }
    }
  }

  // Fetch broad market pre-market
  const marketContext: string[] = []
  for (const sym of ['SPY', 'QQQ', 'VIX']) {
    try {
      const res = await fetch(`https://finnhub.io/api/v1/quote?symbol=${sym}&token=${process.env.FINNHUB_API_KEY}`)
      if (res.ok) {
        const q = await res.json()
        if (q.dp != null) marketContext.push(`${sym}: ${q.dp > 0 ? '+' : ''}${q.dp.toFixed(1)}%`)
      }
    } catch { /* skip */ }
  }

  // Generate brief with Gemini
  const genai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!)
  const model = genai.getGenerativeModel({ model: 'gemini-2.5-flash' })

  const prompt = `You are writing a pre-market brief for a stock trader. Today is ${today}.

BROAD MARKET:
${marketContext.join(' | ') || 'Data unavailable'}

PORTFOLIO POSITIONS PRE-MARKET:
${portfolioContext.length > 0 ? portfolioContext.join('\n') : 'No portfolio data'}

ACTIVE MACRO THEMES:
${themes.map(t => `• [${t.urgency}] ${t.theme_name}: ${t.theme_summary}`).join('\n') || 'None'}

RECENT COUNCIL VERDICTS:
${(recentVerdicts || []).map((v: any) => `${v.ticker}: ${v.signal} (${v.confidence}%)`).join(', ') || 'None'}

Write a concise pre-market brief in this JSON format:
{
  "headline": "One punchy sentence about today's market setup",
  "market_regime": "One sentence on SPY/QQQ/VIX setup",
  "top_themes": ["2-3 macro/geopolitical themes to watch today"],
  "portfolio_alerts": ["Any portfolio positions moving significantly — mention ticker and why"],
  "watchlist": ["2-3 specific setups or tickers worth watching today with brief reason"],
  "risk_of_day": "The single biggest risk to watch for today",
  "one_line": "The most important thing a trader needs to know in one sentence"
}

Be specific, direct, no fluff. Readable in 60 seconds.`

  try {
    const result = await model.generateContent(prompt)
    const raw = result.response.text()
    const clean = raw.replace(/```json|```/g, '').trim()
    const start = clean.indexOf('{')
    const end = clean.lastIndexOf('}')
    const content = start !== -1 ? JSON.parse(clean.slice(start, end + 1)) : {}

    // Cache in DB
    const { data: saved } = await admin
      .from('premarket_briefs')
      .upsert({
        user_id: userId,
        brief_date: today,
        content,
        generated_at: new Date().toISOString(),
      }, { onConflict: 'user_id,brief_date' })
      .select('*')
      .single()

    return saved || { brief_date: today, content }
  } catch (e) {
    console.error('[premarket-brief]', e)
    return { brief_date: today, content: { headline: 'Brief unavailable', one_line: 'Check back shortly.' } }
  }
}
