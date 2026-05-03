// ═════════════════════════════════════════════════════════════
// app/lib/verification.ts
//
// Gap #9 --- Factual claim verification using Gemini 2.5 Pro with
// Google Search grounding. Catches the failure mode where Lead or
// Devil cite UNVERIFIED X tweets as if they were factual claims.
//
// Example caught: Devil cites "@TheCryptoU says NY Fed's $7.5B Treasury
// buy is bullish for BTC" --- but the tweet was a QUESTION, not a report.
// Verification finds no credible outlet reporting the claim, strips it
// before the Judge sees it.
//
// Architecture:
//   1. Extract factual claims from reasoning block (1 Gemini call, no grounding)
//   2. Batch-verify all claims in a single grounded Gemini call
//   3. Inspect groundingMetadata to confirm credible non-X sources
//   4. Return verified/stripped split, log everything
//
// Uses Gemini 2.5 Pro for verification quality. Batching keeps cost/latency
// reasonable (~40s and ~$0.04 per full debate verification).
// ═════════════════════════════════════════════════════════════

import { GoogleGenerativeAI } from '@google/generative-ai'
import { generateWithFallback, generateJSON } from './gemini-helper'
import { createClient } from '@supabase/supabase-js'

const getGenAI = () => new GoogleGenerativeAI(process.env.GEMINI_API_KEY!)

const getAdmin = () => createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

// ─────────────────────────────────────────────────────────────
// Credible outlet whitelist --- used to inspect groundingMetadata
// ─────────────────────────────────────────────────────────────
// A claim is "verified" only if Gemini's grounded search returned a
// source from one of these domains. X/Twitter are explicitly excluded
// because that's where the unverified claims originated.
const CREDIBLE_DOMAINS = new Set([
  // Tier 1 --- major financial journalism
  'reuters.com',
  'bloomberg.com',
  'wsj.com',
  'ft.com',
  'nytimes.com',
  'economist.com',
  'washingtonpost.com',

  // Tier 2 --- reputable financial news
  'cnbc.com',
  'marketwatch.com',
  'barrons.com',
  'finance.yahoo.com',
  'investors.com',
  'forbes.com',
  'fortune.com',
  'businessinsider.com',
  'axios.com',
  'bnnbloomberg.ca',
  'apnews.com',
  'cnn.com',
  'abcnews.go.com',
  'nbcnews.com',
  'foxbusiness.com',

  // Tier 3 --- financial coverage (slightly looser)
  'seekingalpha.com',
  'benzinga.com',
  'investing.com',
  'thestreet.com',
  'morningstar.com',
  'zerohedge.com',
  'kitco.com',
  'tradingeconomics.com',
  'finimize.com',

  // Primary sources
  'sec.gov',
  'federalreserve.gov',
  'treasury.gov',
  'bls.gov',
  'bea.gov',
  'cftc.gov',
  'fdic.gov',
  'newyorkfed.org',
  'congress.gov',
  'whitehouse.gov',
  'house.gov',
  'senate.gov',
  'europa.eu',
  'bankofengland.co.uk',
  'ecb.europa.eu',

  // Crypto-specific reputable sources (for crypto tickers)
  'coindesk.com',
  'theblock.co',
  'decrypt.co',
  'cointelegraph.com',
  'cryptoslate.com',
  'ambcrypto.com',
  'beincrypto.com',
  'u.today',
  'watcher.guru',
  'blockworks.co',
  'cryptobriefing.com',
  'protos.com',

  // Data sources (canonical for data-type claims)
  'alternative.me',           // Crypto Fear & Greed Index
  'coingecko.com',             // Crypto prices
  'coinmarketcap.com',         // Crypto market data
  'fred.stlouisfed.org',       // Fed economic data
  'blockchain.com',            // On-chain data
  'glassnode.com',             // On-chain analytics
  'dune.com',                  // Query-based blockchain analytics
  'defillama.com',             // DeFi TVL data
])

const EXCLUDED_DOMAINS = new Set([
  'x.com', 'twitter.com', 't.co',
  'reddit.com',
  'stocktwits.com',
  'tiktok.com', 'instagram.com',
  'youtube.com',  // often X reposts
])

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────
export interface ClaimVerification {
  claim: string
  verified: boolean
  sourceUrl: string | null
  sourceOutlet: string | null
  reasoning: string
}

