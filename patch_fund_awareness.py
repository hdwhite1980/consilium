#!/usr/bin/env python3
"""
patch_fund_awareness.py

Adds fund-type detection to Council prompts so commodity ETFs (USO, GLD, UNG)
and other non-operating-company tickers (VXX, TLT, leveraged funds) are
analyzed with the appropriate framework.

THE BUG (concrete example, USO 2026-04-28):
  Council issued BEARISH on USO citing "negative revenue, dilution risk
  from 424B3 prospectus filings" — none of which apply to commodity ETFs.

  The Devil's Advocate's anchor argument was a category error, and the
  Lead Analyst capitulated to it, producing a verdict to short oil
  exposure into UAE OPEC+ exit + Iran tensions + Goldman $90 forecast.

THE FIX:
  Add isFundTicker() detection (mirrors existing isForexPair / isCryptoTicker
  pattern). When true:
    - Lead Analyst gets a fund-appropriate system prompt that excludes
      P/E, earnings, dilution, insider analysis
    - Devil's Advocate gets cross-pressure guidance for fund types
      (contango drag, tracking error, structural decay) instead of
      operating-company concerns

PREREQUISITE:
  app/lib/data/fund-detection.ts must already exist.

Idempotent. UTF-8 safe. Preserves CRLF.
"""

from __future__ import annotations
import sys
from pathlib import Path

PIPELINE = Path('app/lib/pipeline.ts')


# =============================================================
# Edit 1: Add import for fund-detection module
# =============================================================

IMPORT_OLD = "import type { SignalBundle } from './aggregator'"
IMPORT_NEW = (
    "import type { SignalBundle } from './aggregator'\n"
    "import { isFundTicker, getFundInfo, buildFundContext } from './data/fund-detection'"
)


# =============================================================
# Edit 2: Lead Analyst — fund branch
# =============================================================

# Anchor on the existing isForexPair declaration line + branch.
# We add a parallel isFund check immediately after.

LEAD_OLD = """function buildLeadSystemPrompt(bundle: SignalBundle, lens: 'technical' | 'fundamental' | 'balanced', overrides: CatalystOverrides): string {
  const isForexPair = bundle.ticker.length === 6 && /^[A-Z]{6}$/.test(bundle.ticker) && ['USD','EUR','GBP','JPY','AUD','CAD','NZD','CHF','SEK','NOK','DKK','SGD','HKD','MXN','ZAR','TRY'].some(c => bundle.ticker.startsWith(c) || bundle.ticker.endsWith(c))

  if (isForexPair) {
    return `You are the Lead Analyst in an elite AI council analyzing ${bundle.ticker}. This is a FOREX currency pair. Analysis focuses on: central bank policy divergence, macroeconomic data (inflation, employment, GDP), interest rate differentials, technical price action, and global risk sentiment. There are no earnings, P/E, or insider data for forex. Be decisive. Support every claim with specific data. Your analysis will be challenged by the Devil's Advocate. Never mention missing or unavailable data — only use what you have. IMPORTANT: If price data shows period change >±200%, treat as potential data error.

${timeframeContext(bundle.timeframe)}${extendedHoursContext(bundle)}${earningsContext(bundle)}${sectorContextString(bundle)}`
  }"""

