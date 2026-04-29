// ═════════════════════════════════════════════════════════════
// app/lib/news-exposure.ts
//
// Compute a per-ticker "news exposure" signal from the existing
// macro intelligence layer (active_macro_themes, macro_events, and
// the latest market_digest).
//
// This module does NOT call any LLM — the heavy lifting is already
// done by macro-intelligence.ts (which runs Gemini once on the news
// stream and persists structured events with sentiment + affected
// tickers/sectors). We just aggregate that pre-computed data into a
// single score per ticker.
//
// SCORE INTERPRETATION
//   +100  = strong BULLISH news tailwind for this ticker
//      0  = no relevant news
//   -100  = strong BEARISH news headwind for this ticker
//
// CONTRIBUTION WEIGHTS (signed by sentiment, summed, capped at ±100)
//   Direct ticker hit in HIGH-urgency theme:    ±40
//   Direct ticker hit in MEDIUM-urgency theme:  ±25
//   Direct ticker hit in LOW-urgency theme:     ±15
//   Sector hit in HIGH-urgency theme:           ±15
//   Sector hit in MEDIUM-urgency theme:         ±10
//   Sector hit in LOW-urgency theme:            ±5
//   Direct ticker mention in macro_events:      ±15 per event
//   Digest sectors_bullish match:               +10
//   Digest sectors_bearish match:               -10
//   Digest tickers_to_watch direct hit:         +5  (unsigned, mild)
//
// The same ticker can pick up several contributions — e.g. NVDA might
// be directly named in two themes AND match the "tech" sector — those
// stack and then clamp to ±100.
//
// LIFECYCLE
//   buildNewsExposureMap()  — call once per scan, returns Map<ticker, score>
//   scoreNewsExposure()     — pure helper used internally; exported for tests
// ═════════════════════════════════════════════════════════════

import { createClient } from '@supabase/supabase-js'
import type { Sector } from '@/app/lib/scanner-universe'

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

export interface NewsExposureContext {
  /** -100..+100, signed bullish/bearish aggregate */
  score: number
  /** Human-readable single-line summary, e.g. "+NVDA in 2 high-urgency themes" */
  summary: string
  /** Up to 3 specific theme/event titles that drove the score, for UI tooltip */
  reasons: string[]
  /** What kind of match: 'direct' (ticker named), 'sector', 'digest', 'none' */
  matchType: 'direct' | 'sector' | 'digest' | 'none'
}

interface ThemeRecord {
  id: string
  theme_name: string
  theme_summary: string | null
  affected_sectors?: string[] | null
  sectors_to_watch?: string[] | null
  affected_tickers?: string[] | null
  tickers_to_watch?: string[] | null
  sentiment: string | null
  urgency: string | null
}

interface EventRecord {
  id: string
  title: string
  summary: string | null
  affected_sectors: string[] | null
  affected_tickers: string[] | null
  sentiment: string | null
  severity: number | null
}

interface DigestRecord {
  digest_date: string
  sentiment_label: string | null
  sector_analysis: {
    sectors_bullish?: string[]
    sectors_bearish?: string[]
    sectors_to_watch?: string[]
  } | null
  top_movers: { tickers?: string[] } | null
}

// ─────────────────────────────────────────────────────────────
// Sector-name normalization
// ─────────────────────────────────────────────────────────────
// macro_events writes sector names that come from the LLM ("technology",
// "energy", "consumer_discretionary", etc.). Scanner uses different
// short codes ("tech", "energy", "consumer_disc", etc.). This map
// bridges them.
//
// We also accept loose phrases — the LLM might write "Tech" or "AI"
// or "semiconductors" — by lowercasing + stripping spaces/underscores
// before lookup.

