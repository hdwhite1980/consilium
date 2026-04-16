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
    const start = new Date(Date.now() - 180 * 86400000).toISOString().split('T')[0] // 6 months for robust S/R
    // Trader Plus: SIP feed, extend to 180 days for better S/R levels
    const r = await fetch(
      `https://data.alpaca.markets/v2/stocks/${ticker}/bars?timeframe=1Day&start=${start}&end=${end}&limit=10000&adjustment=all&feed=sip`,
      { headers: ALPACA_HEADERS, next: { revalidate: 900 } }
    )
    if (r.ok) {
      const d = await r.json()
      const bars = d.bars ?? []
      if (bars.length >= 20) {
      const closes = bars.map((b: { c: number }) => b.c)
      const highs  = bars.map((b: { h: number }) => b.h)
      const lows   = bars.map((b: { l: number }) => b.l)
      // Simple pivot-based S/R
      // Use more bars for S/R now that we have 180 days
      const recentHighs = highs.slice(-60).sort((a: number, b: number) => b - a)
      const recentLows  = lows.slice(-60).sort((a: number, b: number) => a - b)
      const support    = recentLows[2]   ?? recentLows[0]
      const support2   = recentLows[4]   ?? recentLows[0]
      const resistance = recentHighs[2]  ?? recentHighs[0]
      const resistance2 = recentHighs[4] ?? recentHighs[0]
      return { support, resistance, support2, resistance2 }
      }
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

async function fetchOptionPrice(
  ticker: string,
  optionType: string,
  strike: number,
  expiry: string
): Promise<{ price: number | null; delta: number | null; theta: number | null; iv: number | null; daysToExpiry: number } | null> {
  const tradierKey = process.env.TRADIER_API_KEY
  if (!tradierKey) return null
  try {
    const expiryFmt = expiry.replace(/-/g, '')
    const strikePad = String(Math.round(strike * 1000)).padStart(8, '0')
    const symbol = `${ticker}${expiryFmt.slice(2)}${optionType === 'call' ? 'C' : 'P'}${strikePad}`
    const res = await fetch(
      `https://api.tradier.com/v1/markets/quotes?symbols=${symbol}&greeks=true`,
      { headers: { 'Authorization': `Bearer ${tradierKey}`, 'Accept': 'application/json' }, cache: 'no-store' }
    )
    if (!res.ok) return null
    const data = await res.json()
    const q = data?.quotes?.quote
    if (!q) return null
    const mid = (q.bid + q.ask) / 2
    const daysToExpiry = Math.ceil((new Date(expiry).getTime() - Date.now()) / 86400000)
    return {
      price: mid > 0 ? mid : (q.last > 0 ? q.last : null),
      delta: q.greeks?.delta ?? null,
      theta: q.greeks?.theta ?? null,
      iv: q.greeks?.mid_iv ? q.greeks.mid_iv * 100 : null,
      daysToExpiry,
    }
  } catch { return null }
}

function detectOptionAlerts(
  ticker: string,
  underlying: string,
  optionType: string,
  strike: number,
  contracts: number,
  entryPremium: number | null,
  optData: { price: number | null; delta: number | null; theta: number | null; iv: number | null; daysToExpiry: number },
): Array<{ severity: string; alert_type: string; title: string; message: string; trigger_value: number }> {
  const alerts = []
  const { price, delta, theta, iv, daysToExpiry } = optData
  const totalCost = entryPremium ? entryPremium * contracts * 100 : null
  const currentValue = price ? price * contracts * 100 : null
  const pnlPct = totalCost && currentValue ? ((currentValue - totalCost) / totalCost) * 100 : null
  const displayName = `${underlying} $${strike} ${optionType.toUpperCase()}`
  const isLeap = daysToExpiry > 180

  // DTE milestones — different thresholds for LEAPs vs standard options
  if (daysToExpiry <= 1) {
    alerts.push({
      severity: 'urgent', alert_type: 'expiry',
      title: `${displayName} expires today`,
      message: `This option expires today. Current value: ${price ? '$' + (price * 100).toFixed(0) + '/contract' : 'unknown'}. Decide now: close, roll, or let expire.`,
      trigger_value: daysToExpiry,
    })
  } else if (daysToExpiry <= 7) {
    alerts.push({
      severity: 'alert', alert_type: 'expiry',
      title: `${displayName} — ${daysToExpiry} days to expiry`,
      message: `${daysToExpiry} days left. Theta decay is accelerating. ${theta ? `Losing ~$${Math.abs(theta * contracts * 100).toFixed(0)}/day.` : ''} Consider closing or rolling.`,
      trigger_value: daysToExpiry,
    })
  } else if (!isLeap && daysToExpiry <= 21) {
    alerts.push({
      severity: 'watch', alert_type: 'expiry',
      title: `${displayName} entering 21-DTE zone`,
      message: `${daysToExpiry} days to expiry — theta decay accelerates from here. ${theta ? `Currently losing ~$${Math.abs(theta * contracts * 100).toFixed(0)}/day.` : ''}`,
      trigger_value: daysToExpiry,
    })
  } else if (isLeap && daysToExpiry <= 90) {
    // LEAP rolling into standard option territory
    alerts.push({
      severity: 'watch', alert_type: 'expiry',
      title: `${displayName} LEAP — ${daysToExpiry} days remaining`,
      message: `Your LEAP is now under 90 days to expiry and losing LEAP characteristics. Theta decay accelerates significantly here. Consider rolling to a further expiry or closing.`,
      trigger_value: daysToExpiry,
    })
  } else if (isLeap && daysToExpiry <= 180) {
    alerts.push({
      severity: 'watch', alert_type: 'expiry',
      title: `${displayName} LEAP under 6 months`,
      message: `${daysToExpiry} days to expiry — LEAP is approaching the 90-day threshold where theta decay increases significantly. Review your exit plan.`,
      trigger_value: daysToExpiry,
    })
  }

  // P&L thresholds
  if (pnlPct !== null) {
    if (pnlPct <= -50) {
      alerts.push({
        severity: 'urgent', alert_type: 'pnl_threshold',
        title: `${displayName} down ${Math.abs(pnlPct).toFixed(0)}%`,
        message: `Option has lost ${Math.abs(pnlPct).toFixed(0)}% of its value. ${totalCost && currentValue ? `Paid $${totalCost.toFixed(0)}, now worth ~$${currentValue.toFixed(0)}.` : ''} Consider cutting the loss.`,
        trigger_value: pnlPct,
      })
    } else if (pnlPct <= -30) {
      alerts.push({
        severity: 'alert', alert_type: 'pnl_threshold',
        title: `${displayName} down ${Math.abs(pnlPct).toFixed(0)}%`,
        message: `Option down ${Math.abs(pnlPct).toFixed(0)}% from entry. ${theta ? `Theta: -$${Math.abs(theta * contracts * 100).toFixed(0)}/day.` : ''}`,
        trigger_value: pnlPct,
      })
    } else if (pnlPct >= 50) {
      alerts.push({
        severity: 'watch', alert_type: 'pnl_threshold',
        title: `${displayName} up ${pnlPct.toFixed(0)}% — consider taking profits`,
        message: `Option up ${pnlPct.toFixed(0)}%. ${totalCost && currentValue ? `Paid $${totalCost.toFixed(0)}, now worth ~$${currentValue.toFixed(0)}.` : ''} Consider closing half to lock in gains.`,
        trigger_value: pnlPct,
      })
    }
  }

  // Theta burn rate
  if (theta && price) {
    const dailyBurnPct = Math.abs(theta) / price * 100
    if (dailyBurnPct > 5) {
      alerts.push({
        severity: 'watch', alert_type: 'theta_burn',
        title: `${displayName} burning ${dailyBurnPct.toFixed(1)}%/day`,
        message: `Theta is consuming ${dailyBurnPct.toFixed(1)}% of the option's value per day (~$${Math.abs(theta * contracts * 100).toFixed(0)}/day). ${daysToExpiry} days left.`,
        trigger_value: dailyBurnPct,
      })
    }
  }

  return alerts
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
    .maybeSingle()
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
    .maybeSingle()

  const prevStates: Record<string, PositionState> = monitorState?.position_states ?? {}
  const now = new Date()
  const shouldScanNews = !monitorState?.last_news_scan ||
    new Date(monitorState.last_news_scan).getTime() < now.getTime() - 60 * 60 * 1000

  const newAlerts: Array<Record<string, unknown>> = []
  const newStates: Record<string, PositionState> = {}

  // Process each position
  await Promise.all(positions.map(async (pos: Record<string, unknown>) => {
    const isOption = pos.position_type === 'option'
    const ticker = String(pos.ticker)
    const underlying = String(pos.underlying ?? pos.ticker)

    if (isOption) {
      // Options path
      const optData = await fetchOptionPrice(
        underlying,
        String(pos.option_type ?? 'call'),
        Number(pos.strike ?? 0),
        String(pos.expiry ?? ''),
      )
      if (!optData) return

      const stateKey = `${ticker}_opt`
      newStates[stateKey] = {
        price: optData.price ?? 0,
        support: 0,
        resistance: 0,
        pnlPct: null,
        lastAlertedSupport: null,
        lastAlertedResistance: null,
      }

      const detected = detectOptionAlerts(
        ticker, underlying,
        String(pos.option_type ?? 'call'),
        Number(pos.strike ?? 0),
        Number(pos.contracts ?? 1),
        pos.entry_premium ? Number(pos.entry_premium) : null,
        optData,
      )

      // Dedup and push alerts for options
      const { data: recentAlerts } = await admin()
        .from('portfolio_alerts')
        .select('alert_type, trigger_value')
        .eq('user_id', user.id)
        .eq('ticker', ticker)
        .gt('created_at', new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString())

      const recentSet = new Set((recentAlerts ?? []).map((a: Record<string, unknown>) => `${a.alert_type}:${a.trigger_value}`))
      for (const alert of detected) {
        const key = `${alert.alert_type}:${alert.trigger_value}`
        if (!recentSet.has(key)) {
          newAlerts.push({ ...alert, user_id: user.id, ticker, price: optData.price })
        }
      }

      if (shouldScanNews) {
        const news = await scanNewsForTicker(underlying)
        if (news) {
          newAlerts.push({
            user_id: user.id, ticker,
            severity: 'watch', alert_type: 'news',
            title: `News: ${underlying}`,
            message: news, price: optData.price, trigger_value: 0,
          })
        }
      }
      return
    }

    // Stock path (existing)
    const [price, sr] = await Promise.all([
      fetchLivePrice(ticker),
      fetchSupportResistance(ticker),
    ])

    if (!price || !sr) return

    const prevState = prevStates[ticker] ?? null
    const avgCost = pos.avg_cost ? Number(pos.avg_cost) : null
    const shares = Number(pos.shares ?? 0)
    const pnlPct = avgCost ? ((price - avgCost) / avgCost) * 100 : null

    newStates[ticker] = {
      price,
      support: sr.support,
      resistance: sr.resistance,
      pnlPct,
      lastAlertedSupport: prevState?.lastAlertedSupport ?? null,
      lastAlertedResistance: prevState?.lastAlertedResistance ?? null,
    }

    const detected = detectAlerts(ticker, price, avgCost, shares, sr, prevState)

    // Deduplicate — don't re-alert same type within 2 hours
    const { data: recentAlerts } = await admin()
      .from('portfolio_alerts')
      .select('alert_type, trigger_value')
      .eq('user_id', user.id)
      .eq('ticker', ticker)
      .gt('created_at', new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString())

    const recentSet = new Set((recentAlerts ?? []).map((a: Record<string, unknown>) => `${a.alert_type}:${a.trigger_value}`))

    for (const alert of detected) {
      const key = `${alert.alert_type}:${alert.trigger_value}`
      if (!recentSet.has(key)) {
        newAlerts.push({ ...alert, user_id: user.id, ticker, price })
      }
    }

    // Hourly news scan
    if (shouldScanNews) {
      const news = await scanNewsForTicker(ticker)
      if (news) {
        newAlerts.push({
          user_id: user.id, ticker,
          severity: 'watch', alert_type: 'news',
          title: `News: ${ticker}`,
          message: news, price, trigger_value: 0,
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
