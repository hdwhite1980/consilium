#!/usr/bin/env python3
"""
patch_earnings_recency.py

Wires two enhancements into Council prompts:

  1. Earnings-time awareness (granular tier system)
     - Injects earnings proximity context next to extendedHoursContext
     - Tiers: today / tomorrow / 2-3d / 4-7d / 8-14d / 15-30d
     - Devil's Advocate gets contextual addition when earnings <= 7 days

  2. News recency weighting
     - One-time addition to Lead Analyst, Devil's Advocate, Judge system
       prompts: "weight news by recency"

Idempotent. UTF-8 safe. Preserves CRLF.

Usage:
  python patch_earnings_recency.py            # apply
  python patch_earnings_recency.py --dry-run  # preview
"""

from __future__ import annotations
import re
import sys
from pathlib import Path

PIPELINE = Path('app/lib/pipeline.ts')


# =============================================================
# Edit 1: Add earningsContext() helper after extendedHoursContext()
# =============================================================

EARNINGS_HELPER_NEW = """

/**
 * Earnings-time awareness for prompts.
 *
 * Surfaces granular earnings proximity so the Council can adjust
 * weight on technicals vs catalysts. Pre-earnings windows have
 * structurally different price dynamics than mid-quarter periods.
 *
 * Wired into all 9 prompt assembly sites alongside extendedHoursContext.
 *
 * Tier breakdown:
 *   today       \u2014 earnings reporting today (highest catalyst risk)
 *   tomorrow    \u2014 earnings tomorrow (positioning dominates)
 *   imminent    \u2014 earnings in 2-3 days (implied move pricing in)
 *   this_week   \u2014 earnings in 4-7 days (drift + IV expansion)
 *   next_week   \u2014 earnings in 8-14 days (approaching catalyst)
 *   this_month  \u2014 earnings in 15-30 days (on horizon)
 *   distant     \u2014 >30 days or unknown (no injection)
 */
function earningsContext(bundle: SignalBundle): string {
  const days = bundle.fundamentals?.daysToEarnings
  if (days === null || days === undefined || days < 0 || days > 30) return ''

  const impliedMove = bundle.fundamentals?.earningsImpliedMove ?? null
  const historicalMove = bundle.fundamentals?.earningsHistoricalMove ?? null
  const earningsDate = bundle.fundamentals?.nextEarningsDate ?? null
  const dateStr = earningsDate ? ` on ${earningsDate}` : ''
  const moveCtx = (impliedMove !== null && historicalMove !== null)
    ? ` Options market is pricing a \u00b1${impliedMove.toFixed(1)}% move (historical avg: \u00b1${historicalMove.toFixed(1)}%).`
    : (impliedMove !== null)
    ? ` Options market is pricing a \u00b1${impliedMove.toFixed(1)}% move.`
    : ''

  let header: string
  let guidance: string

  if (days === 0) {
    header = `EARNINGS REPORTING TODAY${dateStr}.`
    guidance = `Technical patterns and chart-based targets are unreliable through the print. Pre-earnings drift may already be baked in. Catalysts dominate price action for the next session.`
  } else if (days === 1) {
    header = `EARNINGS TOMORROW${dateStr}.`
    guidance = `The next 24h price action is dominated by positioning into the print, not technicals. Targets and stops should reflect post-earnings volatility, not chart levels.`
  } else if (days >= 2 && days <= 3) {
    header = `EARNINGS IN ${days} DAYS${dateStr}.`
    guidance = `Pre-earnings positioning is active. Implied move should bound any near-term price target. Bullish technical setups face binary catalyst risk in 48-72h.`
  } else if (days >= 4 && days <= 7) {
    header = `EARNINGS IN ${days} DAYS${dateStr}.`
    guidance = `Earnings within the analysis window. Pre-earnings drift can dominate intraday signals. Options flow and analyst revisions become primary signal; pure chart patterns are weaker than usual.`
  } else if (days >= 8 && days <= 14) {
    header = `EARNINGS IN ${days} DAYS${dateStr}.`
    guidance = `Approaching catalyst. IV expansion likely in coming sessions. Multi-week swing targets must factor in event risk before fill.`
  } else {
    header = `EARNINGS IN ${days} DAYS${dateStr}.`
    guidance = `Catalyst on horizon but not immediate. Note for time-horizon planning, especially on multi-week setups.`
  }

  return `\\n\\nEARNINGS PROXIMITY: ${header}${moveCtx} ${guidance}`
}
"""


# =============================================================
# Edit 2: Inject earningsContext call after every extendedHoursContext call
# =============================================================

EH_INJECT_REGEX = r'\$\{extendedHoursContext\(bundle\)\}'
EARNINGS_INJECT_REPLACEMENT = '${extendedHoursContext(bundle)}${earningsContext(bundle)}'


# =============================================================
# Edit 3: Add news-recency guidance to Lead Analyst system prompt
# =============================================================

LEAD_RECENCY_OLD = """Be decisive. Support every claim with specific data. Your analysis will be challenged by the Devil's Advocate. Never mention missing or unavailable data \u2014 only use what you have. IMPORTANT: If the price data shows a period change exceeding \u00b1200%, treat this as a potential data error and note it explicitly rather than building your analysis on it."""

