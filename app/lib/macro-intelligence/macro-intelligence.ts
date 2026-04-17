/**
 * Wali-OS Macro Intelligence Engine
 *
 * Watches broad news for geopolitical, policy, energy, weather, and social
 * events that affect markets — even when they aren't labeled "financial news".
 * Logs events, measures actual market impact, and builds a pattern library
 * that future analyses can reference.
 */

import { createClient } from '@supabase/supabase-js'
import { GoogleGenerativeAI } from '@google/generative-ai'

function getAdmin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

function getGenAI() {
  return new GoogleGenerativeAI(process.env.GEMINI_API_KEY!)
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface MacroEvent {
  id: string
  detected_at: string
  event_date: string
  category: string
  subcategory: string | null
  title: string
  summary: string
  affected_sectors: string[]
  affected_tickers: string[]
  severity: number
  sentiment: string
  confidence: number
  mechanism: string | null
  historical_analogs: string[]
  resolved: boolean
}

export interface MacroPattern {
  id: string
  category: string
  pattern_name: string
  event_count: number
  last_seen: string
  avg_spy_1d: number | null
  avg_spy_1w: number | null
  sector_playbook: Record<string, { avg: number; count: number; direction: string }>
  ticker_playbook: Record<string, { avg: number; direction: string }>
  playbook_summary: string
  reliability_score: number
}

export interface ActiveMacroTheme {
  id: string
  theme_name: string
  theme_summary: string
  playbook: string
  sectors_to_watch: string[]
  tickers_to_watch: string[]
  urgency: string
}

// ── Sector ETF proxies ─────────────────────────────────────────────────────

const SECTOR_ETFS: Record<string, string> = {
  'XLE': 'energy',
  'XLK': 'technology',
  'XLF': 'financials',
  'XLV': 'healthcare',
  'XLI': 'industrials',
  'XLY': 'consumer_discretionary',
  'XLP': 'consumer_staples',
  'XLB': 'materials',
  'XLRE': 'real_estate',
  'XLU': 'utilities',
  'XLC': 'communication',
  'JETS': 'airlines',
  'XHB': 'homebuilders',
  'XRT': 'retail',
  'GLD': 'gold',
  'SLV': 'silver',
  'USO': 'oil',
}

// ── Step 1: Scan broad news for macro events ──────────────────────────────────

export async function scanForMacroEvents(newsHeadlines: string[]): Promise<void> {
  if (!newsHeadlines || newsHeadlines.length === 0) return

  const model = getGenAI().getGenerativeModel({ model: 'gemini-2.5-flash' })

  const prompt = `You are a macro intelligence analyst. Your job is to identify NON-OBVIOUS market-moving events from news headlines — things that aren't labeled "financial news" but have real market implications.

HEADLINES TO ANALYZE:
${newsHeadlines.slice(0, 50).join('\n')}

Look for events in these categories that could affect markets:
- GEOPOLITICAL: Military conflicts, diplomatic tensions, sanctions, elections in major economies
- ENERGY: Oil supply disruptions, pipeline issues, OPEC decisions, natural disasters near energy infrastructure  
- POLICY: Presidential executive orders, major legislation, regulatory changes, trade tariffs
- FED/MONETARY: Fed official speeches, inflation data surprises, employment data
- TRADE: Tariffs, sanctions, supply chain disruptions, port strikes
- WEATHER: Hurricanes, droughts, floods affecting agriculture or energy
- TECHNOLOGY: Major tech regulatory actions, chip export restrictions, AI regulations
- SOCIAL: Major strikes, civil unrest in economically significant regions
- HEALTH: Disease outbreaks that could affect supply chains or specific sectors

For each significant event found (max 3 most important), respond with JSON:
{
  "events": [
    {
      "category": "geopolitical",
      "subcategory": "middle_east_conflict",
      "title": "US-Iran tensions escalate after drone strike",
      "summary": "US military conducted strikes in Iran-backed militia positions in Syria. This escalates tensions in the Middle East and threatens oil supply routes through the Strait of Hormuz.",
      "affected_sectors": ["energy", "defense", "airlines", "shipping"],
      "affected_tickers": ["OXY", "XOM", "CVX", "LMT", "RTX", "UAL", "DAL", "FDX"],
      "severity": 7,
      "sentiment": "mixed",
      "confidence": 82,
      "mechanism": "Middle East conflict raises oil supply risk premium, benefiting energy stocks and defense contractors while hurting airlines (fuel costs) and shipping (route disruptions)",
      "historical_analogs": ["2020 Soleimani assassination", "2019 Saudi Aramco drone attack", "2022 Russia-Ukraine oil shock"]
    }
  ]
}

If no significant non-financial macro events are found, return: {"events": []}
Only include events with severity >= 5. Be specific about mechanisms and affected tickers.`

  try {
    const result = await model.generateContent(prompt)
    const text = result.response.text()
    const clean = text.replace(/```json|```/g, '').trim()
    const start = clean.indexOf('{')
    const end = clean.lastIndexOf('}')
    if (start === -1 || end === -1) return

    const parsed = JSON.parse(clean.slice(start, end + 1))
    const events = parsed.events || []

    if (events.length === 0) return

    const admin = getAdmin()

    for (const event of events) {
      // Check if we already logged a similar event today
      const today = new Date().toISOString().split('T')[0]
      const { data: existing } = await admin
        .from('macro_events')
        .select('id')
        .eq('event_date', today)
        .eq('category', event.category)
        .ilike('title', `%${event.title.slice(0, 30)}%`)
        .maybeSingle()

      if (existing) continue // already logged

      // Insert new event
      const { data: newEvent } = await admin
        .from('macro_events')
        .insert({
          event_date: today,
          category: event.category,
          subcategory: event.subcategory || null,
          title: event.title,
          summary: event.summary,
          source_headlines: newsHeadlines.slice(0, 10),
          affected_sectors: event.affected_sectors || [],
          affected_tickers: event.affected_tickers || [],
          geographic_scope: 'global',
          severity: event.severity,
          sentiment: event.sentiment,
          confidence: event.confidence,
          mechanism: event.mechanism || null,
          historical_analogs: event.historical_analogs || [],
        })
        .select('id')
        .single()

      if (newEvent?.id) {
        // Create an active theme immediately
        await createActiveTheme(newEvent.id, event)

        // Trigger impact measurement after a delay (non-blocking)
        setTimeout(() => measureEventImpact(newEvent.id, '1D').catch(console.error), 0)
      }
    }
  } catch (e) {
    console.error('[macro-intelligence] scan error:', e)
  }
}

// ── Step 2: Create an active theme for display ────────────────────────────────

async function createActiveTheme(eventId: string, event: any): Promise<void> {
  const admin = getAdmin()

  // Find matching pattern for playbook
  const { data: pattern } = await admin
    .from('macro_patterns')
    .select('playbook_summary, sector_playbook, ticker_playbook')
    .eq('category', event.category)
    .ilike('pattern_name', `%${event.subcategory || event.category}%`)
    .maybeSingle()

  const playbook = pattern?.playbook_summary
    || `Based on similar ${event.category} events: ${event.mechanism}`

  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) // 7 days

  await admin.from('active_macro_themes').insert({
    event_id: eventId,
    pattern_id: pattern ? undefined : null,
    theme_name: event.title,
    theme_summary: event.summary,
    playbook,
    sectors_to_watch: event.affected_sectors?.slice(0, 4) || [],
    tickers_to_watch: event.affected_tickers?.slice(0, 6) || [],
    urgency: event.severity >= 8 ? 'high' : event.severity >= 5 ? 'medium' : 'low',
    expires_at: expiresAt.toISOString(),
  })
}

