/**
 * Wali-OS — Position Health Check
 * GET /api/portfolio/check?ticker=NVDA  — single position
 * POST /api/portfolio/check             — all positions
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/app/lib/auth/server'
import { createClient as createAdmin } from '@supabase/supabase-js'
import Anthropic from '@anthropic-ai/sdk'

const getAdmin = () => createAdmin(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export interface PositionCheck {
  ticker: string
  position_type: 'stock' | 'option'
  currentPrice: number
  change1D: number
  volumeRatio: number | null
  rsi: number | null
  entryPrice: number | null
  pnlPct: number | null
  pnlDollar: number | null
  stopLoss: number | null
  takeProfit: number | null
  pctFromStop: number | null
  pctFromTarget: number | null
  optionType?: string
  strike?: number
  expiry?: string
  daysToExpiry?: number | null
  timeDecayUrgent?: boolean
  verdict: 'HOLD' | 'EXIT' | 'ADD' | 'WATCH'
  conviction: 'high' | 'medium' | 'low'
  reason: string
  action: string
  flags: string[]
}

async function fetchQuote(ticker: string) {
  const key = process.env.FINNHUB_API_KEY
  if (!key) return null
  try {
    const [qr, mr, rr] = await Promise.all([
      fetch(`https://finnhub.io/api/v1/quote?symbol=${ticker}&token=${key}`),
      fetch(`https://finnhub.io/api/v1/stock/metric?symbol=${ticker}&metric=all&token=${key}`),
      fetch(`https://finnhub.io/api/v1/indicator?symbol=${ticker}&resolution=D&from=${Math.floor((Date.now()-60*86400000)/1000)}&to=${Math.floor(Date.now()/1000)}&indicator=rsi&timeperiod=14&token=${key}`),
    ])
    if (!qr.ok) return null
    const q = await qr.json()
    if (!q.c || q.c === 0) return null
    const price = q.c
    const prev = q.pc || price
    const change1D = parseFloat(((price - prev) / prev * 100).toFixed(2))
    let avgVolume = null
    if (mr.ok) { const m = await mr.json(); avgVolume = m.metric?.['10DayAverageTradingVolume'] ? m.metric['10DayAverageTradingVolume'] * 1e6 : null }
    let rsi = null
    if (rr.ok) { const r = await rr.json(); if (Array.isArray(r.rsi) && r.rsi.length) rsi = parseFloat(r.rsi[r.rsi.length - 1].toFixed(1)) }
    const volumeRatio = q.v && avgVolume ? parseFloat((q.v / avgVolume).toFixed(2)) : null
    return { price: parseFloat(price.toFixed(2)), change1D, volume: q.v || null, volumeRatio, rsi }
  } catch { return null }
}

async function buildCheck(pos: any, q: NonNullable<Awaited<ReturnType<typeof fetchQuote>>>): Promise<PositionCheck> {
  const isOption = pos.position_type === 'option'
  const entryPrice = isOption ? pos.entry_premium : (pos.avg_cost || null)
  const pnlPct = entryPrice && !isOption ? parseFloat(((q.price - entryPrice) / entryPrice * 100).toFixed(2)) : null
  const pnlDollar = entryPrice && !isOption ? parseFloat(((q.price - entryPrice) * (pos.shares || 1)).toFixed(2)) : null
  const pctFromStop = pos.stop_loss ? parseFloat(((q.price - pos.stop_loss) / pos.stop_loss * 100).toFixed(2)) : null
  const pctFromTarget = pos.take_profit ? parseFloat(((pos.take_profit - q.price) / q.price * 100).toFixed(2)) : null

  let daysToExpiry: number | null = null
  let timeDecayUrgent = false
  if (isOption && pos.expiry) {
    daysToExpiry = Math.floor((new Date(pos.expiry).getTime() - Date.now()) / 86400000)
    timeDecayUrgent = daysToExpiry <= 7
  }

  const flags: string[] = []
  if (pnlPct !== null && pnlPct <= -8) flags.push(`down ${Math.abs(pnlPct).toFixed(1)}% from entry`)
  if (pnlPct !== null && pnlPct >= 20) flags.push(`up ${pnlPct.toFixed(1)}% — consider partial profits`)
  if (pctFromStop !== null && pctFromStop <= 3 && pctFromStop >= 0) flags.push(`only ${pctFromStop.toFixed(1)}% above stop`)
  if (pctFromStop !== null && pctFromStop < 0) flags.push('⚠ STOP LOSS BREACHED')
  if (pctFromTarget !== null && pctFromTarget <= 2) flags.push(`within ${pctFromTarget.toFixed(1)}% of target`)
  if (q.rsi !== null && q.rsi > 75) flags.push(`RSI ${q.rsi} overbought`)
  if (q.rsi !== null && q.rsi < 25) flags.push(`RSI ${q.rsi} oversold`)
  if (q.volumeRatio !== null && q.volumeRatio > 2) flags.push(`${q.volumeRatio}x volume spike`)
  if (timeDecayUrgent) flags.push(`⚠ ${daysToExpiry}d to expiry — theta burning fast`)
  if (daysToExpiry !== null && daysToExpiry < 0) flags.push('⚠ OPTION EXPIRED')

  let verdict: PositionCheck['verdict'] = 'HOLD'
  let conviction: PositionCheck['conviction'] = 'medium'
  if ((pctFromStop !== null && pctFromStop < 0) || (daysToExpiry !== null && daysToExpiry < 1)) { verdict = 'EXIT'; conviction = 'high' }
  else if (pnlPct !== null && pnlPct <= -15) { verdict = 'EXIT'; conviction = 'high' }
  else if (pctFromTarget !== null && pctFromTarget <= 1) { verdict = 'EXIT'; conviction = 'high' }
  else if (timeDecayUrgent && daysToExpiry !== null && daysToExpiry < 4) { verdict = 'EXIT'; conviction = 'high' }
  else if ((pctFromStop !== null && pctFromStop <= 3) || (timeDecayUrgent)) { verdict = 'WATCH'; conviction = 'high' }
  else if (pnlPct !== null && pnlPct >= 15 && q.rsi !== null && q.rsi > 70) { verdict = 'WATCH'; conviction = 'medium' }
  else if (pnlPct !== null && pnlPct > 0 && q.rsi !== null && q.rsi < 60 && q.volumeRatio !== null && q.volumeRatio > 1.5) { verdict = 'ADD'; conviction = 'low' }

  const parts: string[] = []
  if (pnlPct !== null) parts.push(`${pnlPct >= 0 ? '+' : ''}${pnlPct}% P&L`)
  if (q.rsi !== null) parts.push(`RSI ${q.rsi}`)
  if (q.volumeRatio !== null && q.volumeRatio > 1.2) parts.push(`${q.volumeRatio}x avg vol`)
  if (pctFromStop !== null) parts.push(`${pctFromStop.toFixed(1)}% from stop`)
  if (pctFromTarget !== null) parts.push(`${pctFromTarget.toFixed(1)}% from target`)
  if (daysToExpiry !== null) parts.push(`${daysToExpiry}d to expiry`)

  return {
    ticker: pos.ticker, position_type: pos.position_type || 'stock',
    currentPrice: q.price, change1D: q.change1D, volumeRatio: q.volumeRatio, rsi: q.rsi,
    entryPrice, pnlPct, pnlDollar, stopLoss: pos.stop_loss || null, takeProfit: pos.take_profit || null,
    pctFromStop, pctFromTarget,
    optionType: pos.option_type || undefined, strike: pos.strike || undefined, expiry: pos.expiry || undefined,
    daysToExpiry, timeDecayUrgent,
    verdict, conviction, reason: parts.join(' · ') || 'Monitoring',
    action: verdict === 'EXIT' ? (pctFromTarget !== null && pctFromTarget <= 1 ? 'Take profit — at target' : 'Exit — rule triggered')
      : verdict === 'WATCH' ? 'Tighten stop, watch closely'
      : verdict === 'ADD' ? 'Consider adding on continued momentum'
      : 'Hold — no action needed',
    flags,
  }
}

async function enrichWithAI(checks: PositionCheck[]): Promise<PositionCheck[]> {
  if (!checks.length) return checks
  try {
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })
    const snapshot = checks.map(c => [
      `${c.ticker}${c.optionType ? ` ${c.optionType.toUpperCase()} $${c.strike} exp ${c.expiry}` : ''}`,
      `  $${c.currentPrice} (${c.change1D >= 0 ? '+' : ''}${c.change1D}% today)`,
      c.entryPrice ? `  Entry $${c.entryPrice} | P&L ${c.pnlPct !== null ? `${c.pnlPct >= 0 ? '+' : ''}${c.pnlPct}%` : 'N/A'}` : '',
      c.rsi != null ? `  RSI ${c.rsi}` : '',
      c.volumeRatio != null ? `  Volume ${c.volumeRatio}x avg` : '',
      c.stopLoss ? `  Stop $${c.stopLoss} (${c.pctFromStop?.toFixed(1)}% away)` : 'No stop set',
      c.takeProfit ? `  Target $${c.takeProfit} (${c.pctFromTarget?.toFixed(1)}% away)` : 'No target set',
      c.daysToExpiry != null ? `  ${c.daysToExpiry}d to expiry` : '',
      c.flags.length ? `  Flags: ${c.flags.join(', ')}` : '',
    ].filter(Boolean).join('\n')).join('\n\n')

    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514', max_tokens: 1000,
      messages: [{ role: 'user', content: `You are a trading coach doing position reviews. For each position, give a final HOLD/EXIT/WATCH/ADD verdict using the real numbers. Be blunt and specific.\n\n${snapshot}\n\nJSON array, same order:\n[\n  {\n    "ticker": "NVDA",\n    "verdict": "HOLD",\n    "conviction": "high",\n    "reason": "RSI 58, 14% above stop at $185, tracking toward $220 target — thesis intact",\n    "action": "Hold with stop at $185. If breaks $195 on volume consider adding.",\n    "flags": ["volume 1.8x — accumulation pattern"]\n  }\n]\nJSON only.` }]
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const text = (msg.content.find((b: any) => b.type === 'text') as any)?.text || ''
    const clean = text.replace(/```json|```/g, '').trim()
    const ai: any[] = JSON.parse(clean.slice(clean.indexOf('['), clean.lastIndexOf(']') + 1))
    return checks.map((c, i) => {
      const a = ai[i]
      if (!a || a.ticker !== c.ticker) return c
      return { ...c, verdict: a.verdict || c.verdict, conviction: a.conviction || c.conviction, reason: a.reason || c.reason, action: a.action || c.action, flags: [...new Set([...c.flags, ...(a.flags || [])])] }
    })
  } catch { return checks }
}

async function getPositionsAndJournal(userId: string) {
  const admin = getAdmin()
  const { data: portfolio } = await admin.from('portfolios').select('id').eq('user_id', userId).maybeSingle()
  const positions = portfolio
    ? (await admin.from('portfolio_positions').select('*').eq('portfolio_id', portfolio.id)).data || []
    : []
  const { data: journal } = await admin.from('trade_journal').select('ticker,stop_loss,take_profit,entry_price,entry_premium,position_type,option_type,strike,expiry,contracts').eq('user_id', userId).eq('outcome', 'pending')
  const jMap = new Map<string, any>()
  for (const j of (journal || [])) jMap.set(j.ticker, j)
  return { positions, jMap }
}

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ticker = new URL(req.url).searchParams.get('ticker')?.toUpperCase()
  if (!ticker) return NextResponse.json({ error: 'ticker required' }, { status: 400 })

  const { positions, jMap } = await getPositionsAndJournal(user.id)
  const pos = positions.find((p: any) => p.ticker === ticker) || { ticker, shares: 1, position_type: 'stock' }
  const j = jMap.get(ticker)
  const merged = { ...pos, stop_loss: j?.stop_loss || null, take_profit: j?.take_profit || null, ...(j?.entry_price ? { avg_cost: j.entry_price } : {}), ...(j?.entry_premium ? { entry_premium: j.entry_premium } : {}) }

  const quote = await fetchQuote(ticker)
  if (!quote) return NextResponse.json({ error: 'Could not fetch live price data' }, { status: 503 })

  const check = await buildCheck(merged, quote)
  const [enriched] = await enrichWithAI([check])
  return NextResponse.json({ check: enriched })
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { positions: jPositions, jMap } = await getPositionsAndJournal(user.id)
  if (!jPositions.length) return NextResponse.json({ checks: [] })

  const quotes = new Map<string, any>()
  for (const pos of jPositions) {
    const underlying = pos.underlying || pos.ticker
    if (!quotes.has(underlying)) {
      const q = await fetchQuote(underlying)
      if (q) quotes.set(underlying, q)
      await new Promise(r => setTimeout(r, 120))
    }
  }

  const checks: PositionCheck[] = []
  for (const pos of jPositions) {
    const q = quotes.get(pos.underlying || pos.ticker)
    if (!q) continue
    const j = jMap.get(pos.ticker)
    const merged = { ...pos, stop_loss: j?.stop_loss || null, take_profit: j?.take_profit || null, ...(j?.entry_price ? { avg_cost: j.entry_price } : {}), ...(j?.entry_premium ? { entry_premium: j.entry_premium } : {}) }
    checks.push(await buildCheck(merged, q))
  }

  const enriched = await enrichWithAI(checks)
  const order = { EXIT: 0, WATCH: 1, HOLD: 2, ADD: 3 }
  enriched.sort((a, b) => (order[a.verdict] ?? 9) - (order[b.verdict] ?? 9))
  return NextResponse.json({ checks: enriched, checkedAt: new Date().toISOString() })
}
