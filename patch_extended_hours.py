#!/usr/bin/env python3
"""
patch_extended_hours.py

Adds extended-hours awareness (after-hours + pre-market) to the
analysis pipeline. Currently the system uses Finnhub /quote.c which
is regular-session only (verified: timestamp t = 16:00 ET regardless
of when called). After 4 PM ET, evening analyses anchor on the 4 PM
close even when the stock has moved significantly.

Fix uses Alpaca /v2/stocks/{ticker}/trades/latest with feed=sip
which returns the most recent trade across all sessions.

Files modified by this patch (backend only):
  - app/lib/data/alpaca.ts      → add fetchTradeLatest helper
  - app/lib/aggregator.ts       → fetch + populate, add to bundle

API route mapping + UI display are in patch_extended_hours_ui.py
(separate so each can be deployed/rolled back independently).
"""

from __future__ import annotations
import sys
import re
from pathlib import Path

ALPACA = Path('app/lib/data/alpaca.ts')
AGGREGATOR = Path('app/lib/aggregator.ts')


# =========================================================
# alpaca.ts: add fetchTradeLatest helper
# =========================================================

ALPACA_OLD = """// ── Latest Quote ───────────────────────────────────────────────
export async function fetchQuote(ticker: string): Promise<AlpacaQuote | null> {
  try {
    const res = await fetch(
      `${BASE}/v2/stocks/${ticker}/quotes/latest?feed=sip`,
      { headers: alpacaHeaders(), next: { revalidate: 60 } }
    )
    if (!res.ok) return null
    const data = await res.json()
    return data.quote as AlpacaQuote
  } catch {
    return null
  }
}"""

ALPACA_NEW = """// ── Latest Quote ───────────────────────────────────────────────
export async function fetchQuote(ticker: string): Promise<AlpacaQuote | null> {
  try {
    const res = await fetch(
      `${BASE}/v2/stocks/${ticker}/quotes/latest?feed=sip`,
      { headers: alpacaHeaders(), next: { revalidate: 60 } }
    )
    if (!res.ok) return null
    const data = await res.json()
    return data.quote as AlpacaQuote
  } catch {
    return null
  }
}

// ── Latest Trade (extended-hours aware) ────────────────────────
// Unlike Finnhub's /quote endpoint, this returns the most recent
// trade across all sessions (regular + pre-market + after-hours).
// SIP feed for SIP-eligible securities; falls back to IEX.
export interface AlpacaTrade {
  p: number     // trade price
  s: number     // size
  t: string     // ISO timestamp
  x: string     // exchange code
  c?: string[]  // condition codes
}

export async function fetchTradeLatest(ticker: string): Promise<AlpacaTrade | null> {
  try {
    const url = `${BASE}/v2/stocks/${ticker}/trades/latest?feed=sip`
    const res = await fetch(url, { headers: alpacaHeaders(), next: { revalidate: 30 } })
    if (res.ok) {
      const data = await res.json()
      if (data?.trade?.p) return data.trade as AlpacaTrade
    }
    // Fallback to IEX feed for non-SIP-covered tickers
    const iexUrl = `${BASE}/v2/stocks/${ticker}/trades/latest?feed=iex`
    const iexRes = await fetch(iexUrl, { headers: alpacaHeaders(), next: { revalidate: 30 } })
    if (!iexRes.ok) return null
    const iexData = await iexRes.json()
    return (iexData?.trade as AlpacaTrade) ?? null
  } catch {
    return null
  }
}"""


# =========================================================
# aggregator.ts: SignalBundle type extension
# =========================================================

AGG_TYPE_OLD = """  bars: Array<{ t: string; o: number; h: number; l: number; c: number; v: number }>
  news: Array<{ headline: string; summary: string; created_at: string; url: string }>
  currentPrice: number"""