// ── Step 3: Measure actual market impact ──────────────────────────────────────

export async function measureEventImpact(
  eventId: string,
  window: '1D' | '1W' | '1M'
): Promise<void> {
  const admin = getAdmin()

  const { data: event } = await admin
    .from('macro_events')
    .select('*')
    .eq('id', eventId)
    .single()

  if (!event) return

  const finnhubKey = process.env.FINNHUB_API_KEY
  if (!finnhubKey) return

  // Measure S&P, QQQ, VIX
  const broadMarket: Record<string, number | null> = {}
  for (const sym of ['SPY', 'QQQ', 'DIA', 'VIX']) {
    try {
      const res = await fetch(
        `https://finnhub.io/api/v1/quote?symbol=${sym}&token=${finnhubKey}`
      )
      if (res.ok) {
        const q = await res.json()
        broadMarket[sym] = q.dp ?? null // dp = % change
      }
    } catch { /* skip */ }
  }

  // Measure sector ETFs
  const sectorImpacts: Record<string, number> = {}
  for (const etf of Object.keys(SECTOR_ETFS)) {
    try {
      const res = await fetch(
        `https://finnhub.io/api/v1/quote?symbol=${etf}&token=${finnhubKey}`
      )
      if (res.ok) {
        const q = await res.json()
        if (q.dp != null) sectorImpacts[etf] = parseFloat(q.dp.toFixed(2))
      }
    } catch { /* skip */ }
  }

  // Measure affected tickers
  const tickerImpacts: Record<string, number> = {}
  for (const ticker of (event.affected_tickers || []).slice(0, 10)) {
    try {
      const res = await fetch(
        `https://finnhub.io/api/v1/quote?symbol=${ticker}&token=${finnhubKey}`
      )
      if (res.ok) {
        const q = await res.json()
        if (q.dp != null) tickerImpacts[ticker] = parseFloat(q.dp.toFixed(2))
      }
    } catch { /* skip */ }
  }

  // Build impact summary
  const topMovers = Object.entries(tickerImpacts)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .slice(0, 5)
    .map(([t, pct]) => `${t} ${pct > 0 ? '+' : ''}${pct}%`)
    .join(', ')

  const impactSummary = topMovers
    ? `${window} impact — SPY: ${broadMarket['SPY'] ?? 'N/A'}%, VIX: ${broadMarket['VIX'] ?? 'N/A'}%. Top movers: ${topMovers}.`
    : `${window} impact measured. SPY: ${broadMarket['SPY'] ?? 'N/A'}%`

  // Store impact
  await admin.from('macro_event_impacts').insert({
    event_id: eventId,
    measurement_window: window,
    spy_change_pct: broadMarket['SPY'],
    qqq_change_pct: broadMarket['QQQ'],
    dia_change_pct: broadMarket['DIA'],
    vix_change_pct: broadMarket['VIX'],
    sector_impacts: sectorImpacts,
    ticker_impacts: tickerImpacts,
    impact_summary: impactSummary,
  })

  // Update pattern library
  await updatePatternLibrary(event, sectorImpacts, tickerImpacts, broadMarket, window)
}

