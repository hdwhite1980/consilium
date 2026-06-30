// Public grouped verdict feed: every Council verdict (auto-trader + manual),
// grouped by timeframe (1D / 1W / 1M) and then by company. Verdict-only fields
// (signal / entry / stop / target) plus the resolved directional outcome, which
// is the track record itself. No per-user auth — this is the public scoreboard;
// the page applies the email gate for UX.
import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/app/lib/admin/admin-auth'
import { SYSTEM_VERSIONS, getVersionsNewestFirst, getCurrentVersion } from '@/app/lib/system-versions'

export const dynamic = 'force-dynamic'

type TF = '1D' | '1W' | '1M'

interface VerdictRow {
  id: number
  ticker: string | null
  signal: string | null
  confidence: number | null
  entry_price: number | null
  stop_loss: number | null
  take_profit: number | null
  timeframe: string | null
  source: string | null
  version_number: number | null
  verdict_date: string | null
  created_at: string | null
  outcome_1d_directional: string | null
  outcome_1w_directional: string | null
  outcome_1m_directional: string | null
  outcome_1d_strict: string | null
  outcome_1w_strict: string | null
  outcome_1m_strict: string | null
}

interface PublicVerdict {
  id: number
  ticker: string
  signal: string
  confidence: number | null
  entryPrice: number | null
  stopLoss: number | null
  takeProfit: number | null
  source: string
  sourceLabel: string
  isAuto: boolean
  verdictDate: string | null
  createdAt: string | null
  outcome: string          // directional: win | loss | pending | expired
  outcomeStrict: string | null
}

interface CompanyGroup {
  ticker: string
  verdicts: PublicVerdict[]
  wins: number
  losses: number
  graded: number
}

interface TimeframeGroup {
  timeframe: TF
  label: string
  companies: CompanyGroup[]
  totalVerdicts: number
  wins: number
  losses: number
  graded: number
}

const TF_META: Record<TF, string> = {
  '1D': 'Intraday — 1 Day',
  '1W': 'Swing — 1 Week',
  '1M': 'Position — 1 Month',
}

function sourceLabel(src: string | null): { label: string; isAuto: boolean } {
  switch (src) {
    case 'day_shark':            return { label: 'Max · auto', isAuto: true }
    case 'active_story':         return { label: 'Wali · stories', isAuto: true }
    case 'live_movers_crypto':   return { label: 'Wali · crypto movers', isAuto: true }
    case 'live_movers_futures':  return { label: 'Wali · futures movers', isAuto: true }
    case 'council':              return { label: 'Wali · auto', isAuto: true }
    case 'scanner':              return { label: 'Wali · scanner', isAuto: true }
    case 'reeval_add':           return { label: 'Wali · re-eval', isAuto: true }
    case 'legacy':               return { label: 'Manual', isAuto: false }
    default:                     return { label: 'Manual', isAuto: false }
  }
}

function normalizeTF(raw: string | null): TF | null {
  const t = (raw ?? '').toUpperCase()
  if (t === '1D') return '1D'
  if (t === '1W') return '1W'
  if (t === '1M') return '1M'
  return null
}

