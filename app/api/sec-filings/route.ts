import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/app/lib/auth/server'
import { createClient as createAdmin } from '@supabase/supabase-js'
import {
  fetchAllFilingsForTicker,
  getRecentFilings,
  getInsiderActivity,
  getInstitutionalSummary,
} from '@/app/lib/data/sec-filings'

function getAdmin() {
  return createAdmin(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
}

// GET /api/sec-filings?ticker=NVDA — get all filing intelligence for a ticker
export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const ticker = searchParams.get('ticker')?.toUpperCase()
  if (!ticker) return NextResponse.json({ error: 'ticker required' }, { status: 400 })

  const [filings, insiders, institutions] = await Promise.all([
    getRecentFilings(ticker, 20),
    getInsiderActivity(ticker, 90),
    getInstitutionalSummary(ticker),
  ])

  return NextResponse.json({ ticker, filings, insiders, institutions })
}

// POST /api/sec-filings — trigger a full refresh for a ticker or portfolio
export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { ticker, refreshPortfolio } = await req.json()

  if (ticker) {
    // Background refresh for single ticker
    fetchAllFilingsForTicker(ticker.toUpperCase()).catch(console.error)
    return NextResponse.json({ ok: true, message: `Refreshing filings for ${ticker}` })
  }

  if (refreshPortfolio) {
    // Refresh all portfolio tickers
    const admin = getAdmin()
    const { data: positions } = await admin
      .from('portfolios')
      .select('ticker')
      .eq('user_id', user.id)

    const tickers = [...new Set((positions || []).map((p: any) => p.ticker))]

    // Fire non-blocking refreshes with delays
    ;(async () => {
      for (const t of tickers) {
        await fetchAllFilingsForTicker(t).catch(console.error)
        await new Promise(r => setTimeout(r, 2000)) // 2s between tickers
      }
    })()

    return NextResponse.json({ ok: true, message: `Refreshing filings for ${tickers.length} portfolio tickers` })
  }

  return NextResponse.json({ error: 'ticker or refreshPortfolio required' }, { status: 400 })
}
