/**
 * POST /api/seed?ticker=NVDA
 * Manually seeds all intelligence data for a ticker.
 * Call this for any ticker you want pre-populated before analysis.
 * Also runs Federal Register + congressional trade refresh.
 */
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/app/lib/auth/server'
import { fetchAllFilingsForTicker, fetch13FForTicker } from '@/app/lib/data/sec-filings'
import { fetchFederalRegisterActions, fetchCongressionalTrades, fetchRecentBills } from '@/app/lib/data/legislative'
import { fetchEdgarFundamentals } from '@/app/lib/data/edgar'

export async function POST(req: NextRequest) {
  // Allow cron secret bypass for scheduled jobs
  const cronSecret = process.env.CRON_SECRET
  const authHeader = req.headers.get('authorization')
  const isCron = cronSecret && authHeader === `Bearer ${cronSecret}`

  if (!isCron) {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

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

    // SEC filings (8-K, Form 4, dilution) — fast
    try {
      await fetchAllFilingsForTicker(ticker)
      results.sec_filings = 'ok'
    } catch (e) {
      results.sec_filings = `error: ${(e as Error).message?.slice(0, 80)}`
    }

    // 13-F institutional holdings — separate, slower (hits 10 institutions)
    const do13F = searchParams.get('include13f') !== 'false'
    if (do13F) {
      try {
        await fetch13FForTicker(ticker)
        // Check how many rows were written
        const { createClient: mkAdmin } = await import('@supabase/supabase-js')
        const adm = mkAdmin(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
        const { count } = await adm.from('institutional_holdings').select('*', { count: 'exact', head: true }).eq('ticker', ticker)
        results.institutional_holdings_13f = count !== null && count > 0 ? `ok — ${count} institutions` : 'ran but 0 rows written — check name matching'
      } catch (e) {
        results.institutional_holdings_13f = `error: ${(e as Error).message?.slice(0, 80)}`
      }
    }

    // Congressional trades for this ticker
    try {
      await fetchCongressionalTrades(ticker)
      const { createClient: mkAdmin2 } = await import('@supabase/supabase-js')
      const adm2 = mkAdmin2(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
      const { count: ctCount } = await adm2.from('congressional_trades').select('*', { count: 'exact', head: true }).eq('ticker', ticker)
      results.congressional_trades = ctCount !== null && ctCount > 0 ? `ok — ${ctCount} trades` : 'ran but 0 rows — no trades found for this ticker or XML unavailable'
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