LEAD_NEW = """function buildLeadSystemPrompt(bundle: SignalBundle, lens: 'technical' | 'fundamental' | 'balanced', overrides: CatalystOverrides): string {
  const isForexPair = bundle.ticker.length === 6 && /^[A-Z]{6}$/.test(bundle.ticker) && ['USD','EUR','GBP','JPY','AUD','CAD','NZD','CHF','SEK','NOK','DKK','SGD','HKD','MXN','ZAR','TRY'].some(c => bundle.ticker.startsWith(c) || bundle.ticker.endsWith(c))

  if (isForexPair) {
    return `You are the Lead Analyst in an elite AI council analyzing ${bundle.ticker}. This is a FOREX currency pair. Analysis focuses on: central bank policy divergence, macroeconomic data (inflation, employment, GDP), interest rate differentials, technical price action, and global risk sentiment. There are no earnings, P/E, or insider data for forex. Be decisive. Support every claim with specific data. Your analysis will be challenged by the Devil's Advocate. Never mention missing or unavailable data — only use what you have. IMPORTANT: If price data shows period change >±200%, treat as potential data error.

${timeframeContext(bundle.timeframe)}${extendedHoursContext(bundle)}${earningsContext(bundle)}${sectorContextString(bundle)}`
  }

  // Fund-type tickers (ETFs, commodity ETFs, volatility ETPs, bond funds, leveraged funds)
  // get a different analytical framework — they are NOT operating companies.
  if (isFundTicker(bundle.ticker)) {
    const fundInfo = getFundInfo(bundle.ticker)
    const fundContext = buildFundContext(fundInfo)
    return `You are the Lead Analyst in an elite AI council analyzing ${bundle.ticker}.

${fundContext}

Be decisive. Support every claim with specific data. Your analysis will be challenged by the Devil's Advocate. Never mention missing or unavailable data — only use what you have. IMPORTANT: If price data shows period change >±200%, treat as potential data error.

${timeframeContext(bundle.timeframe)}${extendedHoursContext(bundle)}${earningsContext(bundle)}${sectorContextString(bundle)}`
  }"""


# =============================================================
# Edit 3: Devil's Advocate — fund branch
# =============================================================

DEVIL_OLD = """function buildDevilSystemPrompt(bundle: SignalBundle, lens: 'technical' | 'fundamental' | 'balanced'): string {
  const baseCalibration = `CALIBRATION RULES — follow these carefully:"""

DEVIL_NEW = """function buildDevilSystemPrompt(bundle: SignalBundle, lens: 'technical' | 'fundamental' | 'balanced'): string {
  // Fund-type tickers get specialized cross-pressure guidance that excludes
  // operating-company concerns (P/E, dilution, earnings) and substitutes
  // fund-specific risks (contango drag, tracking error, structural decay).
  if (isFundTicker(bundle.ticker)) {
    const fundInfo = getFundInfo(bundle.ticker)
    const fundContext = buildFundContext(fundInfo)
    return `You are the Devil's Advocate in an elite AI council for ${bundle.ticker}. The Lead Analyst will present a thesis for this fund — your role is to stress-test it.

${fundContext}

CALIBRATION RULES — follow these carefully:

1. The Lead Analyst's thesis is wrong by default until proven right by data. However, if you cannot find compelling data-backed counter-evidence, you MUST return NEUTRAL with honest reasoning — do NOT manufacture disagreement. Honest NEUTRAL is the correct answer when data supports the Lead.

2. CATEGORY DISCIPLINE: This is a FUND, not an operating company. NEVER cite operating-company concerns (P/E ratio, EPS misses, dilution from prospectus filings, insider transactions, "negative revenue", "net income losses") — these don't apply to funds. Routine 424B3 prospectus filings are continuous ETF mechanics, NOT dilution events. Citing these is a category error and will weaken your case in the Judge's eyes.

3. APPROPRIATE CROSS-PRESSURE for funds:
   - Contango/backwardation in futures curves (especially for commodity, volatility, leveraged products)
   - Structural decay (volatility drag for leveraged funds, roll costs for futures-based ETFs)
   - Tracking error vs the underlying
   - Macro regime mismatch (e.g., rate-hike risk for bond ETFs, regime-shift for volatility products)
   - Mean reversion at extreme levels
   - Sector-level rotation risk (for sector ETFs)
   - Concentration risk in top holdings (for thematic equity ETFs)

4. Timeframe honesty. Lead's target may be achievable but not within the ${bundle.timeframe} window — challenge time-to-target alignment.

5. Reflexivity check. Strong technical setups at all-time highs in commodity/leveraged/volatility products are where retail traders get trapped.

6. Absence of a metric is not evidence. Never mention unavailable data — only argue with what you actually have.

7. Quality over volume. Two rigorous fund-appropriate challenges beat five operating-company challenges that don't apply.

${timeframeContext(bundle.timeframe)}${extendedHoursContext(bundle)}${earningsContext(bundle)}${sectorContextString(bundle)}`
  }

  const baseCalibration = `CALIBRATION RULES — follow these carefully:"""


