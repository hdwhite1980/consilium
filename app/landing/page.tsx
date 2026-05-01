'use client'

import Link from 'next/link'
import {
  ArrowRight, BarChart3, Briefcase, Building2, Calculator,
  CheckCircle2, FileText, Globe, LineChart, MessageSquare,
  Newspaper, Search, ShieldCheck, Sparkles, TrendingUp, Users,
} from 'lucide-react'
import WaliLogo from '@/app/components/WaliLogo'

// -------------------------------------------------------------
// Wali-OS Marketing Landing Page
//
// Replaces the auth-wall-as-landing-page. Targets unauthenticated
// visitors, communicates the product's actual capabilities, and
// drives signup to the existing 7-day free trial flow.
//
// Design tokens match the existing app: CSS variables for theme,
// brand purple #7c3aed, AI source colors (#a78bfa Claude, #34d399
// GPT, #60a5fa Gemini), Space Grotesk font.
//
// Renders without authentication. See MIGRATION_NOTES.md for the
// middleware change required to expose this route to logged-out
// visitors.
// -------------------------------------------------------------

export default function MarketingLanding() {
  return (
    <main style={{ background: 'var(--bg)', color: 'var(--text)', minHeight: '100vh' }}>
      <Nav />
      <Hero />
      <Pillars />
      <SamplePreview />
      <FeatureGrid />
      <Pricing />
      <FAQ />
      <Footer />
    </main>
  )
}

// -------------------------------------------------------------
// Nav
// -------------------------------------------------------------
function Nav() {
  return (
    <nav style={{
      position: 'sticky', top: 0, zIndex: 50,
      background: 'var(--nav-bg)',
      borderBottom: '1px solid var(--border)',
      backdropFilter: 'blur(8px)',
    }}>
      <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <WaliLogo size="xs" noLink />
          <span style={{ fontFamily: 'IBM Plex Mono, monospace', fontWeight: 600, fontSize: '15px' }}>
            Wali-OS
          </span>
        </div>
        <div className="flex items-center gap-4 text-sm">
          <Link
            href="/login"
            style={{ color: 'var(--text2)' }}
            className="hover:opacity-80 transition"
          >
            Log in
          </Link>
          <Link
            href="/signup"
            style={{
              background: '#7c3aed',
              color: '#fff',
              padding: '8px 16px',
              borderRadius: '8px',
              fontWeight: 500,
            }}
            className="hover:opacity-90 transition text-sm"
          >
            Start free trial
          </Link>
        </div>
      </div>
    </nav>
  )
}

// -------------------------------------------------------------
// Hero
// -------------------------------------------------------------
function Hero() {
  return (
    <section className="max-w-6xl mx-auto px-6 pt-20 pb-24 md:pt-32 md:pb-32">
      <div className="grid md:grid-cols-2 gap-12 items-center">
        {/* Left  -  copy */}
        <div>
          <div
            style={{
              display: 'inline-block',
              padding: '4px 12px',
              borderRadius: '999px',
              background: 'rgba(124,58,237,0.12)',
              border: '1px solid rgba(124,58,237,0.3)',
              color: '#a78bfa',
              fontSize: '12px',
              fontWeight: 500,
              letterSpacing: '0.04em',
              marginBottom: '24px',
            }}
          >
            AI STOCK ANALYSIS, FOR PEOPLE WHO READ
          </div>
          <h1
            style={{
              fontSize: 'clamp(2.25rem, 4.5vw, 3.5rem)',
              lineHeight: 1.1,
              fontWeight: 600,
              letterSpacing: '-0.02em',
              marginBottom: '24px',
            }}
          >
            Most AI stock tools ask one model what to do.
            <br />
            <span style={{ color: '#a78bfa' }}>Wali-OS runs a debate.</span>
          </h1>
          <p
            style={{
              color: 'var(--text2)',
              fontSize: '18px',
              lineHeight: 1.55,
              marginBottom: '32px',
              maxWidth: '520px',
            }}
          >
            Six stages. Three analytical lenses. Direct SEC EDGAR ingestion, real
            options chains, verified track record. For traders who want depth,
            not alerts.
          </p>
          <div className="flex items-center gap-4 flex-wrap">
            <Link
              href="/signup"
              style={{
                background: '#7c3aed',
                color: '#fff',
                padding: '14px 24px',
                borderRadius: '10px',
                fontWeight: 500,
                fontSize: '15px',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '8px',
              }}
              className="hover:opacity-90 transition"
            >
              Start 7-day free trial
              <ArrowRight size={16} />
            </Link>
            <a
              href="#sample"
              style={{
                color: 'var(--text)',
                padding: '14px 20px',
                fontWeight: 500,
                fontSize: '15px',
              }}
              className="hover:opacity-80 transition"
            >
              See a sample analysis {'->'}
            </a>
          </div>
          <p
            style={{
              color: 'var(--text3)',
              fontSize: '13px',
              marginTop: '20px',
            }}
          >
            No card required for trial. Cancel anytime.
          </p>
        </div>

        {/* Right  -  pipeline diagram */}
        <PipelineDiagram />
      </div>
    </section>
  )
}