// ── Step 4: Update pattern library ───────────────────────────────────────────

async function updatePatternLibrary(
  event: any,
  sectorImpacts: Record<string, number>,
  tickerImpacts: Record<string, number>,
  broadMarket: Record<string, number | null>,
  window: string
): Promise<void> {
  const admin = getAdmin()

  const patternName = `${event.subcategory || event.category}`

  const { data: existing } = await admin
    .from('macro_patterns')
    .select('*')
    .eq('category', event.category)
    .eq('pattern_name', patternName)
    .maybeSingle()

  // Build sector playbook
  const sectorPlaybook: Record<string, any> = existing?.sector_playbook || {}
  for (const [etf, pct] of Object.entries(sectorImpacts)) {
    const sector = SECTOR_ETFS[etf] || etf
    const prev = sectorPlaybook[sector] || { avg: 0, count: 0, direction: 'neutral' }
    const newCount = prev.count + 1
    const newAvg = (prev.avg * prev.count + pct) / newCount
    sectorPlaybook[sector] = {
      avg: parseFloat(newAvg.toFixed(2)),
      count: newCount,
      direction: newAvg > 0.5 ? 'up' : newAvg < -0.5 ? 'down' : 'neutral',
    }
  }

  // Build ticker playbook
  const tickerPlaybook: Record<string, any> = existing?.ticker_playbook || {}
  for (const [ticker, pct] of Object.entries(tickerImpacts)) {
    const prev = tickerPlaybook[ticker] || { avg: 0, count: 0 }
    const newCount = prev.count + 1
    const newAvg = (prev.avg * prev.count + pct) / newCount
    tickerPlaybook[ticker] = {
      avg: parseFloat(newAvg.toFixed(2)),
      count: newCount,
      direction: newAvg > 0 ? 'up' : 'down',
    }
  }

  // Generate plain English summary
  const topUp = Object.entries(sectorPlaybook)
    .filter(([, v]: any) => v.direction === 'up')
    .sort((a: any, b: any) => b[1].avg - a[1].avg)
    .slice(0, 3)
    .map(([s, v]: any) => `${s} (+${v.avg}%)`)
    .join(', ')

  const topDown = Object.entries(sectorPlaybook)
    .filter(([, v]: any) => v.direction === 'down')
    .sort((a: any, b: any) => a[1].avg - b[1].avg)
    .slice(0, 3)
    .map(([s, v]: any) => `${s} (${v.avg}%)`)
    .join(', ')

  const playbookSummary = [
    topUp ? `Historically benefits: ${topUp}` : '',
    topDown ? `Historically hurts: ${topDown}` : '',
  ].filter(Boolean).join('. ')

  // Reliability = consistency of direction across events
  const directionConsistency = Object.values(sectorPlaybook)
    .filter((v: any) => v.count >= 2)
    .map((v: any) => v.direction !== 'neutral' ? 1 : 0)
  const reliabilityScore = directionConsistency.length > 0
    ? Math.round((directionConsistency.filter(Boolean).length / directionConsistency.length) * 100)
    : 50

  if (existing) {
    await admin.from('macro_patterns').update({
      event_count: existing.event_count + 1,
      last_seen: new Date().toISOString(),
      avg_spy_1d: window === '1D' ? (broadMarket['SPY'] ?? existing.avg_spy_1d) : existing.avg_spy_1d,
      avg_spy_1w: window === '1W' ? (broadMarket['SPY'] ?? existing.avg_spy_1w) : existing.avg_spy_1w,
      sector_playbook: sectorPlaybook,
      ticker_playbook: tickerPlaybook,
      playbook_summary: playbookSummary || existing.playbook_summary,
      reliability_score: reliabilityScore,
      updated_at: new Date().toISOString(),
    }).eq('id', existing.id)
  } else {
    await admin.from('macro_patterns').insert({
      category: event.category,
      subcategory: event.subcategory,
      pattern_name: patternName,
      event_count: 1,
      last_seen: new Date().toISOString(),
      avg_spy_1d: window === '1D' ? broadMarket['SPY'] : null,
      avg_spy_1w: window === '1W' ? broadMarket['SPY'] : null,
      avg_vix_1d: window === '1D' ? broadMarket['VIX'] : null,
      sector_playbook: sectorPlaybook,
      ticker_playbook: tickerPlaybook,
      playbook_summary: playbookSummary,
      reliability_score: reliabilityScore,
    })
  }
}

