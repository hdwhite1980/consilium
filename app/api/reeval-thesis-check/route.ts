// =============================================================
// app/api/reeval-thesis-check/route.ts
//
// Synchronous thesis-check for an open position. Given an original
// verdict + current state, asks the LLM: "Is your original thesis
// still intact, weakened, or invalidated? What action should we take?"
//
// This is NOT a fresh Council run. It's a constrained second-look at
// an existing thesis. The LLM is asked to evaluate specific claims
// from the original verdict against fresh data — not to re-analyze
// the stock from scratch.
//
// Runtime: 3-5 seconds. Single Sonnet 4 call.
//
// Persists to verdict_log with code_era='thesis-check' so reeval
// decisions are auditable in the track record.
//
// Auth: session OR service (CRON_SECRET + X-Service-* headers).
// =============================================================

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/app/lib/admin/admin-auth'
import { createClient as createAuthClient } from '@/app/lib/auth/server'
import Anthropic from '@anthropic-ai/sdk'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 30

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

export type ThesisStatus = 'intact' | 'weakened' | 'invalidated'
export type ThesisAction = 'hold' | 'tighten_stop' | 'early_exit' | 'add'

export interface ThesisCheckRequest {
  verdictId: number          // original verdict_log.id
  currentPrice: number
  unrealizedPnlPct: number   // % of position value
  triggersFired: string[]    // what triggered the re-eval
  // Optional context — caller can supply, otherwise we fetch
  freshTechnicals?: {
    rsi?: number
    macdHistogram?: number
    priceVsSma20?: number
    priceVsSma50?: number
    volumeRatio?: number
    priceChange1d?: number
  }
  freshNewsHeadlines?: string[]  // headlines from last N minutes
}

export interface ThesisCheckResponse {
  ok: boolean
  thesisStatus: ThesisStatus
  action: ThesisAction
  confidence: number               // 0-100
  rationale: string
  newVerdictId: number | null      // verdict_log.id of the persisted thesis-check
  error?: string
}

// ─────────────────────────────────────────────────────────────
// Auth: session OR service
// ─────────────────────────────────────────────────────────────

async function resolveUserId(req: NextRequest): Promise<{ userId: string | null; source: string }> {
  const authHeader = req.headers.get('authorization') ?? ''
  const serviceTrigger = req.headers.get('x-service-trigger')
  const serviceUserId = req.headers.get('x-service-user-id')
  const expectedAuth = `Bearer ${process.env.CRON_SECRET ?? ''}`
  if (
    process.env.CRON_SECRET &&
    authHeader === expectedAuth &&
    serviceTrigger &&
    serviceUserId
  ) {
    return { userId: serviceUserId, source: 'service' }
  }
  try {
    const supa = await createAuthClient()
    const { data: { user } } = await supa.auth.getUser()
    return { userId: user?.id ?? null, source: user ? 'session' : 'anonymous' }
  } catch {
    return { userId: null, source: 'anonymous' }
  }
}

// ─────────────────────────────────────────────────────────────
// Original verdict loader
// ─────────────────────────────────────────────────────────────

interface OriginalVerdict {
  id: number
  user_id: string
  ticker: string
  signal: string
  confidence: number
  entry_price: number | null
  stop_loss: number | null
  take_profit: number | null
  time_horizon: string | null
  timeframe: string | null
  trader_decision: string | null
  trader_grade: string | null
  trader_rationale: string | null
  trader_pass_reasons: unknown
  trader_risk_reward: number | null
  created_at: string
}