const SECTOR_ALIAS: Record<string, Sector | 'tag:ai' | 'tag:semis' | 'tag:defense' | 'tag:cybersec' | 'tag:biotech' | 'tag:fintech'> = {
  // Direct sector hits
  'technology':              'tech',
  'tech':                    'tech',
  'healthcare':              'healthcare',
  'health':                  'healthcare',
  'biotech':                 'tag:biotech',
  'biotechnology':           'tag:biotech',
  'financials':              'financials',
  'financial':               'financials',
  'banks':                   'financials',
  'banking':                 'financials',
  'fintech':                 'tag:fintech',
  'energy':                  'energy',
  'oil':                     'energy',
  'oilgas':                  'energy',
  'consumerdiscretionary':   'consumer_disc',
  'consumerdisc':            'consumer_disc',
  'discretionary':           'consumer_disc',
  'consumer':                'consumer_disc',
  'consumerstaples':         'consumer_staples',
  'staples':                 'consumer_staples',
  'industrials':             'industrials',
  'industrial':              'industrials',
  'materials':               'materials',
  'realestate':              'real_estate',
  'reit':                    'real_estate',
  'utilities':               'utilities',
  'utility':                 'utilities',
  'communications':          'communications',
  'communication':           'communications',
  'communicationservices':   'communications',
  'media':                   'communications',

  // Theme tags that the macro layer commonly emits as "sectors"
  'ai':                      'tag:ai',
  'artificialintelligence':  'tag:ai',
  'semis':                   'tag:semis',
  'semiconductors':          'tag:semis',
  'semiconductor':           'tag:semis',
  'chips':                   'tag:semis',
  'defense':                 'tag:defense',
  'aerospace':               'tag:defense',
  'cybersec':                'tag:cybersec',
  'cybersecurity':           'tag:cybersec',
  'security':                'tag:cybersec',
}

function normalizeSectorKey(raw: string): string {
  return raw.toLowerCase().replace(/[\s_/-]+/g, '')
}

/**
 * Returns true if `ticker` (with metadata) is exposed to a sector token
 * coming from a macro event/theme. Token is matched against:
 *   - the ticker's primary sector, OR
 *   - any of its tags (so 'ai' / 'semis' / 'defense' match correctly)
 */
function tickerMatchesSectorToken(
  raw: string,
  tickerSector: Sector,
  tickerTags: string[],
): boolean {
  const key = normalizeSectorKey(raw)
  const target = SECTOR_ALIAS[key]
  if (!target) {
    // Last-ditch: if the raw token directly matches a tag the ticker has,
    // accept it. Lets future macro categories work without code changes.
    return tickerTags.includes(key)
  }
  if (target.startsWith('tag:')) {
    const tag = target.slice(4)
    return tickerTags.includes(tag)
  }
  return tickerSector === target
}

// ─────────────────────────────────────────────────────────────
// Sentiment → sign
// ─────────────────────────────────────────────────────────────
// macro layer uses 'positive' | 'negative' | 'mixed' | 'neutral'.
// Some records use 'bullish' | 'bearish' (digest). Normalize.

function sentimentSign(raw: string | null | undefined): -1 | 0 | 1 {
  if (!raw) return 0
  const s = raw.toLowerCase()
  if (s === 'positive' || s === 'bullish' || s === 'strongly_bullish') return 1
  if (s === 'negative' || s === 'bearish' || s === 'strongly_bearish') return -1
  return 0  // mixed, neutral, unknown → 0 (no directional contribution)
}

function urgencyWeight(raw: string | null | undefined): number {
  switch ((raw ?? '').toLowerCase()) {
    case 'high':     return 1.0
    case 'medium':   return 0.65
    case 'low':      return 0.35
    default:         return 0.5
  }
}

// ─────────────────────────────────────────────────────────────
// Pure scoring function — exported for unit testing
// ─────────────────────────────────────────────────────────────

export interface ScoreNewsExposureInput {
  ticker: string
  tickerSector: Sector
  tickerTags: string[]
  themes: ThemeRecord[]
  events: EventRecord[]
  digest: DigestRecord | null
}

