import { NextResponse } from 'next/server'
import { createClient } from '@/app/lib/auth/server'
import { createClient as createAdmin } from '@supabase/supabase-js'
import { GoogleGenerativeAI } from '@google/generative-ai'

const admin = () => createAdmin(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const FINNHUB = process.env.FINNHUB_API_KEY
const ALPACA_HEADERS = {
  'APCA-API-KEY-ID': process.env.ALPACA_API_KEY!,
  'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY!,
}

// ── Thresholds ────────────────────────────────────────────────
const THRESHOLDS = {
  watch:  { pnl: -3,  srProximity: 0.015 }, // within 1.5% of S/R
  alert:  { pnl: -8,  srBreach: true },       // broke through S/R
  urgent: { pnl: -15, stopLoss: true },        // stop loss territory
}

interface PositionState {
  price: number
  support: number
  resistance: number
  pnlPct: number | null
  lastAlertedSupport: number | null
  lastAlertedResistance: number | null
}

async function fetchLivePrice(ticker: string): Promise<number | null> {
  if (!FINNHUB) return null
  try {
    const r = await fetch(`https://finnhub.io/api/v1/quote?symbol=${ticker}&token=${FINNHUB}`, { cache: 'no-store' })
    if (!r.ok) return null
    const d = await r.json()
    return d.c > 0 ? d.c : null
  } catch { return null }
}

async function fetchSupportResistance(ticker: string): Promise<{ support: number; resistance: number; support2: number; resistance2: number } | null> {
  try {
    const end = new Date().toISOString().split('T')[0]
    const start = new Date(Date.now() - 90 * 86400000).toISOString().split('T')[0]
    for (const feed of ['sip', 'iex']) {
      const r = await fetch(
        `https://data.alpaca.markets/v2/stocks/${ticker}/bars?timeframe=1Day&start=${start}&end=${end}&limit=90&adjustment=all&feed=${feed}`,
        { headers: ALPACA_HEADERS, next: { revalidate: 900 } }
      )
      if (!r.ok) continue
      const d = await r.json()
      const bars = d.bars ?? []
      if (bars.length < 20) continue
      const closes = bars.map((b: { c: number }) => b.c)
      const highs  = bars.map((b: { h: number }) => b.h)
      const lows   = bars.map((b: { l: number }) => b.l)
      // Simple pivot-based S/R
      const recentHighs = highs.slice(-20).sort((a: number, b: number) => b - a)
      const recentLows  = lows.slice(-20).sort((a: number, b: number) => a - b)
      const current = closes[closes.length - 1]
      const support    = recentLows[2]   ?? recentLows[0]
      const support2   = recentLows[4]   ?? recentLows[0]
      const resistance = recentHighs[2]  ?? recentHighs[0]
      const resistance2 = recentHighs[4] ?? recentHighs[0]
      return { support, resistance, support2, resistance2 }
    }
    return null
  } catch { return null }
}

async function scanNewsForTicker(ticker: string): Promise<string | null> {
  const key = process.env.GEMINI_API_KEY
  if (!key) return null
  try {
    const genAI = new GoogleGenerativeAI(key)
    const model = genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      tools: [{ googleSearch: {} } as never],
    })
    const result = await model.generateContent(
      `Search for the latest news about ${ticker} stock in the last 24 hours. ` +
      `Are there any significant developments — earnings, guidance changes, analyst upgrades/downgrades, ` +
      `regulatory news, product announcements, or macro events affecting this stock? ` +
      `Respond in 2-3 sentences max. If nothing material, say "No significant news in the last 24 hours."`
    )
    const text = result.response.text().trim()
    if (text.toLowerCase().includes('no significant news') || text.toLowerCase().includes('no major news')) {
      return null
    }
    return text
  } catch { return null }
}

