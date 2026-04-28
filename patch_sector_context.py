#!/usr/bin/env python3
"""
patch_sector_context.py

Wires sector context into the analysis pipeline:
  1. aggregator.ts: import + add `sectorContext?: SectorContext` to SignalBundle
                    + parallel fetch in equity path + inject in bundle return
  2. pipeline.ts: add `sectorContextString(bundle)` helper +
                  inject after every `earningsContext(bundle)` call (9 sites)

PREREQUISITES:
  - app/lib/data/sector-context.ts deployed
  - ticker_sector_peers DB table created
  - Extended-hours + earnings patches already applied
    (this patch anchors on `${earningsContext(bundle)}` injection points)

Idempotent. UTF-8 safe. Preserves CRLF.

Usage:
  python patch_sector_context.py            # apply
  python patch_sector_context.py --dry-run  # preview
"""

from __future__ import annotations
import re
import sys
from pathlib import Path

AGGREGATOR = Path('app/lib/aggregator.ts')
PIPELINE   = Path('app/lib/pipeline.ts')


# =============================================================
# Aggregator edits
# =============================================================

# Edit A1: Add import for sector-context module
# Anchor on the existing extended-hours import (added in prior patch)
AGG_IMPORT_OLD = "import { getExtendedHoursContext, type ExtendedHoursContext } from './data/extended-hours'"
AGG_IMPORT_NEW = (
    "import { getExtendedHoursContext, type ExtendedHoursContext } from './data/extended-hours'\n"
    "import { getSectorContext, type SectorContext } from './data/sector-context'"
)

# Edit A2: Add sectorContext field to SignalBundle type
# Anchor on the extended-hours field
AGG_TYPE_OLD = """  // Extended-hours context (pre-market / after-hours move when market closed)
  extendedHours?: ExtendedHoursContext"""

AGG_TYPE_NEW = """  // Extended-hours context (pre-market / after-hours move when market closed)
  extendedHours?: ExtendedHoursContext

  // Sector + correlated-stock context (sector ETF perf, peer perf, divergence flag)
  sectorContext?: SectorContext"""

# Edit A3: Equity path - add to existing parallel fetch block
AGG_PARALLEL_OLD = """  const [marketContext, fundamentals, smartMoney, optionsFlow, edgarData, extendedHours] = await Promise.all([
    buildMarketContext(sym, timeframe),
    fetchFundamentals(sym, currentPrice),
    fetchSmartMoney(sym),
    fetchOptionsFlow(sym, currentPrice),
    Promise.race([fetchEdgarFundamentals(sym), new Promise<null>(r => setTimeout(() => r(null), 8000))]).catch(() => null),
    getExtendedHoursContext(sym).catch(() => undefined),
  ])"""

AGG_PARALLEL_NEW = """  const [marketContext, fundamentals, smartMoney, optionsFlow, edgarData, extendedHours, sectorContext] = await Promise.all([
    buildMarketContext(sym, timeframe),
    fetchFundamentals(sym, currentPrice),
    fetchSmartMoney(sym),
    fetchOptionsFlow(sym, currentPrice),
    Promise.race([fetchEdgarFundamentals(sym), new Promise<null>(r => setTimeout(() => r(null), 8000))]).catch(() => null),
    getExtendedHoursContext(sym).catch(() => undefined),
    getSectorContext(sym).catch(() => undefined),
  ])"""

# Edit A4: Add sectorContext to the equity-path return statement
AGG_RETURN_OLD = """  return {
    ticker: sym, timeframe, timestamp: new Date().toISOString(),
    bars, news, currentPrice,
    technicals, marketContext, fundamentals, smartMoney, optionsFlow, conviction,
    extendedHours,
    aiContext: { newsSection, priceSection, technicalsSection, marketSection, fundamentalsSection, smartMoneySection, optionsSection, convictionSection, digestContext: digestContext || '', socialContext: socialContext || '', monitorAlerts: monitorAlerts || '', fullBundle },
  }
}"""

AGG_RETURN_NEW = """  return {
    ticker: sym, timeframe, timestamp: new Date().toISOString(),
    bars, news, currentPrice,
    technicals, marketContext, fundamentals, smartMoney, optionsFlow, conviction,
    extendedHours,
    sectorContext,
    aiContext: { newsSection, priceSection, technicalsSection, marketSection, fundamentalsSection, smartMoneySection, optionsSection, convictionSection, digestContext: digestContext || '', socialContext: socialContext || '', monitorAlerts: monitorAlerts || '', fullBundle },
  }
}"""


# =============================================================
# Pipeline edits
# =============================================================

# Edit P1: Add sectorContextString() helper after earningsContext()
# Returns the prompt-ready string from bundle.sectorContext, or empty.
PIPELINE_HELPER_NEW = """

/**
 * Sector + correlated-stock context for prompts.
 * Surfaces sector ETF perf, peer perf, and single-name divergence
 * so the Council can distinguish ticker-specific moves from sector-wide ones.
 *
 * Wired into all 9 prompt assembly sites alongside extendedHoursContext + earningsContext.
 *
 * Returns empty string when no sector data is available (crypto, OTC, unmapped sectors).
 */
function sectorContextString(bundle: SignalBundle): string {
  const sc = bundle.sectorContext
  if (!sc || !sc.promptContext) return ''
  return sc.promptContext
}
"""

# Edit P2: Inject sectorContextString call after every earningsContext call.
# We chain it: ${earningsContext(bundle)} -> ${earningsContext(bundle)}${sectorContextString(bundle)}
EARNINGS_INJECT_REGEX = r'\$\{earningsContext\(bundle\)\}'
SECTOR_INJECT_REPLACEMENT = '${earningsContext(bundle)}${sectorContextString(bundle)}'


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