async function loadOriginalVerdict(verdictId: number, userId: string): Promise<OriginalVerdict | null> {
  const admin = await getSupabaseAdmin()
  const { data, error } = await admin
    .from('verdict_log')
    .select('id, user_id, ticker, signal, confidence, entry_price, stop_loss, take_profit, time_horizon, timeframe, trader_decision, trader_grade, trader_rationale, trader_pass_reasons, trader_risk_reward, created_at')
    .eq('id', verdictId)
    .eq('user_id', userId)
    .maybeSingle()
  if (error || !data) return null
  const r = data as Record<string, unknown>
  return {
    id: Number(r.id),
    user_id: String(r.user_id),
    ticker: String(r.ticker),
    signal: String(r.signal),
    confidence: Number(r.confidence ?? 0),
    entry_price: r.entry_price !== null && r.entry_price !== undefined ? Number(r.entry_price) : null,
    stop_loss: r.stop_loss !== null && r.stop_loss !== undefined ? Number(r.stop_loss) : null,
    take_profit: r.take_profit !== null && r.take_profit !== undefined ? Number(r.take_profit) : null,
    time_horizon: r.time_horizon ? String(r.time_horizon) : null,
    timeframe: r.timeframe ? String(r.timeframe) : null,
    trader_decision: r.trader_decision ? String(r.trader_decision) : null,
    trader_grade: r.trader_grade ? String(r.trader_grade) : null,
    trader_rationale: r.trader_rationale ? String(r.trader_rationale) : null,
    trader_pass_reasons: r.trader_pass_reasons,
    trader_risk_reward: r.trader_risk_reward !== null && r.trader_risk_reward !== undefined ? Number(r.trader_risk_reward) : null,
    created_at: String(r.created_at),
  }
}

// ─────────────────────────────────────────────────────────────
// Prompt builders
// ─────────────────────────────────────────────────────────────

function formatAge(createdAt: string): string {
  const ms = Date.now() - new Date(createdAt).getTime()
  const min = Math.round(ms / 60_000)
  if (min < 60) return `${min} minutes ago`
  const h = Math.round(min / 60)
  if (h < 24) return `${h} hours ago`
  const d = Math.round(h / 24)
  return `${d} days ago`
}

function formatTech(t: ThesisCheckRequest['freshTechnicals']): string {
  if (!t) return 'No fresh technical data supplied.'
  const lines: string[] = []
  if (t.rsi !== undefined) lines.push(`RSI: ${t.rsi.toFixed(0)}`)
  if (t.macdHistogram !== undefined) lines.push(`MACD histogram: ${t.macdHistogram.toFixed(3)}`)
  if (t.priceVsSma20 !== undefined) lines.push(`Price vs SMA20: ${t.priceVsSma20 > 0 ? '+' : ''}${t.priceVsSma20.toFixed(1)}%`)
  if (t.priceVsSma50 !== undefined) lines.push(`Price vs SMA50: ${t.priceVsSma50 > 0 ? '+' : ''}${t.priceVsSma50.toFixed(1)}%`)
  if (t.volumeRatio !== undefined) lines.push(`Volume vs avg: ${t.volumeRatio.toFixed(2)}x`)
  if (t.priceChange1d !== undefined) lines.push(`1-day change: ${t.priceChange1d > 0 ? '+' : ''}${t.priceChange1d.toFixed(2)}%`)
  return lines.length > 0 ? lines.join(', ') : 'No technical fields populated.'
}

