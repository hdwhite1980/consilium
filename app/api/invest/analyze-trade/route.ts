import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/app/lib/auth/server'
import { createClient as createAdmin } from '@supabase/supabase-js'
import Anthropic from '@anthropic-ai/sdk'
import { INVEST_LESSONS } from '@/app/lib/invest-lessons'

const getAdmin = () => createAdmin(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// Tier lookup (mirrors invest/route.ts)
const TIERS = [
  { name: 'Buyer',     min: 1,     max: 50,       maxPositions: 2,  stopPct: '20–30%', targetPct: '40–80%', strategy: 'first-position practice — tight discipline on stops' },
  { name: 'Builder',   min: 50,    max: 200,      maxPositions: 3,  stopPct: '15–20%', targetPct: '30–60%', strategy: 'technical setups with catalyst awareness' },
  { name: 'Operator',  min: 200,   max: 1000,     maxPositions: 4,  stopPct: '12–18%', targetPct: '25–50%', strategy: 'full debate — running the book with intent' },
  { name: 'Principal', min: 1000,  max: 10000,    maxPositions: 5,  stopPct: '8–12%',  targetPct: '15–30%', strategy: 'high-conviction plays with real weight' },
  { name: 'Sovereign', min: 10000, max: Infinity, maxPositions: 10, stopPct: '5–10%',  targetPct: '10–25%', strategy: 'diversified conviction-weighted — any instrument' },
]

function getTier(totalValue: number) {
  return TIERS.find(t => totalValue >= t.min && totalValue < t.max) ?? TIERS[0]
}

interface PostmortemAnalysis {
  whatWorked: string[]
  whatMissed: string[]
  ruleReferences: Array<{ lessonId: string; lessonTitle: string; reason: string }>
  nextTimeTip: string
  honestSummary: string
}

// ── GET /api/invest/analyze-trade?tradeId={id} ──
// Returns the cached post-mortem if it exists. Used by the UI to poll
// after close_trade fires the async generation.
export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const tradeId = req.nextUrl.searchParams.get('tradeId')
  if (!tradeId) return NextResponse.json({ error: 'tradeId required' }, { status: 400 })

  const admin = getAdmin()
  const { data } = await admin
    .from('invest_trade_postmortems')
    .select('*')
    .eq('user_id', user.id)
    .eq('trade_id', tradeId)
    .maybeSingle()

  return NextResponse.json({ postmortem: data ?? null })
}

