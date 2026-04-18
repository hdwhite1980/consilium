'use client'

import { useState, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { ChevronRight } from 'lucide-react'

// ══════════════════════════════════════════════════════════════
// INVEST INTRO — "The Opening Bell"
// Floor cold-open: dark floor → price line draws → orb ignites
// → content rises. Editorial, investor-serious tone.
// ══════════════════════════════════════════════════════════════

type Phase = 'dark' | 'line' | 'ignite' | 'content'

export default function InvestIntroPage() {
  const router = useRouter()
  const [phase, setPhase] = useState<Phase>('dark')
  const [accepting, setAccepting] = useState(false)
  const [checked, setChecked] = useState(false)
  const [skipIntro, setSkipIntro] = useState(false)
  const skipRef = useRef(false)

  useEffect(() => {
    fetch('/api/invest/intro')
      .then(r => r.json())
      .then(d => { if (d.accepted) router.replace('/invest') })
      .catch(() => {})
  }, [router])

  useEffect(() => {
    const timers: Array<ReturnType<typeof setTimeout>> = []
    timers.push(setTimeout(() => { if (!skipRef.current) setPhase('line') }, 400))
    timers.push(setTimeout(() => { if (!skipRef.current) setPhase('ignite') }, 1400))
    timers.push(setTimeout(() => { if (!skipRef.current) setPhase('content') }, 2600))
    return () => timers.forEach(clearTimeout)
  }, [])

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
    <div className={`fi-root fi-phase-${phase}`}>
      <div className="fi-vignette" />

      {/* Horizontal price line drawing across the screen */}
      <svg className="fi-tape-line" viewBox="0 0 1200 200" preserveAspectRatio="none">
        <path
          d="M 0 100 L 150 100 L 180 70 L 230 90 L 280 50 L 340 80 L 400 60 L 480 85 L 540 40 L 620 70 L 690 55 L 780 90 L 860 30 L 940 60 L 1020 45 L 1100 70 L 1200 55"
          fill="none"
          stroke="#d4a857"
          strokeWidth="1"
          className="fi-tape-path"
        />
      </svg>

      {/* Portfolio orb — rises from darkness */}
      <div className="fi-orb-wrap">
        <svg className="fi-orb" viewBox="0 0 220 220" aria-hidden>
          <defs>
            <radialGradient id="fiOrbGrad" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="#10b981" stopOpacity="0.35" />
              <stop offset="40%" stopColor="#d4a857" stopOpacity="0.2" />
              <stop offset="100%" stopColor="#d4a857" stopOpacity="0" />
            </radialGradient>
            <radialGradient id="fiOrbCore" cx="50%" cy="50%" r="35%">
              <stop offset="0%" stopColor="#f5f5f5" stopOpacity="0.9" />
              <stop offset="100%" stopColor="#d4a857" stopOpacity="0" />
            </radialGradient>
          </defs>
          <circle cx="110" cy="110" r="100" fill="url(#fiOrbGrad)" />
          <circle cx="110" cy="110" r="80" fill="none" stroke="#d4a857" strokeOpacity="0.3" strokeWidth="0.5" strokeDasharray="1 6" className="fi-orb-ring" />
          <circle cx="110" cy="110" r="54" fill="url(#fiOrbCore)" />
          <circle cx="110" cy="110" r="3" fill="#d4a857" />
        </svg>
      </div>

      {/* Opening text */}
      <div className="fi-callout">
        <div className="fi-callout-eyebrow">wali · floor</div>
        <h1 className="fi-callout-title">
          <span className="w1">Welcome</span>{' '}
          <span className="w2">to</span>{' '}
          <span className="w3">the</span>{' '}
          <span className="w4">floor.</span>
        </h1>
      </div>

      {phase !== 'content' && !skipIntro && (
        <button
          className="fi-skip"
          onClick={() => { skipRef.current = true; setSkipIntro(true); setPhase('content') }}
        >
          tap to skip →
        </button>
      )}

      {/* Content column */}
      <div className="fi-column">
        <div className="fi-column-inner">

          <header className="fi-header">
            <div className="fi-eyebrow">the invest desk</div>
            <h2 className="fi-h2">
              Before you submit a single order —<br />
              <em>here is what this really is.</em>
            </h2>
            <p className="fi-lede">
              The floor is built for real markets with real stakes. Sixty seconds
              here so you know what you are stepping onto.
            </p>
          </header>

          {/* The instruments */}
          <section className="fi-section">
            <div className="fi-section-label">the instruments</div>
            <div className="fi-cards">
              <IntroCard
                title="Small and micro-cap equities"
                body="Smaller companies — often under $500M market cap. They move fast, react hard to news, and have lower liquidity than large-caps. That is why they can double. It is also why they can drop forty percent in a week."
                accent="#14b8a6"
                glyph="§"
              />
              <IntroCard
                title="Volume and momentum setups"
                body="The council screens for unusual volume — something is moving the tape. Earnings, a catalyst, a short squeeze, sector rotation. The council identifies the setup. The market executes it."
                accent="#d4a857"
                glyph="≈"
              />
              <IntroCard
                title="Sized to your actual capital"
                body="At $5 you buy 2–3 shares of a $1–2 instrument. At $500 you buy 15 shares of a $25 instrument. The tier system scales price range so every position is a real holding — not a lottery ticket."
                accent="#10b981"
                glyph="◇"
              />
            </div>
          </section>

          {/* What the council does / does not */}
          <section className="fi-section">
            <div className="fi-section-label">the council</div>
            <div className="fi-ledger">
              <div className="fi-ledger-col fi-ledger-does">
                <div className="fi-ledger-head">It does</div>
                <ul>
                  <li>Screens real volume movers from live market data</li>
                  <li>Reads sector momentum from the macro feed</li>
                  <li>Publishes specific entry, stop, and target</li>
                  <li>Sizes each position to available capital</li>
                </ul>
              </div>
              <div className="fi-ledger-divider" />
              <div className="fi-ledger-col fi-ledger-doesnot">
                <div className="fi-ledger-head">It does not</div>
                <ul>
                  <li>Predict what any instrument will do tomorrow</li>
                  <li>Guarantee any return at any tier</li>
                  <li>Replace your judgment on the trade</li>
                  <li>Protect you from your own psychology</li>
                </ul>
              </div>
            </div>
          </section>

          {/* The honest bit */}
          <section className="fi-section">
            <div className="fi-honest">
              <div className="fi-honest-mark">!</div>
              <p>
                Every position here is real money on a real tape. Keep each
                trade small enough that a loss is tuition, not ruin. The goal
                of the floor is the discipline of sizing, entering, and exiting
                with intent — that skill compounds over time, even when
                individual trades do not.
              </p>
            </div>
          </section>

          {/* Pullquote */}
          <blockquote className="fi-pullquote">
            Small positions let you make mistakes cheaply. And you will make
            mistakes — everyone does.
          </blockquote>

          {/* The oath */}
          <section className="fi-oath">
            <div className="fi-section-label">acceptance</div>

            <label className="fi-oath-check">
              <button
                type="button"
                className={`fi-oath-checkbox ${checked ? 'on' : ''}`}
                onClick={() => setChecked(!checked)}
                aria-checked={checked}
                role="checkbox"
              >
                {checked && (
                  <svg width="14" height="10" viewBox="0 0 14 10" fill="none" aria-hidden>
                    <path d="M1 5L5 9L13 1" stroke="#0a0e17" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
              </button>
              <span className="fi-oath-text">
                I understand these are volatile, small-cap equities with real
                downside risk. I will only commit capital I am prepared to
                lose on any individual trade.
              </span>
            </label>

            <button
              className={`fi-cta ${checked ? 'ready' : 'waiting'}`}
              disabled={!checked || accepting}
              onClick={accept}
            >
              {accepting ? (
                <span className="fi-cta-dots">
                  {[0, 1, 2].map(i => (
                    <span key={i} style={{ animationDelay: `${i * 0.15}s` }} />
                  ))}
                </span>
              ) : (
                <>
                  {checked ? 'Step onto the floor' : 'Accept to continue'}
                  {checked && <ChevronRight size={15} />}
                </>
              )}
            </button>

            <p className="fi-finepoint">
              You will only see this once. Your acceptance is recorded in your journey.
            </p>
          </section>

        </div>
      </div>

      <IntroStyles />
    </div>
  )
}

function IntroCard({ title, body, accent, glyph }: {
  title: string; body: string; accent: string; glyph: string
}) {
  return (
    <div className="fi-card" style={{ ['--fi-accent' as string]: accent }}>
      <div className="fi-card-glyph" aria-hidden>{glyph}</div>
      <div className="fi-card-body">
        <div className="fi-card-title">{title}</div>
        <p>{body}</p>
      </div>
    </div>
  )
}

function IntroStyles() {
  return (
    <style jsx global>{`
      @import url('https://fonts.googleapis.com/css2?family=Source+Serif+4:opsz,wght@8..60,300;8..60,400;8..60,500;8..60,600&family=Inter:wght@300;400;500;600&family=IBM+Plex+Mono:wght@300;400;500&display=swap');

      .fi-root {
        font-family: 'Inter', system-ui, sans-serif;
        color: rgba(241, 245, 249, 0.92);
        background: #050810;
        min-height: 100vh;
        position: relative;
        overflow-x: hidden;
      }
      .fi-root * { box-sizing: border-box; }
      .fi-root .mono { font-family: 'IBM Plex Mono', monospace; }
      .fi-eyebrow {
        font-family: 'IBM Plex Mono', monospace;
        font-size: 10px; letter-spacing: 0.26em;
        text-transform: uppercase;
        color: rgba(148, 163, 184, 0.6);
        font-weight: 500;
      }

      /* Vignette */
      .fi-vignette {
        position: fixed; inset: 0; z-index: 0;
        pointer-events: none;
        background:
          radial-gradient(ellipse at 50% 50%, #0a0e17 0%, #050810 60%, #000 100%);
      }

      /* Price line (cold-open) */
      .fi-tape-line {
        position: fixed;
        top: 50%; left: 0; right: 0;
        transform: translateY(-60px);
        width: 100%; height: 200px;
        z-index: 1; pointer-events: none;
        opacity: 0;
        transition: opacity 1.2s ease;
      }
      .fi-phase-line .fi-tape-line { opacity: 0.8; }
      .fi-phase-ignite .fi-tape-line { opacity: 0.5; }
      .fi-phase-content .fi-tape-line { opacity: 0.2; }

      .fi-tape-path {
        stroke-dasharray: 3000;
        stroke-dashoffset: 3000;
        animation: tapeDraw 1.8s cubic-bezier(0.65, 0, 0.35, 1) forwards;
        filter: drop-shadow(0 0 6px rgba(212, 168, 87, 0.6));
      }
      .fi-phase-dark .fi-tape-path { animation: none; }
      @keyframes tapeDraw {
        to { stroke-dashoffset: 0; }
      }

      /* Portfolio orb */
      .fi-orb-wrap {
        position: fixed;
        left: 50%; top: 50%;
        transform: translate(-50%, -50%);
        width: 220px; height: 220px;
        z-index: 2;
        transition: all 1.2s cubic-bezier(0.22, 1, 0.36, 1);
        opacity: 0;
      }
      .fi-phase-dark .fi-orb-wrap {
        opacity: 0;
        transform: translate(-50%, -50%) scale(0.3);
      }
      .fi-phase-line .fi-orb-wrap {
        opacity: 0.3;
        transform: translate(-50%, -50%) scale(0.5);
      }
      .fi-phase-ignite .fi-orb-wrap {
        opacity: 1;
        transform: translate(-50%, -50%) scale(0.85);
      }
      .fi-phase-content .fi-orb-wrap {
        opacity: 0.35;
        transform: translate(-50%, -150%) scale(0.55);
      }
      @media (min-width: 720px) {
        .fi-phase-content .fi-orb-wrap {
          transform: translate(-50%, -170%) scale(0.6);
        }
      }
      .fi-orb {
        width: 100%; height: 100%;
        filter: drop-shadow(0 0 30px rgba(212, 168, 87, 0.4));
      }
      .fi-orb-ring {
        animation: fiOrbSpin 80s linear infinite;
        transform-origin: center;
      }
      @keyframes fiOrbSpin { to { transform: rotate(360deg); } }

      /* Callout */
      .fi-callout {
        position: fixed;
        left: 50%; top: 50%;
        transform: translate(-50%, 140px);
        text-align: center;
        z-index: 3;
        opacity: 0;
        transition: all 1s cubic-bezier(0.22, 1, 0.36, 1);
        pointer-events: none;
        width: 90%; max-width: 500px;
      }
      .fi-phase-ignite .fi-callout { opacity: 1; }
      .fi-phase-content .fi-callout {
        opacity: 0;
        transform: translate(-50%, 100px);
      }
      .fi-callout-eyebrow {
        font-family: 'IBM Plex Mono', monospace;
        font-size: 10px;
        letter-spacing: 0.35em;
        text-transform: uppercase;
        color: #d4a857;
        margin-bottom: 14px;
        font-weight: 500;
      }
      .fi-callout-title {
        font-family: 'Source Serif 4', serif;
        font-size: 36px;
        font-weight: 500;
        letter-spacing: -0.02em;
        line-height: 1.15;
        margin: 0;
        color: #f5f5f5;
      }
      @media (min-width: 720px) { .fi-callout-title { font-size: 44px; } }
      .fi-callout-title span {
        display: inline-block;
        opacity: 0;
        transform: translateY(4px);
        transition: opacity 0.8s ease, transform 0.8s ease;
      }
      .fi-phase-ignite .fi-callout-title .w1 { opacity: 1; transform: none; transition-delay: 0.1s; }
      .fi-phase-ignite .fi-callout-title .w2 { opacity: 1; transform: none; transition-delay: 0.3s; }
      .fi-phase-ignite .fi-callout-title .w3 { opacity: 1; transform: none; transition-delay: 0.45s; }
      .fi-phase-ignite .fi-callout-title .w4 {
        opacity: 1; transform: none; transition-delay: 0.6s;
        color: #d4a857;
      }

      /* Skip */
      .fi-skip {
        position: fixed;
        bottom: 32px;
        left: 50%;
        transform: translateX(-50%);
        z-index: 10;
        padding: 9px 18px;
        background: rgba(15, 23, 42, 0.6);
        border: 1px solid rgba(148, 163, 184, 0.15);
        border-radius: 4px;
        color: rgba(148, 163, 184, 0.6);
        font-family: 'IBM Plex Mono', monospace;
        font-size: 10px;
        letter-spacing: 0.2em;
        text-transform: uppercase;
        cursor: pointer;
        backdrop-filter: blur(6px);
        transition: all 0.2s ease;
        font-weight: 500;
        animation: fiSkipBlink 2s ease-in-out infinite 1s;
      }
      .fi-skip:hover {
        color: #d4a857;
        border-color: rgba(212, 168, 87, 0.4);
      }
      @keyframes fiSkipBlink {
        0%, 100% { opacity: 0.5; }
        50% { opacity: 1; }
      }

      /* Content column */
      .fi-column {
        position: relative;
        z-index: 5;
        min-height: 100vh;
        padding: 62vh 20px 40px;
        opacity: 0;
        transform: translateY(20px);
        transition: opacity 1s ease 0.3s, transform 1s cubic-bezier(0.22, 1, 0.36, 1) 0.3s;
        pointer-events: none;
      }
      .fi-phase-content .fi-column {
        opacity: 1;
        transform: translateY(0);
        pointer-events: auto;
      }
      @media (min-width: 720px) { .fi-column { padding-top: 65vh; } }
      .fi-column-inner { max-width: 580px; margin: 0 auto; }

      /* Header */
      .fi-header {
        text-align: center;
        margin-bottom: 44px;
        padding-bottom: 40px;
        border-bottom: 1px solid rgba(148, 163, 184, 0.1);
      }
      .fi-header .fi-eyebrow { display: block; margin-bottom: 16px; }
      .fi-h2 {
        font-family: 'Source Serif 4', serif;
        font-size: 28px; font-weight: 500;
        line-height: 1.2; letter-spacing: -0.01em;
        margin: 0 0 18px;
        color: #f5f5f5;
      }
      @media (min-width: 720px) { .fi-h2 { font-size: 34px; } }
      .fi-h2 em {
        font-style: italic;
        color: #d4a857;
        font-weight: 400;
      }
      .fi-lede {
        font-family: 'Source Serif 4', serif;
        font-size: 15px; line-height: 1.65;
        color: rgba(148, 163, 184, 0.7);
        font-style: italic;
        margin: 0 auto; max-width: 460px;
      }

      /* Sections */
      .fi-section { margin-bottom: 40px; }
      .fi-section-label {
        font-family: 'IBM Plex Mono', monospace;
        font-size: 10px; letter-spacing: 0.28em; text-transform: uppercase;
        color: #d4a857;
        margin-bottom: 16px; text-align: center;
        font-weight: 500;
      }

      /* Cards */
      .fi-cards { display: flex; flex-direction: column; gap: 8px; }
      .fi-card {
        display: flex; gap: 16px; align-items: flex-start;
        padding: 18px 20px;
        border-radius: 4px;
        background: rgba(15, 23, 42, 0.5);
        border: 1px solid rgba(148, 163, 184, 0.1);
        border-left: 3px solid var(--fi-accent, #d4a857);
        transition: all 0.25s ease;
      }
      .fi-card:hover {
        background: rgba(15, 23, 42, 0.7);
        border-color: var(--fi-accent);
      }
      .fi-card-glyph {
        width: 36px; height: 36px;
        flex-shrink: 0;
        border-radius: 2px;
        background: rgba(0, 0, 0, 0.3);
        border: 1px solid var(--fi-accent);
        color: var(--fi-accent);
        font-family: 'IBM Plex Mono', monospace;
        font-size: 18px; font-weight: 300;
        display: flex; align-items: center; justify-content: center;
      }
      .fi-card-body { flex: 1; min-width: 0; }
      .fi-card-title {
        font-family: 'Source Serif 4', serif;
        font-size: 16px; font-weight: 600;
        color: #f5f5f5;
        margin-bottom: 6px;
        letter-spacing: -0.005em;
      }
      .fi-card-body p {
        font-family: 'Source Serif 4', serif;
        font-size: 13px; line-height: 1.6;
        color: rgba(148, 163, 184, 0.75);
        margin: 0;
      }

      /* Ledger */
      .fi-ledger {
        display: grid;
        grid-template-columns: 1fr;
        gap: 20px;
        padding: 22px 20px;
        border-radius: 4px;
        background: rgba(15, 23, 42, 0.4);
        border: 1px solid rgba(148, 163, 184, 0.1);
      }
      @media (min-width: 560px) {
        .fi-ledger { grid-template-columns: 1fr 1px 1fr; gap: 24px; padding: 24px 28px; }
      }
      .fi-ledger-divider {
        display: none;
        background: linear-gradient(to bottom, transparent, rgba(148,163,184,0.2), transparent);
      }
      @media (min-width: 560px) { .fi-ledger-divider { display: block; } }
      .fi-ledger-head {
        font-family: 'IBM Plex Mono', monospace;
        font-size: 10px; letter-spacing: 0.22em; text-transform: uppercase;
        margin-bottom: 12px;
        font-weight: 500;
      }
      .fi-ledger-does .fi-ledger-head { color: #10b981; }
      .fi-ledger-doesnot .fi-ledger-head { color: #dc2626; }
      .fi-ledger-col ul {
        list-style: none;
        padding: 0; margin: 0;
        display: flex; flex-direction: column; gap: 8px;
      }
      .fi-ledger-col li {
        font-family: 'Source Serif 4', serif;
        font-size: 13px; line-height: 1.55;
        color: rgba(226, 232, 240, 0.8);
        padding-left: 16px;
        position: relative;
      }
      .fi-ledger-does li::before {
        content: '+';
        position: absolute; left: 0; top: 0;
        color: #10b981;
        font-family: 'IBM Plex Mono', monospace;
        font-size: 12px; font-weight: 600;
      }
      .fi-ledger-doesnot li::before {
        content: '−';
        position: absolute; left: 0; top: 0;
        color: #dc2626;
        font-family: 'IBM Plex Mono', monospace;
        font-size: 12px; font-weight: 600;
      }

      /* Honest */
      .fi-honest {
        display: flex; gap: 14px;
        padding: 18px 20px;
        border-radius: 4px;
        background: rgba(212, 168, 87, 0.06);
        border: 1px solid rgba(212, 168, 87, 0.2);
        border-left: 3px solid #d4a857;
      }
      .fi-honest-mark {
        width: 24px; height: 24px;
        border-radius: 2px;
        border: 1px solid #d4a857;
        color: #d4a857;
        display: flex; align-items: center; justify-content: center;
        font-family: 'IBM Plex Mono', monospace;
        font-size: 14px; font-weight: 600;
        flex-shrink: 0;
      }
      .fi-honest p {
        font-family: 'Source Serif 4', serif;
        font-size: 14px; line-height: 1.65;
        color: rgba(226, 232, 240, 0.85);
        margin: 0;
        font-style: italic;
      }

      /* Pullquote */
      .fi-pullquote {
        font-family: 'Source Serif 4', serif;
        font-size: 22px; font-weight: 400;
        line-height: 1.4;
        color: #f5f5f5;
        margin: 44px 0;
        padding: 20px 0 20px 26px;
        border-left: 3px solid #d4a857;
        font-style: italic;
      }
      @media (min-width: 720px) { .fi-pullquote { font-size: 26px; } }

      /* Oath */
      .fi-oath {
        padding: 24px 20px 8px;
        border-radius: 4px;
      }
      .fi-oath .fi-section-label { color: #d4a857; }
      .fi-oath-check {
        display: flex; gap: 14px; align-items: flex-start;
        padding: 16px;
        border-radius: 4px;
        background: rgba(15, 23, 42, 0.5);
        border: 1px solid rgba(148, 163, 184, 0.12);
        margin-bottom: 20px;
        cursor: pointer;
        transition: all 0.2s ease;
      }
      .fi-oath-check:hover { border-color: rgba(212, 168, 87, 0.3); }
      .fi-oath-checkbox {
        width: 24px; height: 24px;
        flex-shrink: 0;
        border-radius: 3px;
        border: 2px solid rgba(148, 163, 184, 0.3);
        background: transparent;
        display: flex; align-items: center; justify-content: center;
        cursor: pointer;
        transition: all 0.2s ease;
        padding: 0;
      }
      .fi-oath-checkbox.on {
        background: #d4a857;
        border-color: #d4a857;
      }
      .fi-oath-text {
        font-family: 'Source Serif 4', serif;
        font-size: 14px; line-height: 1.6;
        color: rgba(226, 232, 240, 0.82);
      }

      /* CTA */
      .fi-cta {
        display: flex;
        align-items: center; justify-content: center;
        gap: 10px;
        width: 100%;
        padding: 15px 20px;
        border-radius: 4px;
        border: 0;
        font-family: 'IBM Plex Mono', monospace;
        font-size: 11px;
        letter-spacing: 0.22em;
        text-transform: uppercase;
        font-weight: 600;
        cursor: pointer;
        transition: all 0.25s ease;
      }
      .fi-cta.waiting {
        background: rgba(15, 23, 42, 0.5);
        border: 1px solid rgba(148, 163, 184, 0.15);
        color: rgba(148, 163, 184, 0.4);
        cursor: not-allowed;
      }
      .fi-cta.ready {
        background: #d4a857;
        color: #0a0e17;
      }
      .fi-cta.ready:hover:not(:disabled) { filter: brightness(1.1); }
      .fi-cta-dots { display: flex; gap: 6px; }
      .fi-cta-dots span {
        width: 6px; height: 6px; border-radius: 50%;
        background: #0a0e17;
        animation: fiCtaBounce 1s ease-in-out infinite;
      }
      @keyframes fiCtaBounce {
        0%, 100% { transform: translateY(0); opacity: 0.5; }
        50% { transform: translateY(-6px); opacity: 1; }
      }

      .fi-finepoint {
        font-family: 'Source Serif 4', serif;
        font-style: italic;
        font-size: 12px;
        color: rgba(148, 163, 184, 0.4);
        text-align: center;
        margin: 16px 0 0;
      }
    `}</style>
  )
}
