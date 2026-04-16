'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/app/lib/auth/client'
import { ArrowLeft, Shield, ShieldCheck, ShieldOff, LogOut, CreditCard, Zap, Crown, CheckCircle, ExternalLink } from 'lucide-react'

interface MFAFactor { id: string; factor_type: string; status: string; friendly_name?: string }

interface SubInfo {
  status: string
  tier: 'standard' | 'pro'
  daysLeft: number | null
  trialEndsAt: string | null
  hasAccess: boolean
}

function useDarkMode() {
  const [isDark, setIsDark] = useState(true)
  useEffect(() => {
    const check = () => setIsDark(document.documentElement.getAttribute('data-theme') !== 'light')
    check()
    const obs = new MutationObserver(check)
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => obs.disconnect()
  }, [])
  return isDark
}

export default function SettingsPage() {
  const router = useRouter()
  const [user, setUser] = useState<{ email: string } | null>(null)
  const [factors, setFactors] = useState<MFAFactor[]>([])
  const [sub, setSub] = useState<SubInfo | null>(null)
  const [loading, setLoading] = useState(true)

  // MFA state
  const [enrolling, setEnrolling] = useState(false)
  const [qrCode, setQrCode] = useState('')
  const [factorId, setFactorId] = useState('')
  const [verifyCode, setVerifyCode] = useState('')
  const [mfaError, setMfaError] = useState('')
  const [mfaSuccess, setMfaSuccess] = useState('')

  // Password state
  const [newPw, setNewPw] = useState('')
  const [pwError, setPwError] = useState('')
  const [pwSuccess, setPwSuccess] = useState('')

  // Billing state
  const [billingLoading, setBillingLoading] = useState(false)
  const [notifPrefs, setNotifPrefs] = useState({ email_enabled: false, sms_enabled: false, phone: '', min_severity: 'alert' })
  const [notifSaving, setNotifSaving] = useState(false)
  const [notifSaved, setNotifSaved] = useState(false)

  const isDark = useDarkMode()
  const txt  = isDark ? 'rgba(255,255,255,0.9)' : 'rgba(0,0,0,0.9)'
  const txt2 = isDark ? 'rgba(255,255,255,0.55)' : 'rgba(0,0,0,0.55)'
  const txt3 = isDark ? 'rgba(255,255,255,0.28)' : 'rgba(0,0,0,0.35)'
  const surf = isDark ? '#111620' : '#ffffff'
  const surf2 = isDark ? '#181e2a' : '#f5f7fb'
  const brd  = isDark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.08)'
  const inputBg = isDark ? '#1a2236' : '#f5f7fb'

  useEffect(() => {
    const init = async () => {
      const supabase = createClient()
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) { router.push('/login'); return }
      setUser({ email: user.email! })

      // Load MFA factors
      const { data: listData } = await supabase.auth.mfa.listFactors()
      setFactors((listData?.totp ?? listData?.all?.filter(f => f.factor_type === 'totp') ?? []) as MFAFactor[])

      // Load subscription info
      try {
        const res = await fetch('/api/auth/session')
        const data = await res.json()
        setSub(data)
      } catch { /* ignore */ }

      // Load notification preferences
      try {
        const nr = await fetch('/api/notifications')
        const nd = await nr.json()
        if (nd.prefs) setNotifPrefs({
          email_enabled: nd.prefs.email_enabled ?? false,
          sms_enabled: nd.prefs.sms_enabled ?? false,
          phone: nd.prefs.phone ?? '',
          min_severity: nd.prefs.min_severity ?? 'alert',
        })
      } catch { /* ignore */ }

      setLoading(false)
    }
    init()
  }, [router])

  const enrollMFA = async () => {
    setMfaError('')
    const supabase = createClient()
    const { data, error } = await supabase.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'Consilium' })
    if (error || !data) { setMfaError(error?.message ?? 'Failed to enroll'); return }
    setQrCode(data.totp.qr_code)
    setFactorId(data.id)
    setEnrolling(true)
  }

  const verifyMFA = async () => {
    if (!factorId || verifyCode.length !== 6) return
    setMfaError('')
    const supabase = createClient()
    const { data: challengeData, error: cErr } = await supabase.auth.mfa.challenge({ factorId })
    if (cErr || !challengeData) { setMfaError(cErr?.message ?? 'Challenge failed'); return }
    const { error: vErr } = await supabase.auth.mfa.verify({ factorId, challengeId: challengeData.id, code: verifyCode })
    if (vErr) { setMfaError(vErr.message); return }
    setMfaSuccess('Two-factor authentication enabled!')
    setEnrolling(false)
    const { data: listData2 } = await supabase.auth.mfa.listFactors()
    setFactors((listData2?.totp ?? listData2?.all?.filter(f => f.factor_type === 'totp') ?? []) as MFAFactor[])
  }

  const removeMFA = async (id: string) => {
    if (!confirm('Remove two-factor authentication? This will make your account less secure.')) return
    const supabase = createClient()
    await supabase.auth.mfa.unenroll({ factorId: id })
    const { data: listData2 } = await supabase.auth.mfa.listFactors()
    setFactors((listData2?.totp ?? listData2?.all?.filter(f => f.factor_type === 'totp') ?? []) as MFAFactor[])
    setMfaSuccess('Two-factor authentication removed.')
  }

  const changePassword = async () => {
    setPwError(''); setPwSuccess('')
    if (newPw.length < 6) { setPwError('Password must be at least 6 characters.'); return }
    const supabase = createClient()
    const { error } = await supabase.auth.updateUser({ password: newPw })
    if (error) { setPwError(error.message); return }
    setPwSuccess('Password updated successfully.')
    setNewPw('')
  }

  const saveNotifs = async () => {
    setNotifSaving(true)
    await fetch('/api/notifications', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(notifPrefs),
    })
    setNotifSaving(false)
    setNotifSaved(true)
    setTimeout(() => setNotifSaved(false), 2500)
  }

  const signOut = async () => {
    await fetch('/api/auth/session', { method: 'DELETE' })
    const supabase = createClient()
    await supabase.auth.signOut()
    router.push('/login')
  }

  const openBillingPortal = async () => {
    setBillingLoading(true)
    try {
      const res = await fetch('/api/stripe/portal', { method: 'POST' })
      const data = await res.json()
      if (data.url) window.location.href = data.url
    } catch { /* ignore */ }
    setBillingLoading(false)
  }

  const upgradePlan = (tier: 'standard' | 'pro') => {
    router.push(`/subscribe?highlight=${tier}`)
  }

  if (loading) return (
    <div className="flex items-center justify-center min-h-screen" style={{ background: 'var(--bg)' }}>
      <div className="flex gap-1">{[0,1,2].map(i => <span key={i} className="w-2 h-2 rounded-full animate-bounce" style={{ background: '#a78bfa', animationDelay: `${i*0.15}s` }} />)}</div>
    </div>
  )

  const activeFactor = factors.find(f => f.status === 'verified')
  const isTrialing = sub?.status === 'trialing'
  const isActive = sub?.status === 'active'
  const isPro = sub?.tier === 'pro'
  const isStandard = sub?.tier === 'standard'

  const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
    <div className="rounded-2xl overflow-hidden" style={{ border: `1px solid ${brd}` }}>
      <div className="px-5 py-3 border-b" style={{ background: surf2, borderColor: brd }}>
        <span className="text-xs font-bold uppercase tracking-widest" style={{ color: txt3 }}>{title}</span>
      </div>
      <div className="px-5 py-5 space-y-4" style={{ background: surf }}>
        {children}
      </div>
    </div>
  )

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg)', color: txt }}>
      <header className="flex items-center gap-3 px-4 py-3 border-b sticky top-0 z-10"
        style={{ background: surf, borderColor: brd }}>
        <button onClick={() => router.push('/')} className="flex items-center gap-1.5 text-xs hover:opacity-70" style={{ color: txt3 }}>
          <ArrowLeft size={13} /> Back
        </button>
        <div className="w-px h-4" style={{ background: brd }} />
        <span className="text-sm font-bold" style={{ color: txt }}>Settings</span>
        <div className="flex-1" />
        <button onClick={signOut} className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg hover:opacity-80"
          style={{ background: 'rgba(248,113,113,0.08)', color: '#f87171', border: '1px solid rgba(248,113,113,0.15)' }}>
          <LogOut size={12} /> Sign out
        </button>
      </header>

      <div className="max-w-xl mx-auto px-4 py-6 space-y-5">

        {/* Account */}
        <Section title="Account">
          <div>
            <div className="text-[10px] font-mono uppercase tracking-widest mb-1" style={{ color: txt3 }}>Email</div>
            <div className="text-sm font-mono" style={{ color: txt }}>{user?.email}</div>
          </div>
        </Section>

        {/* Subscription */}
        <Section title="Subscription">
          <div className="flex items-center justify-between">
            <div>
              <div className="flex items-center gap-2 mb-1">
                {isPro ? <Crown size={14} style={{ color: '#a78bfa' }} /> : <Zap size={14} style={{ color: '#fbbf24' }} />}
                <span className="text-sm font-bold" style={{ color: txt }}>
                  {isTrialing ? 'Free Trial' : isPro ? 'Pro' : isStandard ? 'Standard' : 'No plan'}
                </span>
                <span className="text-[10px] px-2 py-0.5 rounded-full font-mono"
                  style={{
                    background: isActive ? 'rgba(52,211,153,0.1)' : isTrialing ? 'rgba(251,191,36,0.1)' : 'rgba(248,113,113,0.1)',
                    color: isActive ? '#34d399' : isTrialing ? '#fbbf24' : '#f87171'
                  }}>
                  {sub?.status ?? 'unknown'}
                </span>
              </div>
              {isTrialing && sub?.daysLeft != null && (
                <div className="text-xs" style={{ color: txt3 }}>
                  {sub.daysLeft} day{sub.daysLeft !== 1 ? 's' : ''} remaining in trial
                </div>
              )}
              {isActive && (
                <div className="text-xs" style={{ color: txt3 }}>
                  {isPro ? '$49/month · Pro plan' : '$29/month · Standard plan'}
                </div>
              )}
            </div>
            {isActive && (
              <button onClick={openBillingPortal} disabled={billingLoading}
                className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg hover:opacity-80 disabled:opacity-50"
                style={{ background: surf2, color: txt2, border: `1px solid ${brd}` }}>
                <ExternalLink size={11} />
                {billingLoading ? 'Loading...' : 'Manage billing'}
              </button>
            )}
          </div>

          {/* Plan comparison / upgrade prompt */}
          {(isTrialing || isStandard) && (
            <div className="space-y-2 pt-2 border-t" style={{ borderColor: brd }}>
              {isTrialing && (
                <p className="text-xs" style={{ color: txt3 }}>
                  Your trial includes full Pro access. Choose a plan before it ends.
                </p>
              )}
              {isStandard && (
                <p className="text-xs" style={{ color: txt3 }}>
                  Upgrade to Pro to unlock Compare, Reinvestment Tracker, Forex, and unlimited portfolio positions.
                </p>
              )}
              <div className="grid grid-cols-2 gap-2">
                <button onClick={() => upgradePlan('standard')}
                  className="flex flex-col items-start p-3 rounded-xl text-left hover:opacity-80 transition-all"
                  style={{ background: surf2, border: isStandard ? `1px solid #fbbf24` : `1px solid ${brd}` }}>
                  <div className="flex items-center gap-1.5 mb-1">
                    <Zap size={12} style={{ color: '#fbbf24' }} />
                    <span className="text-xs font-bold" style={{ color: txt }}>Standard</span>
                    {isStandard && <CheckCircle size={11} style={{ color: '#fbbf24' }} />}
                  </div>
                  <div className="text-lg font-bold font-mono" style={{ color: txt }}>$29</div>
                  <div className="text-[10px]" style={{ color: txt3 }}>/month</div>
                </button>
                <button onClick={() => upgradePlan('pro')}
                  className="flex flex-col items-start p-3 rounded-xl text-left hover:opacity-80 transition-all"
                  style={{ background: isPro ? 'rgba(167,139,250,0.08)' : surf2, border: isPro ? '1px solid rgba(167,139,250,0.4)' : `1px solid ${brd}` }}>
                  <div className="flex items-center gap-1.5 mb-1">
                    <Crown size={12} style={{ color: '#a78bfa' }} />
                    <span className="text-xs font-bold" style={{ color: txt }}>Pro</span>
                    {isPro && <CheckCircle size={11} style={{ color: '#a78bfa' }} />}
                  </div>
                  <div className="text-lg font-bold font-mono" style={{ color: txt }}>$49</div>
                  <div className="text-[10px]" style={{ color: txt3 }}>/month</div>
                </button>
              </div>
            </div>
          )}

          {/* Pro features list when on Standard */}
          {isStandard && (
            <div className="text-xs space-y-1 pt-2 border-t" style={{ borderColor: brd, color: txt3 }}>
              <div className="font-semibold mb-1.5" style={{ color: txt2 }}>Pro adds:</div>
              {['Head-to-Head Compare', 'Reinvestment Tracker with AI strategies', 'Forex — 21 currency pairs', 'Unlimited portfolio positions', 'Analysis history export'].map(f => (
                <div key={f} className="flex items-center gap-1.5">
                  <div className="w-1 h-1 rounded-full" style={{ background: '#a78bfa' }} />
                  {f}
                </div>
              ))}
            </div>
          )}
        </Section>

        {/* Two-factor auth */}
        <Section title="Security — Two-Factor Authentication">
          {mfaSuccess && (
            <div className="px-3 py-2 rounded-lg text-xs" style={{ background: 'rgba(52,211,153,0.08)', border: '1px solid rgba(52,211,153,0.2)', color: '#34d399' }}>
              {mfaSuccess}
            </div>
          )}
          {mfaError && (
            <div className="px-3 py-2 rounded-lg text-xs" style={{ background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.2)', color: '#f87171' }}>
              {mfaError}
            </div>
          )}

          {activeFactor ? (
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <ShieldCheck size={16} style={{ color: '#34d399' }} />
                <div>
                  <div className="text-sm font-semibold" style={{ color: txt }}>2FA enabled</div>
                  <div className="text-xs" style={{ color: txt3 }}>Authenticator app</div>
                </div>
              </div>
              <button onClick={() => removeMFA(activeFactor.id)}
                className="text-xs px-3 py-1.5 rounded-lg hover:opacity-80"
                style={{ background: 'rgba(248,113,113,0.08)', color: '#f87171', border: '1px solid rgba(248,113,113,0.15)' }}>
                Remove
              </button>
            </div>
          ) : enrolling ? (
            <div className="space-y-4">
              <p className="text-xs" style={{ color: txt2 }}>
                Scan this QR code with Google Authenticator, Authy, or 1Password, then enter the 6-digit code.
              </p>
              {qrCode && <img src={qrCode} alt="MFA QR" width={160} height={160} className="rounded-lg" />}
              <div>
                <div className="text-[10px] font-mono uppercase tracking-widest mb-1.5" style={{ color: txt3 }}>Verification code</div>
                <input value={verifyCode} onChange={e => setVerifyCode(e.target.value.replace(/\D/g,'').slice(0,6))}
                  placeholder="000000" maxLength={6}
                  className="w-32 px-3 py-2 rounded-lg text-sm font-mono text-center outline-none border"
                  style={{ background: inputBg, borderColor: brd, color: txt }} />
              </div>
              <div className="flex gap-2">
                <button onClick={verifyMFA} disabled={verifyCode.length !== 6}
                  className="px-4 py-2 rounded-lg text-xs font-semibold text-white disabled:opacity-40"
                  style={{ background: 'linear-gradient(135deg,#7c3aed,#4f46e5)' }}>
                  Verify and enable
                </button>
                <button onClick={() => { setEnrolling(false); setQrCode(''); setVerifyCode('') }}
                  className="px-4 py-2 rounded-lg text-xs hover:opacity-70" style={{ color: txt3 }}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <ShieldOff size={16} style={{ color: txt3 }} />
                <div>
                  <div className="text-sm font-semibold" style={{ color: txt }}>2FA disabled</div>
                  <div className="text-xs" style={{ color: txt3 }}>Add an extra layer of security</div>
                </div>
              </div>
              <button onClick={enrollMFA}
                className="text-xs px-3 py-1.5 rounded-lg hover:opacity-80"
                style={{ background: 'rgba(167,139,250,0.08)', color: '#a78bfa', border: '1px solid rgba(167,139,250,0.15)' }}>
                Enable 2FA
              </button>
            </div>
          )}
        </Section>

        {/* Change password */}
        <Section title="Change Password">
          {pwError && (
            <div className="px-3 py-2 rounded-lg text-xs" style={{ background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.2)', color: '#f87171' }}>
              {pwError}
            </div>
          )}
          {pwSuccess && (
            <div className="px-3 py-2 rounded-lg text-xs" style={{ background: 'rgba(52,211,153,0.08)', border: '1px solid rgba(52,211,153,0.2)', color: '#34d399' }}>
              {pwSuccess}
            </div>
          )}
          <div>
            <div className="text-[10px] font-mono uppercase tracking-widest mb-1.5" style={{ color: txt3 }}>New password</div>
            <input type="password" value={newPw} onChange={e => setNewPw(e.target.value)}
              placeholder="At least 6 characters"
              className="w-full px-3 py-2 rounded-lg text-sm outline-none border"
              style={{ background: inputBg, borderColor: brd, color: txt }} />
          </div>
          <button onClick={changePassword} disabled={newPw.length < 6}
            className="px-4 py-2 rounded-lg text-xs font-semibold disabled:opacity-40 hover:opacity-80"
            style={{ background: surf2, color: txt, border: `1px solid ${brd}` }}>
            Update password
          </button>
        </Section>

        {/* Notifications */}
        <Section title="Notifications">
          {notifSaved && (
            <div className="px-3 py-2 rounded-lg text-xs" style={{ background: 'rgba(52,211,153,0.08)', border: '1px solid rgba(52,211,153,0.2)', color: '#34d399' }}>
              Preferences saved.
            </div>
          )}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-semibold" style={{ color: txt }}>Email alerts</div>
                <div className="text-xs" style={{ color: txt3 }}>Sent to {user?.email}</div>
              </div>
              <button onClick={() => setNotifPrefs(p => ({ ...p, email_enabled: !p.email_enabled }))}
                className="w-10 h-5 rounded-full transition-all relative"
                style={{ background: notifPrefs.email_enabled ? '#a78bfa' : surf2, border: `1px solid ${notifPrefs.email_enabled ? '#a78bfa' : brd}` }}>
                <div className="w-3.5 h-3.5 rounded-full bg-white absolute top-0.5 transition-all"
                  style={{ left: notifPrefs.email_enabled ? '1.25rem' : '0.125rem' }} />
              </button>
            </div>
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-semibold" style={{ color: txt }}>SMS alerts</div>
                <div className="text-xs" style={{ color: txt3 }}>Text message to your phone</div>
              </div>
              <button onClick={() => setNotifPrefs(p => ({ ...p, sms_enabled: !p.sms_enabled }))}
                className="w-10 h-5 rounded-full transition-all relative"
                style={{ background: notifPrefs.sms_enabled ? '#a78bfa' : surf2, border: `1px solid ${notifPrefs.sms_enabled ? '#a78bfa' : brd}` }}>
                <div className="w-3.5 h-3.5 rounded-full bg-white absolute top-0.5 transition-all"
                  style={{ left: notifPrefs.sms_enabled ? '1.25rem' : '0.125rem' }} />
              </button>
            </div>
            {notifPrefs.sms_enabled && (
              <div>
                <div className="text-[10px] font-mono uppercase tracking-widest mb-1.5" style={{ color: txt3 }}>Phone number</div>
                <input value={notifPrefs.phone} onChange={e => setNotifPrefs(p => ({ ...p, phone: e.target.value }))}
                  placeholder="+15551234567"
                  className="w-full px-3 py-2 rounded-lg text-sm font-mono outline-none border"
                  style={{ background: inputBg, borderColor: brd, color: txt }} />
                <div className="text-[10px] mt-1" style={{ color: txt3 }}>Include country code e.g. +1 for US</div>
              </div>
            )}
            <div>
              <div className="text-[10px] font-mono uppercase tracking-widest mb-1.5" style={{ color: txt3 }}>Minimum severity to notify</div>
              <div className="flex gap-2">
                {(['watch', 'alert', 'urgent'] as const).map(s => (
                  <button key={s} onClick={() => setNotifPrefs(p => ({ ...p, min_severity: s }))}
                    className="flex-1 py-1.5 rounded-lg text-xs font-semibold capitalize transition-all"
                    style={{
                      background: notifPrefs.min_severity === s ? 'rgba(167,139,250,0.12)' : surf2,
                      color: notifPrefs.min_severity === s ? '#a78bfa' : txt3,
                      border: `1px solid ${notifPrefs.min_severity === s ? 'rgba(167,139,250,0.3)' : brd}`,
                    }}>
                    {s}
                  </button>
                ))}
              </div>
              <div className="text-[10px] mt-1" style={{ color: txt3 }}>
                Watch = approaching S/R · Alert = breach/−8% · Urgent = −15%+
              </div>
            </div>
            <button onClick={saveNotifs} disabled={notifSaving}
              className="w-full py-2.5 rounded-lg text-xs font-semibold disabled:opacity-40 hover:opacity-80"
              style={{ background: 'rgba(167,139,250,0.1)', color: '#a78bfa', border: '1px solid rgba(167,139,250,0.2)' }}>
              {notifSaving ? 'Saving...' : 'Save notification settings'}
            </button>
          </div>
        </Section>

        {/* Danger zone */}
        <Section title="Sign Out">
          <div className="flex items-center justify-between">
            <p className="text-xs" style={{ color: txt3 }}>Sign out of all devices</p>
            <button onClick={signOut}
              className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg hover:opacity-80"
              style={{ background: 'rgba(248,113,113,0.08)', color: '#f87171', border: '1px solid rgba(248,113,113,0.15)' }}>
              <LogOut size={12} /> Sign out
            </button>
          </div>
        </Section>

        <p className="text-center text-[11px] pb-4" style={{ color: txt3 }}>
          Consilium · <a href="mailto:support@consilium.app" style={{ color: txt3 }}>support@consilium.app</a>
        </p>
      </div>
    </div>
  )
}
