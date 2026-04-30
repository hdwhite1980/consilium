// ─────────────────────────────────────────────────────────────
// Social Scout — live X/social sentiment as a distinct debate voice
// ─────────────────────────────────────────────────────────────
//
// Runs in parallel with the News Scout. Uses Grok 4.20 with live
// search to pull fresh X posts about the ticker. Outputs structured
// sentiment data that feeds the Lead Analyst, Devil's Advocate,
// and Judge.
//
// 2026-04-29 — Added Reddit augmentation. Reddit posts/comments from
// r/wallstreetbets, r/stocks, r/investing, r/options are fetched in
// parallel with Grok's X search and threaded into Grok's prompt for
// synthesis. The output shape is unchanged — both X and Reddit sentiment
// flow into the same SocialSentiment fields.
//
// Design principles:
//   - Fail soft: if Grok is down OR Reddit is down, the other still runs.
//   - Anti-hallucination: prompt explicitly demands that Grok mark
//     confidence as low if it can't cite enough real posts.
//   - Privacy: prompt does not mention the app, other models, or
//     architecture. Sends only ticker + price.
//   - Reddit: public JSON endpoints (no auth needed); rate-limited but
//     well-behaved with reasonable user-agent.
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
  // 2026-04-29 — added: which platforms contributed signal
  platformsCovered?: Array<'x' | 'reddit'>
  isFallback?: boolean
}

// Default fallback when Grok is unavailable or returns unusable data.
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
    platformsCovered: [],
    isFallback: true,
  }
}

// ─────────────────────────────────────────────────────────────
// Reddit fetcher — public JSON endpoints, no auth required
// ─────────────────────────────────────────────────────────────
//
// We hit the search endpoint on each finance subreddit and pull recent
// posts mentioning the ticker. Reddit's JSON API is rate-limited but
// reliable. Total calls per scout run: 4 (one per subreddit).
//
// Endpoint: https://www.reddit.com/r/{subreddit}/search.json?q={ticker}&restrict_sr=1&sort=new&t=week&limit=15
// ─────────────────────────────────────────────────────────────

interface RedditPost {
  subreddit: string
  title: string
  selftext: string                   // post body
  score: number
  num_comments: number
  created_utc: number                // Unix timestamp
  permalink: string                  // /r/x/comments/...
  author: string
  upvote_ratio: number               // 0-1
}

const REDDIT_SUBS = ['wallstreetbets', 'stocks', 'investing', 'options']
const REDDIT_USER_AGENT = 'Wali-OS:1.0 (by /u/wali-os-bot)'

async function fetchRedditForTicker(
  ticker: string,
  timeframe: string,
): Promise<RedditPost[]> {
  // Map our timeframe to Reddit's `t` parameter (time window)
  const t = timeframe === '1D' ? 'day'
    : timeframe === '1W' ? 'week'
    : timeframe === '1M' ? 'month'
    : 'month'

  const allPosts: RedditPost[] = []

  // Run subreddit searches in parallel
  await Promise.all(REDDIT_SUBS.map(async (sub) => {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 5000)
    try {
      const url = `https://www.reddit.com/r/${sub}/search.json` +
        `?q=${encodeURIComponent(ticker)}&restrict_sr=1&sort=new&t=${t}&limit=10`
      const res = await fetch(url, {
        signal: ctrl.signal,
        cache: 'no-store',
        headers: { 'User-Agent': REDDIT_USER_AGENT },
      })
      if (!res.ok) return
      const data = await res.json()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const children = (data?.data?.children ?? []) as any[]
      for (const c of children) {
        const d = c?.data
        if (!d || typeof d !== 'object') continue
        const title = String(d.title ?? '')
        if (!title) continue
        // Filter: must mention the ticker in title or body, not just be in
        // subreddit. (Reddit's search occasionally returns false matches.)
        const body = String(d.selftext ?? '')
        const tickerRegex = new RegExp(`\\b\\$?${ticker}\\b`, 'i')
        if (!tickerRegex.test(title) && !tickerRegex.test(body)) continue

        allPosts.push({
          subreddit: sub,
          title: title.slice(0, 250),
          selftext: body.slice(0, 500),
          score: typeof d.score === 'number' ? d.score : 0,
          num_comments: typeof d.num_comments === 'number' ? d.num_comments : 0,
          created_utc: typeof d.created_utc === 'number' ? d.created_utc : 0,
          permalink: typeof d.permalink === 'string' ? d.permalink : '',
          author: typeof d.author === 'string' ? d.author : 'unknown',
          upvote_ratio: typeof d.upvote_ratio === 'number' ? d.upvote_ratio : 0.5,
        })
      }
    } catch { /* skip this subreddit */ }
    finally { clearTimeout(timer) }
  }))

  // Sort by score descending, take top 12 most-engaged posts
  allPosts.sort((a, b) => b.score - a.score)
  return allPosts.slice(0, 12)
}

