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
import type { SignalBundle } from './aggregator'

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
  'marketbeat.com',
  'thestreet.com',
  'morningstar.com',
  'zerohedge.com',
  'kitco.com',
  'tradingeconomics.com',
  'finimize.com',

  // Primary sources
  'sec.gov',
  'efts.sec.gov',           // EDGAR full-text search
  'data.sec.gov',           // EDGAR data API
  'macrotrends.net',        // long-running aggregator sourced from filings
  'stockanalysis.com',      // commonly cited, sourced from filings
  'tipranks.com',           // analyst consensus aggregator
  'fintel.io',              // institutional + insider data aggregator
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
  ['marketbeat', 'marketbeat.com'],
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
      .filter((c: unknown): c is string => typeof c === 'string' && c.length > 10)
      .map((c) => c.trim().slice(0, 400))
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
- Headline citations → verify the underlying event/topic, NOT the exact headline wording. Outlets phrase the same story differently. If the model cites a headline like "AI's $725 Billion Power Problem" and credible sources cover the underlying topic (AI infrastructure capex around that figure), mark VERIFIED. Only mark UNVERIFIED if the underlying topic itself isn't reported by credible sources.
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
// ─────────────────────────────────────────────────────────────
// Bundle source-of-truth pre-check (Bug 11 fix, May 2026)
// ─────────────────────────────────────────────────────────────
// Verification's Google Search approach generates false-positive strips
// for facts the bundle already knows authoritatively. Examples seen
// in production:
//   - Persona cites "$600.8M insider selling" (correct, EDGAR-sourced).
//     MarketBeat reports "$58.7M over 24 months" (different time window
//     and definition). Verification strips the persona claim because
//     credible source disagrees → Judge thinks correct fact is wrong.
//   - Persona cites "P/E 38.1x". Investing.com says 38.30. Verification
//     strips because of 0.5% rounding difference.
//   - Persona cites "10.49 P/C ratio". Fintel says 0.64 (chain-wide
//     OI ratio). Verification strips correct single-expiry math.
//
// This pre-check runs BEFORE Google Search. It checks each claim
// against the bundle's source-of-truth fields. If the bundle confirms
// (within tolerance), mark verified and skip Gemini. If the bundle
// directly contradicts, mark stripped with a clear "bundle disagrees"
// reason. If the bundle is silent on the topic, return null and let
// the existing Google Search verification run as before.
//
// Conservative by design: we'd rather fall through to Google Search
// (worst case: false-strip) than mark a hallucination verified because
// the math accidentally lands near a real bundle value.
// ─────────────────────────────────────────────────────────────

interface BundleCheckResult {
  matched: boolean              // true = bundle has authoritative answer; false = silent
  verified?: boolean            // when matched: true=confirms, false=contradicts
  sourceOutlet?: string
  reasoning?: string
}

// Pull a numeric dollar amount from a claim. Returns the dollar value as
// a Number (e.g., "600.8M" → 600_800_000, "$5.3B" → 5_300_000_000).
// Returns null if no clear dollar amount is found.
function extractDollarAmount(text: string): number | null {
  // Match patterns like $600.8M, 600.8M, $5.3B, $58.7 million, $1.2 billion
  const re = /\$?\s*([\d,]+(?:\.\d+)?)\s*(b|m|k|billion|million|thousand)\b/i
  const m = text.match(re)
  if (!m) return null
  const num = parseFloat(m[1].replace(/,/g, ''))
  if (!Number.isFinite(num)) return null
  const unit = m[2].toLowerCase()
  const multiplier =
    unit === 'b' || unit === 'billion'  ? 1e9 :
    unit === 'm' || unit === 'million'  ? 1e6 :
    unit === 'k' || unit === 'thousand' ? 1e3 : 1
  return num * multiplier
}

// Pull the first plain numeric value from a claim (no $ or unit required).
// Used for ratio/percentage matching. Returns null if no number found.
function extractFirstNumber(text: string): number | null {
  const m = text.match(/(\d+(?:\.\d+)?)/)
  if (!m) return null
  const num = parseFloat(m[1])
  return Number.isFinite(num) ? num : null
}

