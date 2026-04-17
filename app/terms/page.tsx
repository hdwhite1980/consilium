'use client'
import { useRouter } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'

export default function TermsPage() {
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
        <span className="text-sm text-white/40">Terms of Service</span>
      </header>

      <div className="max-w-3xl mx-auto px-6 py-10 space-y-8">
        <div>
          <h1 className="text-2xl font-bold mb-2">Terms of Service</h1>
          <p className="text-sm text-white/40">Last updated: April 16, 2026</p>
        </div>

        <div className="rounded-2xl p-5" style={{ background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.2)' }}>
          <p className="text-sm font-semibold" style={{ color: '#f87171' }}>
            Important: Wali-OS is an informational tool only. Nothing on this platform is financial advice. All investment decisions are your own responsibility.
          </p>
        </div>

        {[
          {
            title: '1. Acceptance of Terms',
            body: `By accessing or using Wali-OS ("the Service"), you agree to be bound by these Terms of Service. If you do not agree, do not use the Service. We reserve the right to update these terms at any time. Continued use after changes constitutes acceptance.`,
          },
          {
            title: '2. Not Financial Advice',
            body: `Wali-OS is an informational and educational tool only. Nothing on this platform — including but not limited to AI-generated analysis, signals, verdicts, entry prices, stop losses, take profit levels, options recommendations, portfolio analysis, or any other content — constitutes financial advice, investment advice, trading advice, or recommendations of any kind.

We are not a registered investment advisor, broker-dealer, financial planner, or fiduciary. Use of Wali-OS does not create any advisory or professional relationship between you and Wali-OS or its operators.

AI-generated analysis may be incorrect, incomplete, outdated, or based on faulty data. Market conditions change rapidly. Past signal accuracy does not guarantee future results. You should always conduct your own research and consult a qualified financial professional before making any investment decision.`,
          },
          {
            title: '3. Eligibility',
            body: `You must be at least 18 years old to use Wali-OS. By using the Service, you represent that you meet this requirement and that you have the legal capacity to enter into this agreement.`,
          },
          {
            title: '4. Account Responsibilities',
            body: `You are responsible for maintaining the security of your account credentials. You agree not to share your account with others. You are responsible for all activity that occurs under your account. Notify us immediately at support@wali-os.com if you suspect unauthorized access.`,
          },
          {
            title: '5. Subscription and Billing',
            body: `Wali-OS offers paid subscription plans (Standard at $29/month and Pro at $49/month) with a 7-day free trial. Subscriptions renew automatically unless cancelled. You may cancel at any time through your account settings or by contacting support@wali-os.com.

Refunds are not provided for partial billing periods. Payments are processed by Stripe. We do not store your payment card information.`,
          },
          {
            title: '6. Acceptable Use',
            body: `You agree not to:
• Use the Service for any unlawful purpose
• Attempt to reverse engineer, scrape, or extract data from the platform
• Share your account credentials or provide access to others
• Use the Service to manipulate markets or engage in securities fraud
• Resell or redistribute analysis outputs without permission`,
          },
          {
            title: '7. Limitation of Liability',
            body: `To the maximum extent permitted by law, Wali-OS and its operators shall not be liable for any direct, indirect, incidental, special, consequential, or punitive damages arising from:
• Your use of or reliance on the Service
• Investment losses or financial harm of any kind
• Errors, inaccuracies, or interruptions in the Service
• Unauthorized access to your account

Your sole remedy for dissatisfaction with the Service is to stop using it and cancel your subscription.`,
          },
          {
            title: '8. Disclaimer of Warranties',
            body: `The Service is provided "as is" and "as available" without warranties of any kind, express or implied. We do not warrant that the Service will be uninterrupted, error-free, or that the analysis provided will be accurate or profitable.`,
          },
          {
            title: '9. Intellectual Property',
            body: `All content, software, and technology comprising Wali-OS is owned by or licensed to us. You may not copy, reproduce, or distribute any part of the Service without express written permission.

Analysis outputs generated for your personal use during your subscription are yours to use for personal, non-commercial purposes.`,
          },
          {
            title: '10. Termination',
            body: `We reserve the right to suspend or terminate your account at any time for violation of these Terms or for any other reason at our sole discretion. Upon termination, your right to access the Service ceases immediately.`,
          },
          {
            title: '11. Governing Law',
            body: `These Terms are governed by the laws of the United States. Any disputes shall be resolved through binding arbitration rather than in court, except that either party may seek injunctive relief in court for intellectual property disputes.`,
          },
          {
            title: '12. Contact',
            body: `For questions about these Terms:\nEmail: support@wali-os.com\nWali-OS — wali-os.com`,
          },
        ].map(({ title, body }) => (
          <div key={title} className="space-y-2">
            <h2 className="text-base font-bold" style={{ color: 'rgba(255,255,255,0.9)' }}>{title}</h2>
            <p className="text-sm leading-relaxed whitespace-pre-line" style={{ color: 'rgba(255,255,255,0.55)' }}>{body}</p>
          </div>
        ))}

        <div className="border-t pt-6 text-xs text-center" style={{ borderColor: 'rgba(255,255,255,0.07)', color: 'rgba(255,255,255,0.25)' }}>
          Wali-OS · <a href="mailto:support@wali-os.com" className="underline hover:text-white/50">support@wali-os.com</a> · <a href="/privacy" className="underline hover:text-white/50">Privacy Policy</a>
        </div>
      </div>
    </div>
  )
}
