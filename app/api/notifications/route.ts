import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/app/lib/auth/server'
import { createClient as createAdmin } from '@supabase/supabase-js'

const admin = () => createAdmin(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// ── Email via Resend ───────────────────────────────────────────
async function sendEmail(to: string, subject: string, html: string): Promise<boolean> {
  const key = process.env.RESEND_API_KEY
  if (!key) { console.warn('No RESEND_API_KEY'); return false }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: process.env.RESEND_FROM ?? 'Consilium Alerts <alerts@consilium.app>',
        to,
        subject,
        html,
      }),
    })
    if (!res.ok) {
      console.error('Resend error:', res.status, await res.text())
      return false
    }
    return true
  } catch (e) {
    console.error('Resend exception:', e)
    return false
  }
}

// ── SMS via Twilio ─────────────────────────────────────────────
async function sendSMS(to: string, body: string): Promise<boolean> {
  const sid    = process.env.TWILIO_ACCOUNT_SID
  const token  = process.env.TWILIO_AUTH_TOKEN
  const from   = process.env.TWILIO_PHONE_NUMBER
  if (!sid || !token || !from) { console.warn('Twilio not configured'); return false }
  try {
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ To: to, From: from, Body: body }).toString(),
      }
    )
    if (!res.ok) {
      console.error('Twilio error:', res.status, await res.text())
      return false
    }
    return true
  } catch (e) {
    console.error('Twilio exception:', e)
    return false
  }
}

// ── Alert email template ───────────────────────────────────────
function alertEmailHTML(alerts: Array<{ ticker: string; severity: string; title: string; message: string; price: number | null }>) {
  const COLORS: Record<string, string> = { urgent: '#ef4444', alert: '#f97316', watch: '#fbbf24' }
  const rows = alerts.map(a => `
    <tr>
      <td style="padding:12px 16px;border-bottom:1px solid #1e2d40;">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
          <span style="background:${COLORS[a.severity]}22;color:${COLORS[a.severity]};font-size:10px;font-weight:700;padding:2px 8px;border-radius:12px;text-transform:uppercase;">${a.severity}</span>
          <span style="color:#e2e8f0;font-weight:700;font-size:14px;">${a.ticker}</span>
          ${a.price ? `<span style="color:#64748b;font-size:12px;font-family:monospace;">$${a.price.toFixed(2)}</span>` : ''}
        </div>
        <div style="color:#e2e8f0;font-size:13px;font-weight:600;margin-bottom:4px;">${a.title}</div>
        <div style="color:#94a3b8;font-size:12px;line-height:1.5;">${a.message}</div>
      </td>
    </tr>`).join('')

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;padding:0;background:#0a0e17;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <div style="max-width:600px;margin:0 auto;padding:24px 16px;">
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:24px;">
      <div style="width:36px;height:36px;background:rgba(167,139,250,0.15);border-radius:10px;display:flex;align-items:center;justify-content:center;">
        <span style="font-size:18px;">⚡</span>
      </div>
      <div>
        <div style="color:#a78bfa;font-size:11px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;">Consilium</div>
        <div style="color:#e2e8f0;font-size:16px;font-weight:700;">Portfolio Alert${alerts.length > 1 ? 's' : ''}</div>
      </div>
    </div>
    <table style="width:100%;border-collapse:collapse;background:#111620;border-radius:12px;overflow:hidden;border:1px solid #1e2d40;">
      ${rows}
    </table>
    <div style="margin-top:20px;text-align:center;">
      <a href="${process.env.NEXT_PUBLIC_APP_URL}/portfolio" 
        style="display:inline-block;background:linear-gradient(135deg,#7c3aed,#4f46e5);color:#fff;text-decoration:none;padding:10px 24px;border-radius:8px;font-size:13px;font-weight:600;">
        View Portfolio →
      </a>
    </div>
    <div style="margin-top:16px;text-align:center;color:#334155;font-size:11px;">
      You're receiving this because you have portfolio alerts enabled.<br>
      <a href="${process.env.NEXT_PUBLIC_APP_URL}/settings" style="color:#475569;text-decoration:underline;">Manage notification settings</a>
    </div>
  </div>
</body>
</html>`
}

// ── GET — load notification preferences ───────────────────────
export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const { data } = await admin()
    .from('notification_preferences')
    .select('*')
    .eq('user_id', user.id)
    .maybeSingle()

  return NextResponse.json({
    prefs: data ?? {
      email_enabled: false,
      sms_enabled: false,
      phone: null,
      min_severity: 'alert',
    }
  })
}

// ── POST — save preferences ────────────────────────────────────
export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const { email_enabled, sms_enabled, phone, min_severity } = await req.json()

  await admin().from('notification_preferences').upsert({
    user_id: user.id,
    email_enabled: !!email_enabled,
    sms_enabled: !!sms_enabled,
    phone: phone ?? null,
    min_severity: min_severity ?? 'alert',
    updated_at: new Date().toISOString(),
  }, { onConflict: 'user_id' })

  return NextResponse.json({ success: true })
}

// ── PUT — send notifications for pending alerts ────────────────
export async function PUT() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  // Get preferences
  const { data: prefs } = await admin()
    .from('notification_preferences')
    .select('*')
    .eq('user_id', user.id)
    .maybeSingle()

  if (!prefs?.email_enabled && !prefs?.sms_enabled) {
    return NextResponse.json({ sent: 0, reason: 'notifications disabled' })
  }

  // Get unnotified alerts matching severity threshold
  const severityRank: Record<string, number> = { watch: 1, alert: 2, urgent: 3 }
  const minRank = severityRank[prefs.min_severity ?? 'alert'] ?? 2

  const { data: alerts } = await admin()
    .from('portfolio_alerts')
    .select('*')
    .eq('user_id', user.id)
    .eq('notified', false)
    .eq('acknowledged', false)
    .order('created_at', { ascending: false })
    .limit(10)

  const toNotify = (alerts ?? []).filter(a => (severityRank[a.severity] ?? 1) >= minRank)
  if (!toNotify.length) return NextResponse.json({ sent: 0 })

  const results = { email: false, sms: false }

  // Email
  if (prefs.email_enabled && user.email) {
    const urgentCount = toNotify.filter(a => a.severity === 'urgent').length
    const subject = urgentCount > 0
      ? `🚨 ${urgentCount} urgent portfolio alert${urgentCount > 1 ? 's' : ''} — Consilium`
      : `📊 ${toNotify.length} portfolio alert${toNotify.length > 1 ? 's' : ''} — Consilium`

    results.email = await sendEmail(user.email, subject, alertEmailHTML(toNotify))
  }

  // SMS — send a concise summary
  if (prefs.sms_enabled && prefs.phone) {
    const urgents = toNotify.filter(a => a.severity === 'urgent')
    const most = urgents[0] ?? toNotify[0]
    const smsBody = urgents.length > 0
      ? `⚠️ Consilium URGENT: ${most.ticker} — ${most.title}. Price: $${most.price?.toFixed(2) ?? 'N/A'}. View: ${process.env.NEXT_PUBLIC_APP_URL}/portfolio`
      : `📊 Consilium: ${toNotify.length} portfolio alert${toNotify.length > 1 ? 's' : ''}. Top: ${most.title}. View: ${process.env.NEXT_PUBLIC_APP_URL}/portfolio`

    results.sms = await sendSMS(prefs.phone, smsBody)
  }

  // Mark as notified
  const ids = toNotify.map(a => a.id)
  await admin().from('portfolio_alerts').update({ notified: true }).in('id', ids)

  return NextResponse.json({ sent: toNotify.length, results })
}
