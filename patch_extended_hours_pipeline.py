#!/usr/bin/env python3
"""
patch_extended_hours_pipeline.py

Wires extended-hours context into the analysis pipeline:
  1. aggregator.ts: import + add `extendedHours?: ExtendedHoursContext` to SignalBundle
                    + parallel fetch in equity path + inject in bundle return
  2. pipeline.ts: add `extendedHoursContext(bundle)` helper function +
                  inject after every `timeframeContext(bundle.timeframe)` call

PREREQUISITE:
  - app/lib/data/extended-hours.ts must already exist

Idempotent. UTF-8 safe. Preserves CRLF.

Usage:
  python patch_extended_hours_pipeline.py            # apply
  python patch_extended_hours_pipeline.py --dry-run  # preview
"""

from __future__ import annotations
import sys
import re
from pathlib import Path

AGGREGATOR = Path('app/lib/aggregator.ts')
PIPELINE   = Path('app/lib/signals/pipeline.ts')


# =============================================================
# Aggregator edits
# =============================================================

# Edit A1: Add import for extended-hours module
AGG_IMPORT_OLD = "import { fetchNews, fetchBars, formatNewsForAI, formatBarsForAI } from './data/alpaca'"
AGG_IMPORT_NEW = (
    "import { fetchNews, fetchBars, formatNewsForAI, formatBarsForAI } from './data/alpaca'\n"
    "import { getExtendedHoursContext, type ExtendedHoursContext } from './data/extended-hours'"
)

# Edit A2: Add field to SignalBundle type
AGG_TYPE_OLD = """  // Phase 5
  conviction: Awaited<ReturnType<typeof buildConvictionOutput>>"""

AGG_TYPE_NEW = """  // Phase 5
  conviction: Awaited<ReturnType<typeof buildConvictionOutput>>

  // Extended-hours context (pre-market / after-hours move when market closed)
  extendedHours?: ExtendedHoursContext"""

# Edit A3: Equity path - fetch extended hours in parallel with phases 1-4
# We add it to the existing parallel block at the right spot.
AGG_PARALLEL_OLD = """  const [marketContext, fundamentals, smartMoney, optionsFlow, edgarData] = await Promise.all([
    buildMarketContext(sym, timeframe),
    fetchFundamentals(sym, currentPrice),
    fetchSmartMoney(sym),
    fetchOptionsFlow(sym, currentPrice),
    Promise.race([fetchEdgarFundamentals(sym), new Promise<null>(r => setTimeout(() => r(null), 8000))]).catch(() => null),
  ])"""

AGG_PARALLEL_NEW = """  const [marketContext, fundamentals, smartMoney, optionsFlow, edgarData, extendedHours] = await Promise.all([
    buildMarketContext(sym, timeframe),
    fetchFundamentals(sym, currentPrice),
    fetchSmartMoney(sym),
    fetchOptionsFlow(sym, currentPrice),
    Promise.race([fetchEdgarFundamentals(sym), new Promise<null>(r => setTimeout(() => r(null), 8000))]).catch(() => null),
    getExtendedHoursContext(sym).catch(() => undefined),
  ])"""

# Edit A4: Add `extendedHours` to the equity-path return statement
# The return is on a single complex line so we use a substring match
AGG_RETURN_OLD = """  return {
    ticker: sym, timeframe, timestamp: new Date().toISOString(),
    bars, news, currentPrice,
    technicals, marketContext, fundamentals, smartMoney, optionsFlow, conviction,
    aiContext: { newsSection, priceSection, technicalsSection, marketSection, fundamentalsSection, smartMoneySection, optionsSection, convictionSection, digestContext: digestContext || '', socialContext: socialContext || '', monitorAlerts: monitorAlerts || '', fullBundle },
  }
}"""

AGG_RETURN_NEW = """  return {
    ticker: sym, timeframe, timestamp: new Date().toISOString(),
    bars, news, currentPrice,
    technicals, marketContext, fundamentals, smartMoney, optionsFlow, conviction,
    extendedHours,
    aiContext: { newsSection, priceSection, technicalsSection, marketSection, fundamentalsSection, smartMoneySection, optionsSection, convictionSection, digestContext: digestContext || '', socialContext: socialContext || '', monitorAlerts: monitorAlerts || '', fullBundle },
  }
}"""


# =============================================================
# Pipeline edits
# =============================================================

# Edit P1: Add extendedHoursContext helper function right after timeframeContext()
# The function returns a single-line text block when there's meaningful AH/PM data,
# else an empty string. Pipeline prompts will get nothing extra during regular session.
PIPELINE_HELPER_INSERT_AFTER = """function timeframeContext(tf: string): string {"""

# We'll insert after the closing brace of timeframeContext.
PIPELINE_HELPER_NEW = """

/**
 * Extended-hours context for prompts.
 * Returns a markdown-formatted section ready to inject after timeframeContext().
 * Empty string when there's nothing meaningful (regular session, no significant move).
 *
 * Wired into all 9 prompt assembly sites in this file.
 */
function extendedHoursContext(bundle: SignalBundle): string {
  const eh = bundle.extendedHours
  if (!eh || !eh.promptContext) return ''
  return `\\n\\nEXTENDED HOURS CONTEXT:\\n${eh.promptContext}`
}
"""