function formatRedditForPrompt(posts: RedditPost[]): string {
  if (posts.length === 0) return ''
  const formatted = posts.slice(0, 10).map((p, i) => {
    const ageDays = Math.floor((Date.now() / 1000 - p.created_utc) / 86400)
    const ageLabel = ageDays === 0 ? 'today' : ageDays === 1 ? '1d ago' : `${ageDays}d ago`
    const body = p.selftext ? ` :: ${p.selftext.slice(0, 200)}` : ''
    return `[${i + 1}] r/${p.subreddit} (${p.score} upvotes, ${p.num_comments} comments, ${ageLabel}, ${(p.upvote_ratio * 100).toFixed(0)}% upvoted): ${p.title}${body}`
  }).join('\n')

  return `\n\nREDDIT POSTS (from r/wallstreetbets, r/stocks, r/investing, r/options):
${formatted}

Reddit context: WSB skews retail and momentum-chasing. r/stocks and r/investing are more measured. r/options is where flow-driven traders gather. Weight by engagement (upvotes/comments) and upvote ratio (low ratio = controversial, may signal contrarian view).`
}

// ─────────────────────────────────────────────────────────────
// Parses Grok's JSON response, coerces into the SocialSentiment shape.
// ─────────────────────────────────────────────────────────────
function parseAndCoerce(raw: string, platformsCovered: Array<'x' | 'reddit'>): SocialSentiment {
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
      .slice(0, 8)
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
    platformsCovered,
  }
}

/**
 * Run the Social Scout — fetches live X (via Grok) + Reddit sentiment.
 *
 * Never throws. On any failure, returns emptySocialSentiment() with
 * isFallback: true so downstream stages know to weight it to zero.
 */
export async function runSocialScout(
  ticker: string,
  currentPrice: number,
  timeframe: string = '1W',
): Promise<SocialSentiment> {
  const windowHint: Record<string, string> = {
    '1D': 'Focus on posts from the last 6-12 hours. Intraday sentiment matters most.',
    '1W': 'Focus on posts from the last 24-48 hours. Weekly swing sentiment.',
    '1M': 'Focus on posts from the last 3-7 days. Monthly positioning sentiment.',
    '3M': 'Focus on posts from the last 1-2 weeks. Quarterly thematic sentiment.',
  }

  // Fetch Reddit in parallel with Grok's X search.
  // Both are independent; if either fails, the other still produces signal.
  const redditP = fetchRedditForTicker(ticker, timeframe).catch(() => [] as RedditPost[])

  const systemPrompt = `You analyze real-time social media sentiment (X/Twitter and Reddit) for specific stock tickers. You have access to live X search via Grok's tools, AND you'll be given recent Reddit posts as context.

Your output is structured JSON. You never speculate — you report what traders are actually saying based on posts you can cite.

Critical rule: If you cannot find at least 3 distinct, recent posts/comments from real accounts about this ticker (across X + Reddit combined), you MUST mark confidence as "low" and intensity as "low". Do not invent narrative. Do not fill sections with plausible-sounding content you did not actually observe. Empty arrays are acceptable and preferred over fabrication.

Source diversity: Surface BOTH named public figures (analysts, CEOs, notable finance accounts) AND aggregated anonymous retail sentiment. When citing, label the platform: "X: @handle" or "Reddit: r/subreddit". Use "retail aggregate (X)" or "retail aggregate (Reddit)" when multiple anonymous accounts share a view.

Reddit specifics: Score (upvotes) and comment count signal engagement intensity. Upvote ratio under 70% means the post is controversial — that's notable. WSB skews short-term momentum/options-driven; r/stocks and r/investing skew measured. Weight accordingly when reading sentiment.

Cross-platform divergence is interesting: if X is bullish but Reddit is bearish (or vice versa), surface that in sentimentDivergence.`

  // Will be filled after Reddit fetch completes
  const redditPosts = await redditP
  const redditBlock = formatRedditForPrompt(redditPosts)

  const userPrompt = `Ticker: ${ticker}
Current price: $${currentPrice.toFixed(2)}
Analysis timeframe: ${timeframe}
${windowHint[timeframe] ?? windowHint['1W']}

Use your live X search tools to find recent posts about ${ticker}. Combine with the Reddit posts provided below.${redditBlock}

Analyze combined social sentiment (X + Reddit). Return JSON ONLY (no fences, no prose):
{
  "overallMood": "bullish|bearish|mixed|quiet",
  "intensity": "viral|elevated|normal|low",
  "keyNarrative": "one sentence: what story are traders telling about this ticker right now?",
  "bullishTalkingPoints": ["3-5 specific arguments bulls are making — quote or closely paraphrase, label platform"],
  "bearishTalkingPoints": ["3-5 specific arguments bears are making, label platform"],
  "notableVoices": [
    {"handle":"X: @handle or Reddit: r/sub","stance":"bullish|bearish|neutral","claim":"what they said, paraphrased"}
  ],
  "sentimentDivergence": "one sentence IF social diverges from news narrative OR IF X and Reddit disagree, else null",
  "retailVsPro": "one sentence on whether retail accounts and pro/institutional accounts agree or disagree",
  "fadeSignals": ["contrarian flags like 'FOMO peaking on WSB', 'short-squeeze chatter', 'echo chamber forming', or empty array"],
  "confidence": "high|medium|low"
}

Remember: low confidence is the correct answer when signal is weak. Do not manufacture narrative.`

  // Track which platforms actually contributed
  const platformsCovered: Array<'x' | 'reddit'> = []
  if (redditPosts.length > 0) platformsCovered.push('reddit')

  try {
    const raw = await callGrok(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      {
        temperature: 0.3,
        maxTokens: 1800,         // bumped from 1500 — Reddit data adds context
        searchEnabled: true,
        timeoutMs: 90000,
      }
    )
    // X always counted if Grok responded
    platformsCovered.push('x')
    return parseAndCoerce(raw, platformsCovered)
  } catch (e) {
    const msg = (e as Error).message ?? 'unknown error'
    console.warn(`[social-scout] Grok failed: ${msg.slice(0, 200)} — checking if Reddit alone provides signal`)

    // If Grok failed but Reddit had data, build a Reddit-only fallback.
    // Better to surface SOMETHING than fall back to "unavailable" entirely.
    if (redditPosts.length >= 3) {
      const total = redditPosts.length
      const wsbPosts = redditPosts.filter(p => p.subreddit === 'wallstreetbets').length
      return {
        overallMood: 'mixed',
        intensity: total >= 8 ? 'elevated' : 'normal',
        keyNarrative: `${total} Reddit posts found across r/wallstreetbets (${wsbPosts}), r/stocks, r/investing, r/options. X data unavailable this run.`,
        bullishTalkingPoints: [],
        bearishTalkingPoints: [],
        notableVoices: redditPosts.slice(0, 5).map(p => ({
          handle: `Reddit: r/${p.subreddit}`,
          stance: 'neutral' as const,
          claim: p.title.slice(0, 200),
        })),
        sentimentDivergence: null,
        retailVsPro: 'Reddit-only sample — likely retail-skewed',
        fadeSignals: [],
        confidence: 'low',
        collectedAt: new Date().toISOString(),
        platformsCovered: ['reddit'],
      }
    }

    return emptySocialSentiment()
  }
}