// -------------------------------------------------------------
// Pipeline diagram  -  illustrates the six-stage Council flow
// -------------------------------------------------------------
function PipelineDiagram() {
  const stages = [
    { name: 'News Scout',      role: 'Pulls fresh data',   color: '#60a5fa' /* gemini */ },
    { name: 'Lead Analyst',    role: 'Makes the call',     color: '#a78bfa' /* claude */ },
    { name: "Devil's Advocate", role: 'Cross-pressures',    color: '#34d399' /* gpt */    },
    { name: 'Round 2  -  Research', role: 'Both sides probe', color: '#60a5fa' },
    { name: 'Round 2  -  Rebuttal', role: 'Defend or concede', color: '#a78bfa' },
    { name: 'Judge',            role: 'Weighs the transcript', color: '#fbbf24' /* consensus */ },
  ]

  return (
    <div
      className="t-card"
      style={{
        padding: '24px',
        borderRadius: '16px',
        background: 'var(--surface)',
        border: '1px solid var(--border)',
      }}
    >
      <div className="flex items-center gap-2 mb-5" style={{ color: 'var(--text3)', fontSize: '12px', letterSpacing: '0.06em' }}>
        <div style={{ width: '8px', height: '8px', borderRadius: '999px', background: '#34d399' }} className="animate-pulse-dot" />
        COUNCIL PIPELINE  -  RUNNING ANALYSIS
      </div>
      <div className="space-y-3">
        {stages.map((s, i) => (
          <div key={s.name} className="flex items-center gap-3">
            <div
              style={{
                width: '32px', height: '32px',
                borderRadius: '8px',
                background: `${s.color}20`,
                border: `1px solid ${s.color}50`,
                color: s.color,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: '13px', fontWeight: 600,
                fontFamily: 'IBM Plex Mono, monospace',
              }}
            >
              {i + 1}
            </div>
            <div className="flex-1">
              <div style={{ fontWeight: 500, fontSize: '14px' }}>{s.name}</div>
              <div style={{ color: 'var(--text3)', fontSize: '12px' }}>{s.role}</div>
            </div>
            {i < stages.length - 1 && (
              <div style={{ color: 'var(--text3)', fontSize: '14px', lineHeight: 1, fontWeight: 600 }}>|</div>
            )}
          </div>
        ))}
      </div>
      <div
        style={{
          marginTop: '20px',
          paddingTop: '16px',
          borderTop: '1px solid var(--border)',
          fontSize: '12px',
          color: 'var(--text3)',
          fontFamily: 'IBM Plex Mono, monospace',
        }}
      >
        VERDICT: BULLISH @ 73% confidence * stop $171 * target $236 * 3-10d
      </div>
    </div>
  )
}