# Edit P2: Inject extendedHoursContext after every timeframeContext call.
# We do this with regex since there are 9 occurrences and they appear in
# slightly different surrounding contexts.
# Pattern: `${timeframeContext(bundle.timeframe)}` (template literal embed)
# We replace with: `${timeframeContext(bundle.timeframe)}${extendedHoursContext(bundle)}`
PIPELINE_INJECT_REGEX = r'\$\{timeframeContext\(bundle\.timeframe\)\}'
PIPELINE_INJECT_REPLACEMENT = '${timeframeContext(bundle.timeframe)}${extendedHoursContext(bundle)}'


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
# Aggregator patch
# =============================================================

def patch_aggregator(dry_run: bool) -> bool:
    if not AGGREGATOR.exists():
        print(f'  ERROR: {AGGREGATOR} not found', file=sys.stderr)
        return False

    text, le = read_file(AGGREGATOR)

    state = {
        'import':   'getExtendedHoursContext' in text,
        'type':     'extendedHours?: ExtendedHoursContext' in text,
        'parallel': ', extendedHours] = await Promise.all' in text,
        'return':   ('extendedHours,' in text) or ('extendedHours\n' in text and 'aiContext' in text),
    }

    if all(state.values()):
        print('  [OK] aggregator.ts: already fully patched, no changes')
        return True

    edits = []

    # Edit A1: import
    if not state['import']:
        if AGG_IMPORT_OLD not in text:
            print('  ERROR: Could not find Alpaca import anchor in aggregator.ts', file=sys.stderr)
            return False
        text = text.replace(AGG_IMPORT_OLD, AGG_IMPORT_NEW)
        edits.append('  [+] Added extended-hours import')

    # Edit A2: SignalBundle type field
    if not state['type']:
        if AGG_TYPE_OLD not in text:
            print('  ERROR: Could not find SignalBundle Phase 5 anchor', file=sys.stderr)
            return False
        text = text.replace(AGG_TYPE_OLD, AGG_TYPE_NEW)
        edits.append('  [+] Added extendedHours field to SignalBundle type')

    # Edit A3: parallel fetch
    if not state['parallel']:
        if AGG_PARALLEL_OLD not in text:
            print('  ERROR: Could not find parallel-fetch block in equity path', file=sys.stderr)
            return False
        text = text.replace(AGG_PARALLEL_OLD, AGG_PARALLEL_NEW)
        edits.append('  [+] Added getExtendedHoursContext to parallel fetch')

    # Edit A4: return statement (equity path)
    if not state['return']:
        if AGG_RETURN_OLD not in text:
            print('  ERROR: Could not find equity-path return statement', file=sys.stderr)
            return False
        text = text.replace(AGG_RETURN_OLD, AGG_RETURN_NEW)
        edits.append('  [+] Added extendedHours to bundle return')

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

    has_helper = 'function extendedHoursContext(bundle:' in text
    inject_count = text.count('${extendedHoursContext(bundle)}')
    needs_injection = '${timeframeContext(bundle.timeframe)}' in text and inject_count == 0

    if has_helper and not needs_injection:
        print('  [OK] pipeline.ts: already fully patched, no changes')
        return True

    edits = []

    # Edit P1: Insert extendedHoursContext helper after timeframeContext function
    if not has_helper:
        # Find timeframeContext start
        start = text.find(PIPELINE_HELPER_INSERT_AFTER)
        if start < 0:
            print('  ERROR: Could not find timeframeContext function in pipeline.ts', file=sys.stderr)
            return False

        # Walk forward to find matching closing brace using brace depth
        # Skip past 'function timeframeContext(tf: string): string {' opening brace
        cursor = start + len(PIPELINE_HELPER_INSERT_AFTER)
        depth = 1  # already inside the function body
        end = -1
        while cursor < len(text) and depth > 0:
            ch = text[cursor]
            if ch == '{':
                depth += 1
            elif ch == '}':
                depth -= 1
                if depth == 0:
                    end = cursor + 1
                    break
            cursor += 1

        if end < 0:
            print('  ERROR: Could not find end of timeframeContext function', file=sys.stderr)
            return False

        text = text[:end] + PIPELINE_HELPER_NEW + text[end:]
        edits.append('  [+] Inserted extendedHoursContext() helper function')

    # Edit P2: inject extendedHoursContext call after every timeframeContext template
    if needs_injection or inject_count == 0:
        new_text, num_replacements = re.subn(
            PIPELINE_INJECT_REGEX,
            PIPELINE_INJECT_REPLACEMENT.replace('\\', '\\\\'),  # escape for re.sub backref handling
            text,
        )
        # Note: re.sub treats \1 etc as backrefs so we just use string replacement instead
        # to avoid that complication.
        new_text = re.sub(
            PIPELINE_INJECT_REGEX,
            lambda m: PIPELINE_INJECT_REPLACEMENT,
            text,
        )
        num_replacements = text.count('${timeframeContext(bundle.timeframe)}')
        text = new_text
        edits.append(f'  [+] Injected extendedHoursContext into {num_replacements} prompt sites')

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
    print('Extended-hours pipeline integration')
    print('=' * 60)
    if dry_run:
        print('  (DRY RUN — no files will be written)')
    print()

    # Prerequisite
    helper = Path('app/lib/data/extended-hours.ts')
    print('Prerequisite checks:')
    if not helper.exists():
        print(f'  [MISSING] {helper}')
        print('   Deploy app/lib/data/extended-hours.ts before running this patch.')
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
        print('Dry run complete. Re-run without --dry-run to apply.')
    else:
        print('Patch complete. Run `npm run build` to verify.')
    print('=' * 60)
    return 0


if __name__ == '__main__':
    sys.exit(main())