function buildPrompt(orig: OriginalVerdict, req: ThesisCheckRequest): string {
  const ageStr = formatAge(orig.created_at)
  const passReasons = Array.isArray(orig.trader_pass_reasons) ? orig.trader_pass_reasons : []
  const passReasonsBlock = passReasons.length > 0
    ? `\n  Trader noted concerns: ${passReasons.slice(0, 3).map(r => String(r).slice(0, 150)).join(' | ')}`
    : ''

  return `You are reviewing an OPEN trade that the Council previously authorized. Your job is NOT to re-analyze the stock from scratch — it is to check whether the SPECIFIC thesis behind the original verdict is still intact, given what has happened since.

ORIGINAL VERDICT (${ageStr}):
  Ticker: ${orig.ticker}
  Signal: ${orig.signal} · Confidence: ${orig.confidence}%
  Timeframe: ${orig.timeframe ?? 'unknown'} · Horizon: ${orig.time_horizon ?? 'unknown'}
  Trade plan: entry $${orig.entry_price?.toFixed(2) ?? '?'} · stop $${orig.stop_loss?.toFixed(2) ?? '?'} · target $${orig.take_profit?.toFixed(2) ?? '?'}
  Trader: ${orig.trader_decision ?? 'unknown'} grade=${orig.trader_grade ?? '?'} R:R=${orig.trader_risk_reward?.toFixed(2) ?? '?'}${passReasonsBlock}
  Trader rationale: "${(orig.trader_rationale ?? '').slice(0, 800)}"

WHAT HAS HAPPENED SINCE:
  Current price: $${req.currentPrice.toFixed(2)}
  Unrealized P&L: ${req.unrealizedPnlPct > 0 ? '+' : ''}${req.unrealizedPnlPct.toFixed(2)}%
  Re-evaluation triggered by: ${req.triggersFired.length > 0 ? req.triggersFired.join('; ') : 'scheduled check'}

FRESH TECHNICAL SIGNALS:
  ${formatTech(req.freshTechnicals)}

FRESH NEWS (last 30 min):
${req.freshNewsHeadlines && req.freshNewsHeadlines.length > 0
  ? req.freshNewsHeadlines.slice(0, 5).map(h => `  - ${h.slice(0, 200)}`).join('\n')
  : '  (no fresh ticker-specific news)'}

YOUR TASK:
Identify the 2-4 specific claims or assumptions in the original Trader rationale. For each, decide whether new evidence supports it, weakens it, contradicts it, or doesn't speak to it. Then make an overall determination.

CONSTRAINTS:
- DO NOT generate a fresh thesis. Your job is to check the existing one.
- DO NOT recommend "exit" just because the trade is down — drawdown alone is not invalidation. Stops handle drawdown.
- An "invalidated" thesis means SPECIFIC original reasoning is now demonstrably wrong (e.g., "earnings beat" — and earnings just missed; "technical breakout" — and it broke back below the breakout level).
- A "weakened" thesis means some supporting evidence has eroded but the core is still defensible.
- An "intact" thesis means the core reasoning still holds even if price has wiggled.
- Action recommendations:
  * "hold": thesis intact OR weakened but stop is still appropriate — let the bracket work
  * "tighten_stop": thesis weakened — pull stop toward break-even to protect profits / cap loss
  * "early_exit": thesis invalidated — exit before stop, the trade is wrong
  * "add": thesis MORE supported than at entry (rare) — add to position

Respond with STRICT JSON (no markdown, no preamble):
{
  "thesis_check": [
    { "claim": "...", "status": "supported" | "weakened" | "contradicted" | "no_new_info", "note": "1 sentence" }
  ],
  "thesis_status": "intact" | "weakened" | "invalidated",
  "action": "hold" | "tighten_stop" | "early_exit" | "add",
  "confidence": <integer 0-100>,
  "rationale": "1-2 sentence summary of why this action"
}`
}

// ─────────────────────────────────────────────────────────────
// LLM call
// ─────────────────────────────────────────────────────────────

interface LLMResult {
  thesisStatus: ThesisStatus
  action: ThesisAction
  confidence: number
  rationale: string
  thesisCheck: unknown
}

async function callAnthropic(prompt: string): Promise<LLMResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set')
  const client = new Anthropic({ apiKey })
  const res = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1500,
    temperature: 0.2,
    messages: [{ role: 'user', content: prompt }],
  })
  const text = res.content
    .filter(b => b.type === 'text')
    .map(b => (b as { text: string }).text)
    .join('\n')

  // Strip markdown fences if present (defensive)
  const cleaned = text.replace(/```json\s*/i, '').replace(/```\s*$/i, '').trim()

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(cleaned)
  } catch (e) {
    throw new Error(`LLM returned non-JSON: ${cleaned.slice(0, 300)}`)
  }

  const ts = parsed.thesis_status
  const ac = parsed.action
  const cf = parsed.confidence
  const rt = parsed.rationale

  // Validate
  if (ts !== 'intact' && ts !== 'weakened' && ts !== 'invalidated') {
    throw new Error(`Invalid thesis_status: ${String(ts)}`)
  }
  if (ac !== 'hold' && ac !== 'tighten_stop' && ac !== 'early_exit' && ac !== 'add') {
    throw new Error(`Invalid action: ${String(ac)}`)
  }
  const conf = typeof cf === 'number' ? Math.round(cf) : 0
  if (!Number.isFinite(conf) || conf < 0 || conf > 100) {
    throw new Error(`Invalid confidence: ${String(cf)}`)
  }

  return {
    thesisStatus: ts as ThesisStatus,
    action: ac as ThesisAction,
    confidence: conf,
    rationale: typeof rt === 'string' ? rt.slice(0, 1000) : '',
    thesisCheck: parsed.thesis_check ?? null,
  }
}

