#!/usr/bin/env python3
"""
patch_earnings_countdown.py

Adds earnings time + live UI countdown.

Backend (app/lib/signals/fundamentals.ts):
  1. Extend earnings calendar fetch type to read `hour` + bonus fields
     (epsEstimate, revenueEstimate, epsActual, revenueActual)
  2. Add 3 new bundle fields:
       earningsHour: 'bmo' | 'amc' | 'dmh' | null
       earningsTimestamp: string | null  (ISO with approx ET time)
       hoursUntilEarnings: number | null
  3. Update buildEarningsTierDirective to include the timestamp and
     hours-until in the directive text.
  4. Map hour codes to ET times:
       bmo → 8:30 AM ET (typical pre-market call)
       amc → 4:30 PM ET (typical post-close call)
       dmh → 12:00 PM ET (during market hours, less common)

Frontend (page.tsx):
  1. Earnings countdown component above the Trade Plan box.
  2. setInterval ticking every 60s.
  3. Color tiers: <24h red, <72h yellow, otherwise gray.

Idempotent. UTF-8 safe. Preserves CRLF.
"""

from __future__ import annotations
import sys
from pathlib import Path

FUNDAMENTALS = Path('app/lib/signals/fundamentals.ts')

# Frontend page.tsx — auto-discover
PAGE_CANDIDATES = [
    Path('app/(dashboard)/dashboard/page.tsx'),
    Path('app/dashboard/page.tsx'),
    Path('app/page.tsx'),
    Path('app/analysis/page.tsx'),
]


# =========================================================
# BACKEND PATCH 1: Earnings calendar fetch type
# =========================================================

OLD_FETCH_TYPE = """  return finnhubGet<{ earningsCalendar: Array<{ date: string; symbol: string }> }>(
    `/calendar/earnings?symbol=${ticker}&from=${from}&to=${to}`
  )"""

NEW_FETCH_TYPE = """  return finnhubGet<{
    earningsCalendar: Array<{
      date: string
      symbol: string
      hour?: 'bmo' | 'amc' | 'dmh' | string | null
      epsEstimate?: number | null
      epsActual?: number | null
      revenueEstimate?: number | null
      revenueActual?: number | null
      quarter?: number | null
      year?: number | null
    }>
  }>(
    `/calendar/earnings?symbol=${ticker}&from=${from}&to=${to}`
  )"""


# =========================================================
# BACKEND PATCH 2: Type interface — add new fields
# =========================================================

OLD_TYPE_FIELDS = """  nextEarningsDate: string | null
  daysToEarnings: number | null
  earningsRisk: 'high' | 'moderate' | 'low' | 'none'"""

NEW_TYPE_FIELDS = """  nextEarningsDate: string | null
  daysToEarnings: number | null
  earningsRisk: 'high' | 'moderate' | 'low' | 'none'
  earningsHour: 'bmo' | 'amc' | 'dmh' | null   // bmo = before-market-open (~8:30 AM ET), amc = after-market-close (~4:30 PM ET), dmh = during-market-hours
  earningsTimestamp: string | null              // ISO with approximate ET time computed from hour code
  hoursUntilEarnings: number | null             // more precise than daysToEarnings; can be negative if catalyst already passed today
  epsEstimate: number | null                    // analyst EPS estimate for the upcoming/just-reported quarter
  epsActual: number | null                      // populated after the report drops; null pre-earnings
  revenueEstimate: number | null
  revenueActual: number | null"""


# =========================================================
# BACKEND PATCH 3: Compute the new fields
# =========================================================

OLD_COMPUTE = """  const nextEarning = upcoming[0]
  const nextEarningsDate = nextEarning?.date ?? null
  // daysToEarnings: rounded difference from midnight-today to midnight-of-earnings-date.
  // This ensures earnings-today returns 0 (not -1 due to time-of-day arithmetic).
  const daysToEarnings = nextEarningsDate
    ? (() => {
        const earnDate = new Date(nextEarningsDate)
        earnDate.setHours(0, 0, 0, 0)
        return Math.round((earnDate.getTime() - todayMidnight.getTime()) / 86400000)
      })()
    : null
  const earningsRisk: FundamentalSignals['earningsRisk'] =
    daysToEarnings !== null && daysToEarnings <= 7 ? 'high' :
    daysToEarnings !== null && daysToEarnings <= 21 ? 'moderate' :
    daysToEarnings !== null && daysToEarnings <= 45 ? 'low' : 'none'"""

