#!/usr/bin/env python3
"""
patch_dashboard.py

Combined patch for app/page.tsx:
  1. Dashboard nav grouped dropdowns (Discover + Positions)
  2. QA panel integration after Council verdict

This script uses ONLY explicit UTF-8 file I/O. No PowerShell encoding bugs.
Idempotent: re-running skips edits that are already applied.

Usage:
  python patch_dashboard.py           # apply patches, write to disk
  python patch_dashboard.py --dry-run # show what would change, don't write

Requires: Python 3.6+
"""

from __future__ import annotations
import re
import sys
from pathlib import Path


DASHBOARD = Path('app/page.tsx')


# =====================================================================
# Anchor strings (verified against current restored file)
# =====================================================================

LUCIDE_IMPORT_OLD = """import {
  TrendingUp, TrendingDown, Minus, Clock, AlertTriangle,
  BarChart2, Globe, DollarSign, Activity, Shield, Zap, LogOut, BookOpen,
  Sun, Moon, Menu, X, Calendar, Flame, Briefcase, Search, Trophy,
  Scale, LineChart, PieChart, Hourglass, RotateCw, Check, Target,
  Star, ClipboardList, Wallet, RefreshCw, FileText, Coins, ShieldCheck
} from 'lucide-react'"""

LUCIDE_IMPORT_NEW = """import {
  TrendingUp, TrendingDown, Minus, Clock, AlertTriangle,
  BarChart2, Globe, DollarSign, Activity, Shield, Zap, LogOut, BookOpen,
  Sun, Moon, Menu, X, Calendar, Flame, Briefcase, Search, Trophy,
  Scale, LineChart, PieChart, Hourglass, RotateCw, Check, Target,
  Star, ClipboardList, Wallet, RefreshCw, FileText, Coins, ShieldCheck,
  ChevronDown
} from 'lucide-react'"""


NAV_IMPORT_OLD = "import { useRouter, useSearchParams } from 'next/navigation'"
NAV_IMPORT_NEW = "import { useRouter, useSearchParams, usePathname } from 'next/navigation'"


# QA component imports added next to PortfolioAlerts import
QA_IMPORT_OLD = "import PortfolioAlerts from '@/app/components/PortfolioAlerts'"
QA_IMPORT_NEW = (
    "import PortfolioAlerts from '@/app/components/PortfolioAlerts'\n"
    "import AnalysisQA, { AnalysisQAContext } from '@/app/components/AnalysisQA'"
)


NAV_ITEMS_OLD = """  const NAV_ITEMS: Array<{ label: string; icon: React.ReactNode; path: string; color: string }> = [
    { label: 'Today',        icon: <Zap size={12} />,           path: '/news',         color: '#fbbf24' },
    { label: 'Tomorrow',     icon: <Calendar size={12} />,      path: '/tomorrow',     color: '#a78bfa' },
    { label: 'Invest',       icon: <Flame size={12} />,         path: '/invest',       color: '#f97316' },
    { label: 'Portfolio',    icon: <Briefcase size={12} />,     path: '/portfolio',    color: '#34d399' },
    { label: 'Macro',        icon: <Globe size={12} />,         path: '/macro',        color: '#60a5fa' },
    { label: 'Altcoins',     icon: <Coins size={12} />,         path: '/altcoins',     color: '#a78bfa' },
    { label: 'Screener',     icon: <Search size={12} />,        path: '/screener',     color: '#a78bfa' },
    { label: 'Compare',      icon: <Scale size={12} />,         path: '/compare',      color: '#f87171' },
    { label: 'Track Record', icon: <Trophy size={12} />,        path: '/track-record', color: '#fbbf24' },
    { label: 'Guide',        icon: <BookOpen size={12} />,      path: '/guide',        color: txt3 },
  ]"""


