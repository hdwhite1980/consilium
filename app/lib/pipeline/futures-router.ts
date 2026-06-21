// =============================================================
// app/lib/pipeline/futures-router.ts (Layer 5 part 2)
//
// Routes futures verdicts through the futures-aware bundle builder
// and Council prompts.
//
// Two integration points:
//
//   1. In analyze/route.ts after evaluateTickerGate:
//      if (preGate.assetClass === 'futures' && preGate.futuresRoot) {
//        bundle = await buildFuturesAwareBundle(preGate.futuresRoot, tf, onProgress)
//      } else {
//        bundle = await buildSignalBundle(symbol, tf, onProgress)
//      }
//
//   2. In pipeline.ts buildLeadSystemPrompt / buildDevilSystemPrompt /
//      buildJudgeSystemPrompt / buildJudgeReviewerSystemPrompt:
//      if (isFuturesBundle(bundle)) {
//        return buildFuturesLeadSystemPrompt(bundle.futuresMeta)
//        // or buildFuturesDevilSystemPrompt(...)
//      }
//      ... existing logic ...
// =============================================================

import { buildSignalBundle, type SignalBundle } from '@/app/lib/aggregator'
import { buildFuturesBundle, type FuturesBundle, type FuturesMeta } from '@/app/lib/signals/futures-bundle'
import { fetchFuturesCot } from '@/app/lib/signals/futures-cot'
import { getFuturesSpec } from '@/app/lib/trading/futures-sizing'
import { buildEnergyFundamentals } from '@/app/lib/signals/energy-fundamentals'

/**
 * Type guard: is this bundle a futures bundle?
 * Used by pipeline.ts to choose futures vs equity prompts.
 */
export function isFuturesBundle(bundle: SignalBundle): bundle is FuturesBundle {
  return (bundle as { instrumentType?: string }).instrumentType === 'futures'
}

/**
 * Extract futures metadata from a futures bundle.
 * Returns null if not a futures bundle.
 */
export function getFuturesMeta(bundle: SignalBundle): FuturesMeta | null {
  if (!isFuturesBundle(bundle)) return null
  return bundle.futuresMeta
}

/**
 * Build a futures-aware SignalBundle.
 *
 * Strategy:
 *   1. Look up the futures spec (gives us underlying ETF proxy, family, etc.)
 *   2. If underlying ETF proxy exists, build that bundle via the standard
 *      buildSignalBundle (it has all the technicals, options, news, etc.)
 *   3. Fetch CFTC COT for the futures root (best-effort; null OK)
 *   4. Compose the futures bundle wrapping the proxy bundle + COT
 *
 * @param futuresRoot e.g. "ES", "CL", "GC"
 * @param inputTicker what the user typed (e.g. "ES" or "ESH26")
 * @param timeframe pass-through to bundle building
 * @param onProgress optional progress callback
 */
export async function buildFuturesAwareBundle(
  futuresRoot: string,
  inputTicker: string,
  timeframe: string,
  onProgress?: (step: string) => void,
): Promise<FuturesBundle | null> {
  const spec = getFuturesSpec(futuresRoot)
  if (!spec) {
    onProgress?.(`No spec for futures root ${futuresRoot}`)
    return null
  }

  // 1. Build underlying ETF bundle if proxy exists
  let underlyingBundle: SignalBundle | null = null
  if (spec.dataLayer.underlyingEtfProxy) {
    try {
      onProgress?.(`Loading ${spec.dataLayer.underlyingEtfProxy} as underlying proxy for ${futuresRoot}`)
      underlyingBundle = await buildSignalBundle(
        spec.dataLayer.underlyingEtfProxy,
        // Forward timeframe as-is; SignalBundle expects its own enum
        timeframe as Parameters<typeof buildSignalBundle>[1],
        onProgress,
      )
    } catch (e) {
      console.warn(`[futures-router] underlying proxy fetch failed for ${futuresRoot}:`, e instanceof Error ? e.message : e)
    }
  }

  // 2. Fetch CFTC COT (best-effort) AND energy fundamentals in parallel
  onProgress?.(`Fetching CFTC COT for ${futuresRoot}`)
  const isEnergyFamily = spec.category === 'energy'
  if (isEnergyFamily) {
    onProgress?.(`Fetching EIA fundamentals for ${futuresRoot}`)
  }
  const [cotSnapshot, energyFundamentals] = await Promise.all([
    fetchFuturesCot(futuresRoot).catch(() => null),
    isEnergyFamily ? buildEnergyFundamentals(futuresRoot).catch(() => null) : Promise.resolve(null),
  ])
  if (!cotSnapshot) {
    onProgress?.(`COT data not available for ${futuresRoot}`)
  }
  if (isEnergyFamily && !energyFundamentals) {
    onProgress?.(`EIA fundamentals not available for ${futuresRoot} (CL/MCL/NG/QG only in v1, or EIA fetch failed)`)
  }

  // 3. Build futures bundle
  const futuresBundle = buildFuturesBundle({
    futuresRoot,
    inputTicker,
    underlyingBundle,
    cotSnapshot,
    currentFuturesPrice: null,  // future enhancement: live front-month from Tradovate
    energyFundamentals,
  })

  return futuresBundle
}

/**
 * Centralized helper for pipeline.ts — given a bundle, returns
 * whether to use the futures Lead prompt builder.
 *
 * Pipeline integration:
 *   const systemPrompt = isFuturesBundle(bundle)
 *     ? buildFuturesLeadSystemPrompt(bundle.futuresMeta)
 *     : buildLeadSystemPrompt(bundle, lens, overrides)
 */