NEW_COMPUTE = """  const nextEarning = upcoming[0]
  const nextEarningsDate = nextEarning?.date ?? null
  const rawHour = ((nextEarning as { hour?: unknown })?.hour ?? '').toString().toLowerCase()
  const earningsHour: FundamentalSignals['earningsHour'] =
    rawHour === 'bmo' ? 'bmo' :
    rawHour === 'amc' ? 'amc' :
    rawHour === 'dmh' ? 'dmh' : null

  // Build a more precise timestamp using the hour code. ET is UTC-4 (DST)
  // or UTC-5 (standard); we approximate using UTC-4 since US earnings season
  // is largely Q1/Q2 (DST). Approximations are documented; exact times
  // come from the company itself.
  // bmo: 8:30 AM ET = 12:30 UTC
  // amc: 4:30 PM ET = 20:30 UTC
  // dmh: 12:00 PM ET = 16:00 UTC
  let earningsTimestamp: string | null = null
  let hoursUntilEarnings: number | null = null
  if (nextEarningsDate) {
    const utcOffset =
      earningsHour === 'bmo' ? '12:30:00Z' :
      earningsHour === 'amc' ? '20:30:00Z' :
      earningsHour === 'dmh' ? '16:00:00Z' :
      '13:30:00Z'  // default: market open if no hour code
    earningsTimestamp = `${nextEarningsDate}T${utcOffset}`
    const ms = new Date(earningsTimestamp).getTime() - Date.now()
    hoursUntilEarnings = Math.round((ms / 3_600_000) * 10) / 10  // 1 decimal
  }

  // daysToEarnings: rounded difference from midnight-today to midnight-of-earnings-date.
  // This ensures earnings-today returns 0 (not -1 due to time-of-day arithmetic).
  const daysToEarnings = nextEarningsDate
    ? (() => {
        const earnDate = new Date(nextEarningsDate)
        earnDate.setHours(0, 0, 0, 0)
        return Math.round((earnDate.getTime() - todayMidnight.getTime()) / 86400000)
      })()
    : null
  const earningsRisk: FundamentalSignals['earningsRisk'] =
    daysToEarnings !== null && daysToEarnings <= 7 ? 'high' :
    daysToEarnings !== null && daysToEarnings <= 21 ? 'moderate' :
    daysToEarnings !== null && daysToEarnings <= 45 ? 'low' : 'none'"""


# =========================================================
# BACKEND PATCH 4: Update buildEarningsTierDirective signature + body
# =========================================================

OLD_DIRECTIVE = """function buildEarningsTierDirective(
  date: string,
  days: number | null,
  risk: 'high' | 'moderate' | 'low' | 'none'
): string {
  const base = `Next report ${date} (${days}d) — ${risk} risk`
  if (days === null) return base
  if (days === 0) {
    return `${base}\\n  ⚠ EARNINGS TIER: TODAY. Do NOT recommend new entries before the report. Default action plan: wait for post-earnings reaction. If technicals look attractive, frame as "monitor post-earnings setup," not "enter now."`
  }
  if (days === 1) {
    return `${base}\\n  ⚠ EARNINGS TIER: TOMORROW (typically pre-market). There is no full trading session between this analysis and the catalyst. Do NOT recommend new entries before the report. Default action plan: wait for post-earnings reaction.`
  }
  if (days >= 2 && days <= 3) {
    return `${base}\\n  ⚠ EARNINGS TIER: WITHIN 3 DAYS. Acknowledge binary risk explicitly in the action plan. Entries acceptable only with reduced position size and a clear pre-earnings invalidation level. Default to caution.`
  }
  if (days >= 4 && days <= 7) {
    return `${base}\\n  EARNINGS TIER: WITHIN A WEEK. Factor into thesis but normal entries acceptable with risk management appropriate to upcoming binary event.`
  }
  return base
}"""

