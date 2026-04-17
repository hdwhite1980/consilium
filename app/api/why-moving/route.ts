import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/app/lib/auth/server'
import { fetchBars } from '@/app/lib/data/alpaca'
import { fetchNews } from '@/app/lib/data/alpaca'
import { GoogleGenerativeAI } from '@google/generative-ai'
import Anthropic from '@anthropic-ai/sdk'

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { ticker, currentPrice, changePercent } = await req.json()
  if (!ticker) return NextResponse.json({ error: 'ticker required' }, { status: 400 })

  const encoder = new TextEncoder()
  const stream = new TransformStream()
  const writer = stream.writable.getWriter()

  const send = async (data: object) => {
    await writer.write(encoder.encode(`data: ${JSON.stringify(data)}\n\n`))
  }

  ;(async () => {
    try {
      // Step 1: Fetch news fast
      await send({ stage: 'news', status: 'Scanning headlines...' })
      const news = await fetchNews(ticker, 10).catch(() => [])
      const headlines = news.slice(0, 8).map((n: any) => n.headline).join('\n')

      // Step 2: Gemini — what's causing the move
      await send({ stage: 'catalyst', status: 'Identifying catalyst...' })
      const genai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!)
      const model = genai.getGenerativeModel({ model: 'gemini-2.5-flash' })

      const catalystResult = await model.generateContent(`${ticker} is moving ${changePercent > 0 ? 'UP' : 'DOWN'} ${Math.abs(changePercent).toFixed(1)}% right now. Current price: $${currentPrice}.

RECENT HEADLINES:
${headlines || 'No headlines available'}

In 2-3 sentences, explain:
1. What is causing this move (be specific — earnings, news event, sector move, macro factor)?
2. Is this a fundamental catalyst or technical/momentum driven?
3. Does this appear to be a sustained move or a knee-jerk reaction?

Be direct and specific. If you don't have enough context, say so clearly.`)

      const catalyst = catalystResult.response.text().trim()
      await send({ stage: 'catalyst', status: 'done', catalyst })

      // Step 3: Claude — chase or wait?
      await send({ stage: 'verdict', status: 'Analyzing entry...' })
      const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })
      const msg = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 400,
        messages: [{
          role: 'user',
          content: `${ticker} is ${changePercent > 0 ? 'up' : 'down'} ${Math.abs(changePercent).toFixed(1)}% today at $${currentPrice}.

Catalyst summary: ${catalyst}

Give a "Chase or Wait" verdict in this exact JSON format:
{
  "verdict": "CHASE" | "WAIT" | "AVOID",
  "confidence": <50-95>,
  "reason": "One sentence — specific reason for verdict",
  "action": "One specific sentence — exactly what to do right now (e.g. 'Wait for a pullback to $X before entering' or 'Buy the breakout above $X with a stop at $Y')",
  "risk": "One sentence — biggest risk to this trade right now"
}

JSON only.`
        }]
      })

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const textBlock = msg.content.find((b: any) => b.type === 'text') as { text: string } | undefined
      const raw = textBlock?.text || ''
      const clean = raw.replace(/```json|```/g, '').trim()
      const start = clean.indexOf('{')
      const end = clean.lastIndexOf('}')
      const verdict = start !== -1 ? JSON.parse(clean.slice(start, end + 1)) : { verdict: 'WAIT', reason: 'Insufficient data', action: 'Monitor closely', risk: 'Unknown' }

      await send({ stage: 'verdict', status: 'done', verdict })
      await send({ stage: 'complete' })

    } catch (e) {
      await send({ stage: 'error', message: (e as Error).message })
    } finally {
      await writer.close()
    }
  })()

  return new NextResponse(stream.readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  })
}
