import { NextRequest } from 'next/server'
import { buildSignalBundle } from '@/app/lib/aggregator'
import { technicalsToPayload } from '@/app/lib/signals/technicals'
import { runGemini, runClaude, runGPT, runRebuttal, runCounter, runJudge } from '@/app/lib/pipeline'
import Anthropic from '@anthropic-ai/sdk'

export async function POST(req: NextRequest) {
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) =>
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))

      try {
        const { tickerA, tickerB, timeframe, persona } = await req.json()
        if (!tickerA || !tickerB) { send('error', { message: 'Two tickers required' }); return }

        const symA = tickerA.toUpperCase().trim()
        const symB = tickerB.toUpperCase().trim()
        const tf = timeframe || '1W'
        const p = persona || 'balanced'

        send('status', { message: `Building data for ${symA} and ${symB}...` })

        // Build both bundles in parallel
        const [bundleA, bundleB] = await Promise.all([
          buildSignalBundle(symA, tf),
          buildSignalBundle(symB, tf),
        ])
        ;(bundleA as any).persona = p
        ;(bundleB as any).persona = p

        // Send market data for both
        send('market_data_a', {
          ticker: symA,
          currentPrice: bundleA.currentPrice,
          technicals: technicalsToPayload(bundleA.technicals, bundleA.currentPrice),
          conviction: {
            direction: bundleA.conviction.direction,
            convergenceScore: bundleA.conviction.convergenceScore,
            convergingSignals: bundleA.conviction.convergingSignals,
            divergingSignals: bundleA.conviction.divergingSignals,
          },
          fundamentals: {
            peRatio: bundleA.fundamentals?.peRatio ?? null,
            analystConsensus: bundleA.fundamentals?.analystConsensus ?? 'hold',
            analystUpside: bundleA.fundamentals?.analystUpside ?? null,
            earningsRisk: bundleA.fundamentals?.earningsRisk ?? 'low',
            daysToEarnings: bundleA.fundamentals?.daysToEarnings ?? null,
          },
        })
        send('market_data_b', {
          ticker: symB,
          currentPrice: bundleB.currentPrice,
          technicals: technicalsToPayload(bundleB.technicals, bundleB.currentPrice),
          conviction: {
            direction: bundleB.conviction.direction,
            convergenceScore: bundleB.conviction.convergenceScore,
            convergingSignals: bundleB.conviction.convergingSignals,
            divergingSignals: bundleB.conviction.divergingSignals,
          },
          fundamentals: {
            peRatio: bundleB.fundamentals?.peRatio ?? null,
            analystConsensus: bundleB.fundamentals?.analystConsensus ?? 'hold',
            analystUpside: bundleB.fundamentals?.analystUpside ?? null,
            earningsRisk: bundleB.fundamentals?.earningsRisk ?? 'low',
            daysToEarnings: bundleB.fundamentals?.daysToEarnings ?? null,
          },
        })

        send('status', { message: `Running analysis for both...` })

        // Run full pipeline for both in parallel
        const [
          [geminiA, claudeA, gptA],
          [geminiB, claudeB, gptB],
        ] = await Promise.all([
          Promise.all([runGemini(bundleA), ]).then(async ([g]) => {
            const cl = await runClaude(bundleA, g)
            const gp = await runGPT(bundleA, g, cl)
            return [g, cl, gp] as const
          }),
          Promise.all([runGemini(bundleB)]).then(async ([g]) => {
            const cl = await runClaude(bundleB, g)
            const gp = await runGPT(bundleB, g, cl)
            return [g, cl, gp] as const
          }),
        ])

        send('status', { message: 'Running debate rounds...' })

        // Rebuttal and counter for both
        const [rebA, rebB] = await Promise.all([
          runRebuttal(bundleA, claudeA, gptA),
          runRebuttal(bundleB, claudeB, gptB),
        ])
        const [ctrA, ctrB] = await Promise.all([
          runCounter(bundleA, gptA, rebA),
          runCounter(bundleB, gptB, rebB),
        ])

        send('status', { message: 'Getting council verdicts...' })

        const [judgeA, judgeB] = await Promise.all([
          runJudge(bundleA, geminiA, claudeA, gptA, rebA, ctrA, 1),
          runJudge(bundleB, geminiB, claudeB, gptB, rebB, ctrB, 1),
        ])

        send('verdicts', { tickerA: symA, tickerB: symB, judgeA, judgeB })

        // Head-to-head AI comparison
        send('status', { message: 'Running head-to-head comparison...' })

        const anthropic = new Anthropic()
        const compMsg = await anthropic.messages.create({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 1000,
          system: `You are a senior portfolio analyst comparing two investment opportunities. Be decisive. Give a clear recommendation. Use specific data.`,
          messages: [{
            role: 'user',
            content: `HEAD-TO-HEAD COMPARISON: ${symA} vs ${symB}
Timeframe: ${tf} | Lens: ${p}

${symA} ($${bundleA.currentPrice.toFixed(2)}):
Signal: ${judgeA.signal} | Confidence: ${judgeA.confidence}% | Target: ${judgeA.target}
Entry: ${judgeA.entryPrice} | Stop: ${judgeA.stopLoss} | Take Profit: ${judgeA.takeProfit}
Summary: ${judgeA.summary}
P/E: ${bundleA.fundamentals?.peRatio?.toFixed(1) ?? 'N/A'} | RSI: ${bundleA.technicals?.rsi?.toFixed(1) ?? 'N/A'} | Analyst upside: ${bundleA.fundamentals?.analystUpside?.toFixed(1) ?? 'N/A'}%

${symB} ($${bundleB.currentPrice.toFixed(2)}):
Signal: ${judgeB.signal} | Confidence: ${judgeB.confidence}% | Target: ${judgeB.target}
Entry: ${judgeB.entryPrice} | Stop: ${judgeB.stopLoss} | Take Profit: ${judgeB.takeProfit}
Summary: ${judgeB.summary}
P/E: ${bundleB.fundamentals?.peRatio?.toFixed(1) ?? 'N/A'} | RSI: ${bundleB.technicals?.rsi?.toFixed(1) ?? 'N/A'} | Analyst upside: ${bundleB.fundamentals?.analystUpside?.toFixed(1) ?? 'N/A'}%

Provide a head-to-head analysis JSON only:
{
  "winner": "${symA}|${symB}|NEITHER",
  "winnerReason": "2 sentences — specifically why this one wins on risk/reward right now",
  "verdictA": "BULLISH|BEARISH|NEUTRAL",
  "verdictB": "BULLISH|BEARISH|NEUTRAL",
  "riskRewardA": <0-10 score>,
  "riskRewardB": <0-10 score>,
  "strengthsA": ["2-3 key strengths of ${symA}"],
  "strengthsB": ["2-3 key strengths of ${symB}"],
  "weaknessesA": ["1-2 key weaknesses of ${symA}"],
  "weaknessesB": ["1-2 key weaknesses of ${symB}"],
  "relativeValue": "1-2 sentences comparing valuation between the two",
  "recommendation": "Clear actionable recommendation — which to buy, which to avoid, or if both are worth holding",
  "ifYouCanOnlyPick": "One sentence — if forced to pick exactly one right now, which and why"
}`
          }]
        })

        const comparison = JSON.parse(
          (compMsg.content[0] as { text: string }).text.replace(/```json|```/g, '').trim()
        )

        send('complete', {
          tickerA: symA,
          tickerB: symB,
          judgeA,
          judgeB,
          comparison,
          marketA: {
            ticker: symA,
            currentPrice: bundleA.currentPrice,
            technicals: technicalsToPayload(bundleA.technicals, bundleA.currentPrice),
            conviction: {
              direction: bundleA.conviction.direction,
              convergenceScore: bundleA.conviction.convergenceScore,
              convergingSignals: bundleA.conviction.convergingSignals,
              divergingSignals: bundleA.conviction.divergingSignals,
            },
            fundamentals: {
              peRatio: bundleA.fundamentals?.peRatio ?? null,
              analystConsensus: bundleA.fundamentals?.analystConsensus ?? 'hold',
              analystUpside: bundleA.fundamentals?.analystUpside ?? null,
            },
          },
          marketB: {
            ticker: symB,
            currentPrice: bundleB.currentPrice,
            technicals: technicalsToPayload(bundleB.technicals, bundleB.currentPrice),
            conviction: {
              direction: bundleB.conviction.direction,
              convergenceScore: bundleB.conviction.convergenceScore,
              convergingSignals: bundleB.conviction.convergingSignals,
              divergingSignals: bundleB.conviction.divergingSignals,
            },
            fundamentals: {
              peRatio: bundleB.fundamentals?.peRatio ?? null,
              analystConsensus: bundleB.fundamentals?.analystConsensus ?? 'hold',
              analystUpside: bundleB.fundamentals?.analystUpside ?? null,
            },
          },
        })

      } catch (err) {
        console.error('Comparison error:', err)
        send('error', { message: err instanceof Error ? err.message : 'Comparison failed' })
      } finally {
        controller.close()
      }
    }
  })

  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' }
  })
}
