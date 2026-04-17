'use client'
import { useRouter } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'

export default function PrivacyPage() {
  const router = useRouter()
  return (
    <div className="min-h-screen" style={{ background: '#0a0d12', color: 'rgba(255,255,255,0.85)' }}>
      <header className="flex items-center gap-3 px-6 py-4 border-b sticky top-0 z-10"
        style={{ background: '#111620', borderColor: 'rgba(255,255,255,0.07)' }}>
        <button onClick={() => router.back()} className="flex items-center gap-1.5 text-xs text-white/40 hover:text-white/70">
          <ArrowLeft size={13} /> Back
        </button>
        <div className="w-px h-4" style={{ background: 'rgba(255,255,255,0.1)' }} />
        <span className="text-sm font-bold" style={{ color: '#a78bfa' }}>Wali-OS</span>
        <span className="text-sm text-white/40">Privacy Policy</span>
      </header>

      <div className="max-w-3xl mx-auto px-6 py-10 space-y-8">
        <div>
          <h1 className="text-2xl font-bold mb-2">Privacy Policy</h1>
          <p className="text-sm text-white/40">Last updated: April 16, 2026</p>
        </div>

        <div className="rounded-2xl p-5" style={{ background: 'rgba(167,139,250,0.08)', border: '1px solid rgba(167,139,250,0.2)' }}>
          <p className="text-sm font-semibold" style={{ color: '#a78bfa' }}>
            The short version: We do not sell, rent, or share your personal data with third parties for marketing or advertising purposes. Ever.
          </p>
        </div>

        {[
          {
            title: '1. Who We Are',
            body: `Wali-OS ("we", "us", "our") is an AI-powered financial analysis platform available at wali-os.com. We are not a registered investment advisor, broker-dealer, or financial planner. This Privacy Policy explains how we collect, use, and protect your information.`,
          },
          {
            title: '2. Information We Collect',
            body: `We collect the following information when you use Wali-OS:

• Email address and password (for account creation and authentication)
• Portfolio positions you manually enter (stock tickers, share counts, cost basis)
• Analysis history (tickers you have analyzed and saved verdicts)
• Reinvestment trades and investment journey data you log
• Notification preferences (email/SMS settings you configure)
• Usage data (pages visited, features used) for product improvement

We do NOT collect: your brokerage credentials, actual trade data, bank account information, or Social Security numbers. We never connect to your brokerage account.`,
          },
          {
            title: '3. How We Use Your Information',
            body: `We use your information solely to:

• Provide and improve the Wali-OS service
• Send you portfolio alerts and notifications you have opted into
• Process subscription payments (via Stripe — we never see your card details)
• Send account-related emails (password resets, confirmations) via Resend
• Analyze aggregate usage patterns to improve the platform

We do not use your data to train AI models.`,
          },
          {
            title: '4. We Do Not Sell or Share Your Data',
            body: `We do not sell, rent, trade, or otherwise share your personal information with third parties for commercial purposes. Your data is not used for advertising. Your portfolio positions and analysis history are private to your account only.

The only third parties we share data with are service providers necessary to operate the platform:
• Supabase (database and authentication — US-based, SOC 2 compliant)
• Stripe (payment processing — PCI DSS compliant, we never see card numbers)
• Railway (hosting infrastructure — US-based)
• Resend (transactional email delivery only)
• Twilio (SMS alerts, only if you enable them)

These providers are contractually prohibited from using your data for any purpose other than providing their services to us.`,
          },
          {
            title: '5. AI Analysis Data',
            body: `When you analyze a stock, we send the ticker symbol and market data to AI providers (Anthropic, OpenAI, Google) to generate analysis. We do not send your personal information, account details, or portfolio data to these AI providers. API calls are made with your ticker request only and are subject to each provider's own data policies.`,
          },
          {
            title: '6. Data Retention',
            body: `We retain your account data for as long as your account is active. Analysis results and portfolio data are stored to provide the service. You can delete your account and all associated data at any time by contacting support@wali-os.com. We will process deletion requests within 30 days.`,
          },
          {
            title: '7. Security',
            body: `We use industry-standard security practices including encrypted connections (HTTPS), hashed passwords (Supabase Auth), and row-level security on all database tables so users can only access their own data. We conduct regular security reviews. No system is 100% secure — if you believe your account has been compromised, contact us immediately at support@wali-os.com.`,
          },
          {
            title: '8. Your Rights',
            body: `You have the right to:
• Access the personal data we hold about you
• Correct inaccurate data
• Request deletion of your data
• Export your data
• Opt out of marketing communications at any time

To exercise any of these rights, contact us at support@wali-os.com.`,
          },
          {
            title: '9. Cookies',
            body: `We use session cookies to keep you logged in. We do not use third-party tracking cookies or advertising cookies. We do not use Google Analytics or similar tracking services.`,
          },
          {
            title: '10. Changes to This Policy',
            body: `We may update this Privacy Policy from time to time. We will notify you of material changes via email. Continued use of Wali-OS after changes constitutes acceptance of the updated policy.`,
          },
          {
            title: '11. Contact',
            body: `For privacy questions, data requests, or concerns:\nEmail: support@wali-os.com\nWali-OS — wali-os.com`,
          },
        ].map(({ title, body }) => (
          <div key={title} className="space-y-2">
            <h2 className="text-base font-bold" style={{ color: 'rgba(255,255,255,0.9)' }}>{title}</h2>
            <p className="text-sm leading-relaxed whitespace-pre-line" style={{ color: 'rgba(255,255,255,0.55)' }}>{body}</p>
          </div>
        ))}

        <div className="border-t pt-6 text-xs text-center" style={{ borderColor: 'rgba(255,255,255,0.07)', color: 'rgba(255,255,255,0.25)' }}>
          Wali-OS · <a href="mailto:support@wali-os.com" className="underline hover:text-white/50">support@wali-os.com</a> · <a href="/terms" className="underline hover:text-white/50">Terms of Service</a>
        </div>
      </div>
    </div>
  )
}
