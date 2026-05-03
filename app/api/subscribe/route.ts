// ════════════════════════════════════════════════════════════════
// app/api/subscribe/route.ts
//
// POST /api/subscribe
//   body: { email: string, newsletterOptIn?: boolean, source?: string }
//
// Handles the /track-record soft email gate.
//   1. Validates and lowercases email
//   2. Upserts into email_subscribers (dedup by email)
//   3. Best-effort syncs to Resend audience (if RESEND_AUDIENCE_ID set)
//   4. Best-effort sends a welcome email (if newsletter_opt_in)
//   5. Sets `wali_track_record_unlocked=1` cookie (365 days) so the
//      gate stays unlocked on this device.
//
// Resend failures are NON-BLOCKING. The cookie is set and the user
// gets through the gate even if email infra is down — that's the
// product flow. Errors are logged for triage.
// ════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/app/lib/auth/server'
import { createClient as createAdmin } from '@supabase/supabase-js'

export const runtime = 'nodejs'

const UNLOCK_COOKIE_NAME = 'wali_track_record_unlocked'
const UNLOCK_COOKIE_MAX_AGE = 60 * 60 * 24 * 365 // 365 days
const FROM_ADDRESS = process.env.RESEND_NEWSLETTER_FROM ?? 'Wali-OS <hello@wali-os.com>'

// Basic RFC-5322-ish validator. Not exhaustive, but rejects the
// obvious garbage. Resend will do its own validation downstream.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

interface SubscribeBody {
  email?: unknown
  newsletterOptIn?: unknown
  source?: unknown
}

function getAdmin() {
  return createAdmin(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )
}

// ─────────────────────────────────────────────────────────────
// Resend helpers — kept inline. No shared lib/email wrapper exists
// yet in the repo; if one is introduced later, replace these.
// ─────────────────────────────────────────────────────────────

interface ResendContactResponse {
  data?: { id?: string }
  error?: { message?: string; statusCode?: number }
}

async function syncToResendAudience(email: string): Promise<string | null> {
  const apiKey = process.env.RESEND_API_KEY
  const audienceId = process.env.RESEND_AUDIENCE_ID

  if (!apiKey) {
    console.warn('[subscribe] RESEND_API_KEY not set — skipping audience sync')
    return null
  }
  if (!audienceId) {
    console.warn('[subscribe] RESEND_AUDIENCE_ID not set — skipping audience sync')
    return null
  }

  try {
    const res = await fetch(`https://api.resend.com/audiences/${audienceId}/contacts`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email, unsubscribed: false }),
    })
    const json = (await res.json().catch(() => ({}))) as ResendContactResponse
    if (!res.ok) {
      console.error(`[subscribe] Resend audience sync failed (${res.status}):`, json.error?.message ?? 'unknown')
      return null
    }
    return json.data?.id ?? null
  } catch (e) {
    console.error('[subscribe] Resend audience sync threw:', (e as Error).message)
    return null
  }
}

interface ResendSendResponse {
  data?: { id?: string }
  error?: { message?: string; statusCode?: number }
}

