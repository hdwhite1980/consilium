import { NextRequest } from 'next/server'
import { buildSignalBundle, type SignalBundle } from '@/app/lib/aggregator'
import { buildFuturesAwareBundle } from '@/app/lib/pipeline/futures-router'
import { technicalsToPayload } from '@/app/lib/signals/technicals'
import { runPipeline } from '@/app/lib/pipeline'
import { runSocialScout } from '@/app/lib/social-scout'
import { createServerClient } from '@/app/lib/supabase'
import { createClient as createAuthClient } from '@/app/lib/auth/server'
import { CURRENT_VERSION_NUMBER } from '@/app/lib/system-versions'
import { evaluateTickerGate, evaluateBundleIntegrity } from '@/app/lib/ticker-gate'

export const maxDuration = 300

// ─────────────────────────────────────────────────────────────
// Dashboard projections — narrow subsets of fundamentals/smartMoney
// shaped for the SSE `market_data` payload sent to the browser.
//
// IMPORTANT: These are dashboard-only projections. The persisted
// `signal_bundle` JSON in the analyses table now carries the FULL
// fundamentals/smartMoney objects so:
//   - the model/Judge can cite specific dollar values
//     (insiderBuyValue, insiderSellValue, insiderNetValue)
//   - cache replay re-projects from the same full source as a
//     fresh run, ensuring shape parity
//   - downstream consumers (track-record analysis, future RAG)
//     see the same data the council saw
//
// If you change a dashboard field, change it HERE. Do not duplicate
// the projection logic in the cache-hit branch or the market_data
// emit — both call these helpers.
// ─────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function projectFundamentalsForDashboard(f: any) {
  if (!f) return null
  return {
    earningsDate: f.nextEarningsDate ?? f.earningsDate ?? null,
    daysToEarnings: f.daysToEarnings ?? null,
    earningsRisk: f.earningsRisk ?? null,
    earningsHour: f.earningsHour ?? null,
    earningsTimestamp: f.earningsTimestamp ?? null,
    hoursUntilEarnings: f.hoursUntilEarnings ?? null,
    epsEstimate: f.epsEstimate ?? null,
    epsActual: f.epsActual ?? null,
    revenueEstimate: f.revenueEstimate ?? null,
    revenueActual: f.revenueActual ?? null,
    analystConsensus: f.analystConsensus ?? null,
    analystUpside: f.analystUpside ?? null,
    analystBuy: f.analystBuy ?? null,
    analystHold: f.analystHold ?? null,
    analystSell: f.analystSell ?? null,
    peRatio: f.peRatio ?? null,
    consistentBeater: f.consistentBeater ?? null,
    avgSurprisePct: f.avgSurprisePct ?? null,
    insiderSignal: f.insiderSignal ?? null,
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function projectSmartMoneyForDashboard(sm: any) {
  if (!sm) return null
  return {
    insiderSignal: sm.insiderSignal ?? null,
    congressSignal: sm.congressSignal ?? null,
    congressTrades: Array.isArray(sm.congressionalTrades) ? sm.congressionalTrades.length : 0,
    notableHolders: sm.notableHolders ?? [],
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function projectOptionsForDashboard(of: any) {
  if (!of) return null
  return {
    putCallRatio: of.putCallRatio ?? null,
    putCallSignal: of.putCallSignal ?? null,
    shortInterestPct: of.shortInterestPct ?? null,
    shortSignal: of.shortSignal ?? null,
    unusualCount: Array.isArray(of.unusualActivity) ? of.unusualActivity.length : 0,
    unusualActivity: Array.isArray(of.unusualActivity) ? of.unusualActivity.slice(0, 3) : [],
    ivSignal: of.ivSignal ?? null,
    maxPainStrike: of.maxPainStrike ?? null,
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function projectMarketContextForDashboard(mc: any) {
  if (!mc) return null
  return {
    regime: mc.regime ?? null,
    spy: mc.spy ?? null,
    vix: mc.vix ?? null,
    sectorETF: mc.sectorETF ?? null,
    competitors: mc.competitors ?? null,
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function projectConvictionForDashboard(c: any) {
  if (!c) return null
  return {
    direction: c.direction ?? null,
    conviction: c.conviction ?? null,
    convergenceScore: c.convergenceScore ?? null,
    convergingSignals: c.convergingSignals ?? [],
    divergingSignals: c.divergingSignals ?? [],
    scenarios: c.scenarios ?? null,
    regime: c.regime ?? null,
    signals: Array.isArray(c.signals) ? c.signals.slice(0, 10) : [],
    invalidationConditions: c.invalidationConditions ?? null,
  }
}

// Build the full narrow dashboard payload from a SignalBundle (live path)
function buildDashboardPayloadFromBundle(bundle: SignalBundle) {
  return {
    technicals: technicalsToPayload(bundle.technicals, bundle.currentPrice),
    conviction: projectConvictionForDashboard(bundle.conviction),
    fundamentals: projectFundamentalsForDashboard(bundle.fundamentals),
    smartMoney: projectSmartMoneyForDashboard(bundle.smartMoney),
    options: projectOptionsForDashboard(bundle.optionsFlow),
    marketContext: projectMarketContextForDashboard(bundle.marketContext),
  }
}

// Build the same narrow dashboard payload from a persisted signal_bundle
// JSON (cache-hit path). signal_bundle now carries full fundamentals +
// smartMoney objects, so we re-project them here exactly like a fresh run.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildDashboardPayloadFromCache(sb: any) {
  if (!sb) return {
    technicals: null, conviction: null, fundamentals: null,
    smartMoney: null, options: null, marketContext: null,
    extendedHours: null,
  }
  // Bug 24 fix: read from full 'optionsFlow' first (current persistence shape),
  // fall back to legacy 'options' key for cache rows from before the rename.
  // Cache TTLs are 20-60 min so the fallback only matters during the deploy
  // transition window — after that all rows have 'optionsFlow'.
  const optionsSource = sb.optionsFlow ?? sb.options ?? null
  return {
    technicals: sb.technicals ?? null,
    conviction: projectConvictionForDashboard(sb.conviction),
    fundamentals: projectFundamentalsForDashboard(sb.fundamentals),
    smartMoney: projectSmartMoneyForDashboard(sb.smartMoney),
    options: projectOptionsForDashboard(optionsSource),
    marketContext: projectMarketContextForDashboard(sb.marketContext),
    // Bug 20 (May 2026): pass through extended-hours data on cache hit
    // so the dashboard renders the same shape regardless of live vs cached.
    extendedHours: sb.extendedHours ?? null,
  }
}

// Cache durations in minutes per timeframe
const CACHE_MINUTES: Record<string, number> = {
  '1D': 20,   // 20 min — intraday moves fast
  '1W': 45,   // 45 min — price staleness check also runs
  '1M': 60,   // 1 hour — daily bars, price check guards against big moves
  '3M': 90,   // 90 min — longer view but price still matters
}

export async function POST(req: NextRequest) {
  let ticker: string, timeframe: string, forceRefresh: boolean, persona: string
  let source: string | null = null
  try {
    const body = await req.json()
    ticker = body.ticker; timeframe = body.timeframe; forceRefresh = body.forceRefresh; persona = body.persona
    source = typeof body.source === 'string' ? body.source : null
  } catch {
    return Response.json({ error: 'Invalid request body' }, { status: 400 })
  }
  if (!ticker) return Response.json({ error: 'ticker required' }, { status: 400 })

  const symbol = ticker.toUpperCase().trim()
  const tf = timeframe || '1W'
  const encoder = new TextEncoder()

  // ── Pre-bundle ticker gate (May 2026, Bug 29) ──────────────────
  // Refuse known-unsupported tickers BEFORE opening the stream or
  // spending compute on a bundle build. Catches futures (GC, ES, NQ),
  // spot metals (XAUUSD, XAGUSD), and malformed input. Returns a
  // structured 400 with a suggested equity equivalent the UI can
  // render as a clickable link.
  const preGate = evaluateTickerGate(symbol)
  if (!preGate.ok) {
    console.warn(`[analyze] pre-bundle gate blocked ${symbol}: ${preGate.title}`)
    return Response.json({
      error: preGate.title,
      detail: preGate.detail,
      suggested: preGate.suggested ?? null,
      suggestedRationale: preGate.suggestedRationale ?? null,
      stage: preGate.stage,
    }, { status: 400 })
  }

  // --- DIAG: per-request id for tracing through Railway logs ---
  const reqId = Math.random().toString(36).slice(2, 10)
  const startedAt = Date.now()
  const dlog = (msg: string, extra?: unknown) => {
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1)
    if (extra !== undefined) {
      console.log(`[analyze:${reqId}] +${elapsed}s ${msg}`, extra)
    } else {
      console.log(`[analyze:${reqId}] +${elapsed}s ${msg}`)
    }
  }
  dlog(`START ticker=${symbol} tf=${tf} forceRefresh=${forceRefresh ?? false} persona=${persona ?? 'balanced'}`)

  // Get user ID for track record logging — non-blocking, null if not authed.
  //
  // Two auth paths:
  //   1. Service auth (cron callers): Authorization: Bearer <CRON_SECRET>
  //      + x-service-trigger header + x-service-user-id header → use that user
  //   2. Session auth (browser): falls through to Supabase auth.getUser()
  //
  // Service-auth path was added so the auto-council-trigger cron can produce
  // verdicts attributed to a specific user without spoofing a session cookie.
  // Mirrors the pattern used in /api/reeval-thesis-check.
  let currentUserId: string | null = null
  const authHeader = req.headers.get('authorization') ?? ''
  const serviceTrigger = req.headers.get('x-service-trigger')
  const serviceUserId = req.headers.get('x-service-user-id')
  const expectedServiceAuth = `Bearer ${process.env.CRON_SECRET ?? ''}`
  if (
    process.env.CRON_SECRET &&
    authHeader === expectedServiceAuth &&
    serviceTrigger &&
    serviceUserId
  ) {
    currentUserId = serviceUserId
    dlog(`auth resolved via SERVICE (trigger=${serviceTrigger}) userId=${currentUserId}`)
  } else {
    try {
      const authClient = await createAuthClient()
      const { data: { user } } = await authClient.auth.getUser()
      currentUserId = user?.id ?? null
    } catch { /* not blocking */ }
    dlog(`auth resolved userId=${currentUserId ?? '(anonymous)'}`)
  }

  const stream = new ReadableStream({
    async start(controller) {
      let controllerClosed = false
      let controllerClosedAt: { stage: string; elapsedSec: string } | null = null
      const send = (event: string, data: unknown) => {
        if (controllerClosed) return
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
        } catch {
          controllerClosed = true
          controllerClosedAt = { stage: event, elapsedSec: ((Date.now() - startedAt) / 1000).toFixed(1) }
          dlog(`!! CONTROLLER CLOSED at event=${event} (client disconnected, pipeline continues server-side)`)
        }
      }

      // Heartbeat — sends a SSE comment every 15s to prevent Railway/proxy from
      // closing an idle connection while AI stages are running
      const heartbeat = setInterval(() => {
        try { controller.enqueue(encoder.encode(`: heartbeat\n\n`)) } catch { /* stream closed */ }
      }, 15000)

      try {
        const supabase = createServerClient()

        // ── Cache check ────────────────────────────────────────
        if (!forceRefresh) {
          const cacheMinutes = CACHE_MINUTES[tf] ?? 120
          const cutoff = new Date(Date.now() - cacheMinutes * 60 * 1000).toISOString()

          const { data: cached } = await supabase
            .from('analyses')
            .select('*')
            .eq('ticker', symbol)
            .eq('timeframe', tf)
            .eq('persona', persona ?? 'balanced')
            .gte('created_at', cutoff)
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle()

          if (cached) {
            // ── Price staleness check ──────────────────────────
            let priceStale = false
            let livePrice = 0
            try {
              const finnhubKey = process.env.FINNHUB_API_KEY
              if (finnhubKey) {
                const quoteRes = await fetch(
                  `https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${finnhubKey}`,
                  { cache: 'no-store' }
                )
                if (quoteRes.ok) {
                  const quoteData = await quoteRes.json()
                  livePrice = quoteData?.c ?? 0
                }
              }
            } catch { /* fallthrough */ }

            const cachedPrice: number = cached.price ?? 0
            const cacheAgeMs = Date.now() - new Date(cached.created_at).getTime()
            const cacheAgeHours = cacheAgeMs / 3600000

            if (cachedPrice <= 0) {
              // No price stored — can't verify freshness, force refresh if over 30 min
              if (cacheAgeMs > 30 * 60 * 1000) {
                priceStale = true
                send('status', { stage: 'building_bundle', message: 'Cache has no price data — running fresh analysis...' })
              }
            } else if (livePrice > 0) {
              const priceDrift = Math.abs(livePrice - cachedPrice) / cachedPrice
              if (priceDrift > 0.015) {  // >1.5% drift = stale
                priceStale = true
                send('status', { stage: 'building_bundle', message: `Price moved ${(priceDrift*100).toFixed(1)}% since last analysis ($${cachedPrice.toFixed(2)} → $${livePrice.toFixed(2)}) — running fresh...` })
              }
            } else {
              // Finnhub returned 0 — market closed or API issue, fall back to age check
              if (cacheAgeHours > 2) {
                priceStale = true
                send('status', { stage: 'building_bundle', message: 'Cache is over 2 hours old — running fresh analysis...' })
              }
            }

            // Hard maximum: never serve cache older than 2 hours regardless of price check
            if (cacheAgeMs > 2 * 60 * 60 * 1000) {
              priceStale = true
              send('status', { stage: 'building_bundle', message: 'Cache expired (>2 hours) — running fresh analysis...' })
            }

            if (!priceStale) {
            const ageMinutes = Math.round(
              (Date.now() - new Date(cached.created_at).getTime()) / 60000
            )
            dlog(`cache HIT (age ${ageMinutes}m, will replay)`)
            // Stream cached results exactly like a live run
            send('status', { stage: 'cache_hit', message: `Serving cached analysis from ${ageMinutes} minute${ageMinutes === 1 ? '' : 's'} ago` })

            // Restore market_data from stored signal_bundle.
            // signal_bundle now stores the FULL fundamentals/smartMoney
            // objects; we re-project to the narrow dashboard shape here
            // so cached responses match live ones exactly.
            const sb = cached.signal_bundle ?? {}
            send('market_data', {
              bars: [],
              currentPrice: cached.price ?? 0,
              cached: true,
              cachedAt: cached.created_at,
              ageMinutes,
              ...buildDashboardPayloadFromCache(sb),
            })

            // Option 2: re-run Social Scout even on cache hit (sentiment decays fast).
            // Runs in parallel with cached replay so UI stays snappy. Non-blocking.
            const freshSocialPromise = runSocialScout(symbol, cached.price ?? 0, tf)
              .then(fresh => send('grok_done', fresh))
              .catch(() => { /* silent fallback - social is optional */ })

            // Stream each AI stage result with a small delay so the UI animates
            await new Promise(r => setTimeout(r, 300))
            send('gemini_done', cached.gemini_news)

            // Ensure social promise doesn't leak if user disconnects
            void freshSocialPromise

            await new Promise(r => setTimeout(r, 300))
            send('claude_done', cached.claude_analysis)

            await new Promise(r => setTimeout(r, 300))
            send('gpt_done', cached.gpt_validation)

            await new Promise(r => setTimeout(r, 300))
            send('judge_done', cached.judge_verdict)

            // Replay the persisted judge_review_pipeline if this cached row
            // has one. Pre-reviewer rows (persisted before the migration)
            // have null in this column and we skip the emission silently.
            if (cached.judge_review_pipeline) {
              await new Promise(r => setTimeout(r, 100))
              send('judge_review_done', cached.judge_review_pipeline)
            }

            send('complete', {
              analysisId: cached.id,
              cached: true,
              cachedAt: cached.created_at,
              ageMinutes,
              gemini: cached.gemini_news,
              claude: cached.claude_analysis,
              gpt: cached.gpt_validation,
              judge: cached.judge_verdict,
              transcript: cached.transcript,
            })
            dlog(`DONE via cache hit (controllerClosed=${controllerClosed})`)
            return
            } // end !priceStale
          }
        }

        // ── Live pipeline ──────────────────────────────────────
        dlog(`LIVE pipeline starting (cache miss or stale)`)
        send('status', { stage: 'building_bundle', message: 'Gathering market data and computing signals...' })

        const bundle = await (async (): Promise<SignalBundle> => {
          if (preGate.ok && preGate.assetClass === 'futures' && preGate.futuresRoot) {
            send('status', { stage: 'building_bundle', message: `Building futures bundle for ${preGate.futuresRoot}...` })
            const futuresBundle = await buildFuturesAwareBundle(
              preGate.futuresRoot,
              symbol,
              tf,
              (step) => send('status', { stage: 'building_bundle', message: step })
            )
            if (!futuresBundle) {
              throw new Error(`Could not build futures bundle for ${symbol} — underlying data layer returned empty`)
            }
            return futuresBundle
          }
          return buildSignalBundle(symbol, tf, (step) =>
            send('status', { stage: 'building_bundle', message: step })
          )
        })()
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(bundle as any).persona = persona ?? 'balanced'
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(bundle as any).source = source ?? 'manual'

        // ── Post-bundle integrity gate (May 2026, Bug 29) ──────────
        // If the bundle came back empty (price = 0 AND no bars), the
        // data layer found nothing. This catches typos, delisted
        // tickers, foreign listings without data, and ambiguous
        // symbols (ZS as Zscaler vs ZS as soybean futures) where
        // the equity lookup turned out empty. We refuse to run the
        // Council on garbage data — previously the pipeline ran
        // anyway and produced fictional analyses (e.g. XAUUSD verdict
        // citing Vanguard's nonexistent gold-pair position).
        const postGate = evaluateBundleIntegrity(bundle)
        if (!postGate.ok) {
          console.warn(`[analyze:${reqId}] post-bundle gate blocked ${symbol}: ${postGate.title}`)
          send('error', {
            message: postGate.title,
            detail: postGate.detail,
            suggested: postGate.suggested ?? null,
            suggestedRationale: postGate.suggestedRationale ?? null,
            stage: postGate.stage,
          })
          dlog(`DONE via post-bundle gate (${postGate.title})`)
          if (!controllerClosed) {
            try { controller.close() } catch { /* already closed */ }
            controllerClosed = true
          }
          clearInterval(heartbeat)
          return
        }

        send('market_data', {
          bars: bundle.bars,
          currentPrice: bundle.currentPrice,
          cached: false,
          ...buildDashboardPayloadFromBundle(bundle),
        })

        dlog(`bundle built (price=$${bundle.currentPrice.toFixed(2)}), entering runPipeline`)
        const result = await runPipeline(bundle, (event, data) => send(event, data))
        dlog(`runPipeline RETURNED (signal=${result.judge?.signal} confidence=${result.judge?.confidence})`)

        // Save to Supabase — store full dashboard data in signal_bundle for cache restore
        dlog(`starting analyses insert`)
        // Build judge_review_pipeline payload. Captures the full audit trail:
        // - draft (v1): what the Judge first produced, before reviewer
        // - review: JudgeReviewResult with all 5 rules' findings
        // - final (v2 or v1): what shipped to the user — same as v1 unless retry fired
        // - retryFired: true if material_concerns triggered a Judge re-run
        //
        // Single JSONB column instead of separate columns for v1/review/v2 because:
        //   1. Schema migration is one column add, not three
        //   2. Future schema changes to review shape don't require new migrations
        //   3. UI/track-record consumers always read the whole pipeline together
        //
        // Null-safe: if calibration is undefined (e.g., pipeline ran in legacy
        // single-Judge mode), we persist null and downstream consumers skip the
        // review UI. This keeps the system resilient during the deploy transition.
        const judgeReviewPipeline = result.calibration ? {
          version: 1,
          retryFired: (result.calibration.materialRuleNumbers?.length ?? 0) > 0,
          draftSignal: result.calibration.draftSignal,
          draftConfidence: result.calibration.draftConfidence,
          review: result.calibration,
          finalSignal: result.judge.signal,
          finalConfidence: result.judge.confidence,
          // Convenience flags for fast SQL filtering without parsing JSONB:
          overallStatus: result.calibration.overallStatus,
          materialRuleNumbers: result.calibration.materialRuleNumbers ?? [],
        } : null

        const { data: saved, error: savedErr } = await supabase.from('analyses').insert({
          ticker: symbol,
          timeframe: tf,
          persona: persona ?? 'balanced',
          price: bundle.currentPrice,
          gemini_news: result.gemini,
          claude_analysis: result.claude,
          gpt_validation: result.gpt,
          social_sentiment: result.social,
          judge_verdict: result.judge,
          judge_review_pipeline: judgeReviewPipeline,  // NEW: 5-rule reviewer audit
          final_signal: result.judge.signal,
          final_confidence: result.judge.confidence,
          final_target: result.judge.target,
          final_risk: result.judge.risk,
          // Bug 26 (May 2026): top-level columns for the target realism
          // adjustment. The full JudgeResult lives in judge_verdict JSONB,
          // but these convenience columns let dashboards/queries filter
          // for adjusted verdicts without JSONB lookups. NULL when no
          // adjustment fired.
          take_profit_judge_original: result.judge.takeProfitJudgeOriginal ?? null,
          take_profit_adjustment_note: result.judge.takeProfitAdjustmentNote ?? null,
          rounds_taken: result.judge.rounds,
          transcript: result.transcript,
          signal_bundle: {
            technicals: technicalsToPayload(bundle.technicals, bundle.currentPrice),
            conviction: {
              direction: bundle.conviction.direction,
              conviction: bundle.conviction.conviction,
              convergenceScore: bundle.conviction.convergenceScore,
              convergingSignals: bundle.conviction.convergingSignals,
              divergingSignals: bundle.conviction.divergingSignals,
              scenarios: bundle.conviction.scenarios,
              regime: bundle.conviction.regime,
              signals: bundle.conviction.signals.slice(0, 10),
              invalidationConditions: bundle.conviction.invalidationConditions,
            },
            // Bug 7 fix (May 2026): persist FULL fundamentals + smartMoney
            // objects, not the narrow dashboard projection. The previous
            // version dropped insiderBuyValue, insiderSellValue, summary,
            // insiderNetValue, institutionalOwnership, notableHolders, and
            // insiderTransactions[], leaving downstream consumers (cache
            // replay, track-record analysis, future RAG over verdicts)
            // with no source-of-truth dollar values to anchor against.
            // The dashboard does NOT consume signal_bundle directly during
            // a live run — it gets the narrow shape via the SSE market_data
            // event above. On cache hit, buildDashboardPayloadFromCache
            // re-projects from these full objects so the dashboard sees
            // an identical shape regardless of cache vs live.
            fundamentals: bundle.fundamentals,
            smartMoney: bundle.smartMoney,
            // Bug 24 (May 2026): persist the FULL optionsFlow object under
            // its canonical key 'optionsFlow' (matching the bundle shape).
            // Previously persisted as a narrow 'options' projection that
            // dropped putCallOIRatio, totalCallOI, totalPutOI, gex, gexSignal,
            // gexNote, ivSkew, full unusualActivity array, and others.
            // Same pattern as the fundamentals/smartMoney fix above:
            //   - Live runs: dashboard gets narrow shape via SSE market_data event
            //   - Cache hits: buildDashboardPayloadFromCache re-projects narrow
            //     shape from this full object
            //   - Health Check fetchBundleContext + Council Options View (Judge
            //     prompt) now get the full options data as source-of-truth
            optionsFlow: bundle.optionsFlow,
            marketContext: {
              regime: bundle.marketContext.regime,
              spy: bundle.marketContext.spy,
              vix: bundle.marketContext.vix,
              sectorETF: bundle.marketContext.sectorETF,
              competitors: bundle.marketContext.competitors,
            },
            // Bug 20 (May 2026): persist extended-hours snapshot so the
            // dashboard, cache replay, and future cross-run consumers can
            // reference pre-market / after-hours pricing alongside regular-
            // session data. Will be null/undefined when getExtendedHoursContext
            // returns the empty stub (Alpaca auth failure, ticker not covered,
            // or market closed during quiet weekend hours with no recent prints).
            extendedHours: bundle.extendedHours ?? null,
          },
        }).select().single()
        if (savedErr) {
          dlog(`!! analyses INSERT FAILED: ${savedErr.message}`, { code: savedErr.code, details: savedErr.details })
        } else {
          dlog(`analyses inserted OK id=${saved?.id ?? '(no id returned)'}`)
        }

        // Auto-log to track record directly via service role (no HTTP round-trip)
        if (currentUserId && result.judge?.signal && result.judge.signal !== 'NEUTRAL') {
          const today = new Date().toISOString().split('T')[0]
          const parseP = (s: string | undefined): number | null => {
            if (!s) return null
            // Match the FIRST $-prefixed positive number, e.g. $15.25 from
            // "Enter on a pullback to the $15.25 - $15.60 range".
            // Rejects bare numbers, ranges, percentages, and (critically)
            // anything with a leading minus like "-$15.70" or "$-15.70".
            const match = String(s).match(/\$(\d{1,6}(?:\.\d{1,2})?)/)
            if (!match) return null
            const num = parseFloat(match[1])
            return Number.isFinite(num) && num > 0 ? num : null
          }
          // Dedup — don't log same ticker+signal on same day
          dlog(`checking verdict_log for dup`)
          const { data: existing } = await supabase
            .from('verdict_log')
            .select('id')
            .eq('user_id', currentUserId)
            .eq('ticker', symbol)
            .eq('verdict_date', today)
            .eq('signal', result.judge.signal)
            .maybeSingle()
          if (!existing) {
            try {
              dlog(`inserting verdict_log row`)
              const { error: vlErr } = await supabase.from('verdict_log').insert({
                user_id: currentUserId,
                ticker: symbol,
                signal: result.judge.signal,
                confidence: result.judge.confidence ?? null,
                // Entry: prefer the Judge's stated entry; when it's missing or
                // not in a parseable $-format (bare number, range, prose, or a
                // pure directional call), fall back to the price the council
                // actually analyzed at, so the verdict is always scoreable.
                entry_price: parseP(result.judge.entryPrice) ?? (bundle.currentPrice > 0 ? bundle.currentPrice : null),
                stop_loss: parseP(result.judge.stopLoss),
                take_profit: parseP(result.judge.takeProfit),
                time_horizon: result.judge.timeHorizon ?? null,
                persona: persona ?? 'balanced',
                timeframe: tf,
                source: source ?? 'manual',
                outcome_1w: 'pending',
                outcome_1m: 'pending',
                trader_decision: result.trader?.decision ?? null,
                trader_grade: result.trader?.grade ?? null,
                trader_position_size: result.trader?.positionSizePct ?? null,
                trader_risk_reward: result.trader?.riskReward ?? null,
                trader_pass_reasons: result.trader?.passReasons ?? null,
                trader_wait_conditions: result.trader?.waitConditions ?? null,
                trader_rationale: result.trader?.rationale ?? null,
                trader_evaluated_at: result.trader?.evaluatedAt ?? null,
                version_number: CURRENT_VERSION_NUMBER,
                code_era: `v${CURRENT_VERSION_NUMBER}`,
              })
              if (vlErr) {
                dlog(`!! verdict_log INSERT FAILED: ${vlErr.message}`, { code: vlErr.code })
              } else {
                dlog(`verdict_log inserted OK`)
              }
            } catch (e) {
              dlog(`!! verdict_log threw exception: ${(e as Error).message}`)
            }
          } else {
            dlog(`verdict_log skipped (dup found, id=${existing.id})`)
          }
        } else if (currentUserId) {
          dlog(`verdict_log skipped (signal=${result.judge?.signal ?? 'undefined'}, must be BULLISH/BEARISH and userId present)`)
        }

        send('complete', {
          analysisId: saved?.id,
          cached: false,
          ...result,
        })
        const _cca = controllerClosedAt as { stage: string; elapsedSec: string } | null
        const _ccaTag = _cca ? ` at stage=${_cca.stage}` : ''
        dlog(`DONE via live run (controllerClosed=${controllerClosed}${_ccaTag})`)


      } catch (err) {
        dlog(`!! UNCAUGHT pipeline error: ${err instanceof Error ? err.message : String(err)}`)
        console.error('Pipeline error:', err)
        send('error', { message: err instanceof Error ? err.message : 'Pipeline failed' })
      } finally {
        clearInterval(heartbeat)
        if (!controllerClosed) {
          try { controller.close() } catch { /* already closed */ }
        }
        controllerClosed = true
      }
    }
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  })
}