LEAD_RECENCY_NEW = """Be decisive. Support every claim with specific data. Your analysis will be challenged by the Devil's Advocate. Never mention missing or unavailable data \u2014 only use what you have. IMPORTANT: If the price data shows a period change exceeding \u00b1200%, treat this as a potential data error and note it explicitly rather than building your analysis on it.

NEWS RECENCY: Weight news by freshness. Last 24 hours is current and actionable. Last 48-72 hours is recent context. Anything older is background unless it's a structural development (M&A close, leadership change, regulatory ruling). Breaking news from the last 6 hours overrides older narrative coverage."""


# =============================================================
# Edit 4: Add Devil's Advocate earnings cross-pressure (when applicable)
# =============================================================

# This goes inside the existing list of cross-pressure rules in buildDevilSystemPrompt
DEVIL_RECENCY_OLD = """6. Cross-pressure discipline: Your challenges should primarily cite fundamental/earnings/analyst/valuation evidence, not re-argue the chart. Let the Lead have their chart \u2014 attack on fundamentals."""

DEVIL_RECENCY_NEW = """6. Cross-pressure discipline: Your challenges should primarily cite fundamental/earnings/analyst/valuation evidence, not re-argue the chart. Let the Lead have their chart \u2014 attack on fundamentals.
7. Earnings proximity: When earnings are within 7 days (see EARNINGS PROXIMITY context if present), pressure-test specifically how much earnings risk is being priced in. A bullish technical thesis 3 days before a print needs to address: (a) what's the implied move? (b) what's analyst revision trend? (c) is the entry level above or below the implied-move band? Don't let the Lead skip past binary catalyst risk.
8. News recency: Weight news by freshness same as the Lead \u2014 last 24h current, 24-72h recent, older background. Don't cite stale narrative as a reason to disagree."""


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
    """Find the index just after the closing brace of a function.
    `function_signature` should be the opening line e.g. 'function foo(...): X {'
    Returns -1 if not found.
    """
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
# Patch
# =============================================================

def patch_pipeline(dry_run: bool) -> bool:
    if not PIPELINE.exists():
        print(f'  ERROR: {PIPELINE} not found', file=sys.stderr)
        return False

    text, le = read_file(PIPELINE)

    state = {
        'helper':       'function earningsContext(bundle:' in text,
        'inject':       text.count('${earningsContext(bundle)}') > 0,
        'lead_recency': 'NEWS RECENCY: Weight news by freshness' in text,
        'devil_recency':'7. Earnings proximity: When earnings are within' in text,
    }

    if all(state.values()):
        print('  [OK] pipeline.ts: already fully patched, no changes')
        return True

    edits = []

    # Edit 1: Insert earningsContext helper after extendedHoursContext function
    if not state['helper']:
        eh_sig = 'function extendedHoursContext(bundle: SignalBundle): string {'
        end = find_after_function(text, eh_sig)
        if end < 0:
            print('  ERROR: Could not find extendedHoursContext() function', file=sys.stderr)
            print('         (Make sure extended-hours patch was applied first.)', file=sys.stderr)
            return False
        text = text[:end] + EARNINGS_HELPER_NEW + text[end:]
        edits.append('  [+] Added earningsContext() helper function')

    # Edit 2: Inject earningsContext after every extendedHoursContext
    if not state['inject']:
        if EH_INJECT_REGEX.replace('\\', '') not in text:
            # Verify the literal extended-hours injection points exist
            count = len(re.findall(EH_INJECT_REGEX, text))
            if count == 0:
                print('  ERROR: No ${extendedHoursContext(bundle)} sites found.', file=sys.stderr)
                print('         Apply the extended-hours patch first.', file=sys.stderr)
                return False

        new_text = re.sub(
            EH_INJECT_REGEX,
            lambda m: EARNINGS_INJECT_REPLACEMENT,
            text,
        )
        num = len(re.findall(EH_INJECT_REGEX, text))
        text = new_text
        edits.append(f'  [+] Injected earningsContext at {num} prompt sites')

    # Edit 3: Lead Analyst news recency guidance
    if not state['lead_recency']:
        if LEAD_RECENCY_OLD not in text:
            print('  ERROR: Could not find Lead Analyst recency anchor', file=sys.stderr)
            return False
        text = text.replace(LEAD_RECENCY_OLD, LEAD_RECENCY_NEW)
        edits.append('  [+] Added news recency guidance to Lead Analyst system prompt')

    # Edit 4: Devil's Advocate earnings + recency rules
    if not state['devil_recency']:
        if DEVIL_RECENCY_OLD not in text:
            print("  ERROR: Could not find Devil's Advocate rule #6 anchor", file=sys.stderr)
            return False
        text = text.replace(DEVIL_RECENCY_OLD, DEVIL_RECENCY_NEW)
        edits.append("  [+] Added earnings + news recency rules to Devil's Advocate prompt")

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
    print('Earnings-time awareness + news recency')
    print('=' * 60)
    if dry_run:
        print('  (DRY RUN)')
    print()

    print('Step: pipeline.ts')
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
