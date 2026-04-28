/**
 * GET /api/cron/overnight-brief?secret=XXX
 * Called by Railway cron daily at 09:00 UTC (= 4 AM ET EDT, 5 AM ET EST).
 * Schedule: 0 9 * * *
 *
 * For each user with active watchlist entries:
 *   1. Generate one brief per watched ticker
 *   2. Persist to watchlist_overnight_briefs (idempotent on user_id+ticker+brief_date)
 *   3. Send a single consolidated email per user (if email_enabled)
 *
 * Limits:
 *   - Max 25 tickers per user (cost cap, prevents runaway)
 *   - Skips muted tickers and expired watchlist entries
 *   - Skips option-type entries (only stocks/ETFs supported in v1)
 *   - Skips users who already have a brief for today's date (idempotency)
 */
import { NextRequest, NextResponse } from 'next/server'
import { createClient as createAdmin } from '@supabase/supabase-js'
import { generateOvernightBrief, type OvernightBrief } from '@/app/lib/overnight-brief'

const admin = () => createAdmin(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
)

const MAX_TICKERS_PER_USER = 25

// =============================================================
// Email template — multi-ticker consolidated brief
// =============================================================

const SEVERITY_COLOR = { high: '#ef4444', medium: '#f97316', low: '#fbbf24' }
const SKEW_COLOR: Record<string, string> = {
  bullish: '#10b981', bearish: '#ef4444', mixed: '#f97316',
  neutral: '#94a3b8', quiet: '#475569',
}
const SKEW_LABEL: Record<string, string> = {
  bullish: 'BULLISH', bearish: 'BEARISH', mixed: 'MIXED',
  neutral: 'NEUTRAL', quiet: 'QUIET',
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function renderBriefHTML(briefs: OvernightBrief[]): string {
  const sections = briefs.map(b => {
    const skew = b.sentiment_skew
    const skewColor = SKEW_COLOR[skew] ?? SKEW_COLOR.neutral
    const skewLabel = SKEW_LABEL[skew] ?? skew.toUpperCase()

    const itemRows = b.items.length === 0
      ? `<tr><td style="padding:12px 16px;color:#64748b;font-size:12px;font-style:italic;">No material items.</td></tr>`
      : b.items.map(it => {
          const sevColor = SEVERITY_COLOR[it.severity] ?? SEVERITY_COLOR.low
          const dirIcon = it.direction === 'bullish' ? '▲' : it.direction === 'bearish' ? '▼' : '◆'
          const dirColor = it.direction === 'bullish' ? '#10b981' : it.direction === 'bearish' ? '#ef4444' : '#94a3b8'
          const linkHtml = it.url
            ? `<a href="${escapeHtml(it.url)}" style="color:#a78bfa;text-decoration:none;">${escapeHtml(it.headline)}</a>`
            : escapeHtml(it.headline)
          return `
            <tr>
              <td style="padding:14px 16px;border-bottom:1px solid #1e2d40;">
                <div style="margin-bottom:6px;">
                  <span style="background:${sevColor}22;color:${sevColor};font-size:10px;font-weight:700;padding:2px 8px;border-radius:12px;text-transform:uppercase;">${it.severity}</span>
                  <span style="color:${dirColor};font-size:11px;margin-left:6px;">${dirIcon} ${it.direction}</span>
                </div>
                <div style="color:#e2e8f0;font-size:13px;font-weight:600;line-height:1.4;margin-bottom:6px;">${linkHtml}</div>
                <div style="color:#94a3b8;font-size:12px;line-height:1.5;">${escapeHtml(it.reasoning)}</div>
              </td>
            </tr>`
        }).join('')

    return `
      <div style="background:#111620;border:1px solid #1e2d40;border-radius:12px;overflow:hidden;margin-bottom:16px;">
        <div style="padding:14px 16px;border-bottom:1px solid #1e2d40;display:flex;justify-content:space-between;align-items:center;">
          <span style="color:#e2e8f0;font-size:18px;font-weight:700;">${escapeHtml(b.ticker)}</span>
          <span style="background:${skewColor}22;color:${skewColor};font-size:10px;font-weight:700;padding:3px 10px;border-radius:12px;letter-spacing:0.05em;">${skewLabel}</span>
        </div>
        <div style="padding:14px 16px;color:#cbd5e1;font-size:13px;line-height:1.6;border-bottom:1px solid #1e2d40;">
          ${escapeHtml(b.summary)}
        </div>
        <table style="width:100%;border-collapse:collapse;">${itemRows}</table>
      </div>`
  }).join('')

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;padding:0;background:#0a0e17;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <div style="max-width:600px;margin:0 auto;padding:24px 16px;">
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:24px;">
      <div style="width:36px;height:36px;background:rgba(167,139,250,0.15);border-radius:10px;display:flex;align-items:center;justify-content:center;">
        <span style="font-size:18px;">🌅</span>
      </div>
      <div>
        <div style="color:#a78bfa;font-size:11px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;">Wali-OS</div>
        <div style="color:#e2e8f0;font-size:16px;font-weight:700;">Overnight Brief · ${briefs[0]?.brief_date ?? new Date().toISOString().slice(0,10)}</div>
      </div>
    </div>
    <div style="color:#94a3b8;font-size:13px;line-height:1.6;margin-bottom:20px;">
      ${briefs.length} ticker${briefs.length === 1 ? '' : 's'} synthesized from overnight news. Material items prioritized; quiet sessions are flagged accordingly.
    </div>
    ${sections}
    <div style="margin-top:20px;text-align:center;">
      <a href="${process.env.NEXT_PUBLIC_APP_URL}/watchlist"
        style="display:inline-block;background:linear-gradient(135deg,#7c3aed,#4f46e5);color:#fff;text-decoration:none;padding:10px 24px;border-radius:8px;font-size:13px;font-weight:600;">
        Open Watchlist →
      </a>
    </div>
    <div style="margin-top:16px;text-align:center;color:#334155;font-size:11px;">
      You're receiving this because you have email notifications enabled.<br>
      <a href="${process.env.NEXT_PUBLIC_APP_URL}/settings" style="color:#475569;text-decoration:underline;">Manage notification settings</a>
    </div>
  </div>
</body>
</html>`
}

async function sendEmail(to: string, subject: string, html: string): Promise<{ ok: boolean; error?: string }> {
  const key = process.env.RESEND_API_KEY
  if (!key) return { ok: false, error: 'no RESEND_API_KEY' }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: process.env.RESEND_FROM ?? 'Wali-OS <alerts@wali-os.com>',
        to, subject, html,
      }),
    })
    if (!res.ok) {
      const errText = await res.text()
      return { ok: false, error: `${res.status}: ${errText.slice(0, 200)}` }
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

// =============================================================
// Cron handler
// =============================================================

export async function GET(req: NextRequest) {
  const secret = req.nextUrl.searchParams.get('secret') || req.headers.get('x-cron-secret')
  if (secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const startTime = Date.now()
  const sb = admin()
  const today = new Date().toISOString().slice(0, 10)

  // 1. Get all active stock watchlist entries grouped by user
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: entries, error: entriesErr } = await (sb as any)
    .from('watchlist_entries')
    .select('user_id, ticker')
    .eq('muted', false)
    .or('expires_at.is.null,expires_at.gt.' + new Date().toISOString())
    .or('asset_type.is.null,asset_type.eq.stock')

  if (entriesErr) {
    return NextResponse.json({ error: 'Failed to load watchlist', detail: entriesErr.message }, { status: 500 })
  }

  // Group by user, dedupe tickers, cap per user
  const byUser = new Map<string, Set<string>>()
  for (const row of (entries ?? []) as Array<{ user_id: string; ticker: string }>) {
    if (!row.user_id || !row.ticker) continue
    const set = byUser.get(row.user_id) ?? new Set<string>()
    if (set.size < MAX_TICKERS_PER_USER) {
      set.add(row.ticker.toUpperCase())
      byUser.set(row.user_id, set)
    }
  }

  let totalBriefs = 0
  let totalEmails = 0
  let totalErrors = 0
  const userResults: Array<{ user_id: string; tickers: number; emailed: boolean; error?: string }> = []

  // 2. For each user, generate briefs and email
  for (const [userId, tickerSet] of byUser.entries()) {
    const tickers = Array.from(tickerSet)
    const briefs: OvernightBrief[] = []

    // Skip if user already has briefs for today (idempotency)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: existing } = await (sb as any)
      .from('watchlist_overnight_briefs')
      .select('ticker')
      .eq('user_id', userId)
      .eq('brief_date', today)

    const alreadyDone = new Set<string>(((existing ?? []) as Array<{ ticker: string }>).map(r => r.ticker.toUpperCase()))
    const tickersToGenerate = tickers.filter(t => !alreadyDone.has(t))

    // Generate briefs (sequential — avoids parallel LLM rate limits)
    for (const ticker of tickersToGenerate) {
      try {
        const brief = await generateOvernightBrief(ticker)
        briefs.push(brief)

        // Persist
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (sb as any).from('watchlist_overnight_briefs').upsert({
          user_id: userId,
          ticker: brief.ticker,
          brief_date: brief.brief_date,
          summary: brief.summary,
          sentiment_skew: brief.sentiment_skew,
          items: brief.items,
          news_count: brief.news_count,
          news_window_start: brief.news_window_start,
          news_window_end: brief.news_window_end,
          llm_input_tokens: brief.llm_input_tokens ?? null,
          llm_output_tokens: brief.llm_output_tokens ?? null,
          generation_ms: brief.generation_ms,
        }, { onConflict: 'user_id,ticker,brief_date' })

        totalBriefs++
      } catch (e) {
        totalErrors++
        console.error(`[overnight-brief] failed for ${userId}/${ticker}:`, e)
      }
    }

    // Also load any briefs already generated today (so the email is complete)
    if (alreadyDone.size > 0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: previous } = await (sb as any)
        .from('watchlist_overnight_briefs')
        .select('*')
        .eq('user_id', userId)
        .eq('brief_date', today)
      for (const row of (previous ?? []) as Array<Record<string, unknown>>) {
        briefs.push({
          ticker: String(row.ticker),
          brief_date: String(row.brief_date),
          summary: String(row.summary),
          sentiment_skew: row.sentiment_skew as OvernightBrief['sentiment_skew'],
          items: (row.items as OvernightBrief['items']) ?? [],
          news_count: Number(row.news_count) || 0,
          news_window_start: String(row.news_window_start),
          news_window_end: String(row.news_window_end),
          generation_ms: Number(row.generation_ms) || 0,
        })
      }
    }

    if (briefs.length === 0) {
      userResults.push({ user_id: userId, tickers: 0, emailed: false })
      continue
    }

    // Sort briefs: high-severity first, then by ticker
    briefs.sort((a, b) => {
      const aw = a.sentiment_skew === 'quiet' ? 1 : 0
      const bw = b.sentiment_skew === 'quiet' ? 1 : 0
      if (aw !== bw) return aw - bw  // non-quiet first
      return a.ticker.localeCompare(b.ticker)
    })

    // 3. Email delivery — check user prefs first
    let emailed = false
    let emailError: string | undefined

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: prefs } = await (sb as any)
      .from('notification_preferences')
      .select('email_enabled')
      .eq('user_id', userId)
      .maybeSingle()

    if (prefs?.email_enabled) {
      // Get user email from auth.users
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: userRec } = await (sb as any).auth.admin.getUserById(userId)
      const email = userRec?.user?.email

      if (email) {
        const nonQuiet = briefs.filter(b => b.sentiment_skew !== 'quiet').length
        const subject = nonQuiet > 0
          ? `🌅 Overnight Brief: ${nonQuiet} ticker${nonQuiet === 1 ? '' : 's'} with material news`
          : `🌅 Overnight Brief: ${briefs.length} ticker${briefs.length === 1 ? '' : 's'} (quiet session)`

        const send = await sendEmail(email, subject, renderBriefHTML(briefs))
        if (send.ok) {
          emailed = true
          totalEmails++
          // Mark all of today's briefs as delivered
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await (sb as any)
            .from('watchlist_overnight_briefs')
            .update({ delivered_at: new Date().toISOString() })
            .eq('user_id', userId)
            .eq('brief_date', today)
        } else {
          emailError = send.error
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await (sb as any)
            .from('watchlist_overnight_briefs')
            .update({ delivery_error: send.error })
            .eq('user_id', userId)
            .eq('brief_date', today)
        }
      } else {
        emailError = 'no email on user record'
      }
    }

    userResults.push({
      user_id: userId,
      tickers: briefs.length,
      emailed,
      error: emailError,
    })
  }

  return NextResponse.json({
    ok: true,
    duration_ms: Date.now() - startTime,
    users_processed: byUser.size,
    total_briefs: totalBriefs,
    total_emails: totalEmails,
    total_errors: totalErrors,
    user_results: userResults,
  })
}