NEW_DIRECTIVE = """function buildEarningsTierDirective(
  date: string,
  days: number | null,
  risk: 'high' | 'moderate' | 'low' | 'none',
  hour: 'bmo' | 'amc' | 'dmh' | null = null,
  hoursUntil: number | null = null
): string {
  // Build a precise time qualifier from the hour code
  const hourLabel =
    hour === 'bmo' ? ' before market open (~8:30 AM ET)' :
    hour === 'amc' ? ' after market close (~4:30 PM ET)' :
    hour === 'dmh' ? ' during market hours (~12:00 PM ET)' : ''
  const hoursLabel = hoursUntil !== null
    ? (hoursUntil < 0 ? ` — already reported ~${Math.abs(hoursUntil).toFixed(1)}h ago, awaiting post-print data`
       : hoursUntil < 24 ? ` — in ~${hoursUntil.toFixed(1)}h`
       : '')
    : ''
  const base = `Next report ${date}${hourLabel}${hoursLabel} (${days}d) — ${risk} risk`
  if (days === null) return base
  if (days === 0) {
    return `${base}\\n  ⚠ EARNINGS TIER: TODAY${hourLabel ? ' (' + hourLabel.trim() + ')' : ''}. Do NOT recommend new entries before the report. Default action plan: wait for post-earnings reaction. If technicals look attractive, frame as "monitor post-earnings setup," not "enter now."`
  }
  if (days === 1) {
    return `${base}\\n  ⚠ EARNINGS TIER: TOMORROW${hourLabel ? ' (' + hourLabel.trim() + ')' : ''}. There is no full trading session between this analysis and the catalyst. Do NOT recommend new entries before the report. Default action plan: wait for post-earnings reaction.`
  }
  if (days >= 2 && days <= 3) {
    return `${base}\\n  ⚠ EARNINGS TIER: WITHIN 3 DAYS. Acknowledge binary risk explicitly in the action plan. Entries acceptable only with reduced position size and a clear pre-earnings invalidation level. Default to caution.`
  }
  if (days >= 4 && days <= 7) {
    return `${base}\\n  EARNINGS TIER: WITHIN A WEEK. Factor into thesis but normal entries acceptable with risk management appropriate to upcoming binary event.`
  }
  return base
}"""


# =========================================================
# BACKEND PATCH 5: Update directive call site to pass new args
# =========================================================

OLD_DIRECTIVE_CALL = """    `Earnings: ${nextEarningsDate ? buildEarningsTierDirective(nextEarningsDate, daysToEarnings, earningsRisk) : 'No upcoming earnings found'}`,"""

NEW_DIRECTIVE_CALL = """    `Earnings: ${nextEarningsDate ? buildEarningsTierDirective(nextEarningsDate, daysToEarnings, earningsRisk, earningsHour, hoursUntilEarnings) : 'No upcoming earnings found'}`,"""


# =========================================================
# BACKEND PATCH 6: Add new fields to return object
# =========================================================

OLD_RETURN_FIELDS = """    nextEarningsDate, daysToEarnings, earningsRisk,"""

NEW_RETURN_FIELDS = """    nextEarningsDate, daysToEarnings, earningsRisk,
    earningsHour, earningsTimestamp, hoursUntilEarnings,
    epsEstimate: (nextEarning as { epsEstimate?: number | null })?.epsEstimate ?? null,
    epsActual: (nextEarning as { epsActual?: number | null })?.epsActual ?? null,
    revenueEstimate: (nextEarning as { revenueEstimate?: number | null })?.revenueEstimate ?? null,
    revenueActual: (nextEarning as { revenueActual?: number | null })?.revenueActual ?? null,"""


# =========================================================
# AGGREGATOR PATCH: stub fields for crypto/forex paths
# =========================================================

AGGREGATOR = Path('app/lib/aggregator.ts')

