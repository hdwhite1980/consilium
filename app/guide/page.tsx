'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowLeft, HelpCircle, BarChart2, Zap, TrendingUp, DollarSign, Activity, BookOpen, Shield } from 'lucide-react'

interface FAQItem { q: string; a: string }

function FAQAccordion({ items }: { items: FAQItem[] }) {
  const [open, setOpen] = useState<number | null>(null)
  return (
    <div className="space-y-2">
      {items.map((item, i) => (
        <div key={i} className="rounded-xl overflow-hidden" style={{ border: '1px solid rgba(255,255,255,0.07)' }}>
          <button
            onClick={() => setOpen(open === i ? null : i)}
            className="w-full text-left flex items-start justify-between gap-3 px-4 py-3">
            <span className="text-sm font-semibold text-white leading-relaxed">{item.q}</span>
            <span className="text-white/30 shrink-0 mt-0.5">{open === i ? '▲' : '▼'}</span>
          </button>
          {open === i && (
            <div className="px-4 pb-4 text-sm text-white/60 leading-relaxed border-t border-white/05 pt-3">
              {item.a}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

interface GuideSection {
  id: string; title: string; icon: React.ReactNode; color: string; content: React.ReactNode
}

const P = ({ children }: { children: React.ReactNode }) => (
  <p className="text-sm text-white/65 leading-relaxed mb-3">{children}</p>
)
const H = ({ children }: { children: React.ReactNode }) => (
  <h3 className="text-sm font-bold text-white mt-5 mb-2">{children}</h3>
)
const Tip = ({ children }: { children: React.ReactNode }) => (
  <div className="flex gap-2 px-3 py-2.5 rounded-lg mb-3" style={{ background: 'rgba(52,211,153,0.08)', border: '1px solid rgba(52,211,153,0.2)' }}>
    <span className="text-green-400 shrink-0 mt-0.5">💡</span>
    <span className="text-xs text-green-400 leading-relaxed">{children}</span>
  </div>
)
const Warn = ({ children }: { children: React.ReactNode }) => (
  <div className="flex gap-2 px-3 py-2.5 rounded-lg mb-3" style={{ background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.2)' }}>
    <span className="text-yellow-400 shrink-0 mt-0.5">⚠</span>
    <span className="text-xs text-yellow-400 leading-relaxed">{children}</span>
  </div>
)

const SECTIONS: GuideSection[] = [
  {
    id: 'how-it-works',
    title: 'How the Council Works',
    icon: <Zap size={14} />,
    color: '#a78bfa',
    content: (
      <>
        <P>Consilium runs a six-stage adversarial debate before giving you a verdict. The stages stream in real time — you watch the debate happen.</P>
        <H>Stage 1 — News Scout</H>
        <P>Scans recent headlines, assesses macro conditions (VIX level, SPY trend, sector performance), and reports the current market regime (RISK ON, HIGH FEAR, etc.). This context feeds every subsequent stage.</P>
        <H>Stage 2 — Lead Analyst</H>
        <P>Synthesizes all 24+ signals into a directional call with a price target, confidence score, and specific technical and fundamental basis. The analyst personality you selected shapes how they weight different signals.</P>
        <H>Stage 3 — Devil's Advocate</H>
        <P>Attacks the Lead Analyst's thesis with data-backed challenges. Required to disagree — can't simply agree with the Lead Analyst. Produces 2-4 specific challenges, an alternate scenario, and identifies the single strongest counter-argument.</P>
        <H>Stage 4 — Lead Analyst Rebuttal</H>
        <P>Before responding, the Lead Analyst requests fresh live data from the News Scout — earnings estimates, analyst targets, options flow, or macro data. Armed with this, they concede valid points and defend positions where data supports them. Concessions are explicitly listed.</P>
        <Tip>What the Lead Analyst concedes is the most important signal in the entire analysis. If they concede their strongest point, the confidence score drops and the Judge weighs it heavily.</Tip>
        <H>Stage 5 — Devil's Advocate Counter</H>
        <P>Also fetches fresh data from the News Scout, acknowledges where the rebuttal convinced them, and doubles down on unresolved weaknesses. Delivers a closing argument for the Judge.</P>
        <H>Stage 6 — Council Verdict (Judge)</H>
        <P>Having read the complete two-round transcript, the Judge delivers the final verdict. Weighs argument quality — not vote count. Produces: signal (BULLISH/BEARISH/NEUTRAL), confidence score, ATR-derived stop loss and take profit levels, time horizon, plain English explanation, action plan, probability-weighted scenarios, and an invalidation trigger.</P>
        <Warn>The council's analysis is for informational purposes only. It is not financial advice. Never risk money you cannot afford to lose.</Warn>
      </>
    ),
  },
  {
    id: 'signals',
    title: 'Signals & Indicators',
    icon: <BarChart2 size={14} />,
    color: '#60a5fa',
    content: (
      <>
        <P>The sidebar shows 24+ live indicators computed from market data before the debate starts. These feed directly into the AI council's arguments.</P>
        <H>Technical Indicators</H>
        <P>RSI(14), MACD(12,26,9), Stochastic(14,3,3), SMA 20/50/200, EMA 9/12/20/26, golden/death cross, Bollinger Bands, VWAP, OBV with divergence detection, support/resistance levels (2 each), and Fibonacci retracements.</P>
        <H>New Indicators (Added 2026)</H>
        <P><strong className="text-white">ATR(14)</strong> — Average True Range in dollars and %. The council uses 2× ATR for stop placement and 3× ATR for targets. Stops tighter than 1× ATR will be hit by normal daily noise.</P>
        <P><strong className="text-white">Ichimoku Cloud</strong> — The most decisive single trend indicator. Price above cloud = structurally bullish. Below = bearish. Inside = indecisive. TK cross detection for entry signals.</P>
        <P><strong className="text-white">Williams %R</strong> — Oscillator from -100 to 0. Combined with RSI and CCI, triple oscillator confirmation at extremes is one of the strongest overbought/oversold signals.</P>
        <P><strong className="text-white">CCI(20)</strong> — Commodity Channel Index. Above +100 = overbought, below -100 = oversold. Measures deviation from statistical mean price.</P>
        <P><strong className="text-white">ROC</strong> — Rate of Change, 10 and 20 periods. Compares the two to detect accelerating vs decelerating momentum — often the first warning sign before RSI turns.</P>
        <P><strong className="text-white">Relative Strength vs Sector</strong> — Stock performance minus sector ETF performance. A stock up 2% when its sector is up 9% is underperforming by 7% — hidden weakness the Devil's Advocate will cite.</P>
        <P><strong className="text-white">GEX (Gamma Exposure)</strong> — Dealer hedging dynamics. Positive GEX = price pinning near key levels. Negative GEX = moves will accelerate through levels rather than bounce.</P>
        <P><strong className="text-white">Earnings Implied Move</strong> — ATM straddle cost vs historical actual move. When options are overpriced vs history, the council flags it and adjusts the options strategy recommendation.</P>
        <H>Conviction Score</H>
        <P>Aggregates all signals into a -100 to +100 score. Adjusted for market regime — HIGH FEAR discounts bullish signals. The conviction score sets the ceiling for the Lead Analyst's confidence.</P>
        <Tip>Open the Technical Charts section below the verdict to see every indicator visualized with a two-part explanation: what the indicator is showing and what it means for this specific stock right now.</Tip>
      </>
    ),
  },
  {
    id: 'personas',
    title: 'Analyst Personalities',
    icon: <Activity size={14} />,
    color: '#fbbf24',
    content: (
      <>
        <P>Before running an analysis, select which lens the Lead Analyst and Judge apply. Same data, different interpretation.</P>
        <H>⚖ Balanced (default)</H>
        <P>Equal weight to technicals and fundamentals. When signals conflict, explicitly notes the conflict. Produces lower confidence scores when evidence is genuinely divided. Best for most users and most situations.</P>
        <H>📈 Technical Trader</H>
        <P>Price action is primary. Follows the trend — never fights the tape. A death cross is bearish regardless of P/E ratio. RSI, MACD, Ichimoku cloud, and moving averages drive the call. Best for swing traders using 1D and 1W timeframes.</P>
        <H>📊 Fundamental Analyst</H>
        <P>Business quality, earnings growth, analyst consensus, and valuation vs historical averages drive the verdict. A 30% drawdown in a high-quality business at a discount to its historical P/E is an opportunity. Best for investors using 1M and 3M timeframes.</P>
        <Tip>Run the same stock under Technical and Fundamental. Getting different verdicts is not a bug — it tells you exactly what kind of trade this is. Technical BEARISH + Fundamental BULLISH = short-term weakness in a long-term opportunity. Size accordingly.</Tip>
        <P>Each personality produces a separate cached analysis. Running AAPL as Technical never overwrites the AAPL Balanced cache.</P>
      </>
    ),
  },
  {
    id: 'verdict',
    title: 'Reading the Verdict',
    icon: <Shield size={14} />,
    color: '#34d399',
    content: (
      <>
        <P>The Council Verdict appears at the top of results and is always visible. Here's what every field means:</P>
        <H>Signal</H>
        <P>BULLISH, BEARISH, or NEUTRAL. Not a buy/sell recommendation — a directional bias from the council based on the debate outcome.</P>
        <H>Confidence Score</H>
        <P>A measure of signal agreement, not a probability of profit. 85%+ = almost all signals align. 45% = signals genuinely conflict. Use it for position sizing: 85%+ = full size, 70-84% = 75%, 55-69% = 50%, below 55% = 25% or skip.</P>
        <H>Trade Plan (Entry / Stop / Target)</H>
        <P>Entry is the suggested price range. Stop loss uses 2× ATR as a floor — anything tighter gets hit by normal daily volatility. Take profit uses 3× ATR as a starting point, adjusted for nearby resistance levels.</P>
        <Warn>Always use the invalidation trigger. If the trigger condition is met, re-run the analysis — the entire thesis may have changed.</Warn>
        <H>Scenarios</H>
        <P>Bull, base, and bear cases with probability percentages and the specific trigger condition for each. The probabilities sum to 100% and reflect the Judge's reading of the debate quality.</P>
        <H>Signal Explanations</H>
        <P>Expand this section for plain English breakdowns of what the technicals, fundamentals, and smart money are telling the council — written for someone who doesn't need to know what RSI is.</P>
        <H>Log a Trade</H>
        <P>After any BULLISH or NEUTRAL verdict, click "💰 Log trade" to record the entry price, share count, and council signal. This links to the Reinvestment Tracker where you can track P&L and get AI-powered reinvestment ideas.</P>
      </>
    ),
  },
  {
    id: 'pages',
    title: 'Platform Pages',
    icon: <BookOpen size={14} />,
    color: '#f87171',
    content: (
      <>
        <H>🌍 Macro Dashboard</H>
        <P>All 11 S&P 500 sector ETFs ranked by daily performance with a BULLISH/BEARISH/NEUTRAL signal per sector. Shows overall market regime, smart money flows (SPY, QQQ, IWM, GLD, TLT, Dollar), and refreshes every 30 minutes. Use it every morning before opening positions — it tells you whether to be aggressive or defensive.</P>
        <H>⚡ Today's Movers</H>
        <P>Daily-cached market intelligence showing bullish movers, bearish movers, and stocks to watch. Each links directly to the full analysis. Refreshes once per day.</P>
        <H>📅 Tomorrow's Playbook</H>
        <P>Forward-looking daily briefing: earnings events, economic releases, sector rotation setups, and crypto conditions for the next trading session.</P>
        <H>💼 Portfolio</H>
        <P>Add your actual holdings with ticker, shares, and optional cost basis. The holistic analysis fetches live prices for every position, computes RSI and moving averages per holding, and produces a portfolio score (0-100), sector concentration bars, earnings watch for the next 30 days, top risks with severity ratings, and a 3-4 step action plan.</P>
        <H>🔥 Invest</H>
        <P>A separate journey-based experience for building a portfolio from any starting amount. Enter how much you have to invest ($5, $50, $500 — anything), and the council finds stage-appropriate stocks sized to your exact balance.</P>
        <P>Six milestones track your progress: Spark ($0–$10), Ember ($10–$50), Flame ($50–$200), Blaze ($200–$1K), Inferno ($1K–$10K), and Free ($10K+). At each stage, the stock price range shifts automatically — at Spark you see $1–$5 stocks where you can buy 2–5 shares, at Blaze you see $20–$50 stocks where you can buy 15–20 shares. Every position is sized so it feels like a real holding, not a lottery ticket.</P>
        <P>The council pulls live sector performance from the Macro dashboard and finds 5 picks from today's strongest sectors — all within your stage's price range. Each pick includes a specific catalyst, entry zone, ATR-adjusted stop, target, and suggested share count for your available capital.</P>
        <Tip>The win streak mechanic rewards closing profitable trades and redeploying — not holding indefinitely. A locked-in win counts toward your next milestone. When you cross a milestone, picks automatically shift to the next stage's price range.</Tip>
        <P>Prices refresh every 5 minutes during market hours (9:30am–4pm ET). After close, official closing prices are shown. The total portfolio value = cash remaining + current market value of open positions.</P>
        <H>🔥 Invest — Journey Tracker</H>
        <P>The Invest page is built for any starting balance — $5 or $5,000. Enter how much you have to invest and the council finds stocks priced and sized for that exact amount. Six fire milestones track your progress: Spark ($0–$10) → Ember ($10–$50) → Flame ($50–$200) → Blaze ($200–$1K) → Inferno ($1K–$10K) → Free ($10K+).</P>
        <P>Each stage changes the stock price range based on your deployable capital — targeting 10–30 shares per position so every holding feels meaningful. At $5 you get $1–3 stocks. At $500 you get $20–40 stocks. At $2,000 you get $50–100 stocks. The council recalibrates automatically when you cross a milestone.</P>
        <Tip>The "Get picks" button reads live sector performance from the macro dashboard and returns 5 stocks — one per top-performing sector — all priced for your current balance. The sector strip at the top shows which sectors are BULLISH today so you always know why a stock was chosen.</Tip>
        <P>Trades are logged manually with entry price and shares. Live P&L updates every 5 minutes during market hours (9:30am–4pm ET) and shows official closing prices after hours. Closing a trade updates your win streak, win rate, and milestone progress. Your first profitable close triggers a special moment.</P>
        <H>💰 Reinvestment Tracker</H>
        <P>Log trades after council analyses to track live P&L. When you close a trade, the realized gain becomes "available cash." The council then generates three tiered reinvestment strategies — Aggressive (50% of gains into a high-conviction idea), Moderate (25-40% into a strategic play), and Conservative (10-20% into a lower-risk option) — each with a specific entry, stop, and target.</P>
        <Tip>The Reinvestment Tracker works even with unrealized gains. If you haven't closed any trades, the AI uses your paper profits as the deployment amount.</Tip>
        <H>⚡ Head-to-Head Compare</H>
        <P>Runs the full 6-stage debate on two stocks simultaneously, then a third AI call produces a definitive head-to-head verdict. Shows side-by-side conviction scores, risk/reward bars, strengths and weaknesses for each, and a clear "if you can only pick one" recommendation.</P>
        <H>🎓 Trading Academy</H>
        <P>Structured curriculum teaching you to use the platform like an analyst. Three tracks: how the council works, reading signals like a pro, and executing on verdicts. Each lesson includes annotated debate examples and a quiz. The Signal Glossary explains all 24+ indicators with specific examples of how each one shifts verdicts in real debates.</P>
      </>
    ),
  },
  {
    id: 'options',
    title: 'Options Strategy',
    icon: <TrendingUp size={14} />,
    color: '#f87171',
    content: (
      <>
        <P>The Council Options View section appears below the verdict after each analysis. It shows the council's derivatives recommendation based on the verdict, conviction score, IV conditions, and GEX signal.</P>
        <H>Strategy Selection Logic</H>
        <P>BULLISH high conviction → long calls or bull call spreads. BULLISH moderate → covered calls or bull call spread. BEARISH high conviction → long puts or bear put spreads. NEUTRAL → the council shows both sides for reference.</P>
        <H>Earnings Implied Move</H>
        <P>When earnings are within 30 days, the council calculates the ATM straddle cost vs the stock's historical average actual move over the last 4 earnings. If options are priced at 2× the historical move, the council flags "OPTIONS OVERPRICED — selling premium is favored." This is a specific, actionable edge that most retail tools don't provide.</P>
        <H>GEX and Options Strategy</H>
        <P>Strong negative GEX means the council recommends defined-risk strategies (spreads) over naked directional bets — because negative GEX amplifies moves in both directions and creates whipsaw risk for options buyers.</P>
        <Warn>Options are leveraged instruments. One contract = 100 shares. They can expire completely worthless. The Options Strategy section is educational — not a trade recommendation. Never risk money you cannot afford to lose entirely.</Warn>
      </>
    ),
  },
  {
    id: 'smart-money',
    title: 'Smart Money Signals',
    icon: <DollarSign size={14} />,
    color: '#a78bfa',
    content: (
      <>
        <P>Smart money signals track what institutions, insiders, and Congress members are doing with the stock — often before it shows in price.</P>
        <H>Insider Transactions</H>
        <P>SEC Form 4 data showing individual insider buys and sells from the last 90 days with dollar amounts. Net buying is generally bullish — insiders know their own business better than anyone. Selling can be noise (diversification, options exercises) or signal (loss of confidence). The council distinguishes between the two.</P>
        <H>Institutional Holdings</H>
        <P>13F filing data showing major holders and whether notable funds are increasing or decreasing positions. Heavy institutional concentration can be bullish (smart money agrees) or risky (crowded trade vulnerable to simultaneous exits).</P>
        <H>Congressional Trades</H>
        <P>Disclosures of US Congress member trades from QuiverQuant. Congress members have historically outperformed the market significantly. Recent buys from multiple Congress members in the same sector are worth noting.</P>
        <H>Short Interest</H>
        <P>Percentage of float sold short and days to cover. Above 25% = squeeze candidate — good news can trigger rapid covering. Above 15% = heavily shorted. The council uses the put/call ratio as a proxy when direct short interest data is unavailable.</P>
      </>
    ),
  },
]

const FAQ_GENERAL: FAQItem[] = [
  { q: 'What is the Invest page?', a: "The Invest page is a journey-based tracker for growing any starting balance. You enter how much you have to invest, and the council finds stage-appropriate stocks sized to your exact capital. Six fire milestones track your progress from Spark ($0–$10) to Free ($10K+). At each stage, the stock price range adjusts automatically so every position feels like a real holding — not a lottery ticket. It uses live sector data from the Macro dashboard to find 5 picks from today's strongest sectors." },
  { q: "What's the difference between Invest and Reinvestment Tracker?", a: "Invest is for building a portfolio from scratch — any starting amount, with stage-matched picks and milestone tracking. Reinvestment Tracker is for existing investors who have gains from council analyses and want AI-powered strategies for deploying those gains. If you're just starting out or have under $200 to invest, use Invest. If you've been using Consilium for a while and have accumulated gains, use Reinvest." },
  { q: 'What is Consilium?', a: "Consilium is an AI-powered stock and crypto analysis platform that runs a six-stage adversarial debate between multiple AI roles before giving you a verdict. You get a specific signal (BULLISH/BEARISH/NEUTRAL), entry price, ATR-derived stop loss, take profit levels, time horizon, and a full plain English explanation. It covers US stocks, major crypto, and your own portfolio." },
  { q: 'How is this different from other AI stock tools?', a: "Most AI analysis tools give you one model's opinion. Consilium forces its AI council to argue against itself — the Lead Analyst makes a call, the Devil's Advocate attacks it with data, both sides rebut each other using fresh live data fetched mid-debate, and a Judge who has read the full transcript delivers the final verdict. You see every argument made and what got conceded." },
  { q: 'How current is the data?', a: "Live prices come from Finnhub in real time. Historical bar data comes from Alpaca Markets with full dividend adjustment. Options data comes from Tradier's production API. Cached analyses are invalidated automatically when price moves more than 1.5% from the cached price, or after 2 hours maximum — whichever comes first. You'll see a status message when a fresh analysis runs." },
  { q: 'Does it support crypto?', a: "Yes — BTC, ETH, SOL, BNB, XRP, ADA, AVAX, DOGE, and 15+ more. Crypto uses CoinGecko for real-time prices and OHLCV data. All 24+ technical indicators work identically. Fundamentals are replaced with on-chain metadata (market cap, 24h/7d change, ATH, circulating supply). The full 6-stage debate runs on crypto exactly as it does for equities." },
  { q: 'What does the free trial include?', a: "The 7-day free trial includes full access to every feature — main analysis, crypto, Macro dashboard, Portfolio, Reinvestment Tracker, Compare, Trading Academy, and all indicator data. No credit card required to start." },
]

const FAQ_SIGNALS: FAQItem[] = [
  { q: 'What is the conviction score?', a: "The conviction score aggregates all signals across technicals, fundamentals, smart money, options flow, and macro context into a net score from -100 to +100. It's adjusted for market regime — HIGH FEAR discounts bullish signals. The conviction score sets the ceiling on the Lead Analyst's confidence: a +20 conviction score can't produce a 90% BULLISH verdict." },
  { q: 'Why does the confidence score matter for position sizing?', a: "The confidence score is a measure of signal agreement, not a probability of profit. 85%+ with no concessions = full intended position. 70-84% = 75%. 55-69% = 50%. Below 55% = 25% or wait. Any verdict where the Lead Analyst made 2+ concessions should drop one tier regardless of the confidence number." },
  { q: 'What are ATR-derived stops and why does the council use them?', a: "ATR (Average True Range) measures how much the stock moves on a typical day. A stop tighter than 1× ATR will be triggered by normal daily volatility before the trade has a chance to work. The council uses 2× ATR as the minimum stop placement and 3× ATR as the baseline target, giving a 1.5:1 risk/reward starting point. You can see the specific dollar levels in the sidebar under ATR(14)." },
  { q: 'What is the invalidation trigger?', a: "The single most important field in the verdict that most users ignore. It states exactly what condition would make the entire thesis wrong. If that condition is met, re-run the analysis immediately — the debate outcome will likely be very different. Set a price alert for the invalidation level." },
  { q: 'What does GEX tell me?', a: "Gamma Exposure measures dealer hedging dynamics. Positive GEX means dealers are long gamma — they sell into rallies and buy dips to stay neutral, which pins price near key levels. Negative GEX means dealers must chase moves in both directions, amplifying volatility. High negative GEX near a resistance level means a breakout will run hard rather than grind." },
  { q: 'Why do I sometimes get different verdicts for the same stock under different personas?', a: "This is intentional and useful. A stock can be technically BEARISH (price below death cross, below SMA200) and fundamentally BULLISH (beaten-down quality business at a discount to historical P/E) simultaneously. Both can be correct for different timeframes. The divergence tells you exactly what kind of trade this is: follow Technical for a 2-4 week swing, follow Fundamental for a 3-6 month position." },
]

const FAQ_TECHNICAL: FAQItem[] = [
  { q: 'Why do my SMA values differ from TradingView?', a: "Alpaca Markets uses the standard corporate action adjustment methodology for dividend-adjusted prices. TradingView uses a proprietary algorithm. The difference is typically $3-8 on high-dividend stocks like AAPL. This is a data source difference, not a calculation error. RSI, MACD, and directional signals are unaffected and remain accurate." },
  { q: 'What is Ichimoku Cloud and why does it matter?', a: "Ichimoku Kinko Hyo is one of the most comprehensive single indicators in technical analysis — it shows trend direction, momentum, and support/resistance simultaneously. Price above the cloud = structurally bullish (26+ sessions of price structure support this). A TK cross (Tenkan crossing Kijun while above the cloud) is an institutional entry signal. The Lead Analyst consistently leads with cloud position when it's decisive." },
  { q: 'How does relative strength vs sector work?', a: "The council computes your stock's period return minus the sector ETF's period return over the same period. Stock up 2%, sector up 9% = -7% relative strength. This exposes hidden weakness — the stock is rising with the tide, not leading it. The Devil's Advocate uses this to challenge BULLISH calls when a stock is lagging its peers." },
  { q: 'What does the Bollinger Band squeeze mean?', a: "A squeeze occurs when the bands narrow significantly, indicating a period of low volatility. Volatility compression historically precedes expansion — a breakout. The council treats a squeeze as a setup signal, not a directional one. Combine with Ichimoku cloud position and momentum indicators to determine direction." },
]

const FAQ_OPTIONS: FAQItem[] = [
  { q: 'What is the Council Options View?', a: "After each analysis, the Council Options View shows a specific derivatives strategy based on the verdict, conviction score, IV conditions, and GEX signal. For BULLISH verdicts it typically recommends long calls or bull call spreads depending on IV levels. For BEARISH it recommends puts or put spreads. When IV is elevated (options expensive), it may suggest selling premium instead." },
  { q: 'What is the earnings implied move?', a: "When earnings are within 30 days, the council calculates the cost of the at-the-money straddle and compares it to the stock's historical average actual move over the last 4 earnings. If options are priced at 2× the historical move, the verdict notes 'OPTIONS OVERPRICED — vol selling is favored.' This is an edge most retail platforms don't provide." },
  { q: 'Why do options contracts sometimes not load?', a: "Options data comes from Tradier's production API. Tradier requires a funded brokerage account for the production endpoint. If options aren't loading, the sandbox (15-min delayed) may be serving as fallback. Options data is always unavailable for crypto and many small-cap stocks with limited open interest." },
  { q: 'What does max pain mean?', a: "Max pain is the strike price where the most options contracts (by dollar value) would expire worthless. Market makers benefit when price closes near max pain on expiration day. On options expiration Fridays, price often gravitates toward max pain — particularly in smaller, option-heavy stocks. The council notes max pain when it aligns with or contradicts the price target." },
]

const FAQ_BILLING: FAQItem[] = [
  { q: 'How much does Consilium cost?', a: "Standard is $29/month and Pro is $49/month, both with a 7-day free trial. During the trial you get full Pro access regardless of which plan you choose. No credit card required to start." },
  { q: 'Can I cancel anytime?', a: "Yes. You can cancel from the Account Settings page at any time. You'll retain access until the end of your billing period." },
  { q: 'What happens when my trial ends?', a: "You'll see a Subscribe prompt on next login. Your saved analyses, portfolio positions, and trading history are preserved — you just need to subscribe to run new analyses." },
  { q: 'Does Consilium store my financial data?', a: "Consilium stores analysis results, portfolio positions you manually enter, and reinvestment trades you log. It does not connect to your brokerage, does not have access to your actual trades, and does not store payment information (Stripe handles payments)." },
]

export default function GuidePage() {
  const router = useRouter()
  const [tab, setTab] = useState<'guide' | 'faq'>('guide')

  return (
    <div className="flex flex-col min-h-screen" style={{ background: '#0a0d12', color: 'white' }}>
      <header className="flex items-center gap-3 px-4 py-3 border-b sticky top-0 z-10"
        style={{ background: '#111620', borderColor: 'rgba(255,255,255,0.07)' }}>
        <button onClick={() => router.push('/')}
          className="flex items-center gap-1.5 text-xs text-white/40 hover:text-white/70 transition-colors">
          <ArrowLeft size={13} /> Back
        </button>
        <div className="w-px h-4" style={{ background: 'rgba(255,255,255,0.1)' }} />
        <BookOpen size={14} style={{ color: '#a78bfa' }} />
        <span className="text-sm font-bold">User Guide & FAQ</span>
        <div className="flex-1" />
        <button onClick={() => router.push('/training')}
          className="text-xs px-3 py-1 rounded-lg font-semibold transition-all hover:opacity-80"
          style={{ background: 'rgba(167,139,250,0.1)', color: '#a78bfa', border: '1px solid rgba(167,139,250,0.2)' }}>
          🎓 Trading Academy →
        </button>
      </header>

      <div className="flex gap-0 border-b px-4" style={{ borderColor: 'rgba(255,255,255,0.07)', background: '#111620' }}>
        {(['guide', 'faq'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className="px-4 py-2.5 text-xs font-semibold capitalize border-b-2 transition-all"
            style={{ color: tab === t ? '#a78bfa' : 'rgba(255,255,255,0.3)', borderColor: tab === t ? '#a78bfa' : 'transparent' }}>
            {t === 'guide' ? '📖 User Guide' : '❓ FAQ'}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-4 py-6 space-y-6">

          {tab === 'guide' && (
            <>
              {/* Quick nav */}
              <div className="flex flex-wrap gap-2">
                {SECTIONS.map(s => (
                  <a key={s.id} href={`#${s.id}`}
                    className="text-[11px] px-2.5 py-1 rounded-lg transition-all hover:opacity-80"
                    style={{ background: `${s.color}12`, color: s.color, border: `1px solid ${s.color}20` }}>
                    {s.title}
                  </a>
                ))}
              </div>

              {SECTIONS.map(s => (
                <div key={s.id} id={s.id} className="rounded-2xl border overflow-hidden"
                  style={{ borderColor: `${s.color}20`, background: '#111620' }}>
                  <div className="flex items-center gap-3 px-5 py-4 border-b"
                    style={{ borderColor: `${s.color}15` }}>
                    <div className="w-7 h-7 rounded-lg flex items-center justify-center"
                      style={{ background: `${s.color}15` }}>
                      <span style={{ color: s.color }}>{s.icon}</span>
                    </div>
                    <span className="text-base font-bold text-white">{s.title}</span>
                  </div>
                  <div className="px-5 py-5">{s.content}</div>
                </div>
              ))}
            </>
          )}

          {tab === 'faq' && (
            <div className="space-y-8">
              {[
                { title: 'General', icon: <HelpCircle size={14} />, color: '#fbbf24', items: FAQ_GENERAL },
                { title: 'Signals & Indicators', icon: <BarChart2 size={14} />, color: '#a78bfa', items: FAQ_SIGNALS },
                { title: 'Technical Data', icon: <Activity size={14} />, color: '#60a5fa', items: FAQ_TECHNICAL },
                { title: 'Options & Derivatives', icon: <TrendingUp size={14} />, color: '#f87171', items: FAQ_OPTIONS },
                { title: 'Billing & Account', icon: <DollarSign size={14} />, color: '#34d399', items: FAQ_BILLING },
              ].map(group => (
                <div key={group.title}>
                  <div className="flex items-center gap-2 mb-3">
                    <span style={{ color: group.color }}>{group.icon}</span>
                    <h2 className="text-sm font-bold text-white">{group.title}</h2>
                  </div>
                  <FAQAccordion items={group.items} />
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
