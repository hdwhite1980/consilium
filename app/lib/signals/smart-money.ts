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

// ── Finnhub insider transactions (Form 4 with real buy/sell data) ──
async function fetchInsiderTransactions(ticker: string): Promise<InsiderTransaction[]> {
  const key = process.env.FINNHUB_API_KEY
  if (!key) return []
  try {
    const from = new Date(Date.now() - 90 * 86400000).toISOString().split('T')[0]
    const to   = new Date().toISOString().split('T')[0]
    const res = await fetch(
      `https://finnhub.io/api/v1/stock/insider-transactions?symbol=${ticker}&from=${from}&to=${to}&token=${key}`,
      { next: { revalidate: 3600 } }
    )
    if (!res.ok) return []
    const data = await res.json()
    const txns: Array<Record<string, unknown>> = data?.data ?? []
    return txns.slice(0, 15).map(t => {
      const shares    = Math.abs(Number(t.share ?? 0))
      const price     = Number(t.transactionPrice ?? 0)
      const totalVal  = shares * price
      // Finnhub: transactionCode P=Purchase S=Sale 10b5-1=plan sale
      const isBuy = String(t.transactionCode) === 'P'
      return {
        name:           String(t.name ?? 'Insider'),
        title:          String(t.reportedTitle ?? 'Executive'),
        type:           isBuy ? 'buy' as const : 'sell' as const,
        shares,
        pricePerShare:  price,
        totalValue:     isBuy ? totalVal : -totalVal,
        date:           String(t.transactionDate ?? t.filingDate ?? ''),
      }
    }).filter(t => t.shares > 0)
  } catch {
    return []
  }
}

// ── Finnhub institutional ownership (13F data) ─────────────────
async function fetchInstitutionalHoldings(ticker: string): Promise<InstitutionalHolder[]> {
  const key = process.env.FINNHUB_API_KEY
  if (!key) return []
  try {
    const res = await fetch(
      `https://finnhub.io/api/v1/stock/institutional-ownership?symbol=${ticker}&token=${key}`,
      { next: { revalidate: 86400 } }
    )
    if (!res.ok) return []
    const data = await res.json()
    const holders: Array<Record<string, unknown>> = data?.ownership ?? []
    // Take top 5 by share count
    return holders
      .sort((a, b) => Number(b.share ?? 0) - Number(a.share ?? 0))
      .slice(0, 5)
      .map(h => {
        const change = Number(h.change ?? 0)
        const changeType: InstitutionalHolder['changeType'] =
          change > 0 ? 'added' : change < 0 ? 'reduced' : 'unchanged'
        return {
          name:           String(h.name ?? 'Institution'),
          sharesHeld:     Number(h.share ?? 0),
          changeInShares: change,
          changeType,
          pctOfPortfolio: 0,
        }
      })
  } catch {
    return []
  }
}

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

  const totalInstitutionalPct = 0
  // Build notable holders from Finnhub data — top 3 largest by shares held
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
        const val = Math.abs(t.totalValue)
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
  const lines = [
    `=== SMART MONEY SIGNALS ===`,
    ``,
    `Insider activity (90d from SEC EDGAR Form 4):`,
    insiderTxns.length > 0
      ? (() => {
          const buys  = insiderTxns.filter(t => t.type === 'buy')
          const sells = insiderTxns.filter(t => t.type === 'sell')
          const netStr = insiderNetValue >= 0
            ? `net buying $${(insiderNetValue/1000).toFixed(0)}K`
            : `net selling $${(Math.abs(insiderNetValue)/1000).toFixed(0)}K`
          return `  ${insiderTxns.length} filing(s): ${buys.length} buy(s), ${sells.length} sell(s). ${netStr}. Signal: ${insiderSignal.toUpperCase()}`
        })()
      : `  No insider transactions filed in the last 90 days`,
    insiderHighlight ? `  Notable: ${insiderHighlight}` : '',
    ``,
    `Institutional ownership:`,
    institutionalOwnership.length > 0
      ? [
          `  Top holders (13F data):`,
          ...institutionalOwnership.slice(0, 3).map(h => {
            const dir = h.changeInShares > 0 ? `added ${h.changeInShares.toLocaleString()} shares` :
                        h.changeInShares < 0 ? `reduced by ${Math.abs(h.changeInShares).toLocaleString()} shares` :
                        'unchanged'
            return `  • ${h.name}: ${h.sharesHeld.toLocaleString()} shares held, ${dir}`
          })
        ].join('\n')
      : `  No institutional 13F holder data available`,
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
    institutionalNetChange: 'stable',
    notableHolders,
    congressionalTrades: congressTrades,
    congressSignal,
    summary: lines.join('\n'),
  }
}