function detectAlerts(
  ticker: string,
  currentPrice: number,
  avgCost: number | null,
  shares: number,
  sr: { support: number; resistance: number; support2: number; resistance2: number },
  prevState: PositionState | null,
): Array<{ severity: string; alert_type: string; title: string; message: string; trigger_value: number }> {
  const alerts = []
  const pnlPct = avgCost ? ((currentPrice - avgCost) / avgCost) * 100 : null
  const pnlDollar = avgCost ? (currentPrice - avgCost) * shares : null

  // ── P&L thresholds ──────────────────────────────────────
  if (pnlPct !== null) {
    if (pnlPct <= THRESHOLDS.urgent.pnl) {
      alerts.push({
        severity: 'urgent',
        alert_type: 'pnl_threshold',
        title: `${ticker} down ${Math.abs(pnlPct).toFixed(1)}% from cost`,
        message: `${ticker} is at $${currentPrice.toFixed(2)}, down ${Math.abs(pnlPct).toFixed(1)}% from your cost of $${avgCost?.toFixed(2)}. ${pnlDollar !== null ? `Unrealized loss: $${Math.abs(pnlDollar).toFixed(0)}.` : ''} Consider reviewing your stop loss.`,
        trigger_value: pnlPct,
      })
    } else if (pnlPct <= THRESHOLDS.alert.pnl) {
      alerts.push({
        severity: 'alert',
        alert_type: 'pnl_threshold',
        title: `${ticker} down ${Math.abs(pnlPct).toFixed(1)}%`,
        message: `${ticker} is at $${currentPrice.toFixed(2)}, down ${Math.abs(pnlPct).toFixed(1)}% from your cost of $${avgCost?.toFixed(2)}.`,
        trigger_value: pnlPct,
      })
    } else if (pnlPct <= THRESHOLDS.watch.pnl) {
      alerts.push({
        severity: 'watch',
        alert_type: 'pnl_threshold',
        title: `${ticker} down ${Math.abs(pnlPct).toFixed(1)}%`,
        message: `${ticker} is at $${currentPrice.toFixed(2)}, down ${Math.abs(pnlPct).toFixed(1)}% from your cost basis.`,
        trigger_value: pnlPct,
      })
    }
  }

  // ── Support breach ──────────────────────────────────────
  const prevPrice = prevState?.price ?? currentPrice
  if (currentPrice < sr.support && prevPrice >= sr.support) {
    alerts.push({
      severity: 'alert',
      alert_type: 'support_break',
      title: `${ticker} broke support at $${sr.support.toFixed(2)}`,
      message: `${ticker} broke below key support at $${sr.support.toFixed(2)}. Current price $${currentPrice.toFixed(2)}. Next support level at $${sr.support2.toFixed(2)}. This changes the technical picture — consider reviewing your position.`,
      trigger_value: sr.support,
    })
  } else if (currentPrice < sr.support * (1 + THRESHOLDS.watch.srProximity) && currentPrice >= sr.support) {
    alerts.push({
      severity: 'watch',
      alert_type: 'support_break',
      title: `${ticker} approaching support at $${sr.support.toFixed(2)}`,
      message: `${ticker} is at $${currentPrice.toFixed(2)}, within 1.5% of key support at $${sr.support.toFixed(2)}. Watch closely.`,
      trigger_value: sr.support,
    })
  }

  // ── Resistance break (bullish) ──────────────────────────
  if (currentPrice > sr.resistance && prevPrice <= sr.resistance) {
    alerts.push({
      severity: 'watch',
      alert_type: 'resistance_break',
      title: `${ticker} broke above resistance at $${sr.resistance.toFixed(2)}`,
      message: `${ticker} broke through resistance at $${sr.resistance.toFixed(2)} — now at $${currentPrice.toFixed(2)}. This is a bullish signal. Next resistance at $${sr.resistance2.toFixed(2)}.`,
      trigger_value: sr.resistance,
    })
  }

  return alerts
}

export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  // Load unacknowledged alerts
  const { data: alerts } = await admin()
    .from('portfolio_alerts')
    .select('*')
    .eq('user_id', user.id)
    .eq('acknowledged', false)
    .order('created_at', { ascending: false })
    .limit(20)

  return NextResponse.json({ alerts: alerts ?? [] })
}

