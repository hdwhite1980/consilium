// ─────────────────────────────────────────────────────────────
// Wali-OS notification service
// Email: Resend   SMS: Twilio
// Dynamic imports — build succeeds even without packages at compile time
// ─────────────────────────────────────────────────────────────

export interface AlertNotification {
  userId: string
  email: string
  phone?: string | null
  ticker: string
  severity: 'watch' | 'alert' | 'urgent'
  title: string
  message: string
  price?: number | null
}

const SEVERITY_EMOJI = { urgent: '🚨', alert: '⚠️', watch: '👀' }
const SEVERITY_COLOR = { urgent: '#ef4444', alert: '#f97316', watch: '#fbbf24' }

export async function sendAlertEmail(n: AlertNotification) {
  if (!process.env.RESEND_API_KEY) return
  const emoji = SEVERITY_EMOJI[n.severity]
  const color = SEVERITY_COLOR[n.severity]
  const priceStr = n.price ? ` · $${n.price.toFixed(2)}` : ''
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { Resend } = await import('resend') as any
    const resend = new Resend(process.env.RESEND_API_KEY)
    await resend.emails.send({
      from: 'Wali-OS <alerts@wali-os.com>',
      to: n.email,
      subject: `${emoji} ${n.title}${priceStr}`,
      html: `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:0;padding:0;background:#0a0e17;font-family:-apple-system,sans-serif"><div style="max-width:520px;margin:0 auto;padding:32px 24px"><div style="margin-bottom:24px"><span style="color:#a78bfa;font-size:18px;font-weight:700">WALI-OS</span><span style="color:rgba(255,255,255,0.3);font-size:12px;margin-left:8px">Portfolio Alert</span></div><div style="background:#111620;border:1px solid ${color}40;border-left:3px solid ${color};border-radius:12px;padding:20px;margin-bottom:20px"><div style="margin-bottom:12px"><span style="background:${color}20;color:${color};font-size:10px;font-weight:700;padding:3px 8px;border-radius:20px">${n.severity.toUpperCase()}</span> <span style="color:rgba(255,255,255,0.9);font-size:16px;font-weight:700">${n.ticker}</span>${n.price ? ` <span style="color:rgba(255,255,255,0.4);font-size:13px">$${n.price.toFixed(2)}</span>` : ''}</div><p style="color:rgba(255,255,255,0.9);font-size:14px;font-weight:600;margin:0 0 8px">${n.title}</p><p style="color:rgba(255,255,255,0.6);font-size:13px;line-height:1.6;margin:0">${n.message}</p></div><div style="text-align:center;margin-bottom:24px"><a href="${process.env.NEXT_PUBLIC_APP_URL}/portfolio" style="display:inline-block;background:linear-gradient(135deg,#7c3aed,#4f46e5);color:#fff;font-size:13px;font-weight:600;padding:12px 24px;border-radius:10px;text-decoration:none">View Portfolio →</a></div><p style="color:rgba(255,255,255,0.2);font-size:11px;text-align:center;margin:0">Wali-OS AI Council · <a href="${process.env.NEXT_PUBLIC_APP_URL}/settings" style="color:rgba(255,255,255,0.2)">Manage alerts</a></p></div></body></html>`,
    })
  } catch (e) { console.error('Resend error:', e) }
}

export async function sendAlertSMS(n: AlertNotification) {
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN || !process.env.TWILIO_PHONE_NUMBER || !n.phone) return
  const emoji = SEVERITY_EMOJI[n.severity]
  const priceStr = n.price ? ` @ $${n.price.toFixed(2)}` : ''
  const body = `${emoji} Wali-OS: ${n.ticker}${priceStr} — ${n.title}. ${n.message.slice(0, 100)}${n.message.length > 100 ? '...' : ''} View: ${process.env.NEXT_PUBLIC_APP_URL}/portfolio`
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const twilio = ((await import('twilio')) as any).default
    const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
    await client.messages.create({ body, from: process.env.TWILIO_PHONE_NUMBER, to: n.phone })
  } catch (e) { console.error('Twilio error:', e) }
}

export async function sendAlert(n: AlertNotification, { email = true, sms = true } = {}) {
  const tasks = []
  if (email) tasks.push(sendAlertEmail(n))
  if (sms && n.phone) tasks.push(sendAlertSMS(n))
  await Promise.all(tasks)
}