export interface VerificationResult {
  verifiedClaims: string[]               // claims that passed verification
  strippedClaims: ClaimVerification[]    // claims that were cut
  noClaimsFound: boolean                  // true if block had no factual claims
  totalExtracted: number
  verifiedCount: number
  strippedCount: number
  allSourceUrls: string[]                 // flat list of all verified source URLs
  error: string | null
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
interface GroundingChunk { web?: { uri?: string; title?: string } }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
interface GroundingMetadata { groundingChunks?: GroundingChunk[] }

// ─────────────────────────────────────────────────────────────
// Helper: extract domain from URL safely
// ─────────────────────────────────────────────────────────────
function extractDomain(url: string): string | null {
  try {
    const u = new URL(url)
    return u.hostname.replace(/^www\./, '').toLowerCase()
  } catch {
    return null
  }
}

function isCredibleDomain(url: string): boolean {
  const domain = extractDomain(url)
  if (!domain) return false
  if (EXCLUDED_DOMAINS.has(domain)) return false
  // Match exact or subdomain
  for (const credible of CREDIBLE_DOMAINS) {
    if (domain === credible || domain.endsWith('.' + credible)) return true
  }
  return false
}

// Map of well-known outlet name fragments -> canonical credible domain.
// Used to match Gemini grounding `title` fields when the URI is a
// vertexaisearch.cloud.google.com redirect (which hides the real source).
// Names are matched case-insensitively as substrings of the title.
//
// Defensive: only includes outlets already in CREDIBLE_DOMAINS. We are
// not opening the credibility door wider --- just adding a name-based
// path to the same whitelist.
const CREDIBLE_OUTLET_NAMES: Array<[string, string]> = [
  // [outlet name fragment (lowercase), canonical domain]
  ['bloomberg', 'bloomberg.com'],
  ['reuters', 'reuters.com'],
  ['wall street journal', 'wsj.com'],
  ['the wsj', 'wsj.com'],
  ['financial times', 'ft.com'],
  ['the economist', 'economist.com'],
  ['new york times', 'nytimes.com'],
  ['nyt', 'nytimes.com'],
  ['washington post', 'washingtonpost.com'],
  ['cnbc', 'cnbc.com'],
  ['marketwatch', 'marketwatch.com'],
  ["barron's", 'barrons.com'],
  ['barrons', 'barrons.com'],
  ['yahoo finance', 'finance.yahoo.com'],
  ["investor's business daily", 'investors.com'],
  ['ibd', 'investors.com'],
  ['forbes', 'forbes.com'],
  ['fortune', 'fortune.com'],
  ['business insider', 'businessinsider.com'],
  ['axios', 'axios.com'],
  ['ap news', 'apnews.com'],
  ['associated press', 'apnews.com'],
  ['cnn business', 'cnn.com'],
  ['fox business', 'foxbusiness.com'],
  ['nbc news', 'nbcnews.com'],
  ['abc news', 'abcnews.go.com'],
  ['seeking alpha', 'seekingalpha.com'],
  ['benzinga', 'benzinga.com'],
  ['investing.com', 'investing.com'],
  ['thestreet', 'thestreet.com'],
  ['the street', 'thestreet.com'],
  ['morningstar', 'morningstar.com'],
  ['zerohedge', 'zerohedge.com'],
  ['kitco', 'kitco.com'],
  ['trading economics', 'tradingeconomics.com'],
  ['finimize', 'finimize.com'],
  ['sec.gov', 'sec.gov'],
  ['securities and exchange commission', 'sec.gov'],
  ['federal reserve', 'federalreserve.gov'],
  ['u.s. treasury', 'treasury.gov'],
  ['us treasury', 'treasury.gov'],
  ['bureau of labor statistics', 'bls.gov'],
  ['bureau of economic analysis', 'bea.gov'],
  ['cftc', 'cftc.gov'],
  ['fdic', 'fdic.gov'],
  ['new york fed', 'newyorkfed.org'],
  ['ny fed', 'newyorkfed.org'],
  ['congress.gov', 'congress.gov'],
  ['white house', 'whitehouse.gov'],
  ['european central bank', 'ecb.europa.eu'],
  ['bank of england', 'bankofengland.co.uk'],
  ['coindesk', 'coindesk.com'],
  ['the block', 'theblock.co'],
  ['decrypt', 'decrypt.co'],
  ['cointelegraph', 'cointelegraph.com'],
  ['cryptoslate', 'cryptoslate.com'],
  ['ambcrypto', 'ambcrypto.com'],
]

function isCredibleSourceTitle(title: string): boolean {
  if (!title) return false
  const lc = title.toLowerCase()
  // First: try to extract a domain-like token from the title
  // (e.g. "bloomberg.com - Stock News" → 'bloomberg.com')
  const domainMatch = lc.match(/[a-z0-9-]+(?:\.[a-z0-9-]+)+/)
  if (domainMatch) {
    const candidate = domainMatch[0].replace(/^www\./, '')
    if (EXCLUDED_DOMAINS.has(candidate)) return false
    for (const credible of CREDIBLE_DOMAINS) {
      if (candidate === credible || candidate.endsWith('.' + credible)) return true
    }
  }
  // Second: match outlet names (Bloomberg, Reuters, etc.)
  for (const [fragment] of CREDIBLE_OUTLET_NAMES) {
    if (lc.includes(fragment)) return true
  }
  return false
}

// ─────────────────────────────────────────────────────────────
// Step 1: Extract factual claims from a reasoning block
// ─────────────────────────────────────────────────────────────
// Not everything in reasoning needs verification. We extract only
// sentences that make specific factual claims about events, attributions,
// dates, or institutional actions. Technical readings, sentiment
// descriptions, and hypotheticals are NOT claims.

async function extractFactualClaims(ticker: string, textBlock: string): Promise<string[]> {
  const prompt = `You are a precise fact-checker. Given a block of stock market analysis reasoning about ${ticker}, extract ONLY the sentences that make specific FACTUAL CLAIMS which could be checked against news sources.

EXTRACT (these are factual claims):
- Specific named events: "NY Fed's $7.5B Treasury buy tomorrow"
- Institutional actions: "BlackRock added 500k shares last week"
- Attributions: "JPMorgan downgraded NVDA to neutral"
- Dates/catalysts: "Earnings report Thursday after close"
- Quoted numbers with named sources: "CPI came in at 3.2% vs 3.4% consensus"
- Specific policy/regulatory actions: "SEC approved spot ETH ETF"

DO NOT EXTRACT (these are not factual claims):
- Technical indicator readings: "RSI is oversold at 28" (data we have)
- Sentiment descriptions: "Retail is panicking" (mood, not fact)
- Conditional statements: "If price breaks $75k, shorts could squeeze"
- Reasoning/logic: "The bearish thesis depends on..."
- Common knowledge: "BTC is below its all-time high"
- Tweet-style citations without underlying event: "@Someone said bearish"
- Descriptions of what posters/traders are saying (that's sentiment)

REASONING BLOCK:
"""
${textBlock.slice(0, 4000)}
"""

Return ONLY this JSON, no other text:
{
  "claims": ["claim 1 text", "claim 2 text", ...]
}

If there are NO factual claims in the block, return: { "claims": [] }
Return each claim as a standalone self-contained sentence, reworded if needed for clarity.
Maximum 8 claims.`

  try {
    const { data: parsed } = await generateJSON<{ claims?: unknown[] }>({
      prompt,
      caller: 'verification:claim-extract',
      temperature: 0.1,
      maxOutputTokens: 4000,
    })
    const claims = Array.isArray(parsed.claims) ? parsed.claims : []
    return claims
      .filter((c: unknown) => typeof c === 'string' && c.length > 10)
      .map((c: string) => (c as string).trim().slice(0, 400))
      .slice(0, 8)
  } catch (e) {
    console.warn('[verification] claim extraction failed:', (e as Error).message?.slice(0, 200))
    return []
  }
}

// ─────────────────────────────────────────────────────────────
// Step 2: Batch-verify claims using Gemini with Google Search grounding
// ─────────────────────────────────────────────────────────────
async function batchVerifyClaims(
  ticker: string,
  claims: string[],
): Promise<ClaimVerification[]> {
  if (claims.length === 0) return []

  const claimsBlock = claims.map((c, i) => `[${i + 1}] ${c}`).join('\n')

  const prompt = `You are a financial fact-checker. For each of the following claims about ${ticker}, use Google Search to verify whether credible NON-social-media sources report it.

ACCEPTABLE SOURCES (these count as verification):
- Major financial journalism: Reuters, Bloomberg, WSJ, FT, CNBC, MarketWatch, Barron's, Financial Times
- Primary sources: SEC filings, Fed/Treasury/BLS publications, company IR pages, government websites
- Reputable crypto journalism: CoinDesk, The Block, Decrypt, CoinTelegraph, Blockworks
- Canonical data sources (for data/index claims): Alternative.me (Crypto Fear & Greed), CoinGecko, CoinMarketCap, FRED (stlouisfed.org), TradingEconomics, Glassnode, DeFiLlama
- Crypto news aggregators: Watcher.Guru, u.today, CryptoSlate, BeInCrypto, AmbCrypto

NOT ACCEPTABLE (do not count as verification):
- X/Twitter, Reddit, Stocktwits, TikTok, Instagram, YouTube
- Random blogs with no editorial oversight
- Unsourced forum posts

CLAIMS TO VERIFY:
${claimsBlock}

For EACH claim, determine:
- verified: true if at least one ACCEPTABLE source (above) confirms it; false otherwise
- sourceUrl: the URL of the most credible source found (null if none)
- sourceOutlet: the outlet name (e.g., "Reuters", "Bloomberg", "SEC filing", "Alternative.me")
- reasoning: 1-2 sentences on why verified or why rejected

CRITICAL CONSISTENCY RULE:
If your reasoning states that sources confirmed the claim, you MUST set verified=true.
If your reasoning states sources did not confirm or you couldn't find corroboration, you MUST set verified=false.
Never set verified=false while writing reasoning that says "multiple outlets reported..." or "confirmed by..." --- these are contradictions. Read your own reasoning carefully before setting the verified field.

VERIFICATION GUIDANCE:
- Data/index claims (e.g., "Fear & Greed at 27", "BTC at $74k", "CPI came in at 3.2%") → check canonical data sources first
- Event claims (e.g., "NY Fed buying Treasuries tomorrow", "SEC approved ETF") → require credible news coverage
- Price movements with news context → verify the underlying news event, not the exact price
- Vague claims ("sentiment is bearish") → mark UNVERIFIED, these are not factual
- Future events → look for announcements from the relevant institution

Return ONLY this JSON, no other text:
{
  "verifications": [
    {
      "claimIndex": 1,
      "verified": true,
      "sourceUrl": "https://...",
      "sourceOutlet": "Reuters",
      "reasoning": "Reuters reported on April 18 that..."
    }
  ]
}

Return one object per claim in order. If a claim can't be verified, set verified: false and sourceUrl: null.`

  try {
    const { text, rawResponse } = await generateWithFallback({
      prompt,
      caller: 'verification:batch-verify',
      temperature: 0.1,
      maxOutputTokens: 6000,
      useGoogleSearchGrounding: true,
    })

    // Parse JSON out of response (it may have markdown fences even with grounding)
    const cleaned = text.replace(/```json|```/g, '').trim()
    const start = cleaned.indexOf('{')
    const end = cleaned.lastIndexOf('}')
    if (start === -1 || end === -1) {
      console.warn('[verification] no JSON in batch verify response')
      return claims.map((c) => ({
        claim: c, verified: false, sourceUrl: null, sourceOutlet: null,
        reasoning: 'Verification response had no parseable JSON',
      }))
    }

    const parsed = JSON.parse(cleaned.slice(start, end + 1))
    const verifications = Array.isArray(parsed.verifications) ? parsed.verifications : []

    // Inspect groundingMetadata for an independent check on sources
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const meta = (rawResponse?.candidates?.[0] as any)?.groundingMetadata as GroundingMetadata | undefined
    // Build a richer source list. Gemini's grounding API returns
    // redirect URLs in `uri` (always vertexaisearch.cloud.google.com),
    // but the underlying source name is in `title`. We check BOTH.
    const groundingSources: Array<{ uri: string; title: string }> = (meta?.groundingChunks ?? [])
      .map((ch) => ({
        uri: ch?.web?.uri ?? '',
        title: ch?.web?.title ?? '',
      }))
      .filter(s => s.uri || s.title)
    const groundingUrls: string[] = groundingSources.map(s => s.uri).filter(Boolean)
    const credibleGroundingSources = groundingSources.filter(s =>
      isCredibleDomain(s.uri) || isCredibleSourceTitle(s.title)
    )
    const credibleGroundingUrls = credibleGroundingSources.map(s => s.uri).filter(Boolean)

    console.log(`[verification] Gemini grounding surfaced ${groundingUrls.length} sources (${credibleGroundingUrls.length} credible)`)

    // Map each claim to its verification result
    return claims.map((claim, i) => {
      const v = verifications.find((x: { claimIndex: number }) => x.claimIndex === i + 1) ?? verifications[i]
      if (!v) {
        return {
          claim,
          verified: false,
          sourceUrl: null,
          sourceOutlet: null,
          reasoning: 'No verification returned for this claim',
        }
      }

      // Double-check: even if model says "verified", require the source URL
      // to be from a credible domain (or the groundingMetadata to include one).
      const modelSaidVerified = !!v.verified
      const providedUrl = typeof v.sourceUrl === 'string' && v.sourceUrl.startsWith('http') ? v.sourceUrl : null
      const providedUrlIsCredible = providedUrl ? isCredibleDomain(providedUrl) : false
      const modelReasoning = typeof v.reasoning === 'string' ? v.reasoning.slice(0, 400) : ''
      const modelOutlet = typeof v.sourceOutlet === 'string' ? v.sourceOutlet.slice(0, 80) : null

      // Heuristic: detect self-contradiction. If model's reasoning text strongly
      // suggests verification succeeded (e.g. "multiple outlets reported",
      // "confirmed by", "sources confirm"), but verified=false, it's likely
      // a structured-output glitch. Trust the reasoning's tone.
      const reasoningSuggestsVerified = /multiple (outlets|sources) (reported|confirm)|confirmed by|sources (confirm|show|verify)|well[- ]documented|widely reported|(reuters|bloomberg|wsj|cnbc|ft) (reports|reported|covered)/i.test(modelReasoning)

      // If flagged as verified by the model OR the reasoning clearly suggests
      // verification succeeded, try to find a credible URL. Then apply the
      // whitelist check as the final gate.
      const effectiveModelVerified = modelSaidVerified || (reasoningSuggestsVerified && credibleGroundingUrls.length > 0)

      let finalUrl: string | null = null
      if (providedUrlIsCredible) {
        finalUrl = providedUrl
      } else if (effectiveModelVerified && credibleGroundingUrls.length > 0) {
        finalUrl = credibleGroundingUrls[0]
      }

      const finalVerified = effectiveModelVerified && !!finalUrl

      // Construct a clean reasoning/rejection_reason
      let cleanReasoning: string
      if (finalVerified) {
        // Verified: store model's reasoning as-is
        cleanReasoning = modelReasoning
      } else if (modelSaidVerified && !finalUrl) {
        // Demotion case: model said verified but neither URL nor grounding
        // provided a credible domain. Store clear reason, not model reasoning.
        const citedDomain = providedUrl ? (extractDomain(providedUrl) ?? 'unknown') : 'none'
        cleanReasoning = `Model claimed verification via ${modelOutlet ?? citedDomain} but source not in credible whitelist. Grounding returned ${groundingUrls.length} sources (${credibleGroundingUrls.length} credible).`
      } else if (!modelSaidVerified && reasoningSuggestsVerified && credibleGroundingUrls.length === 0) {
        // Self-contradiction with no credible grounding to rescue it
        cleanReasoning = `Model reasoning suggested verification but verified=false and no credible grounding sources found. Possible structured-output glitch. Original reasoning: ${modelReasoning.slice(0, 200)}`
      } else {
        // Genuine rejection --- use model's reasoning
        cleanReasoning = modelReasoning || 'Claim not confirmed by credible mainstream sources'
      }

      return {
        claim,
        verified: finalVerified,
        sourceUrl: finalUrl,
        sourceOutlet: modelOutlet,
        reasoning: cleanReasoning,
      }
    })
  } catch (e) {
    console.warn('[verification] batch verify failed:', (e as Error).message?.slice(0, 200))
    return claims.map((c) => ({
      claim: c,
      verified: false,
      sourceUrl: null,
      sourceOutlet: null,
      reasoning: `Verification error: ${(e as Error).message?.slice(0, 150) ?? 'unknown'}`,
    }))
  }
}

// ─────────────────────────────────────────────────────────────
// Main entrypoint --- verify a reasoning block
// ─────────────────────────────────────────────────────────────
export async function verifyFactualClaims(
  ticker: string,
  sourceStage: 'lead' | 'devil' | 'rebuttal' | 'counter',
  textBlock: string,
  analysisId?: string,
): Promise<VerificationResult> {
  const started = Date.now()
  const trimmed = (textBlock || '').trim()

  if (trimmed.length < 40) {
    return {
      verifiedClaims: [],
      strippedClaims: [],
      noClaimsFound: true,
      totalExtracted: 0,
      verifiedCount: 0,
      strippedCount: 0,
      allSourceUrls: [],
      error: null,
    }
  }

  try {
    // Step 1: extract factual claims
    const claims = await extractFactualClaims(ticker, trimmed)
    if (claims.length === 0) {
      logVerification(ticker, sourceStage, [], [], analysisId, Date.now() - started)
      return {
        verifiedClaims: [],
        strippedClaims: [],
        noClaimsFound: true,
        totalExtracted: 0,
        verifiedCount: 0,
        strippedCount: 0,
        allSourceUrls: [],
        error: null,
      }
    }

    // Step 2: batch verify
    const verifications = await batchVerifyClaims(ticker, claims)

    const verifiedClaims: string[] = []
    const strippedClaims: ClaimVerification[] = []
    const allSourceUrls: string[] = []

    for (const v of verifications) {
      if (v.verified) {
        verifiedClaims.push(v.claim)
        if (v.sourceUrl) allSourceUrls.push(v.sourceUrl)
      } else {
        strippedClaims.push(v)
      }
    }

    // Step 3: log to DB (fire-and-forget)
    logVerification(ticker, sourceStage, verifiedClaims, strippedClaims, analysisId, Date.now() - started)

    return {
      verifiedClaims,
      strippedClaims,
      noClaimsFound: false,
      totalExtracted: claims.length,
      verifiedCount: verifiedClaims.length,
      strippedCount: strippedClaims.length,
      allSourceUrls,
      error: null,
    }
  } catch (e) {
    const msg = (e as Error).message?.slice(0, 200) ?? 'unknown'
    console.error('[verification] top-level failure:', msg)
    // On error, don't strip anything --- fail open so pipeline doesn't break
    return {
      verifiedClaims: [],
      strippedClaims: [],
      noClaimsFound: true,
      totalExtracted: 0,
      verifiedCount: 0,
      strippedCount: 0,
      allSourceUrls: [],
      error: msg,
    }
  }
}

// ─────────────────────────────────────────────────────────────
// Fire-and-forget logging to verification_log
// ─────────────────────────────────────────────────────────────
function logVerification(
  ticker: string,
  sourceStage: 'lead' | 'devil' | 'rebuttal' | 'counter',
  verified: string[],
  stripped: ClaimVerification[],
  analysisId: string | undefined,
  elapsedMs: number,
): void {
  void (async () => {
    try {
      const admin = getAdmin()
      // One row per claim (verified or stripped)
      const rows = [
        ...verified.map((claim) => ({
          ticker,
          source_stage: sourceStage,
          analysis_id: analysisId ?? null,
          claim: claim.slice(0, 1000),
          verified: true,
          source_url: null,
          source_outlet: null,
          rejection_reason: null,
          elapsed_ms: elapsedMs,
        })),
        ...stripped.map((s) => ({
          ticker,
          source_stage: sourceStage,
          analysis_id: analysisId ?? null,
          claim: s.claim.slice(0, 1000),
          verified: false,
          source_url: s.sourceUrl,
          source_outlet: s.sourceOutlet,
          rejection_reason: s.reasoning?.slice(0, 500) ?? null,
          elapsed_ms: elapsedMs,
        })),
      ]
      if (rows.length > 0) {
        await admin.from('verification_log').insert(rows)
      }
    } catch (e) {
      console.warn('[verification-log] failed:', (e as Error).message?.slice(0, 100))
    }
  })()
}

// ─────────────────────────────────────────────────────────────
// Utility: strip stripped-claim text from a reasoning block
// ─────────────────────────────────────────────────────────────
// Used by the pipeline to produce a cleaned version of the reasoning
// that the Judge will see. We do best-effort sentence-level removal.
export function stripClaimsFromText(original: string, claimsToStrip: ClaimVerification[]): string {
  let cleaned = original
  for (const c of claimsToStrip) {
    // Try to find and remove the claim (or close match) from the text
    const claim = c.claim.trim()
    if (!claim) continue
    // Exact match
    if (cleaned.includes(claim)) {
      cleaned = cleaned.replace(claim, '[UNVERIFIED CLAIM REMOVED]')
      continue
    }
    // Loose match: take first 40 chars and see if we find them
    const anchor = claim.slice(0, 40)
    const idx = cleaned.indexOf(anchor)
    if (idx !== -1) {
      // Find the end of the sentence
      const endSearch = cleaned.slice(idx).match(/^[^.!?]+[.!?]/)
      if (endSearch) {
        cleaned = cleaned.slice(0, idx) + '[UNVERIFIED CLAIM REMOVED]' + cleaned.slice(idx + endSearch[0].length)
      }
    }
  }
  return cleaned
}