// -------------------------------------------------------------
// Three pillars
// -------------------------------------------------------------
function Pillars() {
  return (
    <section
      className="border-y"
      style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}
    >
      <div className="max-w-6xl mx-auto px-6 py-20">
        <div className="text-center mb-16">
          <div
            style={{
              color: 'var(--text3)',
              fontSize: '12px',
              letterSpacing: '0.08em',
              fontFamily: 'IBM Plex Mono, monospace',
              marginBottom: '12px',
            }}
          >
            WHAT MAKES WALI-OS DIFFERENT
          </div>
          <h2
            style={{
              fontSize: 'clamp(1.75rem, 3vw, 2.25rem)',
              fontWeight: 600,
              letterSpacing: '-0.01em',
            }}
          >
            Three things competitors can't easily copy.
          </h2>
        </div>

        <div className="grid md:grid-cols-3 gap-6">
          <PillarCard
            number="01"
            title="A council, not a chatbot"
            body="A six-stage pipeline. News Scout pulls fresh data. The Lead Analyst makes the directional call from your chosen lens. The Devil's Advocate cross-pressures from the opposite dimension. Both sides pull research and rebut. A neutral Judge reads the transcript and rules. You see every step."
            proof="Verifiable: every analysis shows the full Council transcript, including concessions."
            accent="#a78bfa"
          />
          <PillarCard
            number="02"
            title="Numbers, not testimonials"
            body="Every BULLISH and BEARISH verdict is logged with a timestamp and price. An automated job computes the actual outcome at one week and one month  -  strict and directional. Hit rates by lens, timeframe, and confidence band are public."
            proof="Verifiable: /api/backtest/stats is open. Most retail tools sell vibes; we publish numbers."
            accent="#34d399"
          />
          <PillarCard
            number="03"
            title="Real data sources, full coverage"
            body="Direct SEC EDGAR ingestion: Form 4 insider transactions, 13-F institutional positions, 8-K material events, congressional disclosures. Tradier for real options chains and Greeks. ECB Frankfurter for forex. Multi-source news with AI urgency evaluation."
            proof="Verifiable: smart money section in every verdict, with named insiders, dollar values, dates."
            accent="#60a5fa"
          />
        </div>
      </div>
    </section>
  )
}

function PillarCard({ number, title, body, proof, accent }: {
  number: string; title: string; body: string; proof: string; accent: string
}) {
  return (
    <div
      style={{
        background: 'var(--surface2)',
        border: '1px solid var(--border)',
        borderRadius: '14px',
        padding: '28px',
        height: '100%',
        display: 'flex', flexDirection: 'column',
      }}
    >
      <div
        style={{
          color: accent,
          fontFamily: 'IBM Plex Mono, monospace',
          fontSize: '12px',
          letterSpacing: '0.08em',
          marginBottom: '16px',
        }}
      >
        {number}
      </div>
      <h3 style={{ fontSize: '20px', fontWeight: 600, marginBottom: '12px', letterSpacing: '-0.01em' }}>
        {title}
      </h3>
      <p style={{ color: 'var(--text2)', fontSize: '14px', lineHeight: 1.6, marginBottom: '16px', flex: 1 }}>
        {body}
      </p>
      <div
        style={{
          paddingTop: '16px',
          borderTop: '1px solid var(--border)',
          color: 'var(--text3)',
          fontSize: '12px',
          fontStyle: 'italic',
        }}
      >
        {proof}
      </div>
    </div>
  )
}

