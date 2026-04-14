import { NextRequest } from 'next/server'
import { buildSignalBundle } from '@/app/lib/aggregator'
import { runPipeline } from '@/app/lib/pipeline'
import { createServerClient } from '@/app/lib/supabase'

export const maxDuration = 120

// Cache durations in minutes per timeframe
const CACHE_MINUTES: Record<string, number> = {
  '1D': 30,
  '1W': 120,
  '1M': 360,
  '3M': 720,
}

export async function POST(req: NextRequest) {
  const { ticker, timeframe, forceRefresh } = await req.json()
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
            .gte('created_at', cutoff)
            .order('created_at', { ascending: false })
            .limit(1)
            .single()

          if (cached) {
            const ageMinutes = Math.round(
              (Date.now() - new Date(cached.created_at).getTime()) / 60000
            )
            // Stream cached results exactly like a live run
            send('status', { stage: 'cache_hit', message: `Serving cached analysis from ${ageMinutes} minute${ageMinutes === 1 ? '' : 's'} ago` })

            // Reconstruct market_data from stored signal_bundle metadata
            send('market_data', {
              bars: [],
              currentPrice: cached.price ?? 0,
              cached: true,
              cachedAt: cached.created_at,
              ageMinutes,
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
          }
        }

        // ── Live pipeline ──────────────────────────────────────
        send('status', { stage: 'building_bundle', message: 'Gathering market data and computing signals...' })

        const bundle = await buildSignalBundle(symbol, tf, (step) =>
          send('status', { stage: 'building_bundle', message: step })
        )

        send('market_data', {
          bars: bundle.bars,
          currentPrice: bundle.currentPrice,
          cached: false,
          technicals: {
            rsi: bundle.technicals.rsi,
            technicalBias: bundle.technicals.technicalBias,
            technicalScore: bundle.technicals.technicalScore,
            sma20: bundle.technicals.sma20,
            sma50: bundle.technicals.sma50,
            sma200: bundle.technicals.sma200,
            support: bundle.technicals.support,
            resistance: bundle.technicals.resistance,
            goldenCross: bundle.technicals.goldenCross,
            macdHistogram: bundle.technicals.macdHistogram,
            bbPosition: bundle.technicals.bbPosition,
            bbSignal: bundle.technicals.bbSignal,
            volumeRatio: bundle.technicals.volumeRatio,
            priceChange1D: bundle.technicals.priceChange1D,
          },
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

        // Save to Supabase
        const { data: saved } = await supabase.from('analyses').insert({
          ticker: symbol,
          timeframe: tf,
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
        }).select().single()

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
