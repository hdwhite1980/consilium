// =============================================================
// app/lib/signals/futures-bundle.ts (Layer 5)
//
// Builds a SignalBundle for a futures contract.
//
// Strategy per family (defined by FuturesContractSpec.dataLayer):
//
//   1. Equity index (ES/NQ/RTY/YM + micros):
//      - Build the underlying ETF's bundle (SPY/QQQ/IWM/DIA)
//      - Re-tag as futures, attach COT data for the futures contract
//      - Result: full Council analysis with COT overlay
//
//   2. Volatility (VX):
//      - Build a VIX-flavored bundle (VIX index level + VIXY ETF data)
//      - Attach COT
//      - Term structure NOT wired in v1 — Council prompt notes this
//
//   3. FX futures (6E/6B/6J/6A/6C/6S/6N):
//      - Build the spot pair's bundle (EURUSD/GBPUSD/etc)
//      - Re-tag as futures, attach COT
//
//   4. Other (energy/metals/grains/rates):
//      - Build a stripped bundle: bars + technicals + macro context
//        + COT + news. NO EDGAR/insider/13F/analyst data.
//      - Council prompt EXPLICITLY notes which fundamentals are
//        not wired so it doesn't hallucinate them.
//
// Council prompts (pipeline-futures.ts) read bundle.futuresMeta to
// know what data is available and what isn't.
// =============================================================

import type { SignalBundle } from '../aggregator'
import { getFuturesSpec, deriveFuturesPriceFromProxy, type FuturesContractSpec } from '../trading/futures-sizing'

export interface FuturesMeta {
  root: string
  category: FuturesContractSpec['category']
  micro: boolean
  underlyingEtfProxy: string | null
  spec: FuturesContractSpec
  // Council-visible data-availability notes
  dataAvailability: {
    fundamentalsWired: boolean
    citationNote: string
    cotAvailable: boolean
    cotData?: CotSnapshot
  }
  // Price derivation info — important for Council prompts and verification
  // so they know the price is an approximation from the underlying proxy.
  priceDerivation: {
    method: 'linear' | 'proxy_only' | 'none' | 'unknown'
    multiplier?: number
    note: string
    approximate: boolean
    proxyTicker: string | null
    proxyPrice: number | null
    futuresPrice: number | null
  } | null
  // Layer 6: energy-family fundamentals (CL/MCL/NG/QG only).
  // Null for all other families.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  energyFundamentals?: any  // EnergyFundamentalsSnapshot; kept as `any` to avoid cross-module circular import in this Layer's seam
}

export interface CotSnapshot {
  reportDate: string
  contractName: string                    // CFTC contract name (e.g. "E-MINI S&P 500 - CHICAGO MERCANTILE EXCHANGE")
  // Non-commercial (speculators)
  nonCommercialLong: number
  nonCommercialShort: number
  nonCommercialNet: number
  nonCommercialNetPctOI: number           // net as % of open interest
  nonCommercialLongChangeWoW: number
  nonCommercialShortChangeWoW: number
  // Commercial (hedgers)
  commercialLong: number
  commercialShort: number
  commercialNet: number
  // Open interest
  openInterest: number
  openInterestChangeWoW: number
  // Interpretation hints for the Council
  interpretation: string
}

export interface BuildFuturesBundleInput {
  futuresRoot: string                     // "ES", "CL", etc.
  inputTicker: string                     // what user typed ("ES", "ESH26", etc.)
  // Underlying ETF/spot bundle (caller fetched it — equity index passes SPY bundle, FX passes EURUSD bundle, etc.)
  underlyingBundle: SignalBundle | null
  cotSnapshot: CotSnapshot | null
  currentFuturesPrice: number | null      // optional: live front-month price if caller has it
  // Layer 6: energy-family snapshot (CL/MCL/NG/QG only). Null for others.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  energyFundamentals?: any | null
}

export interface FuturesBundle extends SignalBundle {
  futuresMeta: FuturesMeta
  // Mark this bundle as futures so the pipeline picks the right prompts
  instrumentType: 'futures'
}

/**
 * Build a futures-aware SignalBundle.
 */
export function buildFuturesBundle(input: BuildFuturesBundleInput): FuturesBundle | null {
  const spec = getFuturesSpec(input.futuresRoot)
  if (!spec) return null

  const baseBundle: SignalBundle = input.underlyingBundle
    ? cloneBundleForFutures(input.underlyingBundle, input.futuresRoot, spec)
    : buildMinimalBundle(input.inputTicker, input.futuresRoot, spec, input.currentFuturesPrice)

  // Build interpretation note for COT
  const cotData = input.cotSnapshot
  const cotAvailable = cotData !== null

  // Extract priceDerivation from baseBundle (set by cloneBundleForFutures)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const derivedFromClone = (baseBundle as any).priceDerivation as {
    method: 'linear' | 'proxy_only' | 'none' | 'unknown'
    multiplier?: number
    note: string
    approximate: boolean
    proxyTicker: string | null
    proxyPrice: number
  } | null | undefined

  // Layer 6: if energyFundamentals is present, the family IS effectively wired
  // regardless of the static spec flag. The spec marks "fundamentalsWired: false"
  // for energy because in v1 the data layer was empty; Layer 6 fixes that for CL/NG.
  const fundamentalsActuallyWired = spec.dataLayer.fundamentalsWired || input.energyFundamentals != null

  const meta: FuturesMeta = {
    root: input.futuresRoot,
    category: spec.category,
    micro: spec.micro,
    underlyingEtfProxy: spec.dataLayer.underlyingEtfProxy,
    spec,
    dataAvailability: {
      fundamentalsWired: fundamentalsActuallyWired,
      citationNote: spec.dataLayer.citationNote,
      cotAvailable,
      cotData: cotData ?? undefined,
    },
    priceDerivation: derivedFromClone ? {
      method: derivedFromClone.method,
      multiplier: derivedFromClone.multiplier,
      note: derivedFromClone.note,
      approximate: derivedFromClone.approximate,
      proxyTicker: derivedFromClone.proxyTicker,
      proxyPrice: derivedFromClone.proxyPrice,
      futuresPrice: Number(baseBundle.currentPrice) || null,
    } : null,
    energyFundamentals: input.energyFundamentals ?? undefined,
  }

  return {
    ...baseBundle,
    futuresMeta: meta,
    instrumentType: 'futures',
  }
}