def find_after_function(text: str, function_signature: str) -> int:
    """Find the index just after the closing brace of a function."""
    start = text.find(function_signature)
    if start < 0:
        return -1
    cursor = start + len(function_signature)
    depth = 1
    while cursor < len(text) and depth > 0:
        ch = text[cursor]
        if ch == '{':
            depth += 1
        elif ch == '}':
            depth -= 1
            if depth == 0:
                return cursor + 1
        cursor += 1
    return -1


# =============================================================
# Aggregator patch
# =============================================================

def patch_aggregator(dry_run: bool) -> bool:
    if not AGGREGATOR.exists():
        print(f'  ERROR: {AGGREGATOR} not found', file=sys.stderr)
        return False

    text, le = read_file(AGGREGATOR)

    state = {
        'import':   'getSectorContext, type SectorContext' in text,
        'type':     'sectorContext?: SectorContext' in text,
        'parallel': ', sectorContext] = await Promise.all' in text,
        'return':   'sectorContext,\n    aiContext' in text,
    }

    if all(state.values()):
        print('  [OK] aggregator.ts: already fully patched, no changes')
        return True

    edits = []

    # Edit A1: import
    if not state['import']:
        if AGG_IMPORT_OLD not in text:
            print('  ERROR: Could not find extended-hours import anchor', file=sys.stderr)
            print('         (Make sure extended-hours patch was applied first.)', file=sys.stderr)
            return False
        text = text.replace(AGG_IMPORT_OLD, AGG_IMPORT_NEW)
        edits.append('  [+] Added sector-context import')

    # Edit A2: SignalBundle type field
    if not state['type']:
        if AGG_TYPE_OLD not in text:
            print('  ERROR: Could not find extendedHours field anchor', file=sys.stderr)
            return False
        text = text.replace(AGG_TYPE_OLD, AGG_TYPE_NEW)
        edits.append('  [+] Added sectorContext field to SignalBundle type')

    # Edit A3: parallel fetch
    if not state['parallel']:
        if AGG_PARALLEL_OLD not in text:
            print('  ERROR: Could not find parallel-fetch block (with extendedHours)', file=sys.stderr)
            return False
        text = text.replace(AGG_PARALLEL_OLD, AGG_PARALLEL_NEW)
        edits.append('  [+] Added getSectorContext to parallel fetch')

    # Edit A4: return statement
    if not state['return']:
        if AGG_RETURN_OLD not in text:
            print('  ERROR: Could not find equity-path return statement', file=sys.stderr)
            return False
        text = text.replace(AGG_RETURN_OLD, AGG_RETURN_NEW)
        edits.append('  [+] Added sectorContext to bundle return')

    for e in edits:
        print(e)

    if dry_run:
        print('  (dry-run: would write aggregator.ts)')
    else:
        write_file(AGGREGATOR, text, le)
        print(f'  Wrote {AGGREGATOR}')

    return True


# =============================================================
# Pipeline patch
# =============================================================

def patch_pipeline(dry_run: bool) -> bool:
    if not PIPELINE.exists():
        print(f'  ERROR: {PIPELINE} not found', file=sys.stderr)
        return False

    text, le = read_file(PIPELINE)

    has_helper = 'function sectorContextString(bundle:' in text
    inject_count = text.count('${sectorContextString(bundle)}')
    has_injections = inject_count > 0

    if has_helper and has_injections:
        print('  [OK] pipeline.ts: already fully patched, no changes')
        return True

    edits = []

    # Edit P1: Insert sectorContextString helper after earningsContext function
    if not has_helper:
        earnings_sig = 'function earningsContext(bundle: SignalBundle): string {'
        end = find_after_function(text, earnings_sig)
        if end < 0:
            print('  ERROR: Could not find earningsContext() function', file=sys.stderr)
            print('         (Apply earnings/recency patch first.)', file=sys.stderr)
            return False
        text = text[:end] + PIPELINE_HELPER_NEW + text[end:]
        edits.append('  [+] Added sectorContextString() helper function')

    # Edit P2: inject sectorContextString call after every earningsContext
    if not has_injections:
        earnings_count = len(re.findall(EARNINGS_INJECT_REGEX, text))
        if earnings_count == 0:
            print('  ERROR: No ${earningsContext(bundle)} sites found', file=sys.stderr)
            print('         (Apply earnings/recency patch first.)', file=sys.stderr)
            return False

        text = re.sub(
            EARNINGS_INJECT_REGEX,
            lambda m: SECTOR_INJECT_REPLACEMENT,
            text,
        )
        edits.append(f'  [+] Injected sectorContextString at {earnings_count} prompt sites')

    for e in edits:
        print(e)

    if dry_run:
        print('  (dry-run: would write pipeline.ts)')
    else:
        write_file(PIPELINE, text, le)
        print(f'  Wrote {PIPELINE}')

    return True


# =============================================================
# Main
# =============================================================

def main() -> int:
    dry_run = '--dry-run' in sys.argv or '-n' in sys.argv

    print('=' * 60)
    print('Sector context pipeline integration')
    print('=' * 60)
    if dry_run:
        print('  (DRY RUN)')
    print()

    helper = Path('app/lib/data/sector-context.ts')
    print('Prerequisite checks:')
    if not helper.exists():
        print(f'  [MISSING] {helper}')
        print('   Deploy app/lib/data/sector-context.ts before running this patch.')
        return 1
    print(f'  [OK] {helper}')
    print()

    print('Step 1: aggregator.ts')
    if not patch_aggregator(dry_run):
        return 1
    print()

    print('Step 2: pipeline.ts')
    if not patch_pipeline(dry_run):
        return 1
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
