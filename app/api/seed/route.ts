/**
 * POST /api/seed?ticker=NVDA
 * Manually seeds all intelligence data for a ticker.
 * Call this for any ticker you want pre-populated before analysis.
 * Also runs Federal Register + congressional trade refresh.
 */
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/app/lib/auth/server'
import { fetchAllFilingsForTicker } from '@/app/lib/data/sec-filings'
import { fetchFederalRegisterActions, fetchCongressionalTrades, fetchRecentBills } from '@/app/lib/data/legislative'
import { fetchEdgarFundamentals } from '@/app/lib/data/edgar'

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const ticker = searchParams.get('ticker')?.toUpperCase()

  const results: Record<string, string> = {}

  // Always refresh Federal Register (EOs affect all tickers)
  try {
    await fetchFederalRegisterActions(7)
    results.federal_register = 'ok'
  } catch (e) {
    results.federal_register = `error: ${(e as Error).message?.slice(0, 80)}`
  }

  // Congress bills (needs API key)
  try {
    await fetchRecentBills(14)
    results.congress_bills = 'ok'
  } catch (e) {
    results.congress_bills = `skipped: ${(e as Error).message?.slice(0, 80)}`
  }

  if (ticker) {
    // EDGAR fundamentals
    try {
      const edgar = await fetchEdgarFundamentals(ticker)
      results.edgar = edgar ? `ok — ${edgar.company_name}, revenue TTM $${edgar.revenue_ttm ? (edgar.revenue_ttm/1e9).toFixed(1)+'B' : 'N/A'}` : 'no data found'
    } catch (e) {
      results.edgar = `error: ${(e as Error).message?.slice(0, 80)}`
    }

    // SEC filings (8-K, Form 4, 13-F, dilution)
    try {
      await fetchAllFilingsForTicker(ticker)
      results.sec_filings = 'ok'
    } catch (e) {
      results.sec_filings = `error: ${(e as Error).message?.slice(0, 80)}`
    }

    // Congressional trades for this ticker
    try {
      await fetchCongressionalTrades(ticker)
      results.congressional_trades = 'ok'
    } catch (e) {
      results.congressional_trades = `error: ${(e as Error).message?.slice(0, 80)}`
    }
  } else {
    // No ticker — just refresh congressional trades globally
    try {
      await fetchCongressionalTrades()
      results.congressional_trades = 'ok (all)'
    } catch (e) {
      results.congressional_trades = `error: ${(e as Error).message?.slice(0, 80)}`
    }
  }

  return NextResponse.json({ ok: true, ticker: ticker || 'global', results })
}
