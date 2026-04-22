// ═════════════════════════════════════════════════════════════
// app/lib/exit-signals.ts
//
// Evaluates whether a watchlist stock should be held, watched,
// or exited. Uses the EXACT same technicals the Council view shows
// (calculateTechnicals from app/lib/signals/technicals.ts) so the
// watchlist indicator table is data-consistent with /analyze.
//
// Flow per ticker:
//   1. Fetch daily bars via the same fetchBars helper aggregator uses
//   2. Call calculateTechnicals(bars) — identical to Council view
//   3. Pull user's most recent verdict_log for this ticker
//   4. Claude Sonnet 4 evaluates: has the original thesis broken?
//   5. Return { exitLevel, technicals, reasons, thesisStatus }
//
// Called in parallel from /api/watchlist/compute for every active entry.
// ═════════════════════════════════════════════════════════════

import Anthropic from '@anthropic-ai/sdk'
import { fetchBars } from '@/app/lib/data/alpaca'
import { calculateTechnicals, type TechnicalSignals } from '@/app/lib/signals/technicals'
import { createClient as createAdmin } from '@supabase/supabase-js'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

const getAdmin = () => createAdmin(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────
export type ExitLevel = 'hold' | 'watch' | 'exit'
export type ThesisStatus = 'intact' | 'weakening' | 'broken'

export interface ExitEvaluation {
  ticker: string
  userId: string
  exitLevel: ExitLevel
  exitConfidence: number                // 0-100
  exitReasons: string[]                 // 2-5 short reasons
  thesisStatus: ThesisStatus
  currentPrice: number
  priceChange1dPct: number
  priceChangeSinceVerdictPct: number | null
  technicals: TechnicalSignals
  originalVerdictId: number | null
  originalSignal: string | null
  originalConfidence: number | null
  computedAt: string
}

interface OriginalVerdict {
  id: number
  signal: string
  confidence: number
  entry_price: number | null
  created_at: string
}

// ─────────────────────────────────────────────────────────────
// Pull user's most recent verdict for this ticker
// ─────────────────────────────────────────────────────────────
async function getLatestVerdict(userId: string, ticker: string): Promise<OriginalVerdict | null> {
  try {
    const admin = getAdmin()
    const { data, error } = await admin
      .from('verdict_log')
      .select('id, signal, confidence, entry_price, created_at')
      .eq('user_id', userId)
      .eq('ticker', ticker.toUpperCase())
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (error || !data) return null
    return data as OriginalVerdict
  } catch {
    return null
  }
}

// ─────────────────────────────────────────────────────────────
// Build a compact summary of technicals for Claude's prompt
// Uses the same fields displayed on /analyze for consistency.
// ─────────────────────────────────────────────────────────────
function summarizeTechnicalsForPrompt(t: TechnicalSignals): string {
  const lines: string[] = []

  lines.push(`Current price: $${t.currentPrice.toFixed(2)} (${t.priceChange1D >= 0 ? '+' : ''}${t.priceChange1D.toFixed(2)}% 1D, ${t.priceChangePeriod >= 0 ? '+' : ''}${t.priceChangePeriod.toFixed(2)}% period)`)
  lines.push(`52w: $${t.low52w.toFixed(2)} - $${t.high52w.toFixed(2)} (${t.distFromHigh.toFixed(1)}% from high, +${t.distFromLow.toFixed(1)}% from low)`)

  lines.push(`Moving averages: SMA20 ${t.priceVsSma20 >= 0 ? '+' : ''}${t.priceVsSma20.toFixed(1)}%, SMA50 ${t.priceVsSma50 >= 0 ? '+' : ''}${t.priceVsSma50.toFixed(1)}%, SMA200 ${t.priceVsSma200 >= 0 ? '+' : ''}${t.priceVsSma200.toFixed(1)}%`)
  if (t.goldenCross) lines.push(`  → Golden Cross detected (SMA50 above SMA200)`)
  if (t.deathCross) lines.push(`  → DEATH CROSS detected (SMA50 below SMA200)`)
  if (t.ema9CrossEma20 !== 'none') lines.push(`  → EMA 9/20 cross: ${t.ema9CrossEma20}`)

  lines.push(`Momentum:`)
  lines.push(`  RSI(14): ${t.rsi.toFixed(1)} [${t.rsiSignal}]`)
  lines.push(`  MACD: line ${t.macdLine.toFixed(3)}, signal ${t.macdSignal.toFixed(3)}, hist ${t.macdHistogram.toFixed(3)} [${t.macdCrossover}]`)
  lines.push(`  Stoch: %K ${t.stochK.toFixed(1)}, %D ${t.stochD.toFixed(1)} [${t.stochSignal}${t.stochCrossover !== 'none' ? ', ' + t.stochCrossover + ' cross' : ''}]`)
  lines.push(`  Williams %R: ${t.williamsR.toFixed(1)} [${t.williamsSignal}]`)
  lines.push(`  CCI: ${t.cci.toFixed(0)} [${t.cciSignal}]`)
  lines.push(`  ROC 10d: ${t.roc10.toFixed(1)}%, 20d: ${t.roc20.toFixed(1)}% [${t.rocSignal}]`)

  lines.push(`Volatility: ATR ${t.atr14.toFixed(2)} (${t.atrPct.toFixed(2)}%) [${t.atrSignal}], Bollinger ${t.bbSignal}, BB position ${t.bbPosition.toFixed(2)}`)

  lines.push(`Ichimoku: ${t.ichimokuSignal}${t.ichimokuCross !== 'none' ? ', TK cross ' + t.ichimokuCross : ''}`)

  lines.push(`Volume: ${t.volumeRatio.toFixed(2)}x 20-day avg [${t.volumeSignal}]`)
  lines.push(`OBV trend: ${t.obvTrend}${t.obvDivergence !== 'none' ? ', divergence: ' + t.obvDivergence : ''}`)

  lines.push(`VWAP: ${t.priceVsVwap >= 0 ? '+' : ''}${t.priceVsVwap.toFixed(2)}% [${t.vwapSignal}]`)

  lines.push(`Support: $${t.support.toFixed(2)} / $${t.support2.toFixed(2)}`)
  lines.push(`Resistance: $${t.resistance.toFixed(2)} / $${t.resistance2.toFixed(2)}`)
  lines.push(`Suggested ATR stop: $${t.stopLossATR.toFixed(2)}, target: $${t.takeProfitATR.toFixed(2)}`)

  if (t.relStrengthVsSector !== null) {
    lines.push(`Relative strength vs sector: ${t.relStrengthVsSector >= 0 ? '+' : ''}${t.relStrengthVsSector.toFixed(1)}% [${t.relStrengthSignal}]`)
  }

  if (t.candlePattern) {
    lines.push(`Candle pattern: ${t.candlePattern.name} [${t.candlePattern.type}] — ${t.candlePattern.description}`)
  }
  if (t.chartPattern) {
    lines.push(`Chart pattern: ${t.chartPattern.name} [${t.chartPattern.type}] — ${t.chartPattern.description}`)
  }
  if (t.gapPattern) {
    lines.push(`Gap: ${t.gapPattern.type} gap of ${t.gapPattern.size.toFixed(2)}% — ${t.gapPattern.description}`)
  }

  lines.push(`Overall technical bias: ${t.technicalBias} (score ${t.technicalScore.toFixed(0)})`)

  return lines.join('\n')
}

// ─────────────────────────────────────────────────────────────
// Claude evaluates: should user hold / watch / exit?
// ─────────────────────────────────────────────────────────────
async function claudeEvaluateExit(params: {
  ticker: string
  originalVerdict: OriginalVerdict | null
  technicals: TechnicalSignals
  daysSinceVerdict: number | null
  priceChangeSinceVerdict: number | null
}): Promise<{
  exitLevel: ExitLevel
  exitConfidence: number
  exitReasons: string[]
  thesisStatus: ThesisStatus
}> {
  const { ticker, originalVerdict, technicals, daysSinceVerdict, priceChangeSinceVerdict } = params
  const techBlock = summarizeTechnicalsForPrompt(technicals)

  const originalBlock = originalVerdict
    ? `ORIGINAL COUNCIL VERDICT (${daysSinceVerdict ?? '?'} days ago):
  - Signal: ${originalVerdict.signal}
  - Confidence: ${originalVerdict.confidence}%
  - Entry price: ${originalVerdict.entry_price !== null ? '$' + originalVerdict.entry_price.toFixed(2) : 'not recorded'}
  - Price change since verdict: ${priceChangeSinceVerdict !== null ? (priceChangeSinceVerdict >= 0 ? '+' : '') + priceChangeSinceVerdict.toFixed(2) + '%' : 'unknown'}`
    : `ORIGINAL COUNCIL VERDICT: none — this ticker was added to watchlist but hasn't been run through /analyze yet. Evaluate technicals on their own merit.`

  const system = `You evaluate whether a stock position should be HELD, WATCHED, or EXITED based on current technicals vs the original Council thesis.

Framework:
  - "exit" — Original thesis has broken. Clear evidence the setup failed (e.g., bullish thesis but death cross + RSI breakdown + volume confirming + key support lost).
  - "watch" — Thesis weakening. Warning signals appearing but not confirmed (e.g., RSI overbought + approaching resistance, but still above key MAs).
  - "hold" — Thesis intact. Current technicals align with or still support the original view.

Rules:
  - Prefer HOLD when evidence is mixed. False exits are expensive.
  - Use EXIT only when multiple indicators agree the thesis is broken.
  - If there's no original verdict, evaluate the technicals neutrally — overbought + bearish momentum = exit regardless.
  - Focus on divergences: bullish thesis + bearish technicals = problem.
  - Mention specific indicators by name in reasons (e.g., "RSI 78 overbought", "MACD bearish cross", "below SMA50").
  - Reasons should be concise — 5-12 words each.

Return JSON only, no preamble or markdown.`

  const user = `Evaluate ${ticker}:

${originalBlock}

CURRENT TECHNICALS (from calculateTechnicals, same as Council view):
${techBlock}

Decide: exit / watch / hold. Provide 2-5 concrete reasons citing specific indicators.

Return JSON:
{
  "exitLevel": "hold|watch|exit",
  "exitConfidence": 0-100,
  "exitReasons": ["short reason 1", "short reason 2", "short reason 3"],
  "thesisStatus": "intact|weakening|broken"
}`

  try {
    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 600,
      system,
      messages: [{ role: 'user', content: user }],
    })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const text = (msg.content[0] as any).text as string
    const clean = text.replace(/```json|```/g, '').trim()
    const start = clean.indexOf('{')
    const end = clean.lastIndexOf('}')
    if (start === -1 || end === -1) throw new Error('No JSON in response')

    const parsed = JSON.parse(clean.slice(start, end + 1))

    const level = ['hold', 'watch', 'exit'].includes(parsed.exitLevel) ? parsed.exitLevel : 'hold'
    const status = ['intact', 'weakening', 'broken'].includes(parsed.thesisStatus) ? parsed.thesisStatus : 'intact'
    const reasons = Array.isArray(parsed.exitReasons)
      ? parsed.exitReasons.filter((r: unknown) => typeof r === 'string').slice(0, 5)
      : []
    const confidence = typeof parsed.exitConfidence === 'number'
      ? Math.max(0, Math.min(100, Math.round(parsed.exitConfidence)))
      : 60

    return {
      exitLevel: level as ExitLevel,
      exitConfidence: confidence,
      exitReasons: reasons,
      thesisStatus: status as ThesisStatus,
    }
  } catch (e) {
    console.warn(`[exit-signals] Claude eval failed for ${ticker}:`, (e as Error).message?.slice(0, 100))
    // Conservative fallback — hold with low confidence
    return {
      exitLevel: 'hold',
      exitConfidence: 30,
      exitReasons: ['Unable to compute exit signal — defaulting to hold'],
      thesisStatus: 'intact',
    }
  }
}

