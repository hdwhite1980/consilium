// ─────────────────────────────────────────────────────────────
// PHASE 3 — SEC EDGAR Smart Money
// Completely free, no API key required
// Form 4 = insider transactions (execs/directors buying/selling)
// 13F  = institutional holdings (hedge funds, mutual funds)
// ─────────────────────────────────────────────────────────────

const EDGAR_BASE = 'https://efts.sec.gov'
const EDGAR_DATA = 'https://data.sec.gov'

export interface SmartMoneySignals {
  // Form 4 — Insider transactions (last 90 days)
  insiderTransactions: InsiderTransaction[]
  insiderNetValue: number       // net $ bought (positive) or sold (negative)
  insiderSignal: 'strong_buy' | 'buy' | 'neutral' | 'sell' | 'strong_sell'
  insiderHighlight: string      // most notable transaction

  // 13F — Institutional ownership
  institutionalOwnership: InstitutionalHolder[]
  totalInstitutionalPct: number // % of float held by institutions
  institutionalNetChange: string // 'increasing' | 'decreasing' | 'stable'
  notableHolders: string[]       // famous funds holding this stock

  // Congressional trades
  congressionalTrades: CongressionalTrade[]
  congressSignal: 'buying' | 'selling' | 'none'

  // Summary for AI
  summary: string
}

export interface InsiderTransaction {
  name: string
  title: string
  type: 'buy' | 'sell'
  shares: number
  pricePerShare: number
  totalValue: number
  date: string
}

export interface InstitutionalHolder {
  name: string
  sharesHeld: number
  changeInShares: number   // positive = added, negative = reduced
  changeType: 'new' | 'added' | 'reduced' | 'sold' | 'unchanged'
  pctOfPortfolio: number
}

export interface CongressionalTrade {
  member: string
  chamber: 'senate' | 'house'
  type: 'purchase' | 'sale'
  amount: string  // range like "$1,001-$15,000"
  date: string
}

// ── Congressional trades via Finnhub ──────────────────────────
async function fetchCongressionalTrades(ticker: string): Promise<CongressionalTrade[]> {
  const key = process.env.FINNHUB_API_KEY
  if (!key) return []
  try {
    const from = new Date(Date.now() - 365 * 86400000).toISOString().split('T')[0]
    const to   = new Date().toISOString().split('T')[0]
    const res = await fetch(
      `https://finnhub.io/api/v1/stock/congressional-trading?symbol=${ticker}&from=${from}&to=${to}&token=${key}`,
      { next: { revalidate: 86400 } }
    )
    if (!res.ok) return []
    const data = await res.json()
    const trades: Array<Record<string, unknown>> = data?.data ?? []
    return trades.slice(0, 10).map(t => ({
      member:   String(t.name ?? 'Unknown'),
      chamber:  String(t.chamber ?? '').toLowerCase().includes('senate') ? 'senate' as const : 'house' as const,
      type:     String(t.transactionType ?? '').toLowerCase().includes('purchase') ? 'purchase' as const : 'sale' as const,
      amount:   String(t.amount ?? t.transactionAmount ?? 'undisclosed'),
      date:     String(t.transactionDate ?? t.reportDate ?? ''),
    }))
  } catch {
    return []
  }
}

// ── EDGAR-sourced insider transactions (Form 4, via sec-filings.ts) ──
// Replaces the previous Finnhub /stock/insider-transactions path which
// returned phantom rows EDGAR didn't have (e.g., NRG 2026-03-04 included
// two 14.3M-share entries totaling $4.69B not present in EDGAR Form 4
// filings). Reads from the insider_transactions table that's populated
// by fetchInsiderTransactions in sec-filings.ts.
async function fetchInsiderTransactions(ticker: string): Promise<InsiderTransaction[]> {
  try {
    const { getInsiderActivity } = await import('@/app/lib/data/sec-filings')
    const rows = await getInsiderActivity(ticker, 90)
    return rows
      .filter((r: { transaction_type?: string }) => {
        const code = String(r.transaction_type ?? '').trim().toUpperCase()
        return code === 'P' || code === 'S'
      })
      .slice(0, 15)
      .map((r: {
        insider_name?: string
        title?: string
        transaction_type?: string
        shares?: number
        price_per_share?: number
        total_value?: number
        transaction_date?: string
      }) => {
        const code = String(r.transaction_type ?? '').trim().toUpperCase()
        return {
          name:           String(r.insider_name ?? 'Insider'),
          title:          String(r.title ?? 'Executive'),
          type:           (code === 'P' ? 'buy' : 'sell') as 'buy' | 'sell',
          shares:         Number(r.shares) || 0,
          pricePerShare:  Number(r.price_per_share) || 0,
          totalValue:     Number(r.total_value) || 0,
          date:           String(r.transaction_date ?? ''),
        }
      })
      .filter(t => t.shares > 0 && t.totalValue > 0)
  } catch {
    return []
  }
}