NAV_ITEMS_NEW = """  // Always-visible top-level nav items (high-frequency actions + utilities)
  const NAV_TOP: Array<{ label: string; icon: React.ReactNode; path: string; color: string }> = [
    { label: 'Today',        icon: <Zap size={12} />,           path: '/news',         color: '#fbbf24' },
    { label: 'Tomorrow',     icon: <Calendar size={12} />,      path: '/tomorrow',     color: '#a78bfa' },
    { label: 'Invest',       icon: <Flame size={12} />,         path: '/invest',       color: '#f97316' },
    { label: 'Compare',      icon: <Scale size={12} />,         path: '/compare',      color: '#f87171' },
    { label: 'Track Record', icon: <Trophy size={12} />,        path: '/track-record', color: '#fbbf24' },
    { label: 'Guide',        icon: <BookOpen size={12} />,      path: '/guide',        color: txt3 },
  ]

  // Dropdown groups for desktop nav
  const NAV_GROUPS: Array<{ label: string; icon: React.ReactNode; color: string; items: Array<{ label: string; icon: React.ReactNode; path: string; color: string }> }> = [
    {
      label: 'Discover',
      icon: <Search size={12} />,
      color: '#a78bfa',
      items: [
        { label: 'Screener', icon: <Search size={12} />,    path: '/screener', color: '#a78bfa' },
        { label: 'Scanner',  icon: <Target size={12} />,    path: '/scanner',  color: '#a78bfa' },
        { label: 'Options',  icon: <LineChart size={12} />, path: '/options',  color: '#fbbf24' },
        { label: 'Macro',    icon: <Globe size={12} />,     path: '/macro',    color: '#60a5fa' },
        { label: 'Altcoins', icon: <Coins size={12} />,     path: '/altcoins', color: '#a78bfa' },
      ],
    },
    {
      label: 'Positions',
      icon: <Briefcase size={12} />,
      color: '#34d399',
      items: [
        { label: 'Portfolio', icon: <Briefcase size={12} />,     path: '/portfolio', color: '#34d399' },
        { label: 'Watchlist', icon: <ClipboardList size={12} />, path: '/watchlist', color: '#60a5fa' },
      ],
    },
  ]

  // Flattened list for mobile drawer (preserves drawer behavior)
  const NAV_ITEMS: Array<{ label: string; icon: React.ReactNode; path: string; color: string }> = [
    ...NAV_TOP.slice(0, 3),
    ...NAV_GROUPS.flatMap(g => g.items),
    ...NAV_TOP.slice(3),
  ]"""


NAV_OPEN_OLD = "  const [navOpen, setNavOpen] = useState(false)"
NAV_OPEN_NEW = (
    "  const [navOpen, setNavOpen] = useState(false)\n"
    "  const [navGroupOpen, setNavGroupOpen] = useState<string | null>(null)"
)


ROUTER_OLD = "  const router = useRouter()"
ROUTER_NEW = (
    "  const router = useRouter()\n"
    "  const pathname = usePathname()"
)


# Desktop nav block - we use bracket-counting to find the matching </div>.
# Anchor: the unique opening tag string (ASCII-only).
DESKTOP_NAV_START_MARKER = '<div className="hidden xl:flex items-center gap-1 px-3 pb-2 pt-0">'