function outcomeForTF(v: VerdictRow, tf: TF): { directional: string; strict: string | null } {
  if (tf === '1D') return { directional: v.outcome_1d_directional ?? 'pending', strict: v.outcome_1d_strict }
  if (tf === '1W') return { directional: v.outcome_1w_directional ?? 'pending', strict: v.outcome_1w_strict }
  return { directional: v.outcome_1m_directional ?? 'pending', strict: v.outcome_1m_strict }
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const admin = await getSupabaseAdmin()
    const url = new URL(req.url)
    const limit = Math.min(1000, Math.max(50, Number(url.searchParams.get('limit') ?? '400')))

    // Version selection: 'all' (default) or a specific version number.
    const versionParam = url.searchParams.get('version') ?? 'all'
    const versionNum = versionParam !== 'all' ? parseInt(versionParam, 10) : null
    const filterVersion = versionNum !== null && Number.isFinite(versionNum)

    let q = admin
      .from('verdict_log')
      .select(
        'id, ticker, signal, confidence, entry_price, stop_loss, take_profit, timeframe, ' +
        'source, version_number, verdict_date, created_at, ' +
        'outcome_1d_directional, outcome_1w_directional, outcome_1m_directional, ' +
        'outcome_1d_strict, outcome_1w_strict, outcome_1m_strict',
      )
      .not('signal', 'is', null)
      .not('ticker', 'is', null)
    if (filterVersion) q = q.eq('version_number', versionNum)
    const { data, error } = await q
      .order('verdict_date', { ascending: false, nullsFirst: false })
      .limit(limit)

    if (error) {
      console.error('[verdicts/feed] query error:', error.message)
      return NextResponse.json({ ok: false, error: 'query failed' }, { status: 500 })
    }

    // Version tabs: count verdicts per version so the UI can show All-time + each
    // version with its size. One lightweight pass over recent verdicts.
    const { data: vcRows } = await admin
      .from('verdict_log')
      .select('version_number')
      .not('signal', 'is', null)
      .not('ticker', 'is', null)
      .limit(5000)
    const counts = new Map<number, number>()
    let allCount = 0
    for (const r of (vcRows ?? []) as Array<{ version_number: number | null }>) {
      allCount++
      const vn = r.version_number
      if (vn != null) counts.set(vn, (counts.get(vn) ?? 0) + 1)
    }
    const versions = [
      { number: null as number | null, label: 'All-time', subtitle: '', maturity: 'mature' as string, count: allCount, isCurrent: false },
      ...getVersionsNewestFirst().map(v => ({
        number: v.number,
        label: v.label,
        subtitle: v.subtitle ?? '',
        maturity: v.maturity,
        count: counts.get(v.number) ?? 0,
        isCurrent: v.number === getCurrentVersion().number,
      })),
    ]
    const selectedVersion = filterVersion
      ? (SYSTEM_VERSIONS.find(v => v.number === versionNum) ?? null)
      : null

    const rows = (data ?? []) as unknown as VerdictRow[]
    const buckets: Record<TF, Map<string, PublicVerdict[]>> = {
      '1D': new Map(), '1W': new Map(), '1M': new Map(),
    }

    for (const v of rows) {
      const tf = normalizeTF(v.timeframe)
      if (!tf) continue
      const ticker = (v.ticker ?? '').toUpperCase()
      if (!ticker) continue
      const { label, isAuto } = sourceLabel(v.source)
      const oc = outcomeForTF(v, tf)
      const pv: PublicVerdict = {
        id: v.id,
        ticker,
        signal: v.signal ?? '',
        confidence: v.confidence,
        entryPrice: v.entry_price != null ? Number(v.entry_price) : null,
        stopLoss: v.stop_loss != null ? Number(v.stop_loss) : null,
        takeProfit: v.take_profit != null ? Number(v.take_profit) : null,
        source: v.source ?? 'manual',
        sourceLabel: label,
        isAuto,
        verdictDate: v.verdict_date,
        createdAt: v.created_at,
        outcome: oc.directional,
        outcomeStrict: oc.strict,
      }
      const m = buckets[tf]
      if (!m.has(ticker)) m.set(ticker, [])
      m.get(ticker)!.push(pv)
    }

    const groups: TimeframeGroup[] = (['1D', '1W', '1M'] as TF[]).map(tf => {
      const companies: CompanyGroup[] = [...buckets[tf].entries()]
        .map(([ticker, verdicts]) => {
          const wins = verdicts.filter(v => v.outcome === 'win').length
          const losses = verdicts.filter(v => v.outcome === 'loss').length
          return { ticker, verdicts, wins, losses, graded: wins + losses }
        })
        .sort((a, b) => {
          const ad = a.verdicts[0]?.verdictDate ?? ''
          const bd = b.verdicts[0]?.verdictDate ?? ''
          return bd.localeCompare(ad)
        })
      const wins = companies.reduce((s, c) => s + c.wins, 0)
      const losses = companies.reduce((s, c) => s + c.losses, 0)
      const totalVerdicts = companies.reduce((s, c) => s + c.verdicts.length, 0)
      return { timeframe: tf, label: TF_META[tf], companies, totalVerdicts, wins, losses, graded: wins + losses }
    })

    const totalVerdicts = groups.reduce((s, g) => s + g.totalVerdicts, 0)
    const totalGraded = groups.reduce((s, g) => s + g.graded, 0)
    const totalWins = groups.reduce((s, g) => s + g.wins, 0)

    return NextResponse.json({
      ok: true,
      generatedAt: new Date().toISOString(),
      groups,
      stats: {
        totalVerdicts,
        totalGraded,
        totalWins,
        hitRate: totalGraded > 0 ? Number(((totalWins / totalGraded) * 100).toFixed(1)) : null,
      },
      versions,
      selectedVersion: selectedVersion
        ? {
            number: selectedVersion.number,
            label: selectedVersion.label,
            subtitle: selectedVersion.subtitle ?? '',
            summary: selectedVersion.summary,
            maturity: selectedVersion.maturity,
          }
        : null,
    })
  } catch (e) {
    console.error('[verdicts/feed] error:', e instanceof Error ? e.message : e)
    return NextResponse.json({ ok: false, error: 'internal error' }, { status: 500 })
  }
}