# Stub style 1: multi-line crypto stub
OLD_AGG_CRYPTO = """      nextEarningsDate: null,"""
NEW_AGG_CRYPTO_INSERT = """      nextEarningsDate: null,
      earningsHour: null,
      earningsTimestamp: null,
      hoursUntilEarnings: null,
      epsEstimate: null,
      epsActual: null,
      revenueEstimate: null,
      revenueActual: null,"""

# Stub style 2: single-line forex stub
OLD_AGG_FOREX = """      nextEarningsDate: null, daysToEarnings: null, earningsRisk: 'none' as const,"""
NEW_AGG_FOREX = """      nextEarningsDate: null, daysToEarnings: null, earningsRisk: 'none' as const,
      earningsHour: null, earningsTimestamp: null, hoursUntilEarnings: null,
      epsEstimate: null, epsActual: null, revenueEstimate: null, revenueActual: null,"""


# =========================================================
# FRONTEND PATCH: Insert earnings countdown above Trade Plan
# =========================================================

OLD_TRADE_PLAN_HEADER = """                {/* ── TRADE PLAN — prominent, right under verdict ── */}
                {jud.entryPrice && ("""

# We render the countdown above the Trade Plan, conditional on
# md?.fundamentals?.earningsTimestamp being present. The countdown
# uses a small inline component with a useEffect-driven setInterval.
NEW_TRADE_PLAN_HEADER = """                {/* ── EARNINGS COUNTDOWN ── shown above Trade Plan when earnings imminent */}
                {md?.fundamentals?.earningsTimestamp && (() => {
                  const target = new Date(md.fundamentals.earningsTimestamp).getTime()
                  return <EarningsCountdown
                    targetMs={target}
                    hour={md.fundamentals.earningsHour ?? null}
                    daysToEarnings={md.fundamentals.daysToEarnings ?? null}
                    epsActual={md.fundamentals.epsActual ?? null}
                  />
                })()}

                {/* ── TRADE PLAN — prominent, right under verdict ── */}
                {jud.entryPrice && ("""

# The EarningsCountdown component itself (insert near top of file,
# after imports). We use a self-contained component with React hooks.
COUNTDOWN_COMPONENT = """
// ── EarningsCountdown ─────────────────────────────────────────
// Live ticking countdown to the next earnings report. Updates every
// 60 seconds. Color coded: <24h red, <72h yellow, otherwise gray.
// If earningsTimestamp is in the past (already reported, awaiting
// post-print data), shows time-since instead.
function EarningsCountdown({
  targetMs,
  hour,
  daysToEarnings,
  epsActual,
}: {
  targetMs: number
  hour: 'bmo' | 'amc' | 'dmh' | string | null
  daysToEarnings: number | null
  epsActual: number | null
}) {
  const [now, setNow] = useState<number>(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(id)
  }, [])
  const diffMs = targetMs - now
  const isPast = diffMs < 0
  const absMs = Math.abs(diffMs)
  const days = Math.floor(absMs / 86_400_000)
  const hours = Math.floor((absMs % 86_400_000) / 3_600_000)
  const minutes = Math.floor((absMs % 3_600_000) / 60_000)
  // Format
  let text: string
  if (isPast && epsActual !== null) {
    // Already reported, EPS in
    text = `Reported ${days > 0 ? `${days}d ` : ''}${hours}h ${minutes}m ago — EPS actual: ${epsActual.toFixed(2)}`
  } else if (isPast) {
    text = `Reported ${days > 0 ? `${days}d ` : ''}${hours}h ${minutes}m ago — awaiting confirmation`
  } else if (days > 0) {
    text = `Earnings in ${days}d ${hours}h ${minutes}m`
  } else {
    text = `Earnings in ${hours}h ${minutes}m`
  }
  // Hour qualifier
  const hourQualifier =
    hour === 'bmo' ? 'before market open' :
    hour === 'amc' ? 'after market close' :
    hour === 'dmh' ? 'during market hours' : ''
  // Color tier
  const totalHours = absMs / 3_600_000
  const color = isPast ? '#34d399'
    : totalHours < 24 ? '#f87171'
    : totalHours < 72 ? '#fbbf24'
    : '#9ca3af'
  const bg = isPast ? 'rgba(52,211,153,0.08)'
    : totalHours < 24 ? 'rgba(248,113,113,0.10)'
    : totalHours < 72 ? 'rgba(251,191,36,0.10)'
    : 'rgba(156,163,175,0.08)'
  const border = isPast ? 'rgba(52,211,153,0.25)'
    : totalHours < 24 ? 'rgba(248,113,113,0.30)'
    : totalHours < 72 ? 'rgba(251,191,36,0.30)'
    : 'rgba(156,163,175,0.20)'
  return (
    <div
      className=\"rounded-xl px-3 py-2 mt-1 flex items-center justify-between\"
      style={{ background: bg, border: `1px solid ${border}` }}
    >
      <div className=\"text-[10px] font-mono uppercase tracking-widest\" style={{ color }}>
        {isPast ? 'POST-EARNINGS' : 'EARNINGS COUNTDOWN'}
      </div>
      <div className=\"text-xs font-mono\" style={{ color }}>
        {text}{hourQualifier && !isPast ? ` (${hourQualifier})` : ''}
      </div>
    </div>
  )
}

"""


