// ─────────────────────────────────────────────────────────────
// Social Scout — live X/social sentiment as a distinct debate voice
// ─────────────────────────────────────────────────────────────
//
// Runs in parallel with the News Scout. Uses Grok 4.20 with live
// search to pull fresh X posts about the ticker. Outputs structured
// sentiment data that feeds the Lead Analyst, Devil's Advocate,
// and Judge.
//
// Design principles:
//   - Fail soft: if Grok is down or returns garbage, return a
//     neutral "quiet / low confidence" result so the debate continues.
//   - Anti-hallucination: prompt explicitly demands that Grok mark
//     confidence as low if it can't cite 3 real posts.
//   - Privacy: prompt does not mention the app, other models, or
//     architecture. Sends only ticker + price.
//
// ─────────────────────────────────────────────────────────────

import { callGrok } from './grok'

export interface NotableVoice {
  handle: string
  stance: 'bullish' | 'bearish' | 'neutral'
  claim: string
}

export interface SocialSentiment {
  overallMood: 'bullish' | 'bearish' | 'mixed' | 'quiet'
  intensity: 'viral' | 'elevated' | 'normal' | 'low'
  keyNarrative: string
  bullishTalkingPoints: string[]
  bearishTalkingPoints: string[]
  notableVoices: NotableVoice[]
  sentimentDivergence: string | null
  retailVsPro: string
  fadeSignals: string[]
  confidence: 'high' | 'medium' | 'low'
  collectedAt: string
  // Flag that indicates this was the fallback placeholder, not real data
  isFallback?: boolean
}

// Default fallback when Grok is unavailable or returns unusable data.
// The debate must continue — this ensures Claude/GPT/Judge see a
// well-formed object and know to ignore it due to low confidence.
export function emptySocialSentiment(): SocialSentiment {
  return {
    overallMood: 'quiet',
    intensity: 'low',
    keyNarrative: 'Social sentiment data unavailable for this analysis.',
    bullishTalkingPoints: [],
    bearishTalkingPoints: [],
    notableVoices: [],
    sentimentDivergence: null,
    retailVsPro: 'unknown',
    fadeSignals: [],
    confidence: 'low',
    collectedAt: new Date().toISOString(),
    isFallback: true,
  }
}

// Parses Grok's JSON response, coerces into the SocialSentiment shape.
// Defensive: if any field is missing, fills with safe default.
function parseAndCoerce(raw: string): SocialSentiment {
  const clean = raw.replace(/```json|```/g, '').trim()
  const start = clean.indexOf('{')
  const end = clean.lastIndexOf('}')
  if (start === -1 || end === -1) throw new Error('No JSON in Grok response')
  const slice = clean.slice(start, end + 1)
  const parsed = JSON.parse(slice)

  const validMoods = ['bullish', 'bearish', 'mixed', 'quiet'] as const
  const validIntensities = ['viral', 'elevated', 'normal', 'low'] as const
  const validConfidence = ['high', 'medium', 'low'] as const
  const validStances = ['bullish', 'bearish', 'neutral'] as const

  const mood = (validMoods as readonly string[]).includes(parsed.overallMood)
    ? parsed.overallMood
    : 'mixed'
  const intensity = (validIntensities as readonly string[]).includes(parsed.intensity)
    ? parsed.intensity
    : 'normal'
  const confidence = (validConfidence as readonly string[]).includes(parsed.confidence)
    ? parsed.confidence
    : 'low'

  const coerceVoices = (arr: unknown): NotableVoice[] => {
    if (!Array.isArray(arr)) return []
    return arr
      .map((v: unknown) => {
        const obj = v as Record<string, unknown>
        const handle = typeof obj?.handle === 'string' ? obj.handle : ''
        const stance = (validStances as readonly string[]).includes(obj?.stance as string)
          ? (obj.stance as 'bullish' | 'bearish' | 'neutral')
          : 'neutral'
        const claim = typeof obj?.claim === 'string' ? obj.claim : ''
        return { handle, stance, claim }
      })
      .filter(v => v.handle && v.claim)
      .slice(0, 6)
  }

  const coerceStringArray = (arr: unknown, max = 5): string[] => {
    if (!Array.isArray(arr)) return []
    return arr
      .filter((s): s is string => typeof s === 'string' && s.length > 0)
      .slice(0, max)
  }

  return {
    overallMood: mood as SocialSentiment['overallMood'],
    intensity: intensity as SocialSentiment['intensity'],
    keyNarrative: typeof parsed.keyNarrative === 'string'
      ? parsed.keyNarrative.slice(0, 400)
      : '',
    bullishTalkingPoints: coerceStringArray(parsed.bullishTalkingPoints),
    bearishTalkingPoints: coerceStringArray(parsed.bearishTalkingPoints),
    notableVoices: coerceVoices(parsed.notableVoices),
    sentimentDivergence: typeof parsed.sentimentDivergence === 'string' && parsed.sentimentDivergence.length > 0
      ? parsed.sentimentDivergence.slice(0, 300)
      : null,
    retailVsPro: typeof parsed.retailVsPro === 'string'
      ? parsed.retailVsPro.slice(0, 200)
      : 'unknown',
    fadeSignals: coerceStringArray(parsed.fadeSignals, 4),
    confidence: confidence as SocialSentiment['confidence'],
    collectedAt: new Date().toISOString(),
  }
}

