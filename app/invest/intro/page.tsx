'use client'

import { useState, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { ChevronRight } from 'lucide-react'

// ══════════════════════════════════════════════════════════════
// INVEST INTRO — The Calling
// Cinematic cold-open: darkness → spark → flame → content emerges
// from firelight. User reads, accepts, crosses into the forge.
// ══════════════════════════════════════════════════════════════

type Phase = 'dark' | 'spark' | 'ignite' | 'content'

export default function InvestIntroPage() {
  const router = useRouter()
  const [phase, setPhase] = useState<Phase>('dark')
  const [accepting, setAccepting] = useState(false)
  const [checked, setChecked] = useState(false)
  const [skipIntro, setSkipIntro] = useState(false)
  const skipRef = useRef(false)

  // Check if already accepted (redirect if so)
  useEffect(() => {
    fetch('/api/invest/intro')
      .then(r => r.json())
      .then(d => { if (d.accepted) router.replace('/invest') })
      .catch(() => {})
  }, [router])

  // The cold-open sequence — dark → spark → ignite → content
  useEffect(() => {
    const timers: Array<ReturnType<typeof setTimeout>> = []
    timers.push(setTimeout(() => { if (!skipRef.current) setPhase('spark') }, 600))
    timers.push(setTimeout(() => { if (!skipRef.current) setPhase('ignite') }, 1600))
    timers.push(setTimeout(() => { if (!skipRef.current) setPhase('content') }, 3000))
    return () => timers.forEach(clearTimeout)
  }, [])

  // Allow user to skip the animation with a tap or key press
  useEffect(() => {
    const onSkip = () => {
      if (phase !== 'content') {
        skipRef.current = true
        setSkipIntro(true)
        setPhase('content')
      }
    }
    window.addEventListener('keydown', onSkip)
    window.addEventListener('touchstart', onSkip, { passive: true })
    return () => {
      window.removeEventListener('keydown', onSkip)
      window.removeEventListener('touchstart', onSkip)
    }
  }, [phase])

  const accept = async () => {
    if (!checked || accepting) return
    setAccepting(true)
    await fetch('/api/invest/intro', { method: 'POST' }).catch(() => {})
    router.push('/invest')
  }

  return (
    <div className={`intro-root phase-${phase}`}>
      {/* Atmospheric layers — all z-stacked, always rendered */}
      <div className="intro-vignette" />
      <div className="intro-firelight" />
      <IntroParticles active={phase !== 'dark'} />

      {/* The flame — grows in with the sequence */}
      <div className="intro-flame-wrap">
        <FlameGraphic />
      </div>

      {/* Title phase — the words that emerge with the flame */}
      <div className="intro-callout">
        <div className="intro-callout-eyebrow">wali · forge</div>
        <h1 className="intro-callout-title">
          <span className="w1">Come</span>{' '}
          <span className="w2">close</span>{' '}
          <span className="w3">to</span>{' '}
          <span className="w4">the</span>{' '}
          <span className="w5">fire.</span>
        </h1>
      </div>

      {/* Skip hint (only during animation) */}
      {phase !== 'content' && !skipIntro && (
        <button
          className="intro-skip"
          onClick={() => { skipRef.current = true; setSkipIntro(true); setPhase('content') }}
        >
          tap to skip →
        </button>
      )}

      {/* Content column — rises up from below after animation */}
      <div className="intro-column">
        <div className="intro-column-inner">

          <header className="intro-header">
            <div className="eyebrow">the invest journey</div>
            <h2 className="intro-h2">
              Before you start —<br />
              <em>here is what this really is.</em>
            </h2>
            <p className="intro-lede">
              The journey is built for real markets with real stakes.
              Spend sixty seconds at the fire so you know what you are
              walking into.
            </p>
          </header>

          {/* Section 1 — The stocks */}
          <section className="intro-section">
            <div className="intro-section-label">the stocks</div>
            <div className="intro-cards">
              <IntroCard
                title="Small-cap and micro-cap stocks"
                body="Smaller companies — often under $500M market cap. They move fast, react hard to news, and have lower liquidity than large-caps. That's why they can double. It's also why they can drop forty percent in a week."
                accent="#f97316"
                glyph="▲"
              />
              <IntroCard
                title="Momentum and volume plays"
                body="The council looks for stocks with unusual volume today — something is moving them. Earnings, a catalyst, a short squeeze, sector rotation. The council identifies the setup. What happens after is the market's call."
                accent="#fbbf24"
                glyph="≈"
              />
              <IntroCard
                title="Sized to what you actually have"
                body="At $5 you buy 2–3 shares of a $1–2 stock. At $500 you buy 15 shares of a $25 stock. The stage system scales the price range so every position feels like a real holding — not a lottery ticket, not an afterthought."
                accent="#34d399"
                glyph="◈"
              />
            </div>
          </section>

          {/* Section 2 — What the council does / does not */}
          <section className="intro-section">
            <div className="intro-section-label">what the council does</div>
            <div className="intro-ledger">
              <div className="ledger-column ledger-does">
                <div className="ledger-head">It does</div>
                <ul>
                  <li>Screens real volume movers from live market data</li>
                  <li>Reads sector momentum from the macro dashboard</li>
                  <li>Gives a specific entry zone, stop, and target</li>
                  <li>Sizes each position to your actual capital</li>
                </ul>
              </div>
              <div className="ledger-divider" />
              <div className="ledger-column ledger-doesnot">
                <div className="ledger-head">It does not</div>
                <ul>
                  <li>Predict what any stock will do tomorrow</li>
                  <li>Guarantee any return at any stage</li>
                  <li>Replace your own judgment on the trade</li>
                  <li>Protect you from your own psychology</li>
                </ul>
              </div>
            </div>
          </section>

          {/* Section 3 — The honest bit */}
          <section className="intro-section">
            <div className="intro-honest">
              <div className="intro-honest-mark">⚠</div>
              <p>
                Every position here is real money in a real market. Keep each
                trade small enough that a loss is a lesson, not a setback.
                The goal of the journey is to build the habit of sizing,
                entering, and exiting with discipline — that skill compounds
                over time even when individual trades do not.
              </p>
            </div>
          </section>

          {/* The pullquote pivot */}
          <blockquote className="intro-pullquote">
            <span className="pq-mark" aria-hidden>"</span>
            Small positions let you make mistakes cheaply.
            And you will make mistakes — everyone does.
          </blockquote>

          {/* The oath */}
          <section className="intro-oath">
            <div className="intro-section-label">the oath</div>

            <label className="oath-check">
              <button
                type="button"
                className={`oath-checkbox ${checked ? 'on' : ''}`}
                onClick={() => setChecked(!checked)}
                aria-checked={checked}
                role="checkbox"
              >
                {checked && (
                  <svg width="14" height="10" viewBox="0 0 14 10" fill="none" aria-hidden>
                    <path d="M1 5L5 9L13 1" stroke="#0a0503" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
              </button>
              <span className="oath-text">
                I understand these are volatile, small-cap stocks with real
                downside risk. I will only invest money I am comfortable
                losing on any individual trade.
              </span>
            </label>

            <button
              className={`intro-cta ${checked ? 'ready' : 'waiting'}`}
              disabled={!checked || accepting}
              onClick={accept}
            >
              {accepting ? (
                <span className="intro-cta-dots">
                  {[0, 1, 2].map(i => (
                    <span key={i} style={{ animationDelay: `${i * 0.15}s` }} />
                  ))}
                </span>
              ) : (
                <>
                  {checked ? 'Cross into the forge' : 'Accept the oath to continue'}
                  {checked && <ChevronRight size={15} />}
                </>
              )}
            </button>

            <p className="intro-finepoint">
              You will only see this once. Your acceptance is recorded in your journey.
            </p>
          </section>

        </div>
      </div>

      <IntroStyles />
    </div>
  )
}

// ══════════════════════════════════════════════════════════════
// SUB-COMPONENTS
// ══════════════════════════════════════════════════════════════

function FlameGraphic() {
  return (
    <svg className="intro-flame" viewBox="0 0 220 220" xmlns="http://www.w3.org/2000/svg" aria-hidden>
      <defs>
        <radialGradient id="introFlameOuter" cx="50%" cy="80%" r="60%">
          <stop offset="0%" stopColor="#fff4d6" stopOpacity="0.95" />
          <stop offset="30%" stopColor="#fbbf24" stopOpacity="0.75" />
          <stop offset="65%" stopColor="#f97316" stopOpacity="0.5" />
          <stop offset="100%" stopColor="#ef4444" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="introFlameCore" cx="50%" cy="75%" r="40%">
          <stop offset="0%" stopColor="#ffffff" stopOpacity="0.95" />
          <stop offset="100%" stopColor="#fbbf24" stopOpacity="0" />
        </radialGradient>
      </defs>
      <g className="intro-flame-core">
        <path
          d="M110 200 C 60 180, 50 130, 80 90 C 90 110, 100 105, 95 80 C 115 95, 130 110, 130 140 C 140 125, 150 130, 150 150 C 160 140, 165 155, 160 170 C 155 185, 140 200, 110 200 Z"
          fill="url(#introFlameOuter)"
        />
        <path
          d="M110 180 C 85 170, 80 140, 100 115 C 105 130, 115 128, 112 108 C 125 120, 135 135, 135 155 C 140 150, 145 158, 142 170 C 138 180, 128 188, 110 188 Z"
          fill="url(#introFlameCore)"
        />
      </g>
    </svg>
  )
}

function IntroCard({ title, body, accent, glyph }: {
  title: string; body: string; accent: string; glyph: string
}) {
  return (
    <div className="intro-card" style={{ ['--accent' as string]: accent }}>
      <div className="intro-card-glyph" aria-hidden>{glyph}</div>
      <div className="intro-card-body">
        <div className="intro-card-title">{title}</div>
        <p>{body}</p>
      </div>
    </div>
  )
}

function IntroParticles({ active }: { active: boolean }) {
  const count = 28
  return (
    <div className={`intro-particles ${active ? 'on' : ''}`} aria-hidden>
      {Array.from({ length: count }).map((_, i) => {
        const left = Math.random() * 100
        const dur = 10 + Math.random() * 16
        const delay = Math.random() * 20
        const drift = Math.random() * 50 - 25
        const opacity = 0.25 + Math.random() * 0.4
        return (
          <span
            key={i}
            className="intro-particle"
            style={{
              left: `${left}%`,
              animationDuration: `${dur}s`,
              animationDelay: `${delay}s`,
              ['--drift' as string]: `${drift}px`,
              opacity,
            }}
          />
        )
      })}
    </div>
  )
}

// ══════════════════════════════════════════════════════════════
// STYLES
// ══════════════════════════════════════════════════════════════
function IntroStyles() {
  return (
    <style jsx global>{`
      @import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,300;9..144,400;9..144,500&family=JetBrains+Mono:wght@300;400;500&display=swap');

      .intro-root {
        font-family: 'Fraunces', Georgia, serif;
        color: rgba(255, 240, 220, 0.92);
        background: #050201;
        min-height: 100vh;
        position: relative;
        overflow-x: hidden;
      }
      .intro-root * { box-sizing: border-box; }
      .intro-root .mono { font-family: 'JetBrains Mono', monospace; }
      .intro-root .eyebrow {
        font-family: 'JetBrains Mono', monospace;
        font-size: 10px;
        letter-spacing: 0.26em;
        text-transform: uppercase;
        color: rgba(255, 180, 100, 0.55);
      }

      /* ── Atmospheric layers ──────────────────────── */
      .intro-vignette {
        position: fixed; inset: 0; z-index: 0; pointer-events: none;
        background: radial-gradient(ellipse at 50% 50%, #1a0b05 0%, #0a0503 50%, #000 100%);
      }
      .intro-firelight {
        position: fixed; inset: 0; z-index: 1; pointer-events: none;
        background:
          radial-gradient(ellipse 800px 500px at 50% 60%, rgba(249,115,22,0.12) 0%, transparent 60%),
          radial-gradient(ellipse 400px 300px at 50% 60%, rgba(251,191,36,0.08) 0%, transparent 70%);
        opacity: 0;
        transition: opacity 1.8s ease-out;
      }
      .phase-spark .intro-firelight { opacity: 0.4; transition-duration: 0.8s; }
      .phase-ignite .intro-firelight { opacity: 0.9; }
      .phase-content .intro-firelight { opacity: 1; }

      /* Particles */
      .intro-particles {
        position: fixed; inset: 0; z-index: 2; pointer-events: none;
        opacity: 0;
        transition: opacity 1.6s ease-out;
      }
      .intro-particles.on { opacity: 1; }
      .intro-particle {
        position: absolute; bottom: 30vh;
        width: 2px; height: 2px; border-radius: 50%;
        background: rgba(255, 200, 130, 0.9);
        box-shadow: 0 0 4px rgba(255, 180, 100, 0.8);
        animation: intro-rise linear infinite;
      }
      @keyframes intro-rise {
        0% { transform: translateY(0) translateX(0); opacity: 0; }
        10% { opacity: 1; }
        90% { opacity: 1; }
        100% { transform: translateY(-80vh) translateX(var(--drift, 20px)); opacity: 0; }
      }

      /* ── The flame (center of the cold-open) ───── */
      .intro-flame-wrap {
        position: fixed;
        left: 50%;
        top: 50%;
        transform: translate(-50%, -50%);
        width: 220px; height: 220px;
        z-index: 3;
        transition: all 1.4s cubic-bezier(0.22, 1, 0.36, 1);
        opacity: 0;
      }
      .phase-dark .intro-flame-wrap {
        opacity: 0;
        transform: translate(-50%, -50%) scale(0.1);
      }
      .phase-spark .intro-flame-wrap {
        opacity: 0.5;
        transform: translate(-50%, -50%) scale(0.3);
        transition-duration: 0.6s;
      }
      .phase-ignite .intro-flame-wrap {
        opacity: 1;
        transform: translate(-50%, -50%) scale(0.85);
      }
      .phase-content .intro-flame-wrap {
        opacity: 0.45;
        /* Move up behind/above the content column */
        transform: translate(-50%, -120%) scale(0.65);
      }
      @media (min-width: 720px) {
        .phase-content .intro-flame-wrap {
          transform: translate(-50%, -140%) scale(0.75);
        }
      }
      .intro-flame {
        width: 100%; height: 100%;
        filter: drop-shadow(0 0 40px rgba(249, 115, 22, 0.5));
      }
      .intro-flame-core {
        animation: introFlicker 3.2s ease-in-out infinite;
        transform-origin: 50% 100%;
      }
      @keyframes introFlicker {
        0%, 100% { transform: scale(1, 1); }
        33% { transform: scale(1.03, 0.97); }
        66% { transform: scale(0.97, 1.04); }
      }

      /* ── The opening callout text ──────────────── */
      .intro-callout {
        position: fixed;
        left: 50%;
        top: 50%;
        transform: translate(-50%, 140px);
        text-align: center;
        z-index: 4;
        opacity: 0;
        transition: all 1.2s cubic-bezier(0.22, 1, 0.36, 1);
        pointer-events: none;
        width: 90%; max-width: 500px;
      }
      .phase-ignite .intro-callout {
        opacity: 1;
      }
      .phase-content .intro-callout {
        opacity: 0;
        transform: translate(-50%, 100px);
      }
      .intro-callout-eyebrow {
        font-family: 'JetBrains Mono', monospace;
        font-size: 10px;
        letter-spacing: 0.35em;
        text-transform: uppercase;
        color: rgba(251, 191, 36, 0.7);
        margin-bottom: 14px;
      }
      .intro-callout-title {
        font-family: 'Fraunces', serif;
        font-size: 36px;
        font-weight: 400;
        font-style: italic;
        letter-spacing: -0.015em;
        line-height: 1.15;
        margin: 0;
        color: rgba(255, 244, 214, 0.98);
      }
      @media (min-width: 720px) {
        .intro-callout-title { font-size: 46px; }
      }
      .intro-callout-title span {
        display: inline-block;
        opacity: 0;
        transform: translateY(6px);
        transition: opacity 0.9s ease, transform 0.9s ease;
      }
      .phase-ignite .intro-callout-title .w1 { opacity: 1; transform: none; transition-delay: 0.1s; }
      .phase-ignite .intro-callout-title .w2 { opacity: 1; transform: none; transition-delay: 0.3s; }
      .phase-ignite .intro-callout-title .w3 { opacity: 1; transform: none; transition-delay: 0.5s; }
      .phase-ignite .intro-callout-title .w4 { opacity: 1; transform: none; transition-delay: 0.6s; }
      .phase-ignite .intro-callout-title .w5 {
        opacity: 1; transform: none; transition-delay: 0.7s;
        background: linear-gradient(180deg, #fff4d6, #f97316);
        -webkit-background-clip: text; background-clip: text;
        -webkit-text-fill-color: transparent; color: transparent;
      }

      /* Skip hint */
      .intro-skip {
        position: fixed;
        bottom: 32px;
        left: 50%;
        transform: translateX(-50%);
        z-index: 10;
        padding: 10px 20px;
        background: rgba(255, 255, 255, 0.04);
        border: 1px solid rgba(255, 220, 180, 0.1);
        border-radius: 999px;
        color: rgba(255, 220, 180, 0.5);
        font-family: 'JetBrains Mono', monospace;
        font-size: 10px;
        letter-spacing: 0.2em;
        text-transform: uppercase;
        cursor: pointer;
        backdrop-filter: blur(6px);
        animation: introSkipBlink 2s ease-in-out infinite 1.2s;
        transition: all 0.2s ease;
      }
      .intro-skip:hover {
        color: #fbbf24;
        border-color: rgba(249, 115, 22, 0.3);
      }
      @keyframes introSkipBlink {
        0%, 100% { opacity: 0.4; }
        50% { opacity: 0.9; }
      }

      /* ── The content column ────────────────────── */
      .intro-column {
        position: relative;
        z-index: 5;
        min-height: 100vh;
        padding: 60vh 20px 40px;
        opacity: 0;
        transform: translateY(30px);
        transition: opacity 1.2s ease 0.4s, transform 1.2s cubic-bezier(0.22, 1, 0.36, 1) 0.4s;
        pointer-events: none;
      }
      .phase-content .intro-column {
        opacity: 1;
        transform: translateY(0);
        pointer-events: auto;
      }
      @media (min-width: 720px) {
        .intro-column { padding-top: 65vh; }
      }
      .intro-column-inner {
        max-width: 540px;
        margin: 0 auto;
      }

      /* Header */
      .intro-header {
        text-align: center;
        margin-bottom: 48px;
        padding-bottom: 40px;
        border-bottom: 1px solid rgba(249, 115, 22, 0.12);
      }
      .intro-header .eyebrow { margin-bottom: 16px; }
      .intro-h2 {
        font-family: 'Fraunces', serif;
        font-size: 28px;
        font-weight: 400;
        line-height: 1.2;
        letter-spacing: -0.01em;
        margin: 0 0 18px;
        color: rgba(255, 244, 214, 0.95);
      }
      @media (min-width: 720px) {
        .intro-h2 { font-size: 36px; }
      }
      .intro-h2 em {
        font-style: italic;
        background: linear-gradient(180deg, #fff4d6 0%, #f97316 100%);
        -webkit-background-clip: text; background-clip: text;
        -webkit-text-fill-color: transparent; color: transparent;
      }
      .intro-lede {
        font-family: 'Fraunces', serif;
        font-size: 15px;
        line-height: 1.65;
        color: rgba(255, 220, 180, 0.6);
        font-style: italic;
        margin: 0 auto;
        max-width: 440px;
      }

      /* Sections */
      .intro-section {
        margin-bottom: 40px;
      }
      .intro-section-label {
        font-family: 'JetBrains Mono', monospace;
        font-size: 10px;
        letter-spacing: 0.28em;
        text-transform: uppercase;
        color: rgba(249, 115, 22, 0.6);
        margin-bottom: 16px;
        text-align: center;
      }

      /* Cards */
      .intro-cards {
        display: flex; flex-direction: column; gap: 10px;
      }
      .intro-card {
        display: flex; gap: 16px; align-items: flex-start;
        padding: 18px 20px;
        border-radius: 14px;
        background: linear-gradient(180deg, rgba(255,255,255,0.025), rgba(255,255,255,0.01));
        border: 1px solid rgba(249, 115, 22, 0.12);
        position: relative;
        transition: all 0.3s ease;
      }
      .intro-card:hover {
        border-color: var(--accent, rgba(249,115,22,0.3));
        transform: translateY(-1px);
      }
      .intro-card-glyph {
        width: 36px; height: 36px;
        flex-shrink: 0;
        border-radius: 50%;
        background: rgba(0, 0, 0, 0.3);
        border: 1px solid var(--accent);
        color: var(--accent);
        font-family: 'JetBrains Mono', monospace;
        font-size: 16px;
        display: flex; align-items: center; justify-content: center;
        box-shadow: 0 0 14px color-mix(in srgb, var(--accent) 40%, transparent);
      }
      .intro-card-body { flex: 1; min-width: 0; }
      .intro-card-title {
        font-family: 'Fraunces', serif;
        font-size: 16px;
        font-weight: 500;
        color: rgba(255, 244, 214, 0.95);
        margin-bottom: 6px;
        letter-spacing: -0.005em;
      }
      .intro-card-body p {
        font-family: 'Fraunces', serif;
        font-size: 13px;
        line-height: 1.6;
        color: rgba(255, 220, 180, 0.62);
        margin: 0;
      }

      /* Ledger (does / does not) */
      .intro-ledger {
        display: grid;
        grid-template-columns: 1fr;
        gap: 20px;
        padding: 22px 20px;
        border-radius: 14px;
        background: rgba(0, 0, 0, 0.25);
        border: 1px solid rgba(249, 115, 22, 0.15);
      }
      @media (min-width: 560px) {
        .intro-ledger {
          grid-template-columns: 1fr 1px 1fr;
          gap: 24px;
          padding: 24px 28px;
        }
      }
      .ledger-divider {
        display: none;
        background: linear-gradient(to bottom, transparent, rgba(249,115,22,0.2), transparent);
      }
      @media (min-width: 560px) {
        .ledger-divider { display: block; }
      }
      .ledger-head {
        font-family: 'JetBrains Mono', monospace;
        font-size: 10px;
        letter-spacing: 0.22em;
        text-transform: uppercase;
        margin-bottom: 12px;
      }
      .ledger-does .ledger-head { color: #34d399; }
      .ledger-doesnot .ledger-head { color: #f87171; }
      .ledger-column ul {
        list-style: none;
        padding: 0;
        margin: 0;
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .ledger-column li {
        font-family: 'Fraunces', serif;
        font-size: 13px;
        line-height: 1.5;
        color: rgba(255, 220, 180, 0.72);
        padding-left: 16px;
        position: relative;
      }
      .ledger-does li::before {
        content: '+';
        position: absolute; left: 0; top: 0;
        color: #34d399;
        font-family: 'JetBrains Mono', monospace;
        font-size: 12px;
        font-weight: 500;
      }
      .ledger-doesnot li::before {
        content: '−';
        position: absolute; left: 0; top: 0;
        color: #f87171;
        font-family: 'JetBrains Mono', monospace;
        font-size: 12px;
        font-weight: 500;
      }

      /* Honest bit (warning block) */
      .intro-honest {
        display: flex;
        gap: 14px;
        padding: 20px;
        border-radius: 14px;
        background: linear-gradient(180deg, rgba(251,191,36,0.08), rgba(251,191,36,0.02));
        border: 1px solid rgba(251, 191, 36, 0.2);
      }
      .intro-honest-mark {
        font-size: 20px;
        color: #fbbf24;
        flex-shrink: 0;
        line-height: 1.2;
        filter: drop-shadow(0 0 8px rgba(251, 191, 36, 0.5));
      }
      .intro-honest p {
        font-family: 'Fraunces', serif;
        font-size: 14px;
        line-height: 1.65;
        color: rgba(251, 191, 36, 0.85);
        margin: 0;
        font-style: italic;
      }

      /* Pullquote */
      .intro-pullquote {
        font-family: 'Fraunces', serif;
        font-size: 22px;
        font-style: italic;
        font-weight: 400;
        line-height: 1.4;
        text-align: center;
        color: rgba(255, 244, 214, 0.92);
        margin: 48px 0;
        padding: 24px 20px;
        border-top: 1px solid rgba(249, 115, 22, 0.15);
        border-bottom: 1px solid rgba(249, 115, 22, 0.15);
        position: relative;
      }
      @media (min-width: 720px) { .intro-pullquote { font-size: 26px; } }
      .pq-mark {
        display: block;
        font-size: 52px;
        line-height: 0.3;
        color: #f97316;
        opacity: 0.5;
        margin-bottom: 14px;
      }

      /* Oath */
      .intro-oath {
        padding: 24px 20px 8px;
        border-radius: 16px;
        background: radial-gradient(ellipse 300px 200px at 50% 0%, rgba(249, 115, 22, 0.08), transparent 70%);
      }
      .intro-oath .intro-section-label { color: #fbbf24; }
      .oath-check {
        display: flex;
        gap: 14px;
        align-items: flex-start;
        padding: 16px;
        border-radius: 12px;
        background: rgba(0, 0, 0, 0.25);
        border: 1px solid rgba(249, 115, 22, 0.12);
        margin-bottom: 20px;
        cursor: pointer;
        transition: all 0.2s ease;
      }
      .oath-check:hover {
        border-color: rgba(249, 115, 22, 0.3);
      }
      .oath-checkbox {
        width: 24px; height: 24px;
        flex-shrink: 0;
        border-radius: 6px;
        border: 2px solid rgba(255, 220, 180, 0.25);
        background: transparent;
        display: flex; align-items: center; justify-content: center;
        cursor: pointer;
        transition: all 0.2s ease;
        padding: 0;
      }
      .oath-checkbox.on {
        background: linear-gradient(135deg, #fbbf24, #f97316);
        border-color: #fbbf24;
        box-shadow: 0 0 16px rgba(251, 191, 36, 0.5);
      }
      .oath-text {
        font-family: 'Fraunces', serif;
        font-size: 14px;
        line-height: 1.6;
        color: rgba(255, 220, 180, 0.75);
      }

      /* CTA */
      .intro-cta {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 10px;
        width: 100%;
        padding: 16px 20px;
        border-radius: 14px;
        border: 0;
        font-family: 'JetBrains Mono', monospace;
        font-size: 11px;
        letter-spacing: 0.22em;
        text-transform: uppercase;
        font-weight: 500;
        cursor: pointer;
        transition: all 0.35s cubic-bezier(0.22, 1, 0.36, 1);
      }
      .intro-cta.waiting {
        background: rgba(255, 255, 255, 0.03);
        border: 1px solid rgba(255, 220, 180, 0.1);
        color: rgba(255, 220, 180, 0.35);
        cursor: not-allowed;
      }
      .intro-cta.ready {
        background: linear-gradient(135deg, #f97316 0%, #ef4444 100%);
        color: #fff4d6;
        box-shadow: 0 0 24px rgba(249, 115, 22, 0.35), 0 8px 24px rgba(239, 68, 68, 0.2);
      }
      .intro-cta.ready:hover:not(:disabled) {
        box-shadow: 0 0 36px rgba(249, 115, 22, 0.55), 0 8px 32px rgba(239, 68, 68, 0.3);
        transform: translateY(-1px);
      }
      .intro-cta-dots {
        display: flex; gap: 6px;
      }
      .intro-cta-dots span {
        width: 6px; height: 6px; border-radius: 50%;
        background: #fff4d6;
        animation: introCtaBounce 1s ease-in-out infinite;
      }
      @keyframes introCtaBounce {
        0%, 100% { transform: translateY(0); opacity: 0.5; }
        50% { transform: translateY(-6px); opacity: 1; }
      }

      .intro-finepoint {
        font-family: 'Fraunces', serif;
        font-style: italic;
        font-size: 12px;
        color: rgba(255, 220, 180, 0.3);
        text-align: center;
        margin: 16px 0 0;
      }
    `}</style>
  )
}