async function sendWelcomeEmail(email: string): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey) {
    console.warn('[subscribe] RESEND_API_KEY not set — skipping welcome email')
    return false
  }

  const subject = 'Welcome to the Wali-OS track record'
  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; color: #1a1a1a;">
      <h1 style="font-size: 22px; margin: 0 0 16px;">You're in.</h1>
      <p style="font-size: 15px; line-height: 1.6; margin: 0 0 16px;">
        Thanks for signing up. You'll get the Wali-OS track record updates as new verdicts resolve.
      </p>
      <p style="font-size: 15px; line-height: 1.6; margin: 0 0 16px;">
        The track record page is now unlocked on this device — bookmark it:
      </p>
      <p style="margin: 0 0 24px;">
        <a href="https://wali-os.com/track-record"
           style="background: #7c3aed; color: white; text-decoration: none; padding: 12px 20px; border-radius: 8px; font-weight: 600; display: inline-block;">
          View track record
        </a>
      </p>
      <p style="font-size: 13px; color: #666; line-height: 1.5; margin: 24px 0 0; border-top: 1px solid #eee; padding-top: 16px;">
        Wali-OS is informational only and not financial advice. You can unsubscribe any time from the link in future emails.
      </p>
    </div>
  `.trim()

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: FROM_ADDRESS,
        to: email,
        subject,
        html,
      }),
    })
    const json = (await res.json().catch(() => ({}))) as ResendSendResponse
    if (!res.ok) {
      console.error(`[subscribe] welcome email send failed (${res.status}):`, json.error?.message ?? 'unknown')
      return false
    }
    return true
  } catch (e) {
    console.error('[subscribe] welcome email send threw:', (e as Error).message)
    return false
  }
}

// ─────────────────────────────────────────────────────────────
// Route handler
// ─────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as SubscribeBody

  const rawEmail = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
  const newsletterOptIn = body.newsletterOptIn === true
  const source = typeof body.source === 'string' && body.source.length > 0 && body.source.length < 64
    ? body.source
    : 'track_record_gate'

  if (!rawEmail || !EMAIL_RE.test(rawEmail)) {
    return NextResponse.json({ error: 'Please enter a valid email address.' }, { status: 400 })
  }

  // Capture optional context (useful for triage/abuse review)
  const ipHint = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null
  const userAgentHint = req.headers.get('user-agent')?.slice(0, 200) ?? null

  // If the visitor happens to be logged in, attach their user_id
  let userId: string | null = null
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    userId = user?.id ?? null
  } catch {
    // Auth not available is fine — gate works for anonymous visitors
    userId = null
  }

  const admin = getAdmin()

  // Check if already exists (drives alreadySubscribed flag in response)
  const { data: existing } = await admin
    .from('email_subscribers')
    .select('id, email, resend_contact_id')
    .eq('email', rawEmail)
    .maybeSingle()

  let alreadySubscribed = false
  let dbError: string | null = null

  if (existing) {
    alreadySubscribed = true
    // Touch updated_at + opt-in if they re-subscribed with the box checked
    if (newsletterOptIn) {
      await admin
        .from('email_subscribers')
        .update({ newsletter_opt_in: true, updated_at: new Date().toISOString() })
        .eq('id', existing.id)
    }
  } else {
    // Sync to Resend BEFORE insert so we can store the contact id
    const resendContactId = await syncToResendAudience(rawEmail)

    const { error: insertErr } = await admin
      .from('email_subscribers')
      .insert({
        email: rawEmail,
        user_id: userId,
        source,
        newsletter_opt_in: newsletterOptIn,
        resend_contact_id: resendContactId,
        ip_hint: ipHint,
        user_agent_hint: userAgentHint,
      })

    if (insertErr) {
      // Race condition: another request inserted the same email between
      // our check and our insert. Treat as already-subscribed.
      if (insertErr.code === '23505') {
        alreadySubscribed = true
      } else {
        console.error('[subscribe] insert failed:', insertErr.message)
        dbError = insertErr.message
      }
    } else if (newsletterOptIn) {
      // Best-effort welcome email. Don't block the response on this.
      sendWelcomeEmail(rawEmail).catch(e => {
        console.error('[subscribe] sendWelcomeEmail unexpected:', (e as Error).message)
      })
    }
  }

  // If the DB insert genuinely failed (not a dedup race), surface that —
  // we DON'T want to set the cookie because the email isn't actually saved.
  if (dbError) {
    return NextResponse.json({ error: 'Could not save your email. Please try again.' }, { status: 500 })
  }

  // Build response with unlock cookie
  const res = NextResponse.json({ ok: true, alreadySubscribed })

  res.cookies.set(UNLOCK_COOKIE_NAME, '1', {
    path: '/',
    maxAge: UNLOCK_COOKIE_MAX_AGE,
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
  })

  return res
}