function withinTolerance(claimed: number, actual: number, tolerancePct: number): boolean {
  if (actual === 0) return claimed === 0
  return Math.abs(claimed - actual) / Math.abs(actual) <= tolerancePct
}

// Main pre-check. Returns matched=false to let Google Search handle the claim.
function tryVerifyAgainstBundle(claim: string, bundle: SignalBundle | undefined): BundleCheckResult {
  if (!bundle) return { matched: false }
  const c = claim.toLowerCase()

  // ── Insider activity claims ────────────────────────────────
  // Match patterns: "insider selling of $X", "$X in insider sales",
  // "insiders sold $X", "executive selling $X", etc.
  const isInsiderClaim = /insider/i.test(c) || /\b(executive|officer|director)s?\b.*\b(sold|sell|selling|bought|buy|buying)\b/i.test(c)
  if (isInsiderClaim) {
    const claimedDollars = extractDollarAmount(claim)
    if (claimedDollars !== null && claimedDollars > 0) {
      // Detect direction (bought vs sold) from the claim text
      const isSelling = /\b(sold|sell|selling|sale|sales|exit|divest)\b/i.test(c)
      const isBuying  = /\b(bought|buy|buying|purchase|purchases|accumulat)\b/i.test(c)
      const sellValue = bundle.fundamentals?.insiderSellValue ?? 0
      const buyValue  = bundle.fundamentals?.insiderBuyValue ?? 0

      // Pick the bundle value that matches the claim's direction.
      // If direction is ambiguous (claim says just "insider activity"),
      // compare against gross flow (buy + sell) since that's what's typically
      // reported as "insider trading volume."
      const bundleValue =
        isSelling && !isBuying ? sellValue :
        isBuying && !isSelling ? buyValue :
        sellValue + buyValue

      // ±10% tolerance on insider dollar amounts. Authoritative source is
      // EDGAR Form 4 filings via insider_transactions table (90-day window,
      // open-market only).
      if (withinTolerance(claimedDollars, bundleValue, 0.10)) {
        return {
          matched: true,
          verified: true,
          sourceOutlet: 'EDGAR (bundle source-of-truth)',
          reasoning: `Bundle confirms: 90-day open-market insider ${isSelling ? 'selling' : isBuying ? 'buying' : 'activity'} = $${(bundleValue/1e6).toFixed(1)}M (claim: $${(claimedDollars/1e6).toFixed(1)}M, within tolerance).`,
        }
      }
      // Bundle has authoritative data and the claim doesn't match.
      // Only mark as a contradiction if the bundle has non-trivial data
      // (otherwise we might be stripping correct claims for tickers where
      // we just don't have insider data ingested yet).
      if (sellValue > 0 || buyValue > 0) {
        return {
          matched: true,
          verified: false,
          sourceOutlet: 'EDGAR (bundle source-of-truth)',
          reasoning: `Bundle contradicts: claim cites $${(claimedDollars/1e6).toFixed(1)}M but EDGAR Form 4 (90d open-market) shows insider buying $${(buyValue/1e6).toFixed(1)}M / selling $${(sellValue/1e6).toFixed(1)}M.`,
        }
      }
      // Bundle has no insider data at all → fall through to Google Search.
      return { matched: false }
    }
  }

  // ── Put/Call ratio claims ─────────────────────────────────
  // Match: "put/call ratio of X.XX", "P/C ratio X.XX", "put-call X.XX"
  const isPCClaim = /\b(put[/\s-]?call|p[/\s-]?c)\s*(ratio|vol|volume|oi)?/i.test(c)
  if (isPCClaim) {
    const claimedRatio = extractFirstNumber(claim)
    if (claimedRatio !== null && claimedRatio > 0 && claimedRatio < 50) {
      const volRatio = bundle.optionsFlow?.putCallRatio ?? null
      const oiRatio = (bundle.optionsFlow as { putCallOIRatio?: number | null } | undefined)?.putCallOIRatio ?? null
      // Allow match against either vol or OI ratio (claim may not specify which).
      // ±10% tolerance — slightly looser than dollars to tolerate rounding +
      // intraday volatility in the snapshot vs the bundle's earlier sample.
      const matches: string[] = []
      if (volRatio !== null && withinTolerance(claimedRatio, volRatio, 0.10)) {
        matches.push(`Put/Call Vol ratio = ${volRatio.toFixed(2)}`)
      }
      if (oiRatio !== null && withinTolerance(claimedRatio, oiRatio, 0.10)) {
        matches.push(`Put/Call OI ratio = ${oiRatio.toFixed(2)}`)
      }
      if (matches.length > 0) {
        return {
          matched: true,
          verified: true,
          sourceOutlet: 'Tradier options chain (bundle source-of-truth)',
          reasoning: `Bundle confirms: ${matches.join(', ')} (claim: ${claimedRatio.toFixed(2)}, within tolerance).`,
        }
      }
      // Bundle has data but neither matches → contradicts.
      if (volRatio !== null || oiRatio !== null) {
        const parts: string[] = []
        if (volRatio !== null) parts.push(`Vol=${volRatio.toFixed(2)}`)
        if (oiRatio !== null) parts.push(`OI=${oiRatio.toFixed(2)}`)
        return {
          matched: true,
          verified: false,
          sourceOutlet: 'Tradier options chain (bundle source-of-truth)',
          reasoning: `Bundle contradicts: claim cites P/C ${claimedRatio.toFixed(2)} but bundle (front 3 monthlies) shows ${parts.join(', ')}.`,
        }
      }
      return { matched: false }
    }
  }

  // ── P/E ratio claims ──────────────────────────────────────
  // Match: "P/E of 38.1x", "P/E ratio 38.1", "trailing P/E 38.1",
  //        "forward P/E 16.2x". Detect forward vs trailing.
  const isPEClaim = /\bp[/\s-]?e\s*(ratio|of|is|=|:)?\s*(\d+(?:\.\d+)?)/i.test(c)
  if (isPEClaim) {
    const claimedPE = extractFirstNumber(claim.replace(/p[/\s-]?e/ig, ''))
    if (claimedPE !== null && claimedPE > 0 && claimedPE < 1000) {
      const isForward = /\bforward\b/i.test(c) || /\bfwd\b/i.test(c)
      const isTrailing = /\b(trailing|ttm|normalized)\b/i.test(c)
      const fwdPE = bundle.fundamentals?.forwardPE ?? null
      const ttmPE = bundle.fundamentals?.peRatio ?? null
      const target =
        isForward && !isTrailing ? fwdPE :
        isTrailing && !isForward ? ttmPE :
        ttmPE  // default to TTM if ambiguous

      // ±5% tolerance — P/E is often quoted with rounding; provider
      // disagreement on "exactly 38.1 vs 38.30" shouldn't strip claims.
      if (target !== null && withinTolerance(claimedPE, target, 0.05)) {
        return {
          matched: true,
          verified: true,
          sourceOutlet: 'Bundle fundamentals (Finnhub-sourced)',
          reasoning: `Bundle confirms: ${isForward ? 'forward' : 'trailing'} P/E = ${target.toFixed(2)} (claim: ${claimedPE.toFixed(2)}, within 5%).`,
        }
      }
      // Don't actively contradict — P/E values vary by methodology
      // (which earnings to use, adjusted vs GAAP, etc.). Just fall
      // through and let Google Search handle the disagreement.
    }
  }

  // ── Analyst consensus claims ──────────────────────────────
  // Match exact strings: "STRONG BUY", "BUY", "HOLD", "SELL", "STRONG SELL"
  const consensusMatch = c.match(/\b(strong\s+buy|strong\s+sell|buy|hold|sell)\b/i)
  if (consensusMatch && /\b(consensus|rating|recommendation|analyst)/i.test(c)) {
    const claimedConsensus = consensusMatch[1].toLowerCase().replace(/\s+/g, '_')
    const bundleConsensus = bundle.fundamentals?.analystConsensus ?? null
    if (bundleConsensus !== null && bundleConsensus !== 'unknown') {
      if (claimedConsensus === bundleConsensus) {
        return {
          matched: true,
          verified: true,
          sourceOutlet: 'Bundle fundamentals (Finnhub-sourced)',
          reasoning: `Bundle confirms: analyst consensus = ${bundleConsensus.toUpperCase().replace('_', ' ')}.`,
        }
      }
      // Don't actively contradict — different aggregators (TipRanks,
      // MarketBeat, Stock Analysis) routinely disagree on consensus
      // labeling because they weight strong-buy/buy differently. Fall
      // through to Google Search, which can find at least one source
      // confirming most consensus claims.
    }
  }

  // ── Earnings date claims ──────────────────────────────────
  // Match "earnings tomorrow", "earnings on May 6", "reports earnings Friday", etc.
  if (/\b(earnings|report)\b/i.test(c) && /\b(tomorrow|today|this\s+week|next\s+week|on\s+\w+|\b[a-z]+\s+\d{1,2}\b)/i.test(c)) {
    const earningsDate = bundle.fundamentals?.nextEarningsDate ?? null
    const days = bundle.fundamentals?.daysToEarnings ?? null
    if (earningsDate !== null && days !== null) {
      const sayTomorrow = /\btomorrow\b/i.test(c)
      const sayToday    = /\btoday\b/i.test(c)
      const sayThisWeek = /\bthis\s+week\b/i.test(c)
      // We only positively-verify the simple cases. Date matching for
      // "May 6" style requires more parsing and isn't worth the bug
      // surface area; let Google Search handle those.
      if (sayToday && days === 0) {
        return { matched: true, verified: true, sourceOutlet: 'Bundle fundamentals (Finnhub-sourced)',
          reasoning: `Bundle confirms: earnings today (${earningsDate}).` }
      }
      if (sayTomorrow && days === 1) {
        return { matched: true, verified: true, sourceOutlet: 'Bundle fundamentals (Finnhub-sourced)',
          reasoning: `Bundle confirms: earnings tomorrow (${earningsDate}).` }
      }
      if (sayThisWeek && days >= 0 && days <= 7) {
        return { matched: true, verified: true, sourceOutlet: 'Bundle fundamentals (Finnhub-sourced)',
          reasoning: `Bundle confirms: earnings in ${days} days (${earningsDate}).` }
      }
    }
  }

  // Bundle is silent on this claim category — fall through to Google Search.
  return { matched: false }
}


