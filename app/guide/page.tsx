'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowLeft, ChevronDown, ChevronUp, BookOpen, HelpCircle, Zap, BarChart2, TrendingUp, Shield, DollarSign, Calendar, Activity } from 'lucide-react'

// ── Types ─────────────────────────────────────────────────────
interface FAQItem { q: string; a: string }
interface GuideSection { id: string; icon: React.ReactNode; title: string; color: string; content: React.ReactNode }

// ── FAQ Component ─────────────────────────────────────────────
function FAQAccordion({ items }: { items: FAQItem[] }) {
  const [open, setOpen] = useState<number | null>(null)
  return (
    <div className="space-y-2">
      {items.map((item, i) => (
        <div key={i} className="rounded-xl border overflow-hidden transition-all"
          style={{ borderColor: open === i ? 'rgba(167,139,250,0.3)' : 'rgba(255,255,255,0.07)', background: open === i ? 'rgba(167,139,250,0.05)' : 'rgba(255,255,255,0.02)' }}>
          <button className="w-full flex items-start justify-between gap-3 px-4 py-3.5 text-left"
            onClick={() => setOpen(open === i ? null : i)}>
            <span className="text-sm font-semibold text-white/85 leading-snug">{item.q}</span>
            {open === i ? <ChevronUp size={16} className="shrink-0 mt-0.5" style={{ color: '#a78bfa' }} /> : <ChevronDown size={16} className="shrink-0 mt-0.5 text-white/30" />}
          </button>
          {open === i && (
            <div className="px-4 pb-4">
              <p className="text-sm text-white/60 leading-relaxed">{item.a}</p>
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

// ── Guide Section Component ───────────────────────────────────
function Section({ section }: { section: GuideSection }) {
  const [collapsed, setCollapsed] = useState(false)
  return (
    <div id={section.id} className="rounded-2xl border overflow-hidden"
      style={{ borderColor: `${section.color}20`, background: '#111620' }}>
      <button className="w-full flex items-center justify-between px-5 py-4 border-b"
        style={{ borderColor: `${section.color}15` }}
        onClick={() => setCollapsed(!collapsed)}>
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-xl flex items-center justify-center shrink-0"
            style={{ background: `${section.color}15` }}>
            <span style={{ color: section.color }}>{section.icon}</span>
          </div>
          <span className="text-base font-bold text-white">{section.title}</span>
        </div>
        {collapsed ? <ChevronDown size={16} className="text-white/30" /> : <ChevronUp size={16} className="text-white/30" />}
      </button>
      {!collapsed && (
        <div className="px-5 py-5">{section.content}</div>
      )}
    </div>
  )
}

// ── Content blocks ────────────────────────────────────────────
function P({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-white/65 leading-relaxed mb-3">{children}</p>
}
function H({ children }: { children: React.ReactNode }) {
  return <h4 className="text-xs font-bold font-mono uppercase tracking-widest text-white/40 mb-2 mt-4 first:mt-0">{children}</h4>
}
function Tip({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg px-3.5 py-3 mb-3 text-sm leading-relaxed"
      style={{ background: 'rgba(52,211,153,0.07)', border: '1px solid rgba(52,211,153,0.2)', color: 'rgba(52,211,153,0.9)' }}>
      💡 {children}
    </div>
  )
}
function Warn({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg px-3.5 py-3 mb-3 text-sm leading-relaxed"
      style={{ background: 'rgba(248,113,113,0.07)', border: '1px solid rgba(248,113,113,0.2)', color: 'rgba(248,113,113,0.9)' }}>
      ⚠ {children}
    </div>
  )
}
function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 mb-3">
      <div className="w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold shrink-0 mt-0.5"
        style={{ background: 'rgba(167,139,250,0.2)', color: '#a78bfa' }}>{n}</div>
      <p className="text-sm text-white/65 leading-relaxed">{children}</p>
    </div>
  )
}

// ── FAQ Data ──────────────────────────────────────────────────
const FAQ_GENERAL: FAQItem[] = [
  { q: 'What is Consilium?', a: 'Consilium is an AI-powered stock analysis platform. You type in a stock ticker and three AI roles — News Scout, Lead Analyst, and Devil\'s Advocate — each contribute their perspective. A fourth role, the Council Judge, weighs all arguments and delivers a final verdict with a signal (Bullish, Bearish, or Neutral), a price target, entry/exit levels, and plain English explanations of every indicator.' },
  { q: 'Is Consilium financial advice?', a: 'No. Consilium is an informational and educational tool. Nothing on this platform constitutes financial advice, investment advice, or trading recommendations. You are solely responsible for your investment decisions. Always do your own research and consult a qualified financial professional before trading.' },
  { q: 'How accurate is Consilium?', a: 'No AI tool — or any analyst — can predict markets with certainty. Consilium synthesizes many signals to give you a well-rounded perspective, but it can and does get things wrong. Use it as one input among many, not as the sole basis for any trade. Past analysis does not guarantee future results.' },
  { q: 'How often should I run an analysis?', a: 'For most stocks, once per day on the 1M or 3M timeframe is sufficient. Day traders might want 1D or 1W analyses more frequently. The cache system means repeated requests for the same ticker/timeframe within the cache window (30 min for 1D, up to 12h for 3M) return the stored result instantly.' },
  { q: 'Why do I sometimes get a cached result?', a: 'To save costs and speed up your experience, Consilium caches analysis results. If someone else (or you) already analyzed the same ticker on the same timeframe recently, you\'ll see the cached result with a yellow "Cached" badge. You can always click "↻ Refresh" to force a fresh analysis.' },
  { q: 'Can I use Consilium for crypto?', a: 'Yes — you can enter crypto tickers like BTC, ETH, SOL, DOGE, etc. The technical indicators and AI analysis work the same way. The Today\'s Movers and Tomorrow\'s Movers pages also include crypto setups.' },
]

const FAQ_TECHNICAL: FAQItem[] = [
  { q: 'What does RSI mean?', a: 'RSI (Relative Strength Index) measures buying and selling momentum on a scale of 0-100. Below 30 means the stock has been sold heavily and may bounce (oversold). Above 70 means it has been bought aggressively and may pull back (overbought). Around 50 is neutral.' },
  { q: 'What is a Death Cross vs Golden Cross?', a: 'A Golden Cross is when the 50-day moving average crosses above the 200-day moving average — a historically bullish signal meaning medium-term momentum is stronger than the long-term trend. A Death Cross is the opposite — the 50-day drops below the 200-day — a historically bearish signal.' },
  { q: 'What is VWAP?', a: 'VWAP (Volume Weighted Average Price) is the average price of every trade made today, weighted by volume. It resets every morning. Price above VWAP means buyers are in control. Below VWAP means sellers dominate. Institutions use it as a benchmark — a stock that can\'t reclaim VWAP is considered weak.' },
  { q: 'What does the Stochastic Oscillator show?', a: 'The Stochastic Oscillator (%K and %D lines) shows where the price closed relative to its range over the past 14 days. Above 80 is overbought. Below 20 is oversold. The most important signal is when the fast %K line crosses the slow %D line — a bullish crossover (K crosses above D) is often a buy signal; bearish crossover is a sell signal.' },
  { q: 'What is OBV?', a: 'On-Balance Volume (OBV) tracks buying and selling pressure by accumulating volume on up-days and subtracting volume on down-days. A rising OBV with a falling price (bullish divergence) suggests smart money is quietly accumulating — a potentially bullish signal. Falling OBV with rising price (bearish divergence) suggests institutions are quietly selling.' },
  { q: 'What are Fibonacci levels?', a: 'Fibonacci retracement levels (23.6%, 38.2%, 50%, 61.8%, 78.6%) identify where price tends to pause or reverse after a big move. They work partly because so many traders watch them — making them self-fulfilling. The nearest Fibonacci level to the current price is the most relevant for short-term trades.' },
  { q: 'Why do all timeframes show the same technicals?', a: 'The 1M and 3M timeframes use daily bars, so the indicators will be very similar. The 1D and 1W timeframes use hourly bars, giving different RSI and MACD readings that reflect shorter-term momentum. Switching from 1W to 1M is a meaningful change; switching between 1M and 3M will be more similar.' },
]

const FAQ_SIGNALS: FAQItem[] = [
  { q: 'What do the four AI stages do?', a: 'News Scout scans recent news and assesses macro conditions. Lead Analyst synthesizes all 50+ technical, fundamental, and smart money signals into a directional call. Devil\'s Advocate challenges that call with data-backed counter-arguments. The Council Verdict (Judge) weighs argument quality — not vote count — and delivers the final signal, price target, entry/exit levels, and plain English explanation.' },
  { q: 'What is the Conviction Score?', a: 'The Conviction Score (-100 to +100) measures how many of the 50+ signals agree with the directional verdict. A score above +50 means strong signal convergence — most indicators point the same way. Near zero means mixed signals. The score helps you gauge how confident the overall analysis is.' },
  { q: 'What is Smart Money?', a: 'Smart Money refers to large, informed investors — corporate insiders (executives and directors), members of Congress who trade stocks, and large institutional holders. When insiders buy their own company\'s stock, it\'s often a bullish signal. Congressional trades are tracked because elected officials sometimes have access to material non-public information.' },
  { q: 'What does Options Flow tell me?', a: 'The put/call ratio measures how many puts (bearish bets) vs calls (bullish bets) are being traded. A low ratio means more calls = bullish sentiment. A high ratio means more puts = bearish. Unusual sweeps are large options orders that exceed normal volume — these often signal that a big player is making a directional bet ahead of a news event.' },
  { q: 'Why are fundamentals sometimes missing?', a: 'Fundamental data (P/E ratio, analyst ratings, earnings dates) comes from Finnhub. If your Finnhub API key isn\'t configured, or if the stock doesn\'t have coverage (e.g., very small caps, crypto), those sections will be empty. The AI will still analyze based on the technical and market signals it does have.' },
]

const FAQ_OPTIONS: FAQItem[] = [
  { q: 'What is a call option?', a: 'A call option gives you the right to BUY 100 shares at a specific price (the strike) before a specific date (expiry). You buy calls when you think a stock will go UP. If the stock rises above your strike price, your option becomes valuable. If it doesn\'t, you lose the premium you paid — which is your maximum loss.' },
  { q: 'What is a put option?', a: 'A put option gives you the right to SELL 100 shares at a specific price before expiry. You buy puts when you think a stock will go DOWN. If the stock falls below your strike, your put gains value. If the stock goes up instead, you lose the premium — your maximum loss.' },
  { q: 'What does ITM, ATM, OTM mean?', a: 'In The Money (ITM) means the option already has intrinsic value — for a call, the stock is above the strike. At The Money (ATM) means the stock is right at the strike price. Out of The Money (OTM) means the option has no intrinsic value yet — for a call, the stock is still below the strike. ATM and slightly OTM options are most commonly traded.' },
  { q: 'What is Delta?', a: 'Delta measures how much your option\'s value changes for every $1 move in the stock. A delta of 0.50 means if the stock rises $1, your call option gains $0.50 per share ($50 per contract controlling 100 shares). Delta ranges from 0 to 1 for calls, and 0 to -1 for puts.' },
  { q: 'What is Theta (time decay)?', a: 'Theta is how much value your option loses every single day, just from time passing — even if the stock doesn\'t move. A theta of -0.05 means you lose $5 per contract per day. This is why holding options too long is dangerous — they decay in value constantly. The closer to expiry, the faster theta erodes the option.' },
  { q: 'What is IV (Implied Volatility)?', a: 'Implied Volatility (IV) reflects how much the market expects a stock to move. High IV means options are expensive — the market expects big moves. Low IV means cheap options. IV often spikes before earnings reports. Buying options when IV is high is risky because even if you\'re right about direction, the IV may "crush" after the event, reducing your option\'s value.' },
  { q: 'How much can I lose trading options?', a: 'When buying calls or puts, your maximum loss is 100% of the premium you paid. If you pay $300 for a contract and it expires worthless, you lose $300. Options expire worthless far more often than most people expect. Never trade options with money you cannot afford to lose entirely.' },
]

const FAQ_BILLING: FAQItem[] = [
  { q: 'How does the free trial work?', a: 'Your 7-day free trial starts the moment you sign up. No credit card is required. You get full access to everything during the trial. On day 7, if you haven\'t subscribed, you\'ll be redirected to the subscription page. You won\'t be charged automatically — you have to actively subscribe.' },
  { q: 'What does $19/month include?', a: 'Everything. Unlimited stock analyses, all timeframes, Today\'s Movers, Tomorrow\'s Movers, Options Strategy recommendations, full technical charts, fundamentals, smart money data, and all future features. There\'s one plan — no tiers or feature gates.' },
  { q: 'How do I cancel?', a: 'Click the "✓ Pro" badge in the top right of the app header. This opens the Stripe billing portal where you can cancel, update payment method, or download invoices. If you cancel, you keep access until the end of your current billing period.' },
  { q: 'Can I get a refund?', a: 'Reach out within 7 days of being charged and we\'ll make it right. We don\'t want you paying for something that isn\'t working for you.' },
  { q: 'Is my account sharing allowed?', a: 'No — accounts are strictly one device at a time. Logging in from a second device automatically signs out the first. This is enforced to protect the integrity of the service.' },
]

// ── Guide Sections ─────────────────────────────────────────────
const SECTIONS: GuideSection[] = [
  {
    id: 'getting-started',
    icon: <Zap size={16} />,
    title: 'Getting Started',
    color: '#fbbf24',
    content: (
      <>
        <H>Running your first analysis</H>
        <Step n={1}>Type a stock ticker (e.g. AAPL, NVDA, TSLA, BTC) into the input box in the top bar.</Step>
        <Step n={2}>Select a timeframe — 1D for intraday, 1W for short-term, 1M for medium-term, 3M for longer-term outlook.</Step>
        <Step n={3}>Click Analyze. The four-stage AI debate begins — usually takes 30-60 seconds.</Step>
        <Step n={4}>Read the Council Verdict at the bottom. This is the final synthesized signal with price target, entry/exit levels, and plain English explanations.</Step>
        <Tip>Start with a stock you already know — this makes it easier to judge whether the analysis makes sense to you.</Tip>

        <H>Understanding the layout</H>
        <P>The left sidebar shows a quick summary of all signal categories: technicals, fundamentals, smart money, options flow, and market context. This gives you a snapshot before reading the full debate.</P>
        <P>The right panel shows the four AI stages streaming in real time. Each stage builds on the previous one — the Judge reads all three stages before delivering the verdict.</P>
        <P>Below the verdict, you'll find the Technical Charts section with detailed visual indicators, and the Options Strategy section for options recommendations.</P>

        <H>Timeframe guide</H>
        <P>1D uses hourly bars and reflects intraday momentum — RSI and MACD on hourly charts move faster and signal more frequently. Use for day trading setups.</P>
        <P>1W also uses hourly bars over a longer lookback — good for swing trades of a few days to a week.</P>
        <P>1M and 3M use daily bars with full SMA200 history. These give the most reliable technical signals for longer holds. Most users start here.</P>
      </>
    ),
  },
  {
    id: 'todays-movers',
    icon: <Activity size={16} />,
    title: "Today's Movers",
    color: '#fbbf24',
    content: (
      <>
        <P>Today's Movers scans the latest 50+ news headlines and identifies specific stocks and crypto that could move significantly today — based on real catalysts, not speculation.</P>
        <H>What you'll see</H>
        <P><strong className="text-white/80">Potential Winners</strong> — stocks with bullish catalysts like earnings beats, analyst upgrades, positive FDA decisions, or partnership announcements.</P>
        <P><strong className="text-white/80">Potential Losers</strong> — stocks with bearish catalysts like earnings misses, downgrades, legal issues, or guidance cuts.</P>
        <P><strong className="text-white/80">Worth Watching</strong> — neutral setups where the direction isn't clear but a significant move is likely.</P>
        <P><strong className="text-white/80">Sector Movements</strong> — which sectors are rotating in or out today and why.</P>
        <Tip>Click "Run full AI analysis" on any mover to get the complete four-stage analysis with price target and trade plan.</Tip>
        <P>Today's Movers is cached once per day — the first analysis each day runs Gemini on the latest headlines. Subsequent visitors that day see the cached result instantly. Use "Force refresh" if you want the absolute latest headlines.</P>
      </>
    ),
  },
  {
    id: 'tomorrows-movers',
    icon: <Calendar size={16} />,
    title: "Tomorrow's Movers",
    color: '#a78bfa',
    content: (
      <>
        <P>Tomorrow's Movers is a forward-looking playbook for the next trading day. Instead of reacting to news that already happened, it helps you prepare in advance.</P>
        <H>What's included</H>
        <P><strong className="text-white/80">Opening Bell Playbook</strong> — a step-by-step guide written in plain English for what to watch in the first 30 minutes of trading. Written for all experience levels.</P>
        <P><strong className="text-white/80">Pre-Market Watchlist</strong> — 5-8 stocks/crypto with specific setups, key price levels, and both a bullish and bearish game plan for each.</P>
        <P><strong className="text-white/80">Earnings Calendar</strong> — companies reporting earnings tomorrow with expected move percentages and what to watch in the report.</P>
        <P><strong className="text-white/80">Economic Events</strong> — Fed minutes, CPI, jobs reports, and other scheduled data releases with plain English explanation of market impact.</P>
        <P><strong className="text-white/80">Sector Setups</strong> — which sectors are positioned for moves and the best individual stock play in each.</P>
        <Tip>Check Tomorrow's Movers the evening before a trading day to build your watchlist and set price alerts.</Tip>
      </>
    ),
  },
  {
    id: 'technical-charts',
    icon: <BarChart2 size={16} />,
    title: 'Technical Charts',
    color: '#a78bfa',
    content: (
      <>
        <P>The Technical Charts section appears below the Council Verdict after each analysis. Every indicator has two sections: "What is this?" explains the concept from scratch, and "What it means for this stock right now" uses the actual values to tell you what the data is saying.</P>
        <H>Indicators included</H>
        <P><strong className="text-white/80">RSI (14)</strong> — momentum gauge. Oversold below 30, overbought above 70.</P>
        <P><strong className="text-white/80">Stochastic (14,3,3)</strong> — similar to RSI but compares close to the price range. Watch for %K/%D crossovers.</P>
        <P><strong className="text-white/80">MACD (12,26,9)</strong> — trend and momentum. Histogram going positive is bullish, crossovers are key signals.</P>
        <P><strong className="text-white/80">Bollinger Bands</strong> — volatility channel. Squeezes often precede big moves. Touching bands is a mean-reversion signal.</P>
        <P><strong className="text-white/80">Moving Averages</strong> — SMA50/200 (golden/death cross), EMA9/20 (faster crossovers for short-term traders).</P>
        <P><strong className="text-white/80">VWAP</strong> — institutional benchmark. Price above VWAP = bullish intraday bias.</P>
        <P><strong className="text-white/80">OBV</strong> — volume-based trend confirmation. Divergences are early warning signals.</P>
        <P><strong className="text-white/80">Fibonacci Levels</strong> — support and resistance zones from recent swing highs/lows.</P>
        <P><strong className="text-white/80">Pivot Points</strong> — S1, S2, R1, R2 levels showing where buyers/sellers have historically appeared.</P>
        <Tip>The Finviz chart image at the top of Technical Charts shows the actual candlestick chart with SMA50 and SMA200 overlaid — you can literally see the death cross or golden cross visually.</Tip>
      </>
    ),
  },
  {
    id: 'options',
    icon: <TrendingUp size={16} />,
    title: 'Options Strategy',
    color: '#34d399',
    content: (
      <>
        <P>The Options Strategy section appears below the Technical Charts after each analysis. Click "Get options recommendation" to trigger it — it runs a separate AI call to generate a specific strategy based on the Council Verdict.</P>
        <H>What you get</H>
        <P><strong className="text-white/80">Strategy recommendation</strong> — a specific strategy (buy calls, buy puts, spread, etc.) matched to the verdict signal and time horizon.</P>
        <P><strong className="text-white/80">Plain English explanation</strong> — why this strategy fits, written for someone who has never traded options.</P>
        <P><strong className="text-white/80">Max loss / Max gain</strong> — realistic numbers for best and worst case, using actual premium costs.</P>
        <P><strong className="text-white/80">Live contracts</strong> — 3 specific options contracts (strike, expiry, bid/ask, IV, Greeks) sourced from Yahoo Finance or Tradier.</P>
        <P><strong className="text-white/80">Greeks explained</strong> — what delta and theta mean for those specific numbers in plain English.</P>
        <Warn>Options are high-risk instruments. They can expire completely worthless. One contract = 100 shares. Never risk money you cannot afford to lose entirely. The Options Strategy section is educational — not a trade recommendation.</Warn>
        <H>Understanding the contract table</H>
        <P>Each contract shows the strike price (the price you have the right to buy/sell at), the expiry date, bid/ask spread, volume, open interest, and IV. Cost per contract = ask price × 100. A $2.50 ask means $250 per contract.</P>
      </>
    ),
  },
  {
    id: 'smart-money',
    icon: <Shield size={16} />,
    title: 'Smart Money Signals',
    color: '#34d399',
    content: (
      <>
        <P>Smart Money refers to informed, large-scale investors whose trading behavior can signal where a stock is headed before it's obvious in the price.</P>
        <H>Insider trading (legal)</H>
        <P>Corporate insiders — CEOs, CFOs, directors — must file Form 4 with the SEC within 2 days of any trade. When multiple insiders buy their own company's stock on the open market (not options grants), it's a historically bullish signal. They know the business better than anyone. Insider selling is less meaningful — executives sell for many reasons (diversification, taxes) — but a cluster of selling by multiple insiders can be bearish.</P>
        <H>Congressional trading</H>
        <P>Members of Congress must disclose trades within 45 days. This data is tracked because lawmakers sometimes have material non-public information from committee work. When Congress members buy a stock, Consilium flags it. This is controversial but legal data.</P>
        <H>Institutional holders</H>
        <P>Large funds (13F filings) show which institutions hold the stock. Heavy institutional ownership isn't necessarily bullish or bearish — but knowing who owns a stock tells you something about its investor base and stability.</P>
        <Tip>Smart Money signals are more meaningful when combined with a bullish or bearish technical setup. Insider buying in a stock that's also technically oversold is a stronger signal than either alone.</Tip>
      </>
    ),
  },
  {
    id: 'fundamentals',
    icon: <DollarSign size={16} />,
    title: 'Fundamentals',
    color: '#60a5fa',
    content: (
      <>
        <P>Fundamentals come from Finnhub and provide context about the company's financial health and analyst sentiment. They complement the technical picture.</P>
        <H>Key metrics explained</H>
        <P><strong className="text-white/80">P/E Ratio</strong> — Price divided by earnings per share. A high P/E (e.g. 40x) means investors are paying a premium for expected growth. Low P/E (e.g. 10x) can mean undervaluation or slow growth. Context matters — compare to the sector average.</P>
        <P><strong className="text-white/80">Analyst Consensus</strong> — the aggregate recommendation from Wall Street analysts (Strong Buy, Buy, Hold, Sell). This reflects institutional research opinions. Upside % shows how far the average analyst price target is above the current price.</P>
        <P><strong className="text-white/80">Earnings Date & Risk</strong> — stocks often make their biggest moves around earnings reports. "High" earnings risk means the report is close and could significantly move the stock in either direction.</P>
        <P><strong className="text-white/80">EPS Record</strong> — whether the company consistently beats earnings estimates ("beater") or misses. Consistent beaters often get rewarded with premium valuations. Consistent misses get punished.</P>
        <Warn>Fundamental data requires a Finnhub API key. If the fundamentals section appears empty, check that FINNHUB_API_KEY is set in Railway.</Warn>
      </>
    ),
  },
]

// ── Main Page ──────────────────────────────────────────────────
export default function GuidePage() {
  const router = useRouter()
  const [activeTab, setActiveTab] = useState<'guide' | 'faq'>('guide')

  const scrollTo = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  return (
    <div className="flex flex-col min-h-screen" style={{ background: '#0a0d12', color: 'white' }}>

      {/* Header */}
      <header className="flex items-center gap-3 px-4 py-3 border-b sticky top-0 z-10"
        style={{ background: '#111620', borderColor: 'rgba(255,255,255,0.07)' }}>
        <button onClick={() => router.push('/')}
          className="flex items-center gap-1.5 text-xs text-white/40 hover:text-white/70 transition-colors">
          <ArrowLeft size={13} /> Back
        </button>
        <div className="w-px h-4" style={{ background: 'rgba(255,255,255,0.1)' }} />
        <div className="flex items-center gap-2">
          <BookOpen size={14} style={{ color: '#a78bfa' }} />
          <span className="text-sm font-bold">Help Center</span>
        </div>

        {/* Tab switcher */}
        <div className="ml-auto flex items-center gap-1 p-1 rounded-lg"
          style={{ background: 'rgba(255,255,255,0.05)' }}>
          {(['guide', 'faq'] as const).map(tab => (
            <button key={tab} onClick={() => setActiveTab(tab)}
              className="px-3 py-1 rounded-md text-xs font-semibold transition-all capitalize"
              style={{
                background: activeTab === tab ? 'rgba(167,139,250,0.2)' : 'transparent',
                color: activeTab === tab ? '#a78bfa' : 'rgba(255,255,255,0.4)',
              }}>
              {tab === 'guide' ? '📖 User Guide' : '❓ FAQ'}
            </button>
          ))}
        </div>
      </header>

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-4 py-6">

          {/* ── USER GUIDE ── */}
          {activeTab === 'guide' && (
            <div className="space-y-4">
              <div className="mb-6">
                <h1 className="text-2xl font-bold text-white mb-2">User Guide</h1>
                <p className="text-sm text-white/50">Everything you need to know to get the most out of Consilium.</p>
              </div>

              {/* Quick nav */}
              <div className="flex flex-wrap gap-2 mb-6">
                {SECTIONS.map(s => (
                  <button key={s.id} onClick={() => scrollTo(s.id)}
                    className="text-[11px] font-mono px-2.5 py-1 rounded-full transition-all hover:opacity-80"
                    style={{ background: `${s.color}12`, color: s.color, border: `1px solid ${s.color}20` }}>
                    {s.title}
                  </button>
                ))}
              </div>

              {SECTIONS.map(s => <Section key={s.id} section={s} />)}

              <div className="rounded-xl p-4 mt-4" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)' }}>
                <p className="text-xs text-white/30 text-center leading-relaxed">
                  Consilium is for informational and educational purposes only. Nothing here constitutes financial advice.
                  Always do your own research and consult a qualified financial professional before making investment decisions.
                </p>
              </div>
            </div>
          )}

          {/* ── FAQ ── */}
          {activeTab === 'faq' && (
            <div className="space-y-8">
              <div className="mb-2">
                <h1 className="text-2xl font-bold text-white mb-2">Frequently Asked Questions</h1>
                <p className="text-sm text-white/50">Quick answers to common questions.</p>
              </div>

              {[
                { title: 'General', icon: <HelpCircle size={14} />, color: '#fbbf24', items: FAQ_GENERAL },
                { title: 'Technical Indicators', icon: <BarChart2 size={14} />, color: '#a78bfa', items: FAQ_TECHNICAL },
                { title: 'AI Signals & Verdict', icon: <Zap size={14} />, color: '#34d399', items: FAQ_SIGNALS },
                { title: 'Options Trading', icon: <TrendingUp size={14} />, color: '#f87171', items: FAQ_OPTIONS },
                { title: 'Billing & Account', icon: <DollarSign size={14} />, color: '#60a5fa', items: FAQ_BILLING },
              ].map(group => (
                <div key={group.title}>
                  <div className="flex items-center gap-2 mb-3">
                    <span style={{ color: group.color }}>{group.icon}</span>
                    <h2 className="text-sm font-bold text-white">{group.title}</h2>
                  </div>
                  <FAQAccordion items={group.items} />
                </div>
              ))}

              <div className="rounded-xl p-4" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)' }}>
                <p className="text-xs text-white/30 text-center leading-relaxed">
                  Still have questions? The disclaimer you accepted on signup contains full legal terms.
                  Consilium does not provide financial advice. All analysis is for educational purposes only.
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