AGG_TYPE_NEW = """  bars: Array<{ t: string; o: number; h: number; l: number; c: number; v: number }>
  news: Array<{ headline: string; summary: string; created_at: string; url: string }>
  currentPrice: number

  // Extended-hours context (after-hours / pre-market / weekends).
  // For crypto/forex these are stubbed with session='closed' and
  // null extendedPrice (no extended hours concept).
  extendedHours: {
    session: 'regular' | 'pre-market' | 'after-hours' | 'closed'
    regularClose: number              // last 4 PM ET regular close
    extendedPrice: number | null      // latest extended-session trade
    extendedChangePct: number | null  // vs regularClose
    extendedAsOf: string | null       // ISO timestamp of latest extended trade
  }"""


# =========================================================
# aggregator.ts: import update
# =========================================================

AGG_IMPORT_OLD = "import { fetchNews, fetchBars, formatNewsForAI, formatBarsForAI } from './data/alpaca'"
AGG_IMPORT_NEW = "import { fetchNews, fetchBars, formatNewsForAI, formatBarsForAI, fetchTradeLatest } from './data/alpaca'"


# =========================================================
# aggregator.ts: helper functions
# =========================================================

EXTENDED_HOURS_HELPERS = '''

// ── Extended-hours session detection & data fetch ──────────────
// US equities sessions in ET:
//   Pre-market:   4:00 AM - 9:30 AM
//   Regular:      9:30 AM - 4:00 PM
//   After-hours:  4:00 PM - 8:00 PM
//   Closed:       8:00 PM - 4:00 AM, weekends, holidays
function detectSession(now: Date): 'regular' | 'pre-market' | 'after-hours' | 'closed' {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  })
  const parts = fmt.formatToParts(now)
  const weekday = parts.find(p => p.type === 'weekday')?.value ?? ''
  const hour = parseInt(parts.find(p => p.type === 'hour')?.value ?? '0', 10)
  const minute = parseInt(parts.find(p => p.type === 'minute')?.value ?? '0', 10)
  const minutesIntoDay = hour * 60 + minute

  if (weekday === 'Sat' || weekday === 'Sun') return 'closed'
  if (minutesIntoDay >= 9 * 60 + 30 && minutesIntoDay < 16 * 60) return 'regular'
  if (minutesIntoDay >= 4 * 60 && minutesIntoDay < 9 * 60 + 30) return 'pre-market'
  if (minutesIntoDay >= 16 * 60 && minutesIntoDay < 20 * 60) return 'after-hours'
  return 'closed'
}

async function buildExtendedHoursContext(
  ticker: string,
  regularClose: number,
): Promise<{
  session: 'regular' | 'pre-market' | 'after-hours' | 'closed'
  regularClose: number
  extendedPrice: number | null
  extendedChangePct: number | null
  extendedAsOf: string | null
}> {
  const now = new Date()
  const session = detectSession(now)

  // During regular session, no extended price is meaningful
  if (session === 'regular') {
    return { session, regularClose, extendedPrice: null, extendedChangePct: null, extendedAsOf: null }
  }

  const trade = await fetchTradeLatest(ticker).catch(() => null)
  if (!trade || !trade.p || trade.p <= 0) {
    return { session, regularClose, extendedPrice: null, extendedChangePct: null, extendedAsOf: null }
  }

  // Skip stale prints (>16h old)
  const tradeMs = new Date(trade.t).getTime()
  const ageHours = (now.getTime() - tradeMs) / 3_600_000
  if (ageHours > 16) {
    return { session, regularClose, extendedPrice: null, extendedChangePct: null, extendedAsOf: null }
  }

  // Skip if trade equals regular close (no extended movement)
  const changePct = ((trade.p - regularClose) / regularClose) * 100
  if (Math.abs(changePct) < 0.05) {
    return { session, regularClose, extendedPrice: null, extendedChangePct: null, extendedAsOf: null }
  }

  return {
    session,
    regularClose,
    extendedPrice: trade.p,
    extendedChangePct: Math.round(changePct * 100) / 100,
    extendedAsOf: trade.t,
  }
}

function formatExtendedHoursForPrompt(eh: {
  session: 'regular' | 'pre-market' | 'after-hours' | 'closed'
  regularClose: number
  extendedPrice: number | null
  extendedChangePct: number | null
  extendedAsOf: string | null
}): string {
  if (eh.extendedPrice === null) return ''
  const sessionLabel =
    eh.session === 'after-hours' ? 'AFTER-HOURS' :
    eh.session === 'pre-market' ? 'PRE-MARKET' :
    eh.session === 'closed' ? 'OUTSIDE TRADING HOURS (last extended print)' :
    'REGULAR'
  const sign = (eh.extendedChangePct ?? 0) >= 0 ? '+' : ''
  return `[${sessionLabel}] Last regular close $${eh.regularClose.toFixed(2)} → extended trade $${eh.extendedPrice.toFixed(2)} (${sign}${(eh.extendedChangePct ?? 0).toFixed(2)}% vs close, as of ${eh.extendedAsOf})`
}

'''


