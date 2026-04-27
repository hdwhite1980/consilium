#!/usr/bin/env python3
"""
fix_intraday_types.py

Fix TypeScript build error at app/page.tsx:2010

  Type 'string' is not assignable to type '"bullish" | "bearish" | "neutral"'

Root cause: page.tsx MarketData interface declares candlePattern.type as
`string` (loose), but IntradayCharts requires strict literal union types
that are exported from technicals.ts.

Fix: Import the strict types from technicals.ts and use them as type
assertions at the IntradayCharts call site.

Idempotent. UTF-8 safe. Preserves CRLF.
"""

from __future__ import annotations
import sys
from pathlib import Path

PAGE = Path('app/page.tsx')


# =============================================================
# Edit 1: Add type-only import from technicals.ts
# =============================================================

IMPORT_ANCHOR = "import IntradayCharts from '@/app/components/IntradayCharts'"
IMPORT_NEW = (
    "import IntradayCharts from '@/app/components/IntradayCharts'\n"
    "import type { CandlePattern as TechCandlePattern, ChartPattern as TechChartPattern } from '@/app/lib/signals/technicals'"
)


# =============================================================
# Edit 2: Cast at the call site
# =============================================================

CALL_OLD = """              <IntradayCharts
                ticker={ticker}
                analysisPatterns={{
                  candle: md.technicals?.candlePattern ?? null,
                  chart: md.technicals?.chartPattern ?? null,
                }}
              />"""

CALL_NEW = """              <IntradayCharts
                ticker={ticker}
                analysisPatterns={{
                  candle: (md.technicals?.candlePattern ?? null) as TechCandlePattern | null,
                  chart: (md.technicals?.chartPattern ?? null) as TechChartPattern | null,
                }}
              />"""


def main() -> int:
    if not PAGE.exists():
        print(f'ERROR: {PAGE} not found', file=sys.stderr)
        return 1

    raw = PAGE.read_bytes()
    has_crlf = b'\r\n' in raw
    text = raw.decode('utf-8')
    if has_crlf:
        text = text.replace('\r\n', '\n')

    has_type_import = 'TechCandlePattern' in text
    has_cast = 'as TechCandlePattern' in text

    if has_type_import and has_cast:
        print('Already patched. No changes.')
        return 0

    edits = []

    if not has_type_import:
        if IMPORT_ANCHOR not in text:
            print('ERROR: Could not find IntradayCharts import anchor.', file=sys.stderr)
            print('       Did you run the IntradayCharts patch first?', file=sys.stderr)
            return 1
        text = text.replace(IMPORT_ANCHOR, IMPORT_NEW)
        edits.append('  [+] Added type-only import from technicals.ts')

    if not has_cast:
        if CALL_OLD not in text:
            print('ERROR: Could not find IntradayCharts call site.', file=sys.stderr)
            return 1
        text = text.replace(CALL_OLD, CALL_NEW)
        edits.append('  [+] Added type assertions at call site')

    for e in edits:
        print(e)

    if has_crlf:
        text = text.replace('\n', '\r\n')

    tmp = PAGE.with_suffix('.tsx.tmp')
    tmp.write_text(text, encoding='utf-8', newline='')
    tmp.replace(PAGE)

    print(f'\nWrote {PAGE}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