export function scoreNewsExposure(input: ScoreNewsExposureInput): NewsExposureContext {
  const { ticker, tickerSector, tickerTags, themes, events, digest } = input

  let score = 0
  const reasons: string[] = []
  let bestMatchType: 'direct' | 'sector' | 'digest' | 'none' = 'none'

  // ── 1. Active themes ─────────────────────────────────────
  for (const theme of themes) {
    const sign = sentimentSign(theme.sentiment)
    const w = urgencyWeight(theme.urgency)
    const tickers = [
      ...(theme.affected_tickers ?? []),
      ...(theme.tickers_to_watch ?? []),
    ].map(t => t?.toUpperCase()).filter(Boolean)

    const sectors = [
      ...(theme.affected_sectors ?? []),
      ...(theme.sectors_to_watch ?? []),
    ].filter(Boolean)

    const directHit = tickers.includes(ticker)
    const sectorHit = !directHit && sectors.some(s => tickerMatchesSectorToken(s, tickerSector, tickerTags))

    if (directHit) {
      // Base 40 at high-urgency, scaled by w
      const contribution = Math.round(40 * w * (sign === 0 ? 0.5 : 1))
      score += contribution * (sign || 1) * (sign === 0 ? 0 : 1)
      bestMatchType = 'direct'
      if (reasons.length < 3) {
        const dirLabel = sign > 0 ? '↑' : sign < 0 ? '↓' : '·'
        reasons.push(`${dirLabel} ${theme.theme_name}`)
      }
    } else if (sectorHit) {
      const contribution = Math.round(15 * w)
      score += contribution * sign
      if (bestMatchType === 'none') bestMatchType = 'sector'
      if (reasons.length < 3 && sign !== 0) {
        const dirLabel = sign > 0 ? '↑' : '↓'
        reasons.push(`${dirLabel} ${theme.theme_name} (sector)`)
      }
    }
  }

  // ── 2. Macro events ──────────────────────────────────────
  // Events are individual news items; themes are aggregations.
  // We weight events lighter than themes (single news vs persistent theme)
  // and only count direct-ticker matches.
  for (const ev of events) {
    const sign = sentimentSign(ev.sentiment)
    if (sign === 0) continue
    const tickers = (ev.affected_tickers ?? []).map(t => t?.toUpperCase()).filter(Boolean)
    if (!tickers.includes(ticker)) continue

    // Severity 1-10; default 5; bias contribution by severity.
    const sev = Math.max(1, Math.min(10, ev.severity ?? 5))
    const contribution = Math.round(15 * (sev / 10))
    score += contribution * sign
    if (bestMatchType !== 'direct') bestMatchType = 'direct'
    if (reasons.length < 3) {
      const dirLabel = sign > 0 ? '↑' : '↓'
      reasons.push(`${dirLabel} ${ev.title.slice(0, 60)}`)
    }
  }

  // ── 3. Latest digest ─────────────────────────────────────
  if (digest) {
    const sa = digest.sector_analysis ?? {}
    const bullishSectors = sa.sectors_bullish ?? []
    const bearishSectors = sa.sectors_bearish ?? []
    const watchTickers = (digest.top_movers?.tickers ?? []).map(t => t?.toUpperCase()).filter(Boolean)

    if (bullishSectors.some(s => tickerMatchesSectorToken(s, tickerSector, tickerTags))) {
      score += 10
      if (bestMatchType === 'none') bestMatchType = 'digest'
      if (reasons.length < 3) reasons.push('↑ digest bullish sector')
    }
    if (bearishSectors.some(s => tickerMatchesSectorToken(s, tickerSector, tickerTags))) {
      score -= 10
      if (bestMatchType === 'none') bestMatchType = 'digest'
      if (reasons.length < 3) reasons.push('↓ digest bearish sector')
    }
    if (watchTickers.includes(ticker)) {
      // Direction unknown — small unsigned nudge that aligns with the
      // digest's overall sentiment.
      const overall = sentimentSign(digest.sentiment_label)
      if (overall !== 0) {
        score += 5 * overall
        if (bestMatchType === 'none') bestMatchType = 'digest'
        if (reasons.length < 3) reasons.push(`${overall > 0 ? '↑' : '↓'} digest watch`)
      }
    }
  }

  // ── Clamp and summarize ─────────────────────────────────
  score = Math.max(-100, Math.min(100, Math.round(score)))

  let summary = ''
  if (score === 0 || bestMatchType === 'none') {
    summary = 'No news exposure'
  } else {
    const dirWord = score > 0 ? 'tailwind' : 'headwind'
    summary = `${score > 0 ? '+' : ''}${score} news ${dirWord}`
  }

  return { score, summary, reasons, matchType: bestMatchType }
}

// ─────────────────────────────────────────────────────────────
// Build the per-ticker exposure map for an entire scan
// ─────────────────────────────────────────────────────────────
// Single Supabase round trip up front, then pure-function scoring
// per ticker. Tens of milliseconds for a 200-ticker universe.

function getAdmin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )
}

export interface NewsExposureBundle {
  themes: ThemeRecord[]
  events: EventRecord[]
  digest: DigestRecord | null
  generatedAt: string
}

let cachedBundle: { bundle: NewsExposureBundle; fetchedAt: number } | null = null
const NEWS_BUNDLE_TTL_MS = 5 * 60 * 1000  // 5 min — themes/events update slowly