export async function POST() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  // Load positions
  const { data: portfolioData } = await admin()
    .from('portfolios')
    .select('id')
    .eq('user_id', user.id)
    .single()
  if (!portfolioData) return NextResponse.json({ alerts: [], checked: 0 })

  const { data: positions } = await admin()
    .from('portfolio_positions')
    .select('ticker, shares, avg_cost')
    .eq('portfolio_id', portfolioData.id)
  if (!positions?.length) return NextResponse.json({ alerts: [], checked: 0 })

  // Load previous state
  const { data: monitorState } = await admin()
    .from('portfolio_monitor_state')
    .select('*')
    .eq('user_id', user.id)
    .single()

  const prevStates: Record<string, PositionState> = monitorState?.position_states ?? {}
  const now = new Date()
  const shouldScanNews = !monitorState?.last_news_scan ||
    new Date(monitorState.last_news_scan).getTime() < now.getTime() - 60 * 60 * 1000

  const newAlerts: Array<Record<string, unknown>> = []
  const newStates: Record<string, PositionState> = {}

  // Process each position
  await Promise.all(positions.map(async (pos) => {
    const [price, sr] = await Promise.all([
      fetchLivePrice(pos.ticker),
      fetchSupportResistance(pos.ticker),
    ])

    if (!price || !sr) return

    const prevState = prevStates[pos.ticker] ?? null
    const pnlPct = pos.avg_cost ? ((price - pos.avg_cost) / pos.avg_cost) * 100 : null

    newStates[pos.ticker] = {
      price,
      support: sr.support,
      resistance: sr.resistance,
      pnlPct,
      lastAlertedSupport: prevState?.lastAlertedSupport ?? null,
      lastAlertedResistance: prevState?.lastAlertedResistance ?? null,
    }

    const detected = detectAlerts(pos.ticker, price, pos.avg_cost, pos.shares, sr, prevState)

    // Deduplicate — don't re-alert same type within 2 hours
    const { data: recentAlerts } = await admin()
      .from('portfolio_alerts')
      .select('alert_type, trigger_value')
      .eq('user_id', user.id)
      .eq('ticker', pos.ticker)
      .gt('created_at', new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString())

    const recentSet = new Set((recentAlerts ?? []).map(a => `${a.alert_type}:${a.trigger_value}`))

    for (const alert of detected) {
      const key = `${alert.alert_type}:${alert.trigger_value}`
      if (!recentSet.has(key)) {
        newAlerts.push({ ...alert, user_id: user.id, ticker: pos.ticker, price })
      }
    }

    // Hourly news scan
    if (shouldScanNews) {
      const news = await scanNewsForTicker(pos.ticker)
      if (news) {
        newAlerts.push({
          user_id: user.id,
          ticker: pos.ticker,
          severity: 'watch',
          alert_type: 'news',
          title: `News: ${pos.ticker}`,
          message: news,
          price,
          trigger_value: 0,
        })
      }
    }
  }))

  // Persist alerts and update state
  if (newAlerts.length > 0) {
    await admin().from('portfolio_alerts').insert(newAlerts)
    // Fire notifications asynchronously — don't block response
    fetch(`${process.env.NEXT_PUBLIC_APP_URL}/api/notifications`, {
      method: 'PUT',
      headers: { 'Cookie': '' }, // server-to-server, auth checked separately
    }).catch(() => null)
  }

  await admin().from('portfolio_monitor_state').upsert({
    user_id: user.id,
    last_checked: now.toISOString(),
    last_news_scan: shouldScanNews ? now.toISOString() : monitorState?.last_news_scan,
    position_states: newStates,
    updated_at: now.toISOString(),
  }, { onConflict: 'user_id' })

  return NextResponse.json({
    alerts: newAlerts,
    checked: positions.length,
    newAlertsCount: newAlerts.length,
  })
}

// Acknowledge alerts
export async function PATCH(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const { alertId, all } = await req.json()

  if (all) {
    await admin().from('portfolio_alerts').update({ acknowledged: true })
      .eq('user_id', user.id).eq('acknowledged', false)
  } else if (alertId) {
    await admin().from('portfolio_alerts').update({ acknowledged: true })
      .eq('id', alertId).eq('user_id', user.id)
  }

  return NextResponse.json({ success: true })
}
