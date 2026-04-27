#!/usr/bin/env python3
"""
patch_intraday_charts.py

Single combined patch for the IntradayCharts feature:

  1. Exports detectCandlePattern and detectChartPattern from technicals.ts
     so the new /api/intraday-bars route can import them
  2. Adds <IntradayCharts /> render to app/page.tsx, below the existing
     <TechnicalCharts> block

Idempotent: re-running skips any edits already applied.

PREREQUISITE FILES (must be deployed before running this patch):
  - app/api/intraday-bars/route.ts
  - app/components/IntradayCharts.tsx

Usage:
  python patch_intraday_charts.py            # apply
  python patch_intraday_charts.py --dry-run  # preview
"""

from __future__ import annotations
import sys
from pathlib import Path

TECHNICALS = Path('app/lib/signals/technicals.ts')
PAGE = Path('app/page.tsx')


# =============================================================
# Edit 1: Export pattern detection functions
# =============================================================

CANDLE_OLD = "function detectCandlePattern(bars: Bar[]): CandlePattern | null {"
CANDLE_NEW = "export function detectCandlePattern(bars: Bar[]): CandlePattern | null {"

CHART_OLD = "function detectChartPattern(bars: Bar[], currentPrice: number): ChartPattern | null {"
CHART_NEW = "export function detectChartPattern(bars: Bar[], currentPrice: number): ChartPattern | null {"


# =============================================================
# Edit 2: Add IntradayCharts import + render to page.tsx
# =============================================================

# Anchor: existing TechnicalCharts import
TC_IMPORT_OLD = "import TechnicalCharts from '@/app/components/TechnicalCharts'"
TC_IMPORT_NEW = (
    "import TechnicalCharts from '@/app/components/TechnicalCharts'\n"
    "import IntradayCharts from '@/app/components/IntradayCharts'"
)

# The TechnicalCharts JSX render. We'll insert IntradayCharts immediately after.
# Anchor uses a unique ASCII fragment of the existing render line.
TC_RENDER_ANCHOR = '<TechnicalCharts ticker={ticker} technicals={md.technicals as any} />'

# What we insert AFTER the TechnicalCharts line (note: appears inside an existing
# Collapsible / div that wraps the TechnicalCharts component). We add a sibling
# section, not nested inside the TechnicalCharts block.
INTRADAY_BLOCK = """

            {/* Intraday charts - separate component, no AI signals, pure visualization */}
            {stage === 'done' && md && (
              <IntradayCharts
                ticker={ticker}
                analysisPatterns={{
                  candle: md.technicals?.candlePattern ?? null,
                  chart: md.technicals?.chartPattern ?? null,
                }}
              />
            )}
"""


# =============================================================
# Helpers
# =============================================================

def detect_line_endings(raw: bytes) -> str:
    """Returns 'crlf' if CRLF dominates, else 'lf'."""
    crlf = raw.count(b'\r\n')
    lf = raw.count(b'\n') - crlf
    return 'crlf' if crlf > lf else 'lf'


def read_text_safe(path: Path) -> tuple[str, str]:
    """Read with explicit UTF-8, return (text, line_ending_style)."""
    raw = path.read_bytes()
    text = raw.decode('utf-8')
    le = detect_line_endings(raw)
    if le == 'crlf':
        text = text.replace('\r\n', '\n')
    return text, le


def write_text_safe(path: Path, text: str, line_ending: str) -> None:
    """Atomic write with explicit UTF-8 + preserved line endings."""
    if line_ending == 'crlf':
        text = text.replace('\n', '\r\n')
    tmp = path.with_suffix(path.suffix + '.tmp')
    tmp.write_text(text, encoding='utf-8', newline='')
    tmp.replace(path)


# =============================================================
# Patch logic
# =============================================================

def patch_technicals(dry_run: bool) -> bool:
    """Add export keyword to detectCandlePattern and detectChartPattern."""
    if not TECHNICALS.exists():
        print(f'  ERROR: {TECHNICALS} not found', file=sys.stderr)
        return False

    text, le = read_text_safe(TECHNICALS)

    has_candle_export = CANDLE_NEW in text
    has_chart_export = CHART_NEW in text

    if has_candle_export and has_chart_export:
        print(f'  [OK] {TECHNICALS}: both functions already exported, no changes')
        return True

    edits = []

    if not has_candle_export:
        if CANDLE_OLD not in text:
            print(f'  ERROR: Could not find detectCandlePattern declaration in {TECHNICALS}', file=sys.stderr)
            return False
        text = text.replace(CANDLE_OLD, CANDLE_NEW)
        edits.append('  [+] Added export to detectCandlePattern')

    if not has_chart_export:
        if CHART_OLD not in text:
            print(f'  ERROR: Could not find detectChartPattern declaration in {TECHNICALS}', file=sys.stderr)
            return False
        text = text.replace(CHART_OLD, CHART_NEW)
        edits.append('  [+] Added export to detectChartPattern')

    for e in edits:
        print(e)

    if dry_run:
        print(f'  (dry-run: would write {TECHNICALS})')
    else:
        write_text_safe(TECHNICALS, text, le)
        print(f'  Wrote {TECHNICALS}')

    return True