/**
 * Run the Social Scout — fetches live X/social sentiment for a ticker.
 *
 * Never throws. On any failure, returns emptySocialSentiment() with
 * isFallback: true so downstream stages know to weight it to zero.
 */
export async function runSocialScout(
  ticker: string,
  currentPrice: number,
  timeframe: string = '1W'
): Promise<SocialSentiment> {

  // Timeframe guidance shapes what counts as relevant sentiment window.
  const windowHint: Record<string, string> = {
    '1D': 'Focus on posts from the last 6-12 hours. Intraday sentiment matters most.',
    '1W': 'Focus on posts from the last 24-48 hours. Weekly swing sentiment.',
    '1M': 'Focus on posts from the last 3-7 days. Monthly positioning sentiment.',
    '3M': 'Focus on posts from the last 1-2 weeks. Quarterly thematic sentiment.',
  }

  const systemPrompt = `You analyze real-time X (Twitter) and social media sentiment for specific stock tickers. You have access to live search results.

Your output is structured JSON. You never speculate — you report what traders are actually saying based on posts you can cite.

Critical rule: If you cannot find at least 3 distinct, recent posts from real accounts about this ticker, you MUST mark confidence as "low" and intensity as "low". Do not invent narrative. Do not fill sections with plausible-sounding content you did not actually observe. Empty arrays are acceptable and preferred over fabrication.

Source diversity: Surface BOTH named public figures (analysts, CEOs, notable finance accounts) AND aggregated anonymous retail sentiment. Label each voice you cite with an identifiable handle or describe it as "retail aggregate" if multiple anonymous accounts share a view.`

  const userPrompt = `Ticker: ${ticker}
Current price: $${currentPrice.toFixed(2)}
Analysis timeframe: ${timeframe}
${windowHint[timeframe] ?? windowHint['1W']}

Analyze live social sentiment. Return JSON ONLY (no fences, no prose):
{
  "overallMood": "bullish|bearish|mixed|quiet",
  "intensity": "viral|elevated|normal|low",
  "keyNarrative": "one sentence: what story are traders telling about this ticker right now?",
  "bullishTalkingPoints": ["3-5 specific arguments bulls are making — quote or closely paraphrase"],
  "bearishTalkingPoints": ["3-5 specific arguments bears are making"],
  "notableVoices": [
    {"handle":"@handle_or_retail_aggregate","stance":"bullish|bearish|neutral","claim":"what they said, paraphrased"}
  ],
  "sentimentDivergence": "one sentence IF social diverges from news narrative, else null",
  "retailVsPro": "one sentence on whether retail accounts and pro/institutional accounts agree or disagree",
  "fadeSignals": ["contrarian flags like 'FOMO peaking', 'short-squeeze chatter', 'echo chamber forming', or empty array"],
  "confidence": "high|medium|low"
}

Remember: low confidence is the correct answer when signal is weak. Do not manufacture narrative.`

  try {
    const raw = await callGrok(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      {
        temperature: 0.3,
        maxTokens: 1500,
        searchEnabled: true,
        timeoutMs: 40000,
      }
    )
    return parseAndCoerce(raw)
  } catch (e) {
    const msg = (e as Error).message ?? 'unknown error'
    console.warn(`[social-scout] failed: ${msg.slice(0, 200)} — returning fallback`)
    return emptySocialSentiment()
  }
}