DESKTOP_NAV_NEW_BLOCK = """        {/* Row 2 (xl+): desktop nav with top-level buttons + dropdown groups */}
        <div className="hidden xl:flex items-center gap-1 px-3 pb-2 pt-0">
          {NAV_TOP.slice(0, 3).map(n => (
            <button
              key={n.path}
              type="button"
              onClick={() => router.push(n.path)}
              aria-label={`Go to ${n.label}`}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold transition-all hover:opacity-80 focus:outline focus:outline-2 focus:outline-offset-1"
              style={{ color: n.color, background: `${n.color}10`, border: `1px solid ${n.color}20`, outlineColor: n.color }}>
              <span className="text-[11px]" aria-hidden="true">{n.icon}</span>
              <span>{n.label}</span>
            </button>
          ))}
          {NAV_GROUPS.map(group => {
            const isOpen = navGroupOpen === group.label
            const isActive = group.items.some(item => pathname === item.path)
            return (
              <div
                key={group.label}
                className="relative"
                onMouseEnter={() => setNavGroupOpen(group.label)}
                onMouseLeave={() => setNavGroupOpen(null)}>
                <button
                  type="button"
                  onClick={() => setNavGroupOpen(isOpen ? null : group.label)}
                  aria-haspopup="menu"
                  aria-expanded={isOpen}
                  aria-label={`${group.label} menu`}
                  className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold transition-all hover:opacity-80 focus:outline focus:outline-2 focus:outline-offset-1"
                  style={{
                    color: group.color,
                    background: isActive ? `${group.color}18` : `${group.color}10`,
                    border: `1px solid ${isActive ? group.color + '40' : group.color + '20'}`,
                    outlineColor: group.color,
                  }}>
                  <span className="text-[11px]" aria-hidden="true">{group.icon}</span>
                  <span>{group.label}</span>
                  <ChevronDown
                    size={10}
                    className={'transition-transform ' + (isOpen ? 'rotate-180' : '')}
                    aria-hidden="true" />
                </button>
                {isOpen && (
                  <div
                    role="menu"
                    aria-label={`${group.label} submenu`}
                    className="absolute top-full left-0 mt-1 py-1 rounded-lg shadow-lg z-50 min-w-[170px]"
                    style={{ background: surf, border: `1px solid ` + brd }}>
                    {group.items.map(item => (
                      <button
                        key={item.path}
                        type="button"
                        role="menuitem"
                        onClick={() => { router.push(item.path); setNavGroupOpen(null) }}
                        aria-label={`Go to ${item.label}`}
                        className="w-full flex items-center gap-2 px-3 py-2 text-xs font-semibold transition-all hover:opacity-80 text-left focus:outline focus:outline-2 focus:outline-offset-1"
                        style={{
                          color: item.color,
                          background: pathname === item.path ? `${item.color}15` : 'transparent',
                          outlineColor: item.color,
                        }}>
                        <span className="text-[11px]" aria-hidden="true">{item.icon}</span>
                        <span>{item.label}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
          {NAV_TOP.slice(3).map(n => (
            <button
              key={n.path}
              type="button"
              onClick={() => router.push(n.path)}
              aria-label={`Go to ${n.label}`}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold transition-all hover:opacity-80 focus:outline focus:outline-2 focus:outline-offset-1"
              style={{ color: n.color, background: `${n.color}10`, border: `1px solid ${n.color}20`, outlineColor: n.color }}>
              <span className="text-[11px]" aria-hidden="true">{n.icon}</span>
              <span>{n.label}</span>
            </button>
          ))}
          <TutorialLauncher tutorialId="main" />
        </div>
"""


# QA panel - inserted before {err && ( block
QA_BLOCK = """            {/* Follow-up Q&A panel - opens explicitly via toggle */}
            {stage === 'done' && jud && md && (
              <AnalysisQA
                context={{
                  ticker,
                  currentPrice: md.currentPrice ?? 0,
                  verdict: jud,
                  news: gem ? {
                    summary: gem.summary,
                    sentiment: gem.sentiment,
                    headlines: gem.headlines,
                    keyEvents: gem.keyEvents,
                    macroFactors: gem.macroFactors,
                    regimeAssessment: gem.regimeAssessment,
                  } : null,
                  leadAnalyst: cla,
                  devilsAdvocate: gpt,
                  rebuttal: reb,
                  counter: ctr,
                  technicals: md.technicals ? {
                    rsi: md.technicals.rsi,
                    macd: md.technicals.macdCrossover,
                    sma50: md.technicals.sma50,
                    sma200: md.technicals.sma200,
                    bias: md.technicals.technicalBias,
                    keySignals: md.conviction?.signals?.slice(0, 8).map(s => `${s.category}: ${s.signal}`),
                  } : null,
                  social: soc ? {
                    summary: soc.keyNarrative,
                    bullishCount: soc.bullishTalkingPoints?.length ?? 0,
                    bearishCount: soc.bearishTalkingPoints?.length ?? 0,
                    keyThemes: [...(soc.bullishTalkingPoints ?? []), ...(soc.bearishTalkingPoints ?? [])].slice(0, 6),
                  } : null,
                } satisfies AnalysisQAContext}
              />
            )}

"""


# =====================================================================
# Helpers
# =====================================================================

def find_matching_close_div(text: str, open_idx: int) -> int:
    """Walk forward from after the opening tag, counting <div>/</div> until balanced.
    Returns the index immediately AFTER the closing </div>, or -1 if not found.
    Assumes open_idx points just past the opening <div ...> tag."""
    cursor = open_idx
    depth = 1
    while cursor < len(text) and depth > 0:
        open_pos  = text.find('<div',   cursor)
        close_pos = text.find('</div>', cursor)
        if close_pos < 0:
            return -1
        if 0 <= open_pos < close_pos:
            depth += 1
            cursor = open_pos + 4
        else:
            depth -= 1
            if depth == 0:
                return close_pos + len('</div>')
            cursor = close_pos + len('</div>')
    return -1


