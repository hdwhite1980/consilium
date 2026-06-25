// =============================================================
// app/lib/trading/reentry-verdict.ts
//
// Focused re-entry decision — a single Claude call, NOT the full Council.
// After the monitor signal-exits a position, this decides whether to get back
// in, and if so AT WHAT PRICE. It is told:
//   - the original thesis (from verdict_log)
//   - that it ENTERED and then EXITED, and the exit price
//   - whether this is a DAY or SWING trade
//   - the current technicals for the trade's own timeframes (the charts)
//
// It returns a fresh entry/stop/target or STAY_OUT. The point is discipline:
// re-enter only on a clean fresh setup at a sensible price — never just because
// we were in the name before, and never by chasing.
// =============================================================

import Anthropic from '@anthropic-ai/sdk'
import type { TechnicalSignals } from '@/app/lib/signals/technicals'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

export interface ReentryOriginalVerdict {
  signal: string
  confidence: number | null
  entry_price: number | null
  stop_loss: number | null
  take_profit: number | null
}

export interface ReentryDecision {
  decision: 'reenter' | 'stay_out'
  entry: number | null
  stop: number | null
  target: number | null
  confidence: number
  reasons: string[]
}

function summarizeTech(label: string, t: TechnicalSignals): string {
  const lines: string[] = [`${label}:`]
  lines.push(`  price ${t.currentPrice?.toFixed(4)} | vs SMA50 ${t.priceVsSma50?.toFixed(1)}% | RSI ${t.rsi?.toFixed(0)} (${t.rsiSignal})`)
  lines.push(`  MACD ${t.macdCrossover} (hist ${t.macdHistogram?.toFixed(4)}) | EMA9/20 ${t.ema9CrossEma20}`)
  lines.push(`  SMA20 ${t.sma20?.toFixed(4)} / SMA50 ${t.sma50?.toFixed(4)} / SMA200 ${t.sma200?.toFixed(4)}`)
  lines.push(`  ATR ${t.atrPct?.toFixed(2)}% (${t.atrSignal}) | volume ${t.volumeSignal} (${t.volumeRatio?.toFixed(2)}x)`)
  if (t.chartPattern) lines.push(`  pattern: ${t.chartPattern.name} [${t.chartPattern.type}]`)
  return lines.join('\n')
}

export async function evaluateReentry(params: {
  ticker: string
  side: 'buy' | 'sell'
  tradeType: 'day' | 'swing'
  original: ReentryOriginalVerdict | null
  exitPrice: number | null
  exitAt: string
  currentPrice: number
  techFast: TechnicalSignals
  techSlow: TechnicalSignals
  fastLabel: string
  slowLabel: string
}): Promise<ReentryDecision> {
  const { ticker, side, tradeType, original, exitPrice, exitAt, currentPrice, techFast, techSlow, fastLabel, slowLabel } = params
  const dir = side === 'buy' ? 'LONG' : 'SHORT'
  const exitMinsAgo = Number.isFinite(new Date(exitAt).getTime())
    ? Math.round((Date.now() - new Date(exitAt).getTime()) / 60000) : null

  const originalBlock = original
    ? `ORIGINAL THESIS:
  - Signal: ${original.signal} | Confidence: ${original.confidence ?? '?'}%
  - Entry: ${original.entry_price !== null ? '$' + original.entry_price.toFixed(4) : 'n/a'} | Stop: ${original.stop_loss !== null ? '$' + original.stop_loss.toFixed(4) : 'n/a'} | Target: ${original.take_profit !== null ? '$' + original.take_profit.toFixed(4) : 'n/a'}`
    : `ORIGINAL THESIS: none recorded — judge the current setup on its own merit.`

  const system = `You decide whether to RE-ENTER a ${tradeType.toUpperCase()} ${dir} trade that was just exited, and if so at what price.

This is a re-entry, so the bar is HIGHER than a fresh entry:
  - Re-enter ONLY if there is a clean, current ${dir === 'LONG' ? 'bullish' : 'bearish'} setup on the trade's own timeframes — not merely because we held it before.
  - Do NOT chase. If price has already run past a sensible entry, STAY OUT and wait.
  - You know the exit price. Re-entering ${dir === 'LONG' ? 'higher' : 'lower'} than you exited is only justified by a genuinely stronger fresh signal.
  - For a DAY trade, levels must be intraday-tight (stop/target sized to the ${fastLabel}/${slowLabel} structure, not multi-day swings). For a SWING trade, levels can breathe.
  - The stop must be on the protective side (below entry for LONG, above for SHORT) and the target on the profit side. Risk:reward should be at least ~1.5:1.

Return JSON only, no preamble or markdown.`

  const user = `Re-entry evaluation for ${ticker} (${tradeType} ${dir}):

${originalBlock}

POSITION HISTORY: entered, then EXITED at ${exitPrice !== null ? '$' + exitPrice.toFixed(4) : 'unknown'}${exitMinsAgo !== null ? ` (${exitMinsAgo} min ago)` : ''}. Current price $${currentPrice.toFixed(4)}.

CURRENT CHARTS (${tradeType} timeframes):
${summarizeTech(fastLabel, techFast)}
${summarizeTech(slowLabel, techSlow)}

Decide whether to re-enter. If yes, give a concrete entry (where to get back in), stop, and target. If the setup isn't clean or it would be chasing, stay out.

Return JSON:
{
  "decision": "reenter" | "stay_out",
  "entry": number | null,
  "stop": number | null,
  "target": number | null,
  "confidence": 0-100,
  "reasons": ["short reason citing specific indicators", "..."]
}`

  try {
    const msg = await anthropic.messages.create({
      model: process.env.ANTHROPIC_SONNET_MODEL ?? 'claude-sonnet-4-6',
      max_tokens: 700,
      system,
      messages: [{ role: 'user', content: user }],
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const text = (msg.content[0] as any).text as string
    const clean = text.replace(/```json|```/g, '').trim()
    const start = clean.indexOf('{'), end = clean.lastIndexOf('}')
    if (start === -1 || end === -1) throw new Error('No JSON in response')
    const p = JSON.parse(clean.slice(start, end + 1))

    const reasons = Array.isArray(p.reasons) ? p.reasons.filter((r: unknown) => typeof r === 'string').slice(0, 5) : []
    const confidence = typeof p.confidence === 'number' ? Math.max(0, Math.min(100, Math.round(p.confidence))) : 50
    const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null)
    const entry = num(p.entry), stop = num(p.stop), target = num(p.target)

    // Validate: a re-enter must carry a coherent, correctly-sided level set.
    if (p.decision === 'reenter' && entry !== null && stop !== null && target !== null) {
      const sided = side === 'buy' ? (stop < entry && target > entry) : (stop > entry && target < entry)
      const rr = Math.abs(target - entry) / Math.max(Math.abs(entry - stop), 1e-9)
      if (sided && rr >= 1.4) {
        return { decision: 'reenter', entry, stop, target, confidence, reasons }
      }
      // Levels incoherent → don't trust the re-enter; stay out.
      return { decision: 'stay_out', entry: null, stop: null, target: null, confidence, reasons: [...reasons, 'levels failed validation'] }
    }
    return { decision: 'stay_out', entry: null, stop: null, target: null, confidence, reasons }
  } catch (e) {
    console.warn(`[reentry-verdict] ${ticker} eval failed:`, (e as Error).message?.slice(0, 100))
    // Conservative fallback — do not re-enter on an error.
    return { decision: 'stay_out', entry: null, stop: null, target: null, confidence: 0, reasons: ['verdict error — staying out'] }
  }
}