/**
 * Formats a SocialSentiment object into a prompt-ready text block that
 * can be injected into Claude/GPT/Judge context. Each role gets a
 * slightly different framing via the `role` parameter.
 */
export function formatSocialSentimentForPrompt(
  social: SocialSentiment,
  role: 'lead' | 'devil' | 'judge'
): string {
  if (social.isFallback || social.confidence === 'low' && social.intensity === 'low') {
    return `SOCIAL SENTIMENT: Unavailable or insufficient signal (confidence: low). Do not weight this dimension in your analysis.`
  }

  const roleDirective = {
    lead: `ATTRIBUTION REQUIRED: When social sentiment reinforces or contradicts any part of your thesis, you MUST cite it explicitly in your reasoning. Use phrases like "Social sentiment confirms...", "X traders are saying...", "The Social Pulse shows...", or "Per live X data...". Do NOT silently absorb social data into your technical or fundamental reasoning — the user needs to see when a claim originates from social vs. from news or signals. If a notable voice's target or claim aligns with your thesis, name it (e.g. "@handle's $290 target aligns with our Double Bottom measured move"). If social sentiment diverges from news, you MUST call that divergence out by name.`,
    devil: `ATTRIBUTION REQUIRED: When you exploit social sentiment in your challenge, you MUST cite it explicitly. Use phrases like "Social sentiment contradicts the Lead's thesis...", "X traders are fading this move...", "The Social Pulse shows FOMO peaking...", or "Per live X data, retail is overextended while pros are quiet...". Do NOT silently use social data — the user must see when a counter-argument is backed by social vs. signals. If news is positive but social is skeptical (or vice versa), name that contradiction explicitly and use it as ammunition. Fade signals indicate the crowd may be wrong — cite them by name when you press on them.`,
    judge: `ATTRIBUTION REQUIRED: Your summary MUST explicitly reference the Social Pulse when it influenced your verdict. Use phrases like "The Social Pulse indicates...", "Social sentiment on X confirms...", or "Live X data diverges from news by...". The council has three distinct voices now — News Scout, Social Pulse, and the Lead/Devil debate — and the user must see you weighing all three. If sentiment confidence is HIGH and reinforces the winning argument, say so. If sentiment is LOW or absent, note that your verdict relies primarily on signals and news rather than social. Do NOT silently blend social into your reasoning without attribution.`,
  }[role]

  const voicesText = social.notableVoices.length > 0
    ? social.notableVoices.map(v => `  ${v.handle} [${v.stance}]: ${v.claim}`).join('\n')
    : '  (none surfaced)'

  const divergence = social.sentimentDivergence
    ? `Divergence from news: ${social.sentimentDivergence}`
    : 'No sentiment divergence from news detected.'

  const fades = social.fadeSignals.length > 0
    ? `Fade signals: ${social.fadeSignals.join('; ')}`
    : 'No fade signals.'

  return `SOCIAL SENTIMENT (live X data, confidence: ${social.confidence}):
Overall mood: ${social.overallMood} | Intensity: ${social.intensity}
Key narrative: ${social.keyNarrative}
Bulls saying: ${social.bullishTalkingPoints.join(' | ') || '(none)'}
Bears saying: ${social.bearishTalkingPoints.join(' | ') || '(none)'}
Notable voices:
${voicesText}
Retail vs pro: ${social.retailVsPro}
${divergence}
${fades}

${roleDirective}`
}