// ─────────────────────────────────────────────────────────────
// Main entrypoint: evaluate one ticker for one user
// ─────────────────────────────────────────────────────────────
export async function evaluateExit(
  userId: string,
  ticker: string,
): Promise<ExitEvaluation | null> {
  const sym = ticker.toUpperCase()

  try {
    // Step 1: fetch daily bars using same helper aggregator uses
    const bars = await fetchBars(sym, '1M')
    if (!bars || bars.length < 20) {
      console.warn(`[exit-signals] insufficient bars for ${sym} (got ${bars?.length ?? 0})`)
      return null
    }

    // Step 2: compute technicals — IDENTICAL to Council view
    const technicals = calculateTechnicals(bars)
    if (!technicals.currentPrice || technicals.currentPrice <= 0) {
      console.warn(`[exit-signals] invalid price from technicals for ${sym}`)
      return null
    }

    // Step 3: pull user's original verdict (if any)
    const originalVerdict = await getLatestVerdict(userId, sym)

    // Step 4: compute deltas for prompt context
    let daysSinceVerdict: number | null = null
    let priceChangeSinceVerdict: number | null = null
    if (originalVerdict?.created_at) {
      daysSinceVerdict = Math.round(
        (Date.now() - new Date(originalVerdict.created_at).getTime()) / (1000 * 60 * 60 * 24)
      )
    }
    if (originalVerdict?.entry_price && originalVerdict.entry_price > 0) {
      priceChangeSinceVerdict = ((technicals.currentPrice - originalVerdict.entry_price)
        / originalVerdict.entry_price) * 100
    }

    // Step 5: Claude evaluates
    const evaluation = await claudeEvaluateExit({
      ticker: sym,
      originalVerdict,
      technicals,
      daysSinceVerdict,
      priceChangeSinceVerdict,
    })

    return {
      ticker: sym,
      userId,
      exitLevel: evaluation.exitLevel,
      exitConfidence: evaluation.exitConfidence,
      exitReasons: evaluation.exitReasons,
      thesisStatus: evaluation.thesisStatus,
      currentPrice: Math.round(technicals.currentPrice * 100) / 100,
      priceChange1dPct: Math.round(technicals.priceChange1D * 100) / 100,
      priceChangeSinceVerdictPct: priceChangeSinceVerdict !== null
        ? Math.round(priceChangeSinceVerdict * 100) / 100
        : null,
      technicals,
      originalVerdictId: originalVerdict?.id ?? null,
      originalSignal: originalVerdict?.signal ?? null,
      originalConfidence: originalVerdict?.confidence ?? null,
      computedAt: new Date().toISOString(),
    }
  } catch (e) {
    console.warn(`[exit-signals] evaluateExit failed for ${sym}:`, (e as Error).message?.slice(0, 120))
    return null
  }
}