/**
 * Formats a SocialSentiment object into a prompt-ready text block that
 * can be injected into Claude/GPT/Judge context.
 */
export function formatSocialSentimentForPrompt(
  social: SocialSentiment,
  role: 'lead' | 'devil' | 'judge'
): string {
  if (social.isFallback || (social.confidence === 'low' && social.intensity === 'low')) {
    return `SOCIAL SENTIMENT: Unavailable or insufficient signal (confidence: low). Do not weight this dimension in your analysis.`
  }

  const platformsLabel = social.platformsCovered && social.platformsCovered.length > 0
    ? `[platforms: ${social.platformsCovered.join(', ')}]`
    : ''

  const roleDirective = {
    lead: `ATTRIBUTION REQUIRED: When social sentiment reinforces or contradicts any part of your thesis, you MUST cite it explicitly in your reasoning. Use phrases like "Social sentiment confirms...", "X traders are saying...", "Reddit chatter shows...", "The Social Pulse shows...", or "Per live social data...". Do NOT silently absorb social data into your technical or fundamental reasoning — the user needs to see when a claim originates from social vs. from news or signals. If a notable voice's target or claim aligns with your thesis, name it (e.g., "@cnbcfastmoney called the same level"). When platforms diverge (e.g., X bullish but Reddit bearish), surface that — it's a real signal.`,
    devil: `Use social sentiment to attack the Lead Analyst's thesis where retail consensus diverges from price action or where you can flag fade signals (FOMO peaking, echo chambers, short-squeeze hysteria). Cross-platform divergence (X vs Reddit) is fertile ground for cross-pressure — if Reddit is bearish on a thesis X loves, that's a real disagreement worth raising.`,
    judge: `Social sentiment is a SECONDARY signal. Weight it less than fundamental/technical evidence but use it to confirm or contradict the news narrative. Cross-platform agreement (X + Reddit aligned) carries more weight than single-platform signal. Note any sentiment divergence in your verdict.`,
  }[role]

  const voicesBlock = social.notableVoices.length > 0
    ? '\nNotable voices:\n' + social.notableVoices.map(v =>
      `  - ${v.handle} (${v.stance}): ${v.claim}`
    ).join('\n')
    : ''

  const fadeBlock = social.fadeSignals.length > 0
    ? `\nFade signals: ${social.fadeSignals.join('; ')}`
    : ''

  const divergenceBlock = social.sentimentDivergence
    ? `\nDivergence: ${social.sentimentDivergence}`
    : ''

  return `SOCIAL SENTIMENT ${platformsLabel} (${social.overallMood}, ${social.intensity}, confidence: ${social.confidence}):
${social.keyNarrative}

Bullish points:
${social.bullishTalkingPoints.map(p => `  • ${p}`).join('\n') || '  (none cited)'}

Bearish points:
${social.bearishTalkingPoints.map(p => `  • ${p}`).join('\n') || '  (none cited)'}
${voicesBlock}${fadeBlock}${divergenceBlock}

Retail vs pro: ${social.retailVsPro}

${roleDirective}`
}