// ── EDGAR-sourced institutional ownership (13F, via institutional_holdings table) ──
// Replaces the previous Finnhub /stock/institutional-ownership path which
// silently returned [] for most tickers (either Finnhub free-tier doesn't
// include the endpoint, or the call was failing without visible logs).
//
// Reads from the institutional_holdings table populated by EDGAR 13F-HR
// ingestion. Same Bug-5 lesson: when both Finnhub and EDGAR cover the same
// data category, EDGAR is the source of truth (real filings with accession
// numbers; Finnhub's institutional endpoint requires paid tier and has
// been returning empty in production).
//
// Data freshness note: 13F filings are inherently quarterly. Latest data
// available anywhere right now is Q1 2026 (filings due May 15, 2026).
// Our ingestion ran 2026-04-18, so we capture most early/on-time filers
// but may be missing late filers from April 19 – May 15. This is still
// dramatically better than empty arrays leading to LLM hallucination.
async function fetchInstitutionalHoldings(ticker: string): Promise<InstitutionalHolder[]> {
  try {
    const { createClient } = await import('@supabase/supabase-js')
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (!url || !key) {
      console.warn(`[institutional ${ticker}] Supabase env not set — returning empty`)
      return []
    }
    const supabase = createClient(url, key)

    // Find the most recent quarter we have data for THIS ticker.
    // We do this in two steps because Supabase JS doesn't have a clean
    // "select where quarter = (select max(quarter) ...)" shape.
    const { data: latestRow, error: maxErr } = await supabase
      .from('institutional_holdings')
      .select('quarter')
      .eq('ticker', ticker)
      .order('quarter', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (maxErr) {
      console.warn(`[institutional ${ticker}] quarter probe failed: ${maxErr.message}`)
      return []
    }
    if (!latestRow?.quarter) {
      // No 13F data for this ticker — common for small caps, ETFs,
      // foreign tickers. Returning empty is the honest answer.
      return []
    }

    // Pull the top holders for that quarter, ordered by share count desc.
    // 10 is generous — the bundle's notableHolders/summary use top 3-5.
    const { data: rows, error: rowsErr } = await supabase
      .from('institutional_holdings')
      .select('institution, shares_held, change_shares, pct_of_portfolio, action, quarter, filing_date')
      .eq('ticker', ticker)
      .eq('quarter', latestRow.quarter)
      .order('shares_held', { ascending: false })
      .limit(10)

    if (rowsErr || !rows) {
      console.warn(`[institutional ${ticker}] holders query failed: ${rowsErr?.message ?? 'no rows'}`)
      return []
    }

    return rows
      .map(r => {
        const action = String(r.action ?? '').toLowerCase()
        const sharesHeld = Number(r.shares_held) || 0

        // change_shares is often null in our ingestion. For 'new' positions,
        // the entire holding is the change (went from 0 to sharesHeld).
        // For other actions where the delta isn't recorded, fall back to 0
        // — better to show "unchanged" than a misleading number.
        let changeInShares = Number(r.change_shares) || 0
        if (changeInShares === 0 && action === 'new') {
          changeInShares = sharesHeld
        }

        // Map action enum to changeType. Tolerate unexpected values.
        const changeType: InstitutionalHolder['changeType'] =
          action === 'new' ? 'new' :
          action === 'added' ? 'added' :
          action === 'reduced' ? 'reduced' :
          action === 'sold' ? 'sold' :
          'unchanged'

        return {
          name:           String(r.institution ?? 'Institution'),
          sharesHeld,
          changeInShares,
          changeType,
          pctOfPortfolio: Number(r.pct_of_portfolio) || 0,
        }
      })
      .filter(h => h.sharesHeld > 0)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    console.warn(`[institutional ${ticker}] unexpected error: ${msg.slice(0, 200)}`)
    return []
  }
}

// ── DEPRECATED: Finnhub institutional ownership (kept for rollback reference)
// Switched to EDGAR-table read above (May 2026, Bug 28). Finnhub's
// /stock/institutional-ownership endpoint is paid-tier and was returning
// empty silently. To re-enable: rename this function to remove _DEPRECATED
// suffix and remove the EDGAR-table version above.
// async function fetchInstitutionalHoldings_DEPRECATED(ticker: string): Promise<InstitutionalHolder[]> {
//   const key = process.env.FINNHUB_API_KEY
//   if (!key) return []
//   try {
//     const res = await fetch(
//       `https://finnhub.io/api/v1/stock/institutional-ownership?symbol=${ticker}&token=${key}`,
//       { next: { revalidate: 86400 } }
//     )
//     if (!res.ok) return []
//     const data = await res.json()
//     const holders: Array<Record<string, unknown>> = data?.ownership ?? []
//     return holders
//       .sort((a, b) => Number(b.share ?? 0) - Number(a.share ?? 0))
//       .slice(0, 5)
//       .map(h => {
//         const change = Number(h.change ?? 0)
//         const changeType: InstitutionalHolder['changeType'] =
//           change > 0 ? 'added' : change < 0 ? 'reduced' : 'unchanged'
//         return {
//           name:           String(h.name ?? 'Institution'),
//           sharesHeld:     Number(h.share ?? 0),
//           changeInShares: change,
//           changeType,
//           pctOfPortfolio: 0,
//         }
//       })
//   } catch {
//     return []
//   }
// }

// ── Notable fund tracker (Dataroma-style, public data) ────────
const NOTABLE_FUNDS: Record<string, string[]> = {
  AAPL: ['Berkshire Hathaway', 'Vanguard', 'BlackRock'],
  MSFT: ['Vanguard', 'BlackRock', 'State Street'],
  NVDA: ['Millennium Management', 'Point72', 'Vanguard'],
  TSLA: ['Cathie Wood (ARK)', 'Baillie Gifford', 'Vanguard'],
  AMZN: ['T. Rowe Price', 'Vanguard', 'Fidelity'],
}

export async function fetchSmartMoney(ticker: string): Promise<SmartMoneySignals> {
  const [insiderTxns, congressTrades, institutionalOwnership] = await Promise.all([
    fetchInsiderTransactions(ticker),
    fetchCongressionalTrades(ticker),
    fetchInstitutionalHoldings(ticker),
  ])

  // ── Institutional aggregates (Bug 28, May 2026) ───────────────────
  // Previously these were hardcoded to 0 and 'stable' because Finnhub
  // wasn't returning data. Now that we have real EDGAR 13F data we
  // compute them from actual holdings:
  //
  // totalInstitutionalPct: sum of pct_of_portfolio across top holders.
  //   Note: pct_of_portfolio is often null in our ingestion — when it is,
  //   we can't compute this and leave it at 0. When the ingestion script
  //   gets fixed to populate pct_of_portfolio, this will start working.
  //
  // institutionalNetChange: aggregate direction of share-count changes.
  //   We sum changeInShares across all top holders. Positive net = funds
  //   are net adding; negative = net reducing; near-zero = stable.
  //   Threshold for "stable" is ±5% of average holding size to avoid
  //   classifying tiny rebalances as a directional signal.
  const totalInstitutionalPct = institutionalOwnership.reduce(
    (sum, h) => sum + (h.pctOfPortfolio || 0), 0
  )

  const totalNetChange = institutionalOwnership.reduce(
    (sum, h) => sum + (h.changeInShares || 0), 0
  )
  const avgHoldingSize = institutionalOwnership.length > 0
    ? institutionalOwnership.reduce((s, h) => s + h.sharesHeld, 0) / institutionalOwnership.length
    : 0
  const stableThreshold = avgHoldingSize * 0.05
  const institutionalNetChange: SmartMoneySignals['institutionalNetChange'] =
    institutionalOwnership.length === 0 ? 'stable' :
    totalNetChange > stableThreshold  ? 'increasing' :
    totalNetChange < -stableThreshold ? 'decreasing' :
    'stable'

  // Notable holders: top 3 by share count with directional marker.
  // Surfacing real holders from EDGAR 13F data instead of the hardcoded
  // NOTABLE_FUNDS dict (kept above as reference). This means smaller
  // tickers without 13F data get an empty list — which is honest.
  const notableHolders = institutionalOwnership
    .slice(0, 3)
    .map(h => {
      const changeLabel = h.changeInShares > 0 ? '▲' : h.changeInShares < 0 ? '▼' : '='
      return `${h.name} ${changeLabel}`
    })

  // ── Insider signal ─────────────────────────────────────────
  const insiderNetValue = insiderTxns.reduce((sum, t) =>
    sum + (t.type === 'buy' ? t.totalValue : -t.totalValue), 0)

  const insiderSignal: SmartMoneySignals['insiderSignal'] =
    insiderNetValue > 5_000_000 ? 'strong_buy' :
    insiderNetValue > 500_000  ? 'buy' :
    insiderNetValue < -5_000_000 ? 'strong_sell' :
    insiderNetValue < -500_000 ? 'sell' : 'neutral'

  const insiderHighlight = insiderTxns.length > 0
    ? (() => {
        const t = insiderTxns[0]
        const action = t.type === 'buy' ? 'bought' : 'sold'
        const val = t.totalValue  // always positive; no abs needed
        const valStr = val >= 1_000_000 ? `$${(val/1_000_000).toFixed(1)}M` : `$${(val/1_000).toFixed(0)}K`
        return `${t.name} (${t.title}) ${action} ${t.shares.toLocaleString()} shares (${valStr}) on ${t.date}`
      })()
    : 'No insider transactions in the last 90 days'

  // ── Congressional signal ───────────────────────────────────
  const congBuys = congressTrades.filter(t => t.type === 'purchase').length
  const congSells = congressTrades.filter(t => t.type === 'sale').length
  const congressSignal: SmartMoneySignals['congressSignal'] =
    congBuys > congSells ? 'buying' : congSells > congBuys ? 'selling' : 'none'

  // ── Build summary ──────────────────────────────────────────
  // NOTE: Insider aggregate is intentionally NOT included in this summary.
  // fundamentals.ts is the single source of truth for insider net buy/sell
  // values. Including the same data here in a different format caused LLM
  // personas to anchor on inconsistent numbers (ref: REGN incident
  // 2026-04-28 where $93K vs $3.1M appeared in same verdict). The data
  // structures remain on the returned object for downstream consumers,
  // but the prompt-visible summary now focuses on what smart-money.ts
  // uniquely contributes: institutional ownership + congressional trades.
  const lines = [
    `=== SMART MONEY SIGNALS ===`,
    ``,
    `Institutional ownership (latest 13F, EDGAR-sourced):`,
    institutionalOwnership.length > 0
      ? [
          `  Top holders by share count:`,
          ...institutionalOwnership.slice(0, 5).map(h => {
            const dir = h.changeInShares > 0 ? `added ${h.changeInShares.toLocaleString()} shares this quarter` :
                        h.changeInShares < 0 ? `reduced by ${Math.abs(h.changeInShares).toLocaleString()} shares this quarter` :
                        'position unchanged'
            return `  • ${h.name}: ${h.sharesHeld.toLocaleString()} shares held, ${dir}`
          }),
          `  Aggregate direction: institutions are ${institutionalNetChange.toUpperCase()} positions`,
        ].join('\n')
      : `  No 13F holder data available for this ticker (small-cap, ETF, foreign listing, or no recent filings).`,
    ``,
    `Congressional trading (180d):`,
    congressTrades.length > 0
      ? [
          `  ${congressTrades.length} trade(s) reported. Buys: ${congBuys} / Sells: ${congSells}`,
          `  Signal: Congress is ${congressSignal.toUpperCase()}`,
          ...congressTrades.slice(0, 3).map(t =>
            `  ${t.member} (${t.chamber}): ${t.type} ${t.amount} on ${t.date}`
          )
        ].join('\n')
      : `  No congressional trades reported for this ticker`,
  ].filter(l => l !== null)

  return {
    insiderTransactions: insiderTxns,
    insiderNetValue,
    insiderSignal,
    insiderHighlight,
    institutionalOwnership,
    totalInstitutionalPct,
    institutionalNetChange,
    notableHolders,
    congressionalTrades: congressTrades,
    congressSignal,
    summary: lines.join('\n'),
  }
}