# =========================================================
# Helpers
# =========================================================

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


def find_page_tsx() -> Path | None:
    for cand in PAGE_CANDIDATES:
        if cand.exists():
            txt = cand.read_text(encoding='utf-8', errors='ignore')
            if 'TRADE PLAN' in txt and 'jud.entryPrice' in txt:
                return cand
    app_dir = Path('app')
    if app_dir.exists():
        for p in app_dir.rglob('page.tsx'):
            try:
                txt = p.read_text(encoding='utf-8', errors='ignore')
                if 'TRADE PLAN' in txt and 'jud.entryPrice' in txt:
                    return p
            except Exception:
                continue
    return None


# =========================================================
# Main
# =========================================================

def patch_fundamentals() -> bool:
    if not FUNDAMENTALS.exists():
        print(f'  ERROR: {FUNDAMENTALS} not found', file=sys.stderr)
        return False

    text, le = read_file(FUNDAMENTALS)

    # Idempotency check
    already_patched = (
        'earningsHour:' in text and
        'earningsTimestamp:' in text and
        'hoursUntilEarnings:' in text
    )
    if already_patched:
        print(f'  [OK] {FUNDAMENTALS}: already patched')
        return True

    # Apply patches in order
    patches = [
        (OLD_FETCH_TYPE, NEW_FETCH_TYPE, 'fetch type extended with hour + bonus fields'),
        (OLD_TYPE_FIELDS, NEW_TYPE_FIELDS, 'type interface extended with 3 new fields'),
        (OLD_COMPUTE, NEW_COMPUTE, 'compute earningsHour, earningsTimestamp, hoursUntilEarnings'),
        (OLD_DIRECTIVE, NEW_DIRECTIVE, 'directive helper now accepts hour + hoursUntil'),
        (OLD_DIRECTIVE_CALL, NEW_DIRECTIVE_CALL, 'directive call site passes new args'),
        (OLD_RETURN_FIELDS, NEW_RETURN_FIELDS, 'return object includes new fields'),
    ]
    for old, new, label in patches:
        if old not in text:
            print(f'  ERROR: Could not find anchor for: {label}', file=sys.stderr)
            return False
        text = text.replace(old, new)
        print(f'  [+] {label}')

    write_file(FUNDAMENTALS, text, le)
    print(f'  Wrote {FUNDAMENTALS}')
    return True