// -------------------------------------------------------------
// Sample preview / proof section
//
// This is the most important section. Currently a placeholder
// styled to look like a real Council transcript. Replace the
// inner contents with a real screenshot or embed when you have
// one. See MIGRATION_NOTES.md for screenshot specs.
// -------------------------------------------------------------
function SamplePreview() {
  return (
    <section id="sample" className="max-w-6xl mx-auto px-6 py-20">
      <div className="text-center mb-12">
        <div
          style={{
            color: 'var(--text3)',
            fontSize: '12px',
            letterSpacing: '0.08em',
            fontFamily: 'IBM Plex Mono, monospace',
            marginBottom: '12px',
          }}
        >
          WHAT YOU SEE
        </div>
        <h2 style={{ fontSize: 'clamp(1.75rem, 3vw, 2.25rem)', fontWeight: 600, letterSpacing: '-0.01em' }}>
          Every analysis is a transcript you can read.
        </h2>
        <p style={{ color: 'var(--text2)', maxWidth: '600px', margin: '12px auto 0', fontSize: '15px' }}>
          Below is the structure of an actual Council verdict. The Lead's argument,
          the Devil's challenges, both sides' research, the Judge's ruling, the
          stop, the target, the invalidation trigger  -  all visible.
        </p>
      </div>

      {/* Real screenshot of an actual Council verdict on AMC.
          Replace at /public/landing/sample-analysis.png. */}
      <div
        className="t-card"
        style={{
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: '14px',
          overflow: 'hidden',
        }}
      >
        <img
          src="/landing/sample-analysis.png"
          alt="A real Council verdict for AMC -- NEUTRAL signal with full technicals, trade plan with entry/stop/target/time-horizon, scenario probabilities, and invalidation trigger"
          style={{ width: '100%', display: 'block' }}
        />
      </div>

      <div className="text-center mt-8">
        <Link
          href="/signup"
          style={{
            color: '#a78bfa',
            fontWeight: 500,
            fontSize: '14px',
          }}
          className="hover:opacity-80 transition"
        >
          Run your own analysis  -  start free trial {'->'}
        </Link>
      </div>
    </section>
  )
}

