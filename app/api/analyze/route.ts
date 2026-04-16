import { NextRequest } from 'next/server'
import { buildSignalBundle } from '@/app/lib/aggregator'
import { technicalsToPayload } from '@/app/lib/signals/technicals'
import { runPipeline } from '@/app/lib/pipeline'
import { createServerClient } from '@/app/lib/supabase'

export const maxDuration = 120

// Cache durations in minutes per timeframe
const CACHE_MINUTES: Record<string, number> = {
  '1D': 20,   // 20 min — intraday moves fast
  '1W': 45,   // 45 min — price staleness check also runs
  '1M': 60,   // 1 hour — daily bars, price check guards against big moves
  '3M': 90,   // 90 min — longer view but price still matters
}

export async function POST(req: NextRequest) {
  const { ticker, timeframe, forceRefresh, persona } = await req.json()
  if (!ticker) return Response.json({ error: 'ticker required' }, { status: 400 })

  const symbol = ticker.toUpperCase().trim()
  const tf = timeframe || '1W'
  const encoder = new TextEncoder()

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) =>
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))

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
            .single()

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
            // Stream cached results exactly like a live run
            send('status', { stage: 'cache_hit', message: `Serving cached analysis from ${ageMinutes} minute${ageMinutes === 1 ? '' : 's'} ago` })

            // Restore market_data from stored signal_bundle
            const sb = cached.signal_bundle ?? {}
            send('market_data', {
              bars: [],
              currentPrice: cached.price ?? 0,
              cached: true,
              cachedAt: cached.created_at,
              ageMinutes,
              // Restore all dashboard data from signal_bundle if available
              technicals: sb.technicals ?? null,
              conviction: sb.conviction ?? null,
              fundamentals: sb.fundamentals ?? null,
              smartMoney: sb.smartMoney ?? null,
              options: sb.options ?? null,
              marketContext: sb.marketContext ?? null,
            })

            // Stream each AI stage result with a small delay so the UI animates
            await new Promise(r => setTimeout(r, 300))
            send('gemini_done', cached.gemini_news)

            await new Promise(r => setTimeout(r, 300))
            send('claude_done', cached.claude_analysis)

            await new Promise(r => setTimeout(r, 300))
            send('gpt_done', cached.gpt_validation)

            await new Promise(r => setTimeout(r, 300))
            send('judge_done', cached.judge_verdict)

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
            return
            } // end !priceStale
          }
        }

        // ── Live pipeline ──────────────────────────────────────
        send('status', { stage: 'building_bundle', message: 'Gathering market data and computing signals...' })

        const bundle = await buildSignalBundle(symbol, tf, (step) =>
          send('status', { stage: 'building_bundle', message: step })
        )
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(bundle as any).persona = persona ?? 'balanced'

        send('market_data', {
          bars: bundle.bars,
          currentPrice: bundle.currentPrice,
          cached: false,
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
          fundamentals: {
            earningsDate: bundle.fundamentals.nextEarningsDate,
            daysToEarnings: bundle.fundamentals.daysToEarnings,
            earningsRisk: bundle.fundamentals.earningsRisk,
            analystConsensus: bundle.fundamentals.analystConsensus,
            analystUpside: bundle.fundamentals.analystUpside,
            analystBuy: bundle.fundamentals.analystBuy,
            analystHold: bundle.fundamentals.analystHold,
            analystSell: bundle.fundamentals.analystSell,
            peRatio: bundle.fundamentals.peRatio,
            consistentBeater: bundle.fundamentals.consistentBeater,
            avgSurprisePct: bundle.fundamentals.avgSurprisePct,
            insiderSignal: bundle.fundamentals.insiderSignal,
          },
          smartMoney: {
            insiderSignal: bundle.smartMoney.insiderSignal,
            congressSignal: bundle.smartMoney.congressSignal,
            congressTrades: bundle.smartMoney.congressionalTrades.length,
            notableHolders: bundle.smartMoney.notableHolders,
          },
          options: {
            putCallRatio: bundle.optionsFlow.putCallRatio,
            putCallSignal: bundle.optionsFlow.putCallSignal,
            shortInterestPct: bundle.optionsFlow.shortInterestPct,
            shortSignal: bundle.optionsFlow.shortSignal,
            unusualCount: bundle.optionsFlow.unusualActivity.length,
            unusualActivity: bundle.optionsFlow.unusualActivity.slice(0, 3),
            ivSignal: bundle.optionsFlow.ivSignal,
            maxPainStrike: bundle.optionsFlow.maxPainStrike,
          },
          marketContext: {
            regime: bundle.marketContext.regime,
            spy: bundle.marketContext.spy,
            vix: bundle.marketContext.vix,
            sectorETF: bundle.marketContext.sectorETF,
            competitors: bundle.marketContext.competitors,
          },
        })

        const result = await runPipeline(bundle, (event, data) => send(event, data))

        // Save to Supabase — store full dashboard data in signal_bundle for cache restore
        const { data: saved } = await supabase.from('analyses').insert({
          ticker: symbol,
          timeframe: tf,
          persona: persona ?? 'balanced',
          price: bundle.currentPrice,
          gemini_news: result.gemini,
          claude_analysis: result.claude,
          gpt_validation: result.gpt,
          judge_verdict: result.judge,
          final_signal: result.judge.signal,
          final_confidence: result.judge.confidence,
          final_target: result.judge.target,
          final_risk: result.judge.risk,
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
            fundamentals: {
              earningsDate: bundle.fundamentals.nextEarningsDate,
              daysToEarnings: bundle.fundamentals.daysToEarnings,
              earningsRisk: bundle.fundamentals.earningsRisk,
              analystConsensus: bundle.fundamentals.analystConsensus,
              analystUpside: bundle.fundamentals.analystUpside,
              analystBuy: bundle.fundamentals.analystBuy,
              analystHold: bundle.fundamentals.analystHold,
              analystSell: bundle.fundamentals.analystSell,
              peRatio: bundle.fundamentals.peRatio,
              consistentBeater: bundle.fundamentals.consistentBeater,
              avgSurprisePct: bundle.fundamentals.avgSurprisePct,
              insiderSignal: bundle.fundamentals.insiderSignal,
            },
            smartMoney: {
              insiderSignal: bundle.smartMoney.insiderSignal,
              congressSignal: bundle.smartMoney.congressSignal,
              congressTrades: bundle.smartMoney.congressionalTrades.length,
              notableHolders: bundle.smartMoney.notableHolders,
            },
            options: {
              putCallRatio: bundle.optionsFlow.putCallRatio,
              putCallSignal: bundle.optionsFlow.putCallSignal,
              shortInterestPct: bundle.optionsFlow.shortInterestPct,
              shortSignal: bundle.optionsFlow.shortSignal,
              unusualCount: bundle.optionsFlow.unusualActivity.length,
              unusualActivity: bundle.optionsFlow.unusualActivity.slice(0, 3),
              ivSignal: bundle.optionsFlow.ivSignal,
              maxPainStrike: bundle.optionsFlow.maxPainStrike,
            },
            marketContext: {
              regime: bundle.marketContext.regime,
              spy: bundle.marketContext.spy,
              vix: bundle.marketContext.vix,
              sectorETF: bundle.marketContext.sectorETF,
              competitors: bundle.marketContext.competitors,
            },
          },
        }).select().single()

        // Auto-log to track record (fire-and-forget)
        if (result.judge?.signal && result.judge.signal !== 'NEUTRAL') {
          fetch(`${process.env.NEXT_PUBLIC_APP_URL}/api/track-record`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Cookie': req.headers.get('cookie') ?? '' },
            body: JSON.stringify({
              ticker: symbol,
              signal: result.judge.signal,
              confidence: result.judge.confidence,
              entry_price: result.judge.entryPrice,
              stop_loss: result.judge.stopLoss,
              take_profit: result.judge.takeProfit,
              time_horizon: result.judge.timeHorizon,
              persona: persona ?? 'balanced',
              timeframe: tf,
            }),
          }).catch(() => null)
        }

        send('complete', {
          analysisId: saved?.id,
          cached: false,
          ...result,
        })

      } catch (err) {
        console.error('Pipeline error:', err)
        send('error', { message: err instanceof Error ? err.message : 'Pipeline failed' })
      } finally {
        controller.close()
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