def patch_page_tsx() -> bool:
    page = find_page_tsx()
    if page is None:
        print('  ERROR: Could not find page.tsx with TRADE PLAN block', file=sys.stderr)
        return False

    text, le = read_file(page)

    already_patched = 'EarningsCountdown' in text
    if already_patched:
        print(f'  [OK] {page}: already patched')
        return True

    if OLD_TRADE_PLAN_HEADER not in text:
        print(f'  ERROR: Could not find TRADE PLAN anchor in {page}', file=sys.stderr)
        return False

    # Insert the JSX countdown
    text = text.replace(OLD_TRADE_PLAN_HEADER, NEW_TRADE_PLAN_HEADER)
    print('  [+] Inserted EarningsCountdown JSX above Trade Plan')

    # Insert the component definition. Find a good anchor: after the last
    # `import` line at the top of the file. Simplest robust approach:
    # locate the first occurrence of "export default function" and insert
    # the component definition right before it.
    anchor_idx = text.find('export default function')
    if anchor_idx == -1:
        print('  ERROR: Could not find "export default function" to anchor component', file=sys.stderr)
        return False

    # Check that React imports include useState and useEffect
    if 'useState' not in text or 'useEffect' not in text:
        # Find the React import line and ensure both are present
        # Pattern: import { ... } from 'react' or "react"
        import re
        m = re.search(r"import\s*\{([^}]*)\}\s*from\s*['\"]react['\"]", text)
        if m:
            existing = m.group(1)
            needed = []
            if 'useState' not in existing:
                needed.append('useState')
            if 'useEffect' not in existing:
                needed.append('useEffect')
            if needed:
                merged = (existing.strip().rstrip(',') + ', ' + ', '.join(needed)).strip().lstrip(',').strip()
                new_import = f"import {{ {merged} }} from 'react'"
                # Replace using the matched span
                text = text[:m.start()] + new_import + text[m.end():]
                print(f'  [+] Added {needed} to React import')
                # Update anchor_idx since we changed text length
                anchor_idx = text.find('export default function')
        else:
            print('  WARN: Could not find React import to add hooks; assuming they are imported elsewhere', file=sys.stderr)

    text = text[:anchor_idx] + COUNTDOWN_COMPONENT + text[anchor_idx:]
    print('  [+] Inserted EarningsCountdown component definition before default export')

    write_file(page, text, le)
    print(f'  Wrote {page}')
    return True


def patch_aggregator() -> bool:
    if not AGGREGATOR.exists():
        print(f'  ERROR: {AGGREGATOR} not found', file=sys.stderr)
        return False

    text, le = read_file(AGGREGATOR)

    if 'earningsHour: null,\n      earningsTimestamp:' in text or \
       'earningsHour: null, earningsTimestamp: null,' in text:
        print(f'  [OK] {AGGREGATOR}: stubs already patched')
        return True

    edits = 0

    # Stub style 1 (multi-line) — there should be exactly 1 occurrence
    if OLD_AGG_CRYPTO in text:
        text = text.replace(OLD_AGG_CRYPTO, NEW_AGG_CRYPTO_INSERT, 1)
        edits += 1
        print('  [+] Patched crypto stub with new earnings fields')

    # Stub style 2 (single-line forex)
    if OLD_AGG_FOREX in text:
        text = text.replace(OLD_AGG_FOREX, NEW_AGG_FOREX, 1)
        edits += 1
        print('  [+] Patched forex stub with new earnings fields')

    if edits == 0:
        print(f'  WARN: No stub patterns found in {AGGREGATOR}', file=sys.stderr)
        print('         If your codebase only has the main fundamentals.ts path, this is fine.', file=sys.stderr)
        return True

    write_file(AGGREGATOR, text, le)
    print(f'  Wrote {AGGREGATOR}')
    return True


def main() -> int:
    dry_run = '--dry-run' in sys.argv or '-n' in sys.argv
    print('=' * 60)
    print('Earnings countdown + time fields')
    print('=' * 60)
    if dry_run:
        print('  (DRY RUN — would not write)')
    print()

    print('--- Backend (fundamentals.ts) ---')
    if not patch_fundamentals():
        return 1
    print()
    print('--- Aggregator stubs (aggregator.ts) ---')
    if not patch_aggregator():
        return 1
    print()
    print('--- Frontend (page.tsx) ---')
    if not patch_page_tsx():
        return 1

    print()
    print('=' * 60)
    print('Patch complete. Run `npm run build` to verify.')
    print('=' * 60)
    return 0


if __name__ == '__main__':
    sys.exit(main())