def patch_page(dry_run: bool) -> bool:
    """Add IntradayCharts import + render to page.tsx."""
    if not PAGE.exists():
        print(f'  ERROR: {PAGE} not found', file=sys.stderr)
        return False

    text, le = read_text_safe(PAGE)

    has_import = 'IntradayCharts' in text and 'from \'@/app/components/IntradayCharts\'' in text
    has_render = '<IntradayCharts' in text

    if has_import and has_render:
        print(f'  [OK] {PAGE}: IntradayCharts already integrated, no changes')
        return True

    edits = []

    # Edit 2a: Add import
    if not has_import:
        if TC_IMPORT_OLD not in text:
            print(f'  ERROR: Could not find TechnicalCharts import anchor in {PAGE}', file=sys.stderr)
            return False
        text = text.replace(TC_IMPORT_OLD, TC_IMPORT_NEW)
        edits.append('  [+] Added IntradayCharts import')

    # Edit 2b: Add render block after the existing <TechnicalCharts ...> tag
    if not has_render:
        anchor_idx = text.find(TC_RENDER_ANCHOR)
        if anchor_idx < 0:
            print(f'  ERROR: Could not find TechnicalCharts render anchor in {PAGE}', file=sys.stderr)
            print(f'         Looking for: {TC_RENDER_ANCHOR}', file=sys.stderr)
            return False

        # Find the end of that line (anchor includes the self-closing /> already)
        line_end = text.find('\n', anchor_idx)
        if line_end < 0:
            print(f'  ERROR: Could not find line end after TechnicalCharts anchor', file=sys.stderr)
            return False

        # The TechnicalCharts is wrapped in a Collapsible. We need to find the
        # closing of that Collapsible block (</Collapsible>) and insert our
        # block AFTER it.
        # Walk forward looking for </Collapsible>
        coll_close_idx = text.find('</Collapsible>', anchor_idx)
        if coll_close_idx < 0:
            print(f'  ERROR: Could not find </Collapsible> after TechnicalCharts', file=sys.stderr)
            return False

        # Find the line end after </Collapsible> + closing brace + paren
        # The block ends with: </Collapsible>\n            )}\n
        # We want to insert just after that.
        after_close = text.find(')}', coll_close_idx)
        if after_close < 0:
            print('  ERROR: Could not find ")}" after </Collapsible>', file=sys.stderr)
            return False

        # Find end of that line
        insertion_point = text.find('\n', after_close)
        if insertion_point < 0:
            insertion_point = len(text)
        else:
            insertion_point += 1  # after the newline

        text = text[:insertion_point] + INTRADAY_BLOCK + text[insertion_point:]
        edits.append('  [+] Inserted <IntradayCharts /> render block')

    for e in edits:
        print(e)

    if dry_run:
        print(f'  (dry-run: would write {PAGE})')
    else:
        write_text_safe(PAGE, text, le)
        print(f'  Wrote {PAGE}')

    return True


# =============================================================
# Main
# =============================================================

def main() -> int:
    dry_run = '--dry-run' in sys.argv or '-n' in sys.argv

    print('=' * 60)
    print('IntradayCharts integration patch')
    print('=' * 60)
    if dry_run:
        print('  (DRY RUN — no files will be written)')
    print()

    # Sanity checks for prerequisite files
    api_route = Path('app/api/intraday-bars/route.ts')
    component = Path('app/components/IntradayCharts.tsx')

    print('Prerequisite checks:')
    if not api_route.exists():
        print(f'  [MISSING] {api_route}')
        print('   Place app/api/intraday-bars/route.ts before running this patch.')
        return 1
    print(f'  [OK] {api_route}')

    if not component.exists():
        print(f'  [MISSING] {component}')
        print('   Place app/components/IntradayCharts.tsx before running this patch.')
        return 1
    print(f'  [OK] {component}')
    print()

    # Edit 1: technicals.ts exports
    print('Step 1: Export pattern detection functions in technicals.ts')
    if not patch_technicals(dry_run):
        print('  Aborted due to error.', file=sys.stderr)
        return 1
    print()

    # Edit 2: page.tsx integration
    print('Step 2: Add IntradayCharts to app/page.tsx')
    if not patch_page(dry_run):
        print('  Aborted due to error.', file=sys.stderr)
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
