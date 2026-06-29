// =============================================================
// app/api/auto-trader/day-shark/max-chat/route.ts
//
// Interactive Max — chat with the day_shark persona. Claude (MAX_PERSONA_SYSTEM)
// answers in character, grounded in Max's REAL live state (open positions, P&L,
// milestone) so he talks about what he's actually doing, not made-up trades.
// =============================================================

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/app/lib/auth/server'
import { createClient as createAdmin } from '@supabase/supabase-js'
import { anthropic } from '@/app/lib/pipeline/llm'
import { MAX_PERSONA_SYSTEM, nextMilestone } from '@/app/lib/trading/day-shark'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MODEL = process.env.MAX_CHAT_MODEL || process.env.ANTHROPIC_SONNET_MODEL || 'claude-sonnet-4-6'
const CRYPTO_START = 50
const OPEN = ['placed', 'filled', 'partial_fill']
const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v) || 0)

function admin() {
  return createAdmin(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
}

// Assemble Max's REAL state so he speaks to what he's actually holding.
async function buildStateContext(userId: string): Promise<{ context: string; openTickers: string[] }> {
  const { data } = await admin()
    .from('trade_attempts')
    .select('ticker, asset_class, side, outcome, entry_price_est, filled_avg_price, stop_price, target_price, realized_pnl, created_at')
    .eq('user_id', userId)
    .eq('signal_source', 'day_shark')
    .order('created_at', { ascending: false })
    .limit(200)

  const rows = data ?? []
  const open = rows.filter(r => OPEN.includes(r.outcome))
  const closed = rows.filter(r => r.outcome === 'closed_win' || r.outcome === 'closed_loss')
  const wins = closed.filter(r => r.outcome === 'closed_win').length
  const losses = closed.filter(r => r.outcome === 'closed_loss').length
  const totalPnl = closed.reduce((s, r) => s + num(r.realized_pnl), 0)
  const cryptoPnl = closed.filter(r => r.asset_class === 'crypto').reduce((s, r) => s + num(r.realized_pnl), 0)
  const stake = CRYPTO_START + cryptoPnl
  const next = nextMilestone(stake, CRYPTO_START)

  const openTickers = open.map(r => String(r.ticker))
  const openLines = open.length
    ? open.map(r => `  - ${r.ticker} (${r.asset_class ?? 'stock'}, ${r.side ?? 'buy'}): entry ${num(r.filled_avg_price) || num(r.entry_price_est)}, stop ${r.stop_price}, target ${r.target_price}`).join('\n')
    : '  (nothing open right now)'

  const context = [
    'LIVE STATE — these are your REAL numbers. Speak only to these; do not invent positions or results:',
    `Crypto stake: $${stake.toFixed(2)} | chasing next milestone: $${next}`,
    `Record: ${wins}W / ${losses}L | realized P&L: $${totalPnl.toFixed(2)}`,
    `Open positions (${open.length}):`,
    openLines,
  ].join('\n')

  return { context, openTickers }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  let body: { message?: string; history?: Array<{ role: string; content: string }> }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'bad request' }, { status: 400 }) }

  const message = String(body.message ?? '').slice(0, 2000).trim()
  if (!message) return NextResponse.json({ error: 'empty message' }, { status: 400 })
  const history = Array.isArray(body.history) ? body.history.slice(-8) : []

  const { context, openTickers } = await buildStateContext(user.id)
  const system =
    `${MAX_PERSONA_SYSTEM}\n\n` +
    `You are chatting live with the trader who runs you. Stay fully in character: cocky, hungry, punchy, ruthless on losers, milestone-obsessed. NEVER promise or guarantee returns. You narrate decisions an automated system makes on a 1-day horizon; you never invent trades or override risk limits.\n\n` +
    `You can take three kinds of action, set in "action":\n` +
    `- The trader CLEARLY asks to sell/close/dump/exit ONE name you hold -> {"type":"close_one","ticker":"<TICKER>"}. Make "reply" a short CONFIRMATION ASK ("Want me to dump KEEL? Hit confirm and it's gone.").\n` +
    `- The trader asks to close EVERYTHING -> {"type":"close_all"}. Same confirmation-ask style.\n` +
    `- The trader asks you to RE-EVALUATE / re-check / get a fresh read / "is the thesis still good" on a name you HOLD -> {"type":"reeval","ticker":"<TICKER>"}. Make "reply" a short "on it" line ("Pulling a fresh read on MU now."). Do NOT make up the analysis yourself — the system runs the real check.\n` +
    `Only set an action on a clear instruction. If they're just chatting or asking about state you already have, action is null. NEVER invent a chart read or analysis in your reply — if they want your read on a name, that's a reeval action, not you guessing.\n\n` +
    `Respond with ONLY a JSON object, no markdown, no backticks:\n{"reply": "<your in-character line, 1-4 sentences>", "action": null | {"type":"close_one","ticker":"KEEL"} | {"type":"close_all"} | {"type":"reeval","ticker":"MU"}}\n\n` +
    context

  try {
    const msg = await anthropic().messages.create({
      model: MODEL,
      max_tokens: 350,
      system,
      messages: [
        ...history.map(h => ({
          role: h.role === 'assistant' ? ('assistant' as const) : ('user' as const),
          content: String(h.content ?? '').slice(0, 2000),
        })),
        { role: 'user' as const, content: message },
      ],
    })

    const raw = msg.content.filter(b => b.type === 'text').map(b => (b as { text: string }).text).join('\n').trim()

    // Parse the persona's JSON. If anything is off, degrade to plain reply + no action.
    let reply = raw
    let action:
      | { type: 'close_one'; ticker: string }
      | { type: 'close_all' }
      | { type: 'reeval'; ticker: string }
      | null = null
    try {
      const parsed = JSON.parse(raw.replace(/^```json\s*/i, '').replace(/```$/i, '').trim())
      if (parsed && typeof parsed.reply === 'string') reply = parsed.reply
      const a = parsed?.action
      if (a && a.type === 'close_all') {
        action = openTickers.length ? { type: 'close_all' } : null
      } else if (a && (a.type === 'close_one' || a.type === 'reeval') && typeof a.ticker === 'string') {
        // Validate against the REAL open book — never act on what isn't held.
        const match = openTickers.find(t => t.toUpperCase() === a.ticker.toUpperCase())
        action = match ? { type: a.type, ticker: match } : null
        if (!match) reply = `I\u2019m not holding ${a.ticker} right now. Open book: ${openTickers.join(', ') || 'nothing'}.`
      }
    } catch { /* not JSON — use raw as reply, no action */ }

    return NextResponse.json({ reply: reply || 'Tape\u2019s moving \u2014 say that again?', action })
  } catch (e) {
    console.error('[max-chat] error', e)
    return NextResponse.json({ error: 'Max is heads-down on the tape \u2014 give it a sec.' }, { status: 502 })
  }
}