# =========================================================
# aggregator.ts: stocks branch quote block update
# =========================================================

AGG_STOCKS_QUOTE_OLD = """  // Use Finnhub for real-time price — much more accurate than last bar close
  let currentPrice = bars.length ? bars[bars.length - 1].c : 0
  try {
    const fhKey = process.env.FINNHUB_API_KEY
    if (fhKey) {
      const quoteRes = await fetch(
        `https://finnhub.io/api/v1/quote?symbol=${sym}&token=${fhKey}`
      )
      if (quoteRes.ok) {
        const q = await quoteRes.json()
        if (q.c && q.c > 0) currentPrice = q.c
      }
    }
  } catch { /* fall back to bar close */ }"""

AGG_STOCKS_QUOTE_NEW = """  // Use Finnhub for real-time regular-session price.
  // NOTE: Finnhub /quote.c is REGULAR-SESSION ONLY (timestamp = 4 PM ET
  // even when called during after-hours). Extended-hours pricing is
  // fetched separately below via Alpaca trades/latest (SIP feed).
  let currentPrice = bars.length ? bars[bars.length - 1].c : 0
  let regularClose = currentPrice
  try {
    const fhKey = process.env.FINNHUB_API_KEY
    if (fhKey) {
      const quoteRes = await fetch(
        `https://finnhub.io/api/v1/quote?symbol=${sym}&token=${fhKey}`
      )
      if (quoteRes.ok) {
        const q = await quoteRes.json()
        if (q.c && q.c > 0) {
          currentPrice = q.c
          regularClose = q.c
        }
      }
    }
  } catch { /* fall back to bar close */ }

  // Fetch extended-hours context (after-hours / pre-market when active)
  const extendedHours = await buildExtendedHoursContext(sym, regularClose)"""


# =========================================================
# aggregator.ts: stocks branch priceSection update
# =========================================================

# This is the priceSection in the stocks branch (after our quote update).
# We want to inject extended-hours info into the prompt template.
AGG_PS_STOCKS_OLD = """  const priceSection = `=== PRICE ACTION ===\\n${formatBarsForAI(bars, timeframe)}`"""

AGG_PS_STOCKS_NEW = """  const ehPromptLine = formatExtendedHoursForPrompt(extendedHours)
  const priceSection = `=== PRICE ACTION ===${ehPromptLine ? '\\n' + ehPromptLine : ''}\\n${formatBarsForAI(bars, timeframe)}`"""


# =========================================================
# aggregator.ts: stocks branch return update (add extendedHours)
# =========================================================

# Shape we expect: `bars, news, currentPrice,`
# In the stocks branch return, add extendedHours after currentPrice.
AGG_STOCKS_RETURN_OLD = "bars, news, currentPrice,"
AGG_STOCKS_RETURN_NEW = "bars, news, currentPrice, extendedHours,"


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


def patch_alpaca() -> bool:
    if not ALPACA.exists():
        print(f'  ERROR: {ALPACA} not found', file=sys.stderr)
        return False

    text, le = read_file(ALPACA)

    if 'fetchTradeLatest' in text:
        print(f'  [OK] {ALPACA}: fetchTradeLatest already present')
        return True

    if ALPACA_OLD not in text:
        print(f'  ERROR: Could not find fetchQuote anchor in {ALPACA}', file=sys.stderr)
        return False

    text = text.replace(ALPACA_OLD, ALPACA_NEW, 1)
    write_file(ALPACA, text, le)
    print(f'  [+] {ALPACA}: added fetchTradeLatest helper + AlpacaTrade interface')
    return True


