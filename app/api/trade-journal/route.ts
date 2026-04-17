import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/app/lib/auth/server'
import { createClient as createAdmin } from '@supabase/supabase-js'
import Anthropic from '@anthropic-ai/sdk'

function getAdmin() {
  return createAdmin(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
}

// GET — fetch journal entries
export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const limit = parseInt(searchParams.get('limit') || '20')
  const ticker = searchParams.get('ticker')

  let query = getAdmin()
    .from('trade_journal')
    .select('*')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (ticker) query = query.eq('ticker', ticker.toUpperCase())

  const { data, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Compute stats
  const resolved = (data || []).filter(e => e.outcome !== 'pending')
  const wins = resolved.filter(e => e.outcome === 'win').length
  const winRate = resolved.length > 0 ? Math.round((wins / resolved.length) * 100) : null
  const avgPnl = resolved.length > 0
    ? parseFloat((resolved.reduce((sum, e) => sum + (e.pnl_percent || 0), 0) / resolved.length).toFixed(1))
    : null

  return NextResponse.json({ entries: data || [], stats: { winRate, avgPnl, totalTrades: resolved.length } })
}

// POST — add entry or update outcome + trigger post-mortem
export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json()
  const admin = getAdmin()

  // Add new entry from a verdict
  if (body.action === 'add') {
    const isOption = body.position_type === 'option'
    const row: Record<string, unknown> = {
      user_id: user.id,
      verdict_log_id: body.verdict_log_id || null,
      ticker: body.ticker.toUpperCase(),
      signal: body.signal,
      entry_price: body.entry_price || null,
      stop_loss: body.stop_loss || null,
      take_profit: body.take_profit || null,
      timeframe: body.timeframe || null,
      confidence: body.confidence || null,
      outcome: 'pending',
      position_type: body.position_type || 'stock',
      notes: body.notes || null,
    }
    if (isOption) {
      row.option_type     = body.option_type || null
      row.strike          = body.strike ? parseFloat(body.strike) : null
      row.expiry          = body.expiry || null
      row.contracts       = body.contracts ? parseInt(body.contracts) : 1
      row.entry_premium   = body.entry_premium ? parseFloat(body.entry_premium) : null
      row.underlying      = (body.underlying || body.ticker).toUpperCase()
    }

    const { data, error } = await admin.from('trade_journal').insert(row).select('id').single()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true, id: data.id })
  }

  // Resolve an entry + trigger post-mortem
  if (body.action === 'resolve') {
    const { id, exit_price, outcome, notes } = body

    // Fetch original entry
    const { data: entry } = await admin
      .from('trade_journal')
      .select('*')
      .eq('id', id)
      .eq('user_id', user.id)
      .single()

    if (!entry) return NextResponse.json({ error: 'Entry not found' }, { status: 404 })

    // For options: P&L is based on premium change, not underlying price
    let pnlPercent: number | null = null
    if (entry.position_type === 'option' && entry.entry_premium && body.exit_premium) {
      const ep = parseFloat(body.exit_premium)
      pnlPercent = parseFloat(((ep - entry.entry_premium) / entry.entry_premium * 100).toFixed(2))
    } else if (entry.entry_price && exit_price) {
      pnlPercent = parseFloat(((exit_price - entry.entry_price) / entry.entry_price * 100 * (entry.signal === 'BEARISH' ? -1 : 1)).toFixed(2))
    }

    // Generate AI post-mortem
    const postmortem = await generatePostMortem(entry, exit_price, outcome, pnlPercent)

    const resolveUpdate: Record<string, unknown> = {
      exit_price,
      exit_date: new Date().toISOString(),
      outcome,
      pnl_percent: pnlPercent,
      notes: notes || entry.notes,
      postmortem,
      updated_at: new Date().toISOString(),
    }
    if (body.exit_premium != null) resolveUpdate.exit_premium = parseFloat(body.exit_premium)

    await admin.from('trade_journal').update(resolveUpdate).eq('id', id).eq('user_id', user.id)

    return NextResponse.json({ ok: true, postmortem })
  }

  // Update notes/tags
  if (body.action === 'update') {
    await admin.from('trade_journal').update({
      notes: body.notes,
      tags: body.tags,
      updated_at: new Date().toISOString(),
    }).eq('id', body.id).eq('user_id', user.id)
    return NextResponse.json({ ok: true })
  }

  // Delete entry
  if (body.action === 'delete') {
    await admin.from('trade_journal').delete().eq('id', body.id).eq('user_id', user.id)
    return NextResponse.json({ ok: true })
  }

  return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
}

async function generatePostMortem(
  entry: any,
  exitPrice: number,
  outcome: string,
  pnlPercent: number | null
): Promise<object> {
  try {
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })
    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 600,
      messages: [{
        role: 'user',
        content: `You are a trading coach reviewing a completed trade for the Wali-OS AI council. Provide an honest, specific post-mortem.

TRADE DETAILS:
Ticker: ${entry.ticker}
Signal: ${entry.signal}
Timeframe: ${entry.timeframe}
Council confidence: ${entry.confidence}%
Entry price: $${entry.entry_price}
Stop loss: $${entry.stop_loss}
Take profit: $${entry.take_profit}
Exit price: $${exitPrice}
Outcome: ${outcome.toUpperCase()}
P&L: ${pnlPercent !== null ? `${pnlPercent > 0 ? '+' : ''}${pnlPercent}%` : 'N/A'}

Respond with JSON only:
{
  "what_worked": "What the council analysis got right (1-2 sentences, specific)",
  "what_missed": "What the council missed or underweighted (1-2 sentences, specific)",
  "key_lesson": "The single most important lesson from this trade (1 sentence)",
  "signal_quality": "high|medium|low",
  "council_grade": "A|B|C|D",
  "improve_next_time": "Specific thing to look for next time in a similar setup (1 sentence)",
  "pattern_note": "Any pattern this trade confirms or refutes in the council's methodology (1 sentence)"
}`
      }]
    })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const textBlock = msg.content.find((b: any) => b.type === 'text') as { text: string } | undefined
    const raw = textBlock?.text || ''
    const clean = raw.replace(/```json|```/g, '').trim()
    const start = clean.indexOf('{')
    const end = clean.lastIndexOf('}')
    return start !== -1 ? JSON.parse(clean.slice(start, end + 1)) : {}
  } catch {
    return { what_worked: 'N/A', what_missed: 'N/A', key_lesson: 'N/A', signal_quality: 'medium', council_grade: 'C' }
  }
}