// ── Query functions for News Scout and pages ──────────────────────────────────

export async function getRelevantPatterns(
  categories: string[],
  sectors: string[]
): Promise<MacroPattern[]> {
  const admin = getAdmin()

  const { data } = await admin
    .from('macro_patterns')
    .select('*')
    .or(`category.in.(${categories.join(',')}),subcategory.in.(${categories.join(',')})`)
    .gte('event_count', 2) // only show patterns with at least 2 data points
    .order('reliability_score', { ascending: false })
    .limit(5)

  return data || []
}

export async function getActiveThemes(): Promise<ActiveMacroTheme[]> {
  const admin = getAdmin()
  const now = new Date().toISOString()

  const { data } = await admin
    .from('active_macro_themes')
    .select('*')
    .gt('expires_at', now)
    .order('urgency', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(5)

  return data || []
}

export async function getRecentMacroEvents(limit = 10): Promise<MacroEvent[]> {
  const admin = getAdmin()

  const { data } = await admin
    .from('macro_events')
    .select('*')
    .order('detected_at', { ascending: false })
    .limit(limit)

  return data || []
}

// ── Build context string for AI pipeline (News Scout) ────────────────────────

export async function buildMacroIntelligenceContext(
  ticker: string,
  sectors: string[]
): Promise<string> {
  const admin = getAdmin()

  // Get active themes
  const themes = await getActiveThemes()

  // Get relevant patterns for this ticker's sectors
  const patterns = await getRelevantPatterns(
    ['geopolitical', 'energy', 'policy', 'trade', 'fed'],
    sectors
  )

  // Get recent events that mention this ticker
  const { data: tickerEvents } = await admin
    .from('macro_events')
    .select('title, summary, sentiment, affected_sectors, mechanism')
    .contains('affected_tickers', [ticker])
    .order('detected_at', { ascending: false })
    .limit(3)

  if (themes.length === 0 && patterns.length === 0 && (!tickerEvents || tickerEvents.length === 0)) {
    return ''
  }

  const lines: string[] = ['=== MACRO INTELLIGENCE (GEOPOLITICAL & SYSTEMIC SIGNALS) ===']

  if (themes.length > 0) {
    lines.push('\nACTIVE MACRO THEMES (currently affecting markets):')
    for (const theme of themes) {
      lines.push(`• [${theme.urgency.toUpperCase()}] ${theme.theme_name}`)
      lines.push(`  ${theme.theme_summary}`)
      lines.push(`  Historical playbook: ${theme.playbook}`)
      if (theme.sectors_to_watch.length > 0) {
        lines.push(`  Watch sectors: ${theme.sectors_to_watch.join(', ')}`)
      }
    }
  }

  if (tickerEvents && tickerEvents.length > 0) {
    lines.push(`\nMACRO EVENTS DIRECTLY AFFECTING ${ticker}:`)
    for (const ev of tickerEvents) {
      lines.push(`• ${ev.title} (${ev.sentiment})`)
      lines.push(`  ${ev.summary}`)
      if (ev.mechanism) lines.push(`  Market mechanism: ${ev.mechanism}`)
    }
  }

  if (patterns.length > 0) {
    lines.push('\nHISTORICAL PATTERN LIBRARY (similar events and their market outcomes):')
    for (const p of patterns) {
      lines.push(`• Pattern: "${p.pattern_name}" (${p.event_count} historical occurrences, ${p.reliability_score}% reliable)`)
      if (p.playbook_summary) lines.push(`  ${p.playbook_summary}`)
      if (p.avg_spy_1w != null) lines.push(`  Avg SPY 1W impact: ${p.avg_spy_1w > 0 ? '+' : ''}${p.avg_spy_1w}%`)
    }
  }

  lines.push('\nINSTRUCTION: Use this macro intelligence as evidence in your analysis. If active themes directly affect this ticker or sector, weight them heavily. Reference specific historical patterns when making your case.')

  return lines.join('\n')
}

// ── Schedule follow-up impact measurements ───────────────────────────────────

export async function scheduleImpactMeasurements(): Promise<void> {
  const admin = getAdmin()
  const now = new Date()

  // Find events that need 1W measurement (7 days old, no 1W measurement yet)
  const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
  const { data: pending1W } = await admin
    .from('macro_events')
    .select('id')
    .lt('detected_at', oneWeekAgo.toISOString())
    .eq('resolved', false)
    .limit(5)

  for (const event of pending1W || []) {
    const { data: existing } = await admin
      .from('macro_event_impacts')
      .select('id')
      .eq('event_id', event.id)
      .eq('measurement_window', '1W')
      .maybeSingle()

    if (!existing) {
      await measureEventImpact(event.id, '1W').catch(console.error)
    }
  }

  // Expire old themes
  await admin
    .from('active_macro_themes')
    .update({ expires_at: now.toISOString() })
    .lt('expires_at', now.toISOString())
}