# =====================================================================
# Main
# =====================================================================

def main(dry_run: bool = False) -> int:
    if not DASHBOARD.exists():
        print(f'ERROR: {DASHBOARD} does not exist. Run from repo root (E:\\consilium).', file=sys.stderr)
        return 1

    # Read with explicit UTF-8
    raw_bytes = DASHBOARD.read_bytes()
    try:
        text = raw_bytes.decode('utf-8')
    except UnicodeDecodeError as e:
        print(f'ERROR: File is not valid UTF-8: {e}', file=sys.stderr)
        return 1

    # Detect line endings to preserve them
    has_crlf = b'\r\n' in raw_bytes
    if has_crlf:
        text = text.replace('\r\n', '\n')

    print(f'Read {DASHBOARD}: {len(raw_bytes)} bytes, {len(text.splitlines())} lines '
          f'({"CRLF" if has_crlf else "LF"} line endings)')
    print()

    # State detection
    state = {
        'chevron':         'ChevronDown' in text and bool(re.search(r"ChevronDown[\s,]*\}\s*from\s*['\"]lucide-react['\"]", text)),
        'usePathname':     "usePathname } from 'next/navigation'" in text or "usePathname, " in text,
        'AnalysisQA_imp':  'import AnalysisQA' in text,
        'NAV_TOP':         'const NAV_TOP' in text,
        'NAV_GROUPS':      'const NAV_GROUPS' in text,
        'navGroupOpen':    'navGroupOpen' in text,
        'pathname_var':    re.search(r'const pathname = usePathname\(\)', text) is not None,
        'desktop_grouped': 'NAV_GROUPS.map(group =>' in text,
        'qa_render':       '<AnalysisQA' in text and 'context={{' in text,
    }

    print('Current state:')
    for k, v in state.items():
        print(f'  [{"OK" if v else "  "}] {k}')
    print()

    # If nothing missing, no-op
    if all(state.values()):
        print('Already fully patched. No changes.')
        return 0

    edits_made = []

    # ---------------------------------------------------------------
    # Edit 1: Lucide import - add ChevronDown
    # ---------------------------------------------------------------
    if not state['chevron']:
        if LUCIDE_IMPORT_OLD not in text:
            print('ERROR: Could not find lucide-react import block (anchor mismatch).', file=sys.stderr)
            return 1
        text = text.replace(LUCIDE_IMPORT_OLD, LUCIDE_IMPORT_NEW)
        edits_made.append('[1] Added ChevronDown to lucide imports')

    # ---------------------------------------------------------------
    # Edit 2: next/navigation import - add usePathname
    # ---------------------------------------------------------------
    if not state['usePathname']:
        if NAV_IMPORT_OLD not in text:
            print('ERROR: Could not find next/navigation import (anchor mismatch).', file=sys.stderr)
            return 1
        text = text.replace(NAV_IMPORT_OLD, NAV_IMPORT_NEW)
        edits_made.append('[2] Added usePathname to next/navigation import')

    # ---------------------------------------------------------------
    # Edit 3: AnalysisQA import
    # ---------------------------------------------------------------
    if not state['AnalysisQA_imp']:
        if QA_IMPORT_OLD not in text:
            print('ERROR: Could not find PortfolioAlerts import (anchor mismatch).', file=sys.stderr)
            return 1
        text = text.replace(QA_IMPORT_OLD, QA_IMPORT_NEW)
        edits_made.append('[3] Added AnalysisQA import')

    # ---------------------------------------------------------------
    # Edit 4: Replace NAV_ITEMS with NAV_TOP + NAV_GROUPS + flat NAV_ITEMS
    # ---------------------------------------------------------------
    if not state['NAV_TOP']:
        if NAV_ITEMS_OLD not in text:
            print('ERROR: Could not find NAV_ITEMS array (anchor mismatch).', file=sys.stderr)
            return 1
        text = text.replace(NAV_ITEMS_OLD, NAV_ITEMS_NEW)
        edits_made.append('[4] Replaced NAV_ITEMS with NAV_TOP + NAV_GROUPS + flat NAV_ITEMS')

    # ---------------------------------------------------------------
    # Edit 5: Add navGroupOpen state
    # ---------------------------------------------------------------
    if not state['navGroupOpen']:
        if NAV_OPEN_OLD not in text:
            print('ERROR: Could not find navOpen state declaration.', file=sys.stderr)
            return 1
        text = text.replace(NAV_OPEN_OLD, NAV_OPEN_NEW)
        edits_made.append('[5] Added navGroupOpen state')

    # ---------------------------------------------------------------
    # Edit 6: Add pathname variable
    # ---------------------------------------------------------------
    if not state['pathname_var']:
        if ROUTER_OLD not in text:
            print('ERROR: Could not find useRouter() declaration.', file=sys.stderr)
            return 1
        text = text.replace(ROUTER_OLD, ROUTER_NEW)
        edits_made.append('[6] Added pathname variable')

    # ---------------------------------------------------------------
    # Edit 7: Replace desktop nav block with grouped version
    # Uses bracket-counting (no exact text match required)
    # ---------------------------------------------------------------
    if not state['desktop_grouped']:
        marker_idx = text.find(DESKTOP_NAV_START_MARKER)
        if marker_idx < 0:
            print('ERROR: Could not find desktop nav <div> opening tag.', file=sys.stderr)
            return 1

        # Find matching </div>
        after_open = marker_idx + len(DESKTOP_NAV_START_MARKER)
        close_end = find_matching_close_div(text, after_open)
        if close_end < 0:
            print('ERROR: Could not find matching </div> for desktop nav.', file=sys.stderr)
            return 1

        # Walk back to start-of-line for marker_idx; also include the JSX
        # comment line above if it looks like ours.
        line_start = text.rfind('\n', 0, marker_idx) + 1
        prev_line_end = line_start - 1  # the \n itself
        prev_line_start = text.rfind('\n', 0, prev_line_end) + 1
        comment_line = text[prev_line_start:line_start]
        include_comment = ('Row 2' in comment_line) or ('desktop nav' in comment_line)
        replace_start = prev_line_start if include_comment else line_start

        text = text[:replace_start] + DESKTOP_NAV_NEW_BLOCK + text[close_end:]
        edits_made.append('[7] Replaced desktop nav block with grouped dropdowns')

    # ---------------------------------------------------------------
    # Edit 8: Insert QA panel block before {err && ( ...
    # ---------------------------------------------------------------
    if not state['qa_render']:
        err_marker = '{err && ('
        err_idx = text.find(err_marker)
        if err_idx < 0:
            print('ERROR: Could not find {err && ( anchor for QA placement.', file=sys.stderr)
            return 1

        # Insert at start of the line containing the err marker
        line_start = text.rfind('\n', 0, err_idx) + 1
        text = text[:line_start] + QA_BLOCK + text[line_start:]
        edits_made.append('[8] Inserted AnalysisQA render block')

    # ---------------------------------------------------------------
    # Restore line endings if originally CRLF
    # ---------------------------------------------------------------
    if has_crlf:
        text = text.replace('\n', '\r\n')

    # ---------------------------------------------------------------
    # Report
    # ---------------------------------------------------------------
    print('Edits to apply:')
    for e in edits_made:
        print(f'  {e}')
    print()

    if dry_run:
        print('DRY RUN: no file written.')
        return 0

    # Write atomically: write to temp file, then rename
    tmp_path = DASHBOARD.with_suffix('.tsx.tmp')
    tmp_path.write_text(text, encoding='utf-8', newline='')
    tmp_path.replace(DASHBOARD)

    # Verify written file is still valid UTF-8 and non-empty
    written = DASHBOARD.read_bytes()
    print(f'Wrote {DASHBOARD}: {len(written)} bytes')

    # Quick sanity check
    if b'NAV_GROUPS' not in written:
        print('WARNING: NAV_GROUPS not found in written file', file=sys.stderr)
    if b'AnalysisQA' not in written:
        print('WARNING: AnalysisQA not found in written file', file=sys.stderr)

    print()
    print('Done. Run `npm run build` or `git diff` to verify.')
    return 0


if __name__ == '__main__':
    dry = '--dry-run' in sys.argv or '-n' in sys.argv
    sys.exit(main(dry_run=dry))