/**
 * Clone an underlying ETF/spot bundle, retag as futures, and remove
 * fundamentals that don't apply to the futures contract.
 *
 * For equity index futures: keeps SPY's bundle nearly intact (technicals,
 * options flow, news), strips company-specific (no individual stock
 * fundamentals on SPY anyway).
 *
 * For FX futures: keeps spot pair's bundle nearly intact (technicals,
 * macro narrative, COT).
 */
function cloneBundleForFutures(
  underlying: SignalBundle,
  futuresRoot: string,
  spec: FuturesContractSpec,
): SignalBundle {
  // Derive the futures contract price from the proxy ETF/spot price.
  // For ES/NQ/RTY/YM: futures = proxy × multiplier (10, 40, 10, 100 respectively)
  // For non-equity-index families: keep proxy price but flag as approximation
  const proxyPrice = Number(underlying.currentPrice) || 0
  const derived = deriveFuturesPriceFromProxy(futuresRoot, proxyPrice)

  // Shallow-clone, override ticker + price + add proxy/derivation metadata
  const cloned: SignalBundle = {
    ...underlying,
    ticker: futuresRoot,
    currentPrice: derived ? derived.price : proxyPrice,
    // Preserve proxy info + derivation note for verification + UI
    underlyingProxy: spec.dataLayer.underlyingEtfProxy ?? undefined,
    underlyingProxyPrice: proxyPrice,
    priceDerivation: derived ? {
      method: spec.priceFromProxy?.method ?? 'unknown',
      multiplier: spec.priceFromProxy?.method === 'linear' ? spec.priceFromProxy.multiplier : undefined,
      note: derived.note,
      approximate: derived.approximate,
      proxyTicker: spec.dataLayer.underlyingEtfProxy ?? null,
      proxyPrice,
    } : null,
  } as SignalBundle & {
    underlyingProxy?: string
    underlyingProxyPrice?: number
    priceDerivation?: unknown
  }

  // For non-equity-index families using ETF proxy, strip fields that
  // are ETF-specific but don't translate cleanly. (For SPY/QQQ/IWM/DIA
  // proxy of ES/NQ/RTY/YM, we keep everything — they're tracking the
  // same underlying index.)
  if (spec.category !== 'equity_index' && spec.category !== 'fx') {
    const c = cloned as SignalBundle & { proxyDisclaimer?: string }
    c.proxyDisclaimer = `Bundle data is from ${spec.dataLayer.underlyingEtfProxy ?? 'ETF proxy'}, NOT direct ${futuresRoot} contract data. ETF and futures can diverge due to contango/roll dynamics.`
  }

  return cloned
}

/**
 * Build a minimal bundle when no underlying ETF data is available.
 * Used for HO, BZ, ZM, ZL (no clean ETF proxy).
 */
function buildMinimalBundle(
  inputTicker: string,
  futuresRoot: string,
  spec: FuturesContractSpec,
  currentPrice: number | null,
): SignalBundle {
  // Construct an empty-ish bundle with just the metadata. The Council
  // will see "no fundamentals, no technicals, only COT" and is
  // explicitly instructed to refuse to issue strong verdicts.
  const empty: Record<string, unknown> = {
    ticker: futuresRoot,
    currentPrice: currentPrice ?? 0,
    bars: [],
    technicals: undefined,
    fundamentals: undefined,
    options: undefined,
    smartMoney: undefined,
    news: undefined,
    social: undefined,
  }
  return empty as unknown as SignalBundle
}

/**
 * Helper: format COT snapshot for inclusion in Council prompts.
 * Returns a multiline string the Lead/Devil can read.
 */
export function formatCotForPrompt(snap: CotSnapshot): string {
  const lines: string[] = []
  lines.push(`COT (CFTC, as of ${snap.reportDate}):`)
  lines.push(`  Non-commercial (speculators):`)
  lines.push(`    Net: ${snap.nonCommercialNet > 0 ? '+' : ''}${snap.nonCommercialNet.toLocaleString()} contracts (${(snap.nonCommercialNetPctOI * 100).toFixed(1)}% of OI)`)
  lines.push(`    Long: ${snap.nonCommercialLong.toLocaleString()} (WoW ${snap.nonCommercialLongChangeWoW > 0 ? '+' : ''}${snap.nonCommercialLongChangeWoW.toLocaleString()})`)
  lines.push(`    Short: ${snap.nonCommercialShort.toLocaleString()} (WoW ${snap.nonCommercialShortChangeWoW > 0 ? '+' : ''}${snap.nonCommercialShortChangeWoW.toLocaleString()})`)
  lines.push(`  Commercial (hedgers):`)
  lines.push(`    Net: ${snap.commercialNet > 0 ? '+' : ''}${snap.commercialNet.toLocaleString()} contracts`)
  lines.push(`  Open interest: ${snap.openInterest.toLocaleString()} (WoW ${snap.openInterestChangeWoW > 0 ? '+' : ''}${snap.openInterestChangeWoW.toLocaleString()})`)
  lines.push(`  Interpretation: ${snap.interpretation}`)
  return lines.join('\n')
}