# =============================================================
# Helpers
# =============================================================

def detect_line_endings(raw: bytes) -> str:
    crlf = raw.count(b'\r\n')
    lf = raw.count(b'\n') - crlf
    return 'crlf' if crlf > lf else 'lf'


def read_file(path: Path) -> tuple[str, str]:
    raw = path.read_bytes()
    text = raw.decode('utf-8')
    le = detect_line_endings(raw)
    if le == 'crlf':
        text = text.replace('\r\n', '\n')
    return text, le


def write_file(path: Path, text: str, line_ending: str) -> None:
    if line_ending == 'crlf':
        text = text.replace('\n', '\r\n')
    tmp = path.with_suffix(path.suffix + '.tmp')
    tmp.write_text(text, encoding='utf-8', newline='')
    tmp.replace(path)


# =============================================================
# Main
# =============================================================

def main() -> int:
    dry_run = '--dry-run' in sys.argv or '-n' in sys.argv

    print('=' * 60)
    print('Fund-awareness pipeline integration')
    print('=' * 60)
    if dry_run:
        print('  (DRY RUN)')
    print()

    helper = Path('app/lib/data/fund-detection.ts')
    print('Prerequisite checks:')
    if not helper.exists():
        print(f'  [MISSING] {helper}')
        print('   Deploy app/lib/data/fund-detection.ts before running this patch.')
        return 1
    print(f'  [OK] {helper}')
    print()

    if not PIPELINE.exists():
        print(f'  ERROR: {PIPELINE} not found', file=sys.stderr)
        return 1

    text, le = read_file(PIPELINE)

    state = {
        'import': "from './data/fund-detection'" in text,
        'lead':   'if (isFundTicker(bundle.ticker)) {' in text and 'fund-appropriate' in text.lower(),
        'devil':  'CATEGORY DISCIPLINE: This is a FUND' in text,
    }

    if all(state.values()):
        print('  [OK] pipeline.ts: already fully patched, no changes')
        return 0

    edits = []

    if not state['import']:
        if IMPORT_OLD not in text:
            print('  ERROR: Could not find aggregator import anchor', file=sys.stderr)
            return 1
        text = text.replace(IMPORT_OLD, IMPORT_NEW)
        edits.append('  [+] Added fund-detection import')

    if not state['lead']:
        if LEAD_OLD not in text:
            print('  ERROR: Could not find Lead Analyst forex branch anchor', file=sys.stderr)
            print('         Make sure all prior pipeline patches were applied first.', file=sys.stderr)
            return 1
        text = text.replace(LEAD_OLD, LEAD_NEW)
        edits.append('  [+] Added Lead Analyst fund branch')

    if not state['devil']:
        if DEVIL_OLD not in text:
            print("  ERROR: Could not find Devil's Advocate calibration anchor", file=sys.stderr)
            return 1
        text = text.replace(DEVIL_OLD, DEVIL_NEW)
        edits.append("  [+] Added Devil's Advocate fund branch")

    for e in edits:
        print(e)

    if dry_run:
        print('  (dry-run: would write pipeline.ts)')
    else:
        write_file(PIPELINE, text, le)
        print(f'  Wrote {PIPELINE}')

    print()
    print('=' * 60)
    if dry_run:
        print('Dry run complete.')
    else:
        print('Patch complete. Run `npm run build` to verify.')
    print('=' * 60)
    return 0


if __name__ == '__main__':
    sys.exit(main())