export async function verifyFactualClaims(
  ticker: string,
  sourceStage: 'lead' | 'devil' | 'rebuttal' | 'counter',
  textBlock: string,
  bundle?: SignalBundle,
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

    // Step 2a: bundle pre-check (Bug 11 fix) — settle claims the bundle
    // can speak to authoritatively, BEFORE burning a Gemini search call.
    // Claims the bundle can't speak to fall through to Step 2b.
    const bundleSettled: ClaimVerification[] = []
    const remainingClaims: string[] = []
    for (const claim of claims) {
      const r = tryVerifyAgainstBundle(claim, bundle)
      if (r.matched) {
        bundleSettled.push({
          claim,
          verified: r.verified ?? false,
          sourceUrl: null,
          sourceOutlet: r.sourceOutlet ?? null,
          reasoning: r.reasoning ?? '',
        })
      } else {
        remainingClaims.push(claim)
      }
    }

    // Step 2b: batch verify remaining claims via Google Search
    const searchVerifications = remainingClaims.length > 0
      ? await batchVerifyClaims(ticker, remainingClaims)
      : []

    // Step 3: combine bundle-settled + search-verified into final lists
    const allVerifications: ClaimVerification[] = [...bundleSettled, ...searchVerifications]
    const verifiedClaims: string[] = []
    const strippedClaims: ClaimVerification[] = []
    const allSourceUrls: string[] = []

    for (const v of allVerifications) {
      if (v.verified) {
        verifiedClaims.push(v.claim)
        if (v.sourceUrl) allSourceUrls.push(v.sourceUrl)
      } else {
        strippedClaims.push(v)
      }
    }

    // Step 4: log to DB (fire-and-forget)
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