def patch_aggregator() -> bool:
    if not AGGREGATOR.exists():
        print(f'  ERROR: {AGGREGATOR} not found', file=sys.stderr)
        return False

    text, le = read_file(AGGREGATOR)
    edits = 0
    skipped = 0

    # 1. Type extension
    if 'extendedHours: {' in text:
        skipped += 1
        print('  [OK] SignalBundle.extendedHours type already present')
    elif AGG_TYPE_OLD in text:
        text = text.replace(AGG_TYPE_OLD, AGG_TYPE_NEW, 1)
        edits += 1
        print('  [+] Added extendedHours field to SignalBundle type')
    else:
        print('  ERROR: Could not find SignalBundle anchor', file=sys.stderr)
        return False

    # 2. Import fetchTradeLatest
    if 'fetchTradeLatest' in text:
        skipped += 1
        print('  [OK] fetchTradeLatest already imported')
    elif AGG_IMPORT_OLD in text:
        text = text.replace(AGG_IMPORT_OLD, AGG_IMPORT_NEW, 1)
        edits += 1
        print('  [+] Imported fetchTradeLatest from alpaca client')
    else:
        print('  ERROR: Could not find Alpaca import line', file=sys.stderr)
        return False

    # 3. Helpers
    if 'function detectSession(' in text:
        skipped += 1
        print('  [OK] Helpers already in place')
    else:
        anchor = "import { getMonitorAlerts } from './market-monitor'"
        if anchor not in text:
            print('  ERROR: Could not find import anchor for helpers', file=sys.stderr)
            return False
        text = text.replace(anchor, anchor + EXTENDED_HOURS_HELPERS, 1)
        edits += 1
        print('  [+] Added detectSession + buildExtendedHoursContext + formatExtendedHoursForPrompt')

    # 4. Stocks branch quote block update
    if 'buildExtendedHoursContext(sym, regularClose)' in text:
        skipped += 1
        print('  [OK] Stocks-branch quote block already updated')
    elif AGG_STOCKS_QUOTE_OLD in text:
        text = text.replace(AGG_STOCKS_QUOTE_OLD, AGG_STOCKS_QUOTE_NEW, 1)
        edits += 1
        print('  [+] Stocks branch: added regularClose + extendedHours fetch')
    else:
        print('  ERROR: Could not find stocks-branch quote block', file=sys.stderr)
        return False

    # 5. Stocks branch priceSection update
    if 'formatExtendedHoursForPrompt(extendedHours)' in text:
        skipped += 1
        print('  [OK] Stocks-branch priceSection already updated')
    else:
        # We need to patch only the priceSection in the stocks branch.
        # Find the priceSection that comes AFTER our extendedHours fetch.
        anchor_idx = text.find('buildExtendedHoursContext(sym, regularClose)')
        if anchor_idx == -1:
            print('  WARN: Could not find anchor for priceSection patch', file=sys.stderr)
        else:
            # Search from anchor forward for the priceSection line
            search_text = text[anchor_idx:]
            # Match this exact pattern (one line):
            # Allow for either `bars` or `validatedBars` as the variable
            ps_pattern = re.compile(
                r'  const priceSection = `=== PRICE ACTION ===\\n\$\{formatBarsForAI\((\w+),\s*(\w+)\)\}`'
            )
            m = ps_pattern.search(search_text)
            if not m:
                print('  WARN: Stocks-branch priceSection not found in expected shape', file=sys.stderr)
            else:
                bars_var = m.group(1)
                tf_var = m.group(2)
                replacement = (
                    "  const ehPromptLine = formatExtendedHoursForPrompt(extendedHours)\n"
                    "  const priceSection = `=== PRICE ACTION ===${ehPromptLine ? '\\n' + ehPromptLine : ''}\\n${formatBarsForAI("
                    + bars_var + ", " + tf_var + ")}`"
                )
                replace_start = anchor_idx + m.start()
                replace_end = anchor_idx + m.end()
                text = text[:replace_start] + replacement + text[replace_end:]
                edits += 1
                print(f'  [+] Stocks branch: priceSection now includes extended-hours line (vars: {bars_var}, {tf_var})')

    # 6. Stocks branch return: add extendedHours to bundle
    # The return statement uses `bars, news, currentPrice,` exactly once
    # in the stocks branch. We patch only the FIRST occurrence after our
    # extended-hours fetch.
    if 'currentPrice, extendedHours,' in text:
        skipped += 1
        print('  [OK] Stocks-branch return already includes extendedHours')
    else:
        anchor_idx = text.find('buildExtendedHoursContext(sym, regularClose)')
        if anchor_idx != -1:
            ret_idx = text.find(AGG_STOCKS_RETURN_OLD, anchor_idx)
            if ret_idx != -1:
                text = text[:ret_idx] + AGG_STOCKS_RETURN_NEW + text[ret_idx + len(AGG_STOCKS_RETURN_OLD):]
                edits += 1
                print('  [+] Stocks branch: bundle return includes extendedHours')
            else:
                print('  WARN: Could not find return-fields anchor in stocks branch', file=sys.stderr)

    # 7. Crypto and forex stubs.
    # These branches don't have the `extendedHours` variable in scope,
    # so we use literal stub objects.
    crypto_old = "bars: validatedBars, news, currentPrice,"
    crypto_new = (
        "bars: validatedBars, news, currentPrice,\n"
        "      extendedHours: {\n"
        "        session: 'closed' as const,\n"
        "        regularClose: currentPrice,\n"
        "        extendedPrice: null,\n"
        "        extendedChangePct: null,\n"
        "        extendedAsOf: null,\n"
        "      },"
    )
    # Idempotency: only patch if NOT already followed by extendedHours
    crypto_idx = text.find(crypto_old)
    if crypto_idx != -1:
        # Check what comes immediately after the anchor
        after = text[crypto_idx + len(crypto_old):crypto_idx + len(crypto_old) + 50]
        if 'extendedHours' not in after:
            text = text.replace(crypto_old, crypto_new, 1)
            edits += 1
            print('  [+] Crypto branch: added extendedHours stub')
        else:
            print('  [OK] Crypto branch: already has extendedHours stub')

    forex_old = """      bars, news, currentPrice,
      technicals, marketContext,"""
    forex_new = """      bars, news, currentPrice,
      extendedHours: {
        session: 'closed' as const,
        regularClose: currentPrice,
        extendedPrice: null,
        extendedChangePct: null,
        extendedAsOf: null,
      },
      technicals, marketContext,"""
    forex_idx = text.find(forex_old)
    if forex_idx != -1:
        # Check the 50 chars after forex anchor for extendedHours
        # (it would only be there if already patched — the anchor doesn't include it)
        # Actually our forex_old anchor includes "technicals, marketContext," which
        # follows extendedHours in the patched form. So presence of forex_old
        # itself means NOT patched.
        text = text.replace(forex_old, forex_new, 1)
        edits += 1
        print('  [+] Forex branch: added extendedHours stub')

    if edits == 0 and skipped > 0:
        print(f'  [OK] {AGGREGATOR}: all extended-hours patches already applied')
        return True

    write_file(AGGREGATOR, text, le)
    return True


def main() -> int:
    print('=' * 60)
    print('Extended-hours data feature (after-hours + pre-market)')
    print('=' * 60)
    print()
    print('--- alpaca.ts ---')
    if not patch_alpaca():
        return 1
    print()
    print('--- aggregator.ts ---')
    if not patch_aggregator():
        return 1
    print()
    print('=' * 60)
    print('Backend complete. Run `npm run build` to verify.')
    print('Note: API route mapping + UI display are NOT done by this script.')
    print('Those will be in patch_extended_hours_ui.py once backend is verified.')
    print('=' * 60)
    return 0


if __name__ == '__main__':
    sys.exit(main())