// ── POST /api/invest/analyze-trade ──
// Body: { tradeId: string }
// Generates the post-mortem if not cached, caches it, returns it.
export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  let body: Record<string, unknown>
  try { body = await req.json() }
  catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }) }

  const tradeId = typeof body.tradeId === 'string' ? body.tradeId : null
  if (!tradeId) return NextResponse.json({ error: 'tradeId required' }, { status: 400 })

  const admin = getAdmin()

  // ── Cache check
  const { data: cached } = await admin
    .from('invest_trade_postmortems')
    .select('*')
    .eq('user_id', user.id)
    .eq('trade_id', tradeId)
    .maybeSingle()

  if (cached) {
    return NextResponse.json({ postmortem: cached, cached: true })
  }

  // ── Load the trade
  const { data: trade, error: tradeErr } = await admin
    .from('invest_trades')
    .select('*')
    .eq('id', tradeId)
    .eq('user_id', user.id)
    .maybeSingle()

  if (tradeErr || !trade) {
    return NextResponse.json({ error: 'Trade not found' }, { status: 404 })
  }
  if (trade.exit_price == null) {
    return NextResponse.json({ error: 'Trade is not closed' }, { status: 400 })
  }

  // ── Load journey so we know account value at close
  const { data: journey } = await admin
    .from('invest_journey')
    .select('*')
    .eq('user_id', user.id)
    .maybeSingle()

  // Approximate account value at close: starting balance + sum of realized P/L up to and including this trade
  const { data: allTrades } = await admin
    .from('invest_trades')
    .select('*')
    .eq('user_id', user.id)
    .not('exit_price', 'is', null)
    .lte('exit_date', trade.exit_date)

  const realizedToDate = (allTrades ?? []).reduce(
    (s, t) => s + ((t.exit_price ?? 0) - t.entry_price) * t.shares,
    0
  )
  const accountAtClose = (journey?.starting_balance ?? 0) + realizedToDate
  const tierAtClose = getTier(accountAtClose)

  // ── Load user's completed lessons so the analyzer can reference them
  const { data: lessonProgress } = await admin
    .from('invest_lesson_progress')
    .select('lesson_id, correct')
    .eq('user_id', user.id)

  const completedLessonIds = new Set(
    (lessonProgress ?? []).filter(p => p.correct).map(p => p.lesson_id)
  )
  const completedLessons = INVEST_LESSONS.filter(l => completedLessonIds.has(l.id))

  // ── Compute trade mechanics
  const isOption = trade.position_type === 'option'
  const pnlDollar = (trade.exit_price - trade.entry_price) * trade.shares
  const pnlPct = ((trade.exit_price - trade.entry_price) / trade.entry_price) * 100
  const holdMs = new Date(trade.exit_date).getTime() - new Date(trade.opened_at).getTime()
  const holdDays = Math.max(0, Math.round(holdMs / (1000 * 60 * 60 * 24)))
  const outcome: 'win' | 'loss' | 'breakeven' =
    pnlPct > 0.5 ? 'win' : pnlPct < -0.5 ? 'loss' : 'breakeven'

  const positionCostBasis = trade.entry_price * trade.shares
  const pctOfAccount = accountAtClose > 0
    ? (positionCostBasis / (accountAtClose - realizedToDate + positionCostBasis)) * 100
    : 0

  // ── Build Claude prompt
  const lessonList = completedLessons.length > 0
    ? completedLessons.map(l => `- ${l.id}: "${l.title}" — ${l.subtitle}`).join('\n')
    : '(none completed yet)'

  const tradeDescription = isOption
    ? `${trade.option_type?.toUpperCase()} option on ${trade.underlying ?? trade.ticker}
  Strike: $${trade.strike}
  Expiry: ${trade.expiry}
  Contracts: ${trade.contracts}
  Entry premium: $${trade.entry_premium?.toFixed(2) ?? trade.entry_price}/share
  Exit premium: $${trade.exit_premium?.toFixed(2) ?? trade.exit_price}/share
  Total cost: $${(trade.entry_price * trade.shares).toFixed(2)}
  Total received: $${(trade.exit_price * trade.shares).toFixed(2)}
  Realized P/L: ${pnlPct >= 0 ? '+' : ''}$${pnlDollar.toFixed(2)} (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}% on premium)`
    : `Stock position on ${trade.ticker}
  Shares: ${trade.shares}
  Entry: $${trade.entry_price.toFixed(2)}
  Exit: $${trade.exit_price.toFixed(2)}
  Realized P/L: ${pnlPct >= 0 ? '+' : ''}$${pnlDollar.toFixed(2)} (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%)`

  const prompt = `You are an experienced trading coach reviewing a closed paper trade for a retail trader on the Wali-OS platform. Grade the PROCESS, not the outcome.

A lucky win with bad process = low grade.
An unlucky loss with excellent process = high grade.

TRADE DETAILS:
${tradeDescription}
Held: ${holdDays} day(s)
Council signal at open: ${trade.council_signal ?? 'none logged'}
Council confidence: ${trade.confidence ?? 'not recorded'}
User notes: ${trade.notes ?? '(no notes)'}
Position cost basis as % of account: ${pctOfAccount.toFixed(1)}%

TRADER TIER AT CLOSE: ${tierAtClose.name} (account ~$${accountAtClose.toFixed(0)})
Tier config:
  - Max positions: ${tierAtClose.maxPositions}
  - Stop range: ${tierAtClose.stopPct}
  - Target range: ${tierAtClose.targetPct}
  - Strategy: ${tierAtClose.strategy}

LESSONS THE TRADER HAS COMPLETED:
${lessonList}

GRADING RUBRIC (process, not outcome):
- A: Clear setup, disciplined sizing, respected stop/target, no rule violations
- B: Good overall process, minor deviation (e.g. slight size over target, late exit)
- C: Mixed — partial discipline but clear process errors
- D: Poor process — broke multiple rules the trader has been taught
- F: Reckless — ignored core discipline (over-size, chase, no stop, etc.)

RETURN JSON ONLY — no markdown, no backticks, no preamble:
{
  "grade": "B+",
  "processScore": 78,
  "outcome": "${outcome}",
  "analysis": {
    "whatWorked": [
      "Specific thing 1 the trader did right",
      "Specific thing 2 the trader did right"
    ],
    "whatMissed": [
      "Specific deviation from discipline if any (or empty array if clean)"
    ],
    "ruleReferences": [
      { "lessonId": "buyer-2", "lessonTitle": "Stops before targets", "reason": "Why this lesson is relevant — 1 sentence" }
    ],
    "nextTimeTip": "One concrete, actionable adjustment for the next similar setup",
    "honestSummary": "2–3 sentences summarizing the trade from a coach's perspective. Kind but direct. Not patronizing."
  }
}

Rules for the analysis:
1. Reference ONLY lessons the trader has already completed (from the list above) — do not reference locked lessons
2. If the trader has completed few lessons, focus on universal principles, not specific lesson IDs
3. If outcome is "win" but process was poor, say so directly — this is how they learn
4. If outcome is "loss" but process was good, say so directly — this is how they stay motivated
5. Keep each whatWorked/whatMissed item to one sentence
6. grade must be one of: A+, A, A-, B+, B, B-, C+, C, C-, D, F
7. processScore is 0–100 (should roughly map: A=85–100, B=70–84, C=55–69, D=40–54, F=0–39)`

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

  let grade = 'C'
  let processScore = 60
  let analysis: PostmortemAnalysis = {
    whatWorked: [],
    whatMissed: [],
    ruleReferences: [],
    nextTimeTip: '',
    honestSummary: '',
  }

  try {
    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1200,
      system: `You are a trading coach. You grade process, not outcome. You are direct but not harsh. Your output is STRICT JSON matching the requested schema — no markdown, no commentary outside the JSON.`,
      messages: [{ role: 'user', content: prompt }],
    })

    const text = (msg.content[0] as { type: string; text: string }).text
    const clean = text.replace(/```json|```/g, '').trim()
    const result = JSON.parse(clean)

    // Validate response structure before trusting it
    if (typeof result.grade === 'string' && ['A+','A','A-','B+','B','B-','C+','C','C-','D','F'].includes(result.grade)) {
      grade = result.grade
    }
    if (typeof result.processScore === 'number' && result.processScore >= 0 && result.processScore <= 100) {
      processScore = Math.round(result.processScore)
    }
    if (result.analysis && typeof result.analysis === 'object') {
      analysis = {
        whatWorked: Array.isArray(result.analysis.whatWorked) ? result.analysis.whatWorked.slice(0, 5) : [],
        whatMissed: Array.isArray(result.analysis.whatMissed) ? result.analysis.whatMissed.slice(0, 5) : [],
        ruleReferences: Array.isArray(result.analysis.ruleReferences)
          ? result.analysis.ruleReferences.slice(0, 4).filter((r: { lessonId?: string; lessonTitle?: string; reason?: string }) =>
              r && typeof r.lessonId === 'string' && typeof r.lessonTitle === 'string')
          : [],
        nextTimeTip: typeof result.analysis.nextTimeTip === 'string' ? result.analysis.nextTimeTip : '',
        honestSummary: typeof result.analysis.honestSummary === 'string' ? result.analysis.honestSummary : '',
      }
    }
  } catch (err) {
    console.error('[analyze-trade] Claude call failed:', err)
    // Fall through with defaults — we still persist a placeholder post-mortem
    // so the UI doesn't keep polling forever
    analysis.honestSummary = 'Post-mortem generation temporarily unavailable. Your trade result is recorded — review the lessons at your tier for general guidance.'
    analysis.nextTimeTip = 'Return to this trade later; the analyzer will generate a full review on the next attempt.'
  }

  // ── Persist to cache
  const { data: saved, error: insertErr } = await admin
    .from('invest_trade_postmortems')
    .insert({
      user_id: user.id,
      trade_id: tradeId,
      grade,
      process_score: processScore,
      outcome,
      analysis,
      tier_at_trade: tierAtClose.name,
    })
    .select()
    .single()

  if (insertErr) {
    console.error('[analyze-trade] insert failed:', insertErr)
    // Return the computed result even if persistence failed
    return NextResponse.json({
      postmortem: {
        trade_id: tradeId,
        grade,
        process_score: processScore,
        outcome,
        analysis,
        tier_at_trade: tierAtClose.name,
        generated_at: new Date().toISOString(),
      },
      cached: false,
      persistError: insertErr.message,
    })
  }

  return NextResponse.json({ postmortem: saved, cached: false })
}