// ─────────────────────────────────────────────────────────────
// Persistence — write to verdict_log with code_era='thesis-check'
// ─────────────────────────────────────────────────────────────

async function persistThesisCheck(
  orig: OriginalVerdict,
  req: ThesisCheckRequest,
  result: LLMResult,
): Promise<number | null> {
  const admin = await getSupabaseAdmin()
  // Map thesis action back to a signal so it shows up in track record sensibly
  const mappedSignal = result.action === 'early_exit'
    ? (orig.signal === 'BULLISH' ? 'BEARISH' : 'BULLISH')
    : orig.signal

  // trader_decision mapping: thesis-check is its own discipline gate;
  // intact → TAKE (continue), weakened → WAIT (cautious), invalidated → PASS
  const traderDecision = result.thesisStatus === 'intact' ? 'TAKE'
                       : result.thesisStatus === 'weakened' ? 'WAIT'
                       : 'PASS'

  const passReasons = [`thesis check action=${result.action}`, `triggers=${req.triggersFired.join('|')}`]

  const { data, error } = await admin
    .from('verdict_log')
    .insert({
      user_id: orig.user_id,
      ticker: orig.ticker,
      signal: mappedSignal,
      confidence: result.confidence,
      entry_price: req.currentPrice,
      stop_loss: orig.stop_loss,
      take_profit: orig.take_profit,
      time_horizon: orig.time_horizon,
      persona: 'balanced',
      timeframe: orig.timeframe,
      verdict_date: new Date().toISOString().slice(0, 10),
      trader_decision: traderDecision,
      trader_grade: null,
      trader_position_size: 0,
      trader_risk_reward: orig.trader_risk_reward,
      trader_pass_reasons: passReasons,
      trader_wait_conditions: [],
      trader_rationale: result.rationale,
      trader_evaluated_at: new Date().toISOString(),
      code_era: 'thesis-check',
      version_number: 4,
      original_verdict_id: orig.id,
    })
    .select('id')
    .single()
  if (error) {
    console.warn('[thesis-check] persist failed:', error.message)
    return null
  }
  return Number((data as { id: number }).id)
}

// ─────────────────────────────────────────────────────────────
// Route handler
// ─────────────────────────────────────────────────────────────

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = await resolveUserId(req)
  if (!auth.userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: ThesisCheckRequest
  try {
    body = await req.json() as ThesisCheckRequest
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  if (!body.verdictId || typeof body.verdictId !== 'number') {
    return NextResponse.json({ error: 'verdictId required (number)' }, { status: 400 })
  }
  if (!Number.isFinite(body.currentPrice) || body.currentPrice <= 0) {
    return NextResponse.json({ error: 'currentPrice required (positive number)' }, { status: 400 })
  }
  if (!Number.isFinite(body.unrealizedPnlPct)) {
    return NextResponse.json({ error: 'unrealizedPnlPct required (number)' }, { status: 400 })
  }
  if (!Array.isArray(body.triggersFired)) {
    return NextResponse.json({ error: 'triggersFired required (array)' }, { status: 400 })
  }

  try {
    const orig = await loadOriginalVerdict(body.verdictId, auth.userId)
    if (!orig) {
      return NextResponse.json({ error: `Original verdict ${body.verdictId} not found for user` }, { status: 404 })
    }

    const prompt = buildPrompt(orig, body)
    const llm = await callAnthropic(prompt)
    const newVerdictId = await persistThesisCheck(orig, body, llm)

    const response: ThesisCheckResponse = {
      ok: true,
      thesisStatus: llm.thesisStatus,
      action: llm.action,
      confidence: llm.confidence,
      rationale: llm.rationale,
      newVerdictId,
    }
    console.log(`[thesis-check] user=${auth.userId} ${orig.ticker} verdict=${orig.id} → status=${llm.thesisStatus} action=${llm.action} conf=${llm.confidence} newVerdict=${newVerdictId}`)
    return NextResponse.json(response)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.error('[thesis-check] failed:', msg)
    return NextResponse.json({
      ok: false,
      thesisStatus: 'intact' as ThesisStatus,   // safe default
      action: 'hold' as ThesisAction,
      confidence: 0,
      rationale: `thesis-check error: ${msg.slice(0, 300)}`,
      newVerdictId: null,
      error: msg.slice(0, 500),
    }, { status: 500 })
  }
}