export async function fetchNewsExposureBundle(): Promise<NewsExposureBundle> {
  const now = Date.now()
  if (cachedBundle && now - cachedBundle.fetchedAt < NEWS_BUNDLE_TTL_MS) {
    return cachedBundle.bundle
  }

  const admin = getAdmin()
  const nowIso = new Date().toISOString()
  const sevenDaysAgo = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString()

  // Fetch all three sources in parallel
  const [themesRes, eventsRes, digestRes] = await Promise.all([
    admin
      .from('active_macro_themes')
      .select('id, theme_name, theme_summary, affected_sectors, sectors_to_watch, affected_tickers, tickers_to_watch, sentiment, urgency')
      .gt('expires_at', nowIso)
      .limit(20),
    admin
      .from('macro_events')
      .select('id, title, summary, affected_sectors, affected_tickers, sentiment, severity')
      .gte('detected_at', sevenDaysAgo)
      .order('detected_at', { ascending: false })
      .limit(30),
    admin
      .from('market_digests')
      .select('digest_date, sentiment_label, sector_analysis, top_movers')
      .order('digest_date', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ])

  const bundle: NewsExposureBundle = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    themes: (themesRes.data ?? []) as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    events: (eventsRes.data ?? []) as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    digest: (digestRes.data ?? null) as any,
    generatedAt: nowIso,
  }

  cachedBundle = { bundle, fetchedAt: now }
  return bundle
}

/**
 * Force-clear the in-memory cache. Useful for tests or admin endpoints
 * that want a fresh bundle on the next request.
 */
export function clearNewsExposureCache(): void {
  cachedBundle = null
}

export interface BuildExposureMapInput {
  /** Each entry the caller wants exposure for — only ticker/sector/tags needed. */
  entries: Array<{ ticker: string; sector: Sector; tags: string[] }>
}

/**
 * Returns a Map keyed by ticker → NewsExposureContext.
 * Tickers with no relevant news still get an entry with score=0.
 */
export async function buildNewsExposureMap(
  input: BuildExposureMapInput,
): Promise<Map<string, NewsExposureContext>> {
  const bundle = await fetchNewsExposureBundle()
  const out = new Map<string, NewsExposureContext>()

  for (const e of input.entries) {
    const ctx = scoreNewsExposure({
      ticker: e.ticker,
      tickerSector: e.sector,
      tickerTags: e.tags,
      themes: bundle.themes,
      events: bundle.events,
      digest: bundle.digest,
    })
    out.set(e.ticker, ctx)
  }

  return out
}

// ─────────────────────────────────────────────────────────────
// Apply news exposure to a directional pick score
// ─────────────────────────────────────────────────────────────
// Used by the scanner when the user toggles news boost on.
//
//   - Pick direction: 'bullish' | 'bearish' | 'mixed'
//   - News exposure score: -100..+100
//
// The boost is ALIGNED with the pick's direction:
//   - Bullish pick + positive news = + boost  (confirmation)
//   - Bullish pick + negative news = - penalty (contradiction)
//   - Bearish pick + negative news = + boost
//   - Bearish pick + positive news = - penalty
//   - Mixed pick: news is informational only, no boost (returns 0)
//
// The boost is then BLENDED into composite: composite' = 0.85*composite + 0.15*alignedBoost
// (using boost on the same 0-100 scale as composite, mapped from -100..+100).
//
// Returns both the new composite and the aligned boost so the UI can
// show both numbers if it wants.

export interface ApplyExposureInput {
  composite: number             // existing 0-100 score
  direction: 'bullish' | 'bearish' | 'mixed'
  exposureScore: number         // -100..+100
}

export interface ApplyExposureResult {
  compositeWithNews: number
  alignedBoost: number          // -100..+100, signed in agreement with direction
}

export function applyExposureToComposite(input: ApplyExposureInput): ApplyExposureResult {
  const { composite, direction, exposureScore } = input

  let alignedBoost = 0
  if (direction === 'bullish') alignedBoost = exposureScore
  else if (direction === 'bearish') alignedBoost = -exposureScore
  // mixed → 0

  // Map alignedBoost from -100..+100 onto a 0..100 scale centered at 50,
  // so when blended with composite (0..100) it pulls scores up or down
  // around the existing baseline.
  const boostOnScale = 50 + alignedBoost / 2  // -100 → 0, 0 → 50, +100 → 100

  const blended = composite * 0.85 + boostOnScale * 0.15
  const compositeWithNews = Math.max(0, Math.min(100, Math.round(blended)))

  return { compositeWithNews, alignedBoost }
}