// -------------------------------------------------------------
// Feature grid
// -------------------------------------------------------------
function FeatureGrid() {
  const features = [
    { icon: <Briefcase size={18} />,    title: 'Portfolio analysis',       body: 'Add real holdings  -  get sector concentration, theta decay, earnings timing risk, and a 3-step action plan.' },
    { icon: <ShieldCheck size={18} />,   title: 'Position monitoring',      body: 'Severity-tiered alerts via email and SMS for stops, support breaks, P&L, news, options DTE.' },
    { icon: <Users size={18} />,         title: 'Head-to-head comparison',  body: 'Run the Council on two tickers simultaneously  -  get a definitive "if you can only pick one" verdict.' },
    { icon: <MessageSquare size={18} />, title: 'Q&A on any analysis',      body: 'Ask follow-up questions with the full Council context preserved. "What would change your mind?"' },
    { icon: <BarChart3 size={18} />,     title: 'Crypto coverage',          body: '25+ coins via CoinGecko. Same Council pipeline, same depth as US equities.' },
    { icon: <Globe size={18} />,         title: 'Forex coverage',           body: '30+ pairs via ECB data. Forex-specific framing focuses on central-bank policy divergence.' },
    { icon: <Newspaper size={18} />,     title: 'End-of-day digest',        body: 'Institutional-grade market summary every evening. Pre-market brief every morning.' },
    { icon: <FileText size={18} />,      title: 'Plain-English mode',       body: 'Every verdict includes plain-language breakdowns. No assumed knowledge of RSI or P/E.' },
  ]

  return (
    <section className="max-w-6xl mx-auto px-6 py-20">
      <div className="text-center mb-12">
        <div
          style={{
            color: 'var(--text3)',
            fontSize: '12px',
            letterSpacing: '0.08em',
            fontFamily: 'IBM Plex Mono, monospace',
            marginBottom: '12px',
          }}
        >
          THE REST OF THE PRODUCT
        </div>
        <h2 style={{ fontSize: 'clamp(1.75rem, 3vw, 2.25rem)', fontWeight: 600, letterSpacing: '-0.01em' }}>
          Eight more capabilities, no upsell tax.
        </h2>
        <p style={{ color: 'var(--text2)', maxWidth: '600px', margin: '12px auto 0', fontSize: '15px' }}>
          Everything below is included in both plans. Upgrade is for advanced
          options-chain enrichment and higher rate limits, not for unlocking
          basic features.
        </p>
      </div>

      <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-4">
        {features.map(f => (
          <div
            key={f.title}
            style={{
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              borderRadius: '12px',
              padding: '20px',
            }}
          >
            <div style={{ color: '#a78bfa', marginBottom: '12px' }}>{f.icon}</div>
            <div style={{ fontWeight: 500, fontSize: '14px', marginBottom: '6px' }}>
              {f.title}
            </div>
            <div style={{ color: 'var(--text3)', fontSize: '13px', lineHeight: 1.5 }}>
              {f.body}
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

// -------------------------------------------------------------
// Pricing
// -------------------------------------------------------------
function Pricing() {
  return (
    <section
      className="border-y"
      style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}
    >
      <div className="max-w-4xl mx-auto px-6 py-20">
        <div className="text-center mb-12">
          <div
            style={{
              color: 'var(--text3)',
              fontSize: '12px',
              letterSpacing: '0.08em',
              fontFamily: 'IBM Plex Mono, monospace',
              marginBottom: '12px',
            }}
          >
            PRICING
          </div>
          <h2 style={{ fontSize: 'clamp(1.75rem, 3vw, 2.25rem)', fontWeight: 600, letterSpacing: '-0.01em' }}>
            Two plans. Both start with a 7-day free trial.
          </h2>
        </div>

        <div className="grid md:grid-cols-2 gap-6">
          <PricingCard
            tier="Standard"
            price="$29"
            period="/month"
            blurb="Everything in the Council, all asset classes, full portfolio analysis and monitoring."
            features={[
              'Full six-stage Council on stocks, crypto, forex',
              'Three analytical lenses  -  technical, fundamental, balanced',
              'Direct SEC EDGAR ingestion (Form 4, 13-F, 8-K)',
              'Portfolio analysis with theta decay and earnings risk',
              'Position monitoring  -  email + SMS alerts',
              'End-of-day digest, pre-market brief',
              'Q&A on every analysis',
              'Public backtest stats',
            ]}
          />
          <PricingCard
            tier="Pro"
            price="$49"
            period="/month"
            blurb="Everything in Standard plus advanced options chain enrichment via Tradier production."
            features={[
              'Everything in Standard',
              'Tradier production options chain  -  real Greeks',
              'GEX-aware strategy recommendations',
              'Earnings implied move vs historical actual',
              'Higher rate limits',
              'Priority support',
            ]}
            highlighted
          />
        </div>

        <p
          style={{
            textAlign: 'center',
            color: 'var(--text3)',
            fontSize: '13px',
            marginTop: '24px',
          }}
        >
          Cancel anytime via the Stripe customer portal. No card required for the trial.
        </p>
      </div>
    </section>
  )
}

function PricingCard({ tier, price, period, blurb, features, highlighted }: {
  tier: string; price: string; period: string; blurb: string;
  features: string[]; highlighted?: boolean
}) {
  return (
    <div
      style={{
        background: 'var(--surface2)',
        border: highlighted ? '1px solid #7c3aed' : '1px solid var(--border)',
        borderRadius: '16px',
        padding: '32px',
        position: 'relative',
      }}
    >
      {highlighted && (
        <div
          style={{
            position: 'absolute',
            top: '-12px', right: '24px',
            background: '#7c3aed',
            color: '#fff',
            padding: '4px 12px',
            borderRadius: '999px',
            fontSize: '11px',
            fontWeight: 600,
            letterSpacing: '0.06em',
          }}
        >
          RECOMMENDED
        </div>
      )}
      <div style={{ fontSize: '14px', color: 'var(--text2)', marginBottom: '8px' }}>{tier}</div>
      <div className="flex items-baseline gap-1 mb-4">
        <span style={{ fontSize: '44px', fontWeight: 600, letterSpacing: '-0.02em' }}>{price}</span>
        <span style={{ color: 'var(--text3)', fontSize: '15px' }}>{period}</span>
      </div>
      <p style={{ color: 'var(--text2)', fontSize: '14px', lineHeight: 1.55, marginBottom: '24px' }}>
        {blurb}
      </p>
      <ul className="space-y-3 mb-8">
        {features.map(f => (
          <li key={f} className="flex items-start gap-2" style={{ fontSize: '13px', color: 'var(--text2)' }}>
            <CheckCircle2 size={14} style={{ color: '#34d399', flexShrink: 0, marginTop: '2px' }} />
            <span>{f}</span>
          </li>
        ))}
      </ul>
      <Link
        href="/signup"
        style={{
          display: 'block',
          background: highlighted ? '#7c3aed' : 'transparent',
          color: highlighted ? '#fff' : 'var(--text)',
          border: highlighted ? 'none' : '1px solid var(--border2)',
          padding: '12px',
          borderRadius: '10px',
          textAlign: 'center',
          fontWeight: 500,
          fontSize: '14px',
        }}
        className="hover:opacity-90 transition"
      >
        Start free trial
      </Link>
    </div>
  )
}

// -------------------------------------------------------------
// FAQ
// -------------------------------------------------------------
function FAQ() {
  const items = [
    {
      q: 'What does the Council actually do?',
      a: 'A News Scout pulls fresh data. A Lead Analyst makes the directional call from your chosen lens (technical, fundamental, or balanced). A Devil\'s Advocate cross-pressures from the opposite lens. Both sides ask one research question each, fetch fresh data, and rebut. A neutral Judge reads the full transcript, weighs argument quality, and delivers the verdict  -  including stop, target, three probability-weighted scenarios, and the one specific condition that would invalidate the thesis. You see the whole transcript, not just the conclusion.',
    },
    {
      q: 'How do I know your analysis is any good?',
      a: 'Every BULLISH and BEARISH verdict is logged with a timestamp. An automated cron job computes the actual outcome at one week and one month  -  both strict (did the price hit the target?) and directional (did it move the right way?). The /api/backtest/stats endpoint exposes hit rates by analytical lens, timeframe, and confidence band. We are not aware of another retail tool that publishes its track record this transparently.',
    },
    {
      q: 'What assets are covered?',
      a: 'US equities (full Alpaca universe  -  stocks, ETFs, ADRs), 25+ cryptocurrencies via CoinGecko, and 30+ forex pairs via ECB Frankfurter data. The Council runs identically across all three with asset-class-appropriate framing  -  for example, the forex prompt path skips fundamentals (no P/E for currency pairs) and focuses on central-bank policy divergence and interest rate differentials.',
    },
    {
      q: 'What about options?',
      a: 'Tradier production API integration provides the real options chain with real Greeks. The Council\'s options strategy section gives concrete recommendations  -  specific strikes, expirations, and types  -  with delta, theta, and IV cited. Earnings implied move is compared against historical actual moves to flag mispriced premium. GEX (gamma exposure) is incorporated into strategy selection.',
    },
    {
      q: 'Can I cancel anytime?',
      a: 'Yes. Subscription management is via the Stripe customer portal, accessible from your dashboard. The 7-day free trial does not require a card. Standard subscribers can upgrade to Pro mid-cycle with prorated billing.',
    },
  ]

  return (
    <section className="max-w-3xl mx-auto px-6 py-20">
      <div className="text-center mb-12">
        <h2 style={{ fontSize: 'clamp(1.75rem, 3vw, 2.25rem)', fontWeight: 600, letterSpacing: '-0.01em' }}>
          Questions you probably have
        </h2>
      </div>
      <div className="space-y-6">
        {items.map(item => (
          <div
            key={item.q}
            style={{
              borderBottom: '1px solid var(--border)',
              paddingBottom: '20px',
            }}
          >
            <div style={{ fontWeight: 600, fontSize: '15px', marginBottom: '8px' }}>
              {item.q}
            </div>
            <div style={{ color: 'var(--text2)', fontSize: '14px', lineHeight: 1.6 }}>
              {item.a}
            </div>
          </div>
        ))}
      </div>

      {/* Final CTA */}
      <div className="text-center mt-16">
        <h3 style={{ fontSize: '24px', fontWeight: 600, marginBottom: '12px', letterSpacing: '-0.01em' }}>
          Run an analysis. See the difference.
        </h3>
        <p style={{ color: 'var(--text2)', marginBottom: '20px', fontSize: '14px' }}>
          7 days free. No card required.
        </p>
        <Link
          href="/signup"
          style={{
            background: '#7c3aed',
            color: '#fff',
            padding: '14px 24px',
            borderRadius: '10px',
            fontWeight: 500,
            fontSize: '15px',
            display: 'inline-flex',
            alignItems: 'center',
            gap: '8px',
          }}
          className="hover:opacity-90 transition"
        >
          Start free trial
          <ArrowRight size={16} />
        </Link>
      </div>
    </section>
  )
}

// -------------------------------------------------------------
// Footer
// -------------------------------------------------------------
function Footer() {
  return (
    <footer
      style={{
        borderTop: '1px solid var(--border)',
        background: 'var(--surface)',
        padding: '48px 24px',
      }}
    >
      <div className="max-w-6xl mx-auto">
        <div className="flex flex-wrap justify-between items-start gap-8">
          <div>
            <div className="flex items-center gap-3 mb-3">
              <WaliLogo size="xs" noLink />
              <span style={{ fontFamily: 'IBM Plex Mono, monospace', fontWeight: 600, fontSize: '14px' }}>
                Wali-OS
              </span>
            </div>
            <div style={{ color: 'var(--text3)', fontSize: '13px', maxWidth: '320px', lineHeight: 1.5 }}>
              AI stock analysis with the depth of a research team and the discipline of a backtest.
            </div>
          </div>
          <div className="flex flex-wrap gap-12">
            <FooterColumn
              title="Product"
              links={[
                { href: '/login', label: 'Log in' },
                { href: '/signup', label: 'Sign up' },
              ]}
            />
            <FooterColumn
              title="Legal"
              links={[
                { href: '/privacy', label: 'Privacy' },
                { href: '/terms', label: 'Terms' },
                { href: '/disclaimer', label: 'Disclaimer' },
              ]}
            />
          </div>
        </div>
        <div
          style={{
            marginTop: '32px',
            paddingTop: '24px',
            borderTop: '1px solid var(--border)',
            color: 'var(--text3)',
            fontSize: '12px',
            lineHeight: 1.6,
          }}
        >
          Wali-OS is for informational and educational purposes. Nothing in the
          product constitutes investment advice. Past performance does not
          guarantee future results. Trading carries risk of loss. (c) {new Date().getFullYear()} Wali-OS.
        </div>
      </div>
    </footer>
  )
}

function FooterColumn({ title, links }: { title: string; links: { href: string; label: string }[] }) {
  return (
    <div>
      <div style={{ color: 'var(--text3)', fontSize: '12px', letterSpacing: '0.08em', marginBottom: '12px', fontFamily: 'IBM Plex Mono, monospace' }}>
        {title.toUpperCase()}
      </div>
      <div className="space-y-2">
        {links.map(l => (
          <Link
            key={l.href}
            href={l.href}
            style={{ color: 'var(--text2)', fontSize: '13px', display: 'block' }}
            className="hover:opacity-80 transition"
          >
            {l.label}
          </Link>
        ))}
      </div>
    </div>
  )
}
