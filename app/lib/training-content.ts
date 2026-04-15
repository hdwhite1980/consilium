// ── Training Curriculum ──────────────────────────────────────
// All lesson content, quiz questions, and glossary entries

export interface QuizQuestion {
  id: string
  question: string
  options: string[]
  correctIndex: number
  explanation: string
}

export interface Lesson {
  id: string           // e.g. 'training:track1:lesson1'
  title: string
  subtitle: string
  duration: string     // e.g. '3 min read'
  content: Section[]
  quiz: QuizQuestion[]
}

export interface Section {
  type: 'text' | 'callout' | 'debate_block' | 'tip' | 'warning'
  label?: string       // for debate_block: role name; for callout: label
  color?: string
  text: string
  annotation?: string  // the teaching point on a debate_block
}

export interface Track {
  id: string
  title: string
  description: string
  color: string
  lessons: Lesson[]
}

export interface GlossaryEntry {
  term: string
  oneLiner: string
  explanation: string
  debateImpact: string
  example: string
  usageCount?: number     // pulled dynamically
  verdictChangeRate?: number
}

// ── TRACK 1: How the Council Works ───────────────────────────
const track1: Track = {
  id: 'track1',
  title: 'How the council works',
  description: 'Understand the adversarial debate architecture and why it produces better analysis than single-model tools.',
  color: '#a78bfa',
  lessons: [
    {
      id: 'training:track1:lesson1',
      title: "Why one AI's opinion isn't enough",
      subtitle: 'The problem with single-model analysis',
      duration: '4 min',
      content: [
        {
          type: 'text',
          text: "Every major AI stock analysis tool does the same thing: ask one model to analyze a stock and summarize its findings. The model has no incentive to challenge itself. If its training data overrepresents bullish narratives, the output will be bullish. If the prompt asks for risks, it generates risks — but they're the same risks it always generates, not the ones specific to this stock right now.",
        },
        {
          type: 'callout',
          label: 'The core problem',
          color: '#f87171',
          text: "A single AI's analysis has no error-correction mechanism. It cannot catch its own blind spots because it has no adversary. It's like asking one analyst to write both the bull case and the bear case — they'll unconsciously weight the side they already believe.",
        },
        {
          type: 'text',
          text: "Consilium's council forces three separate roles with opposing incentives. The Lead Analyst is rewarded for a decisive directional call. The Devil's Advocate is rewarded for finding holes in that call. Neither can ignore the other. The debate creates genuine intellectual conflict — and conflict is what surfaces real risks.",
        },
        {
          type: 'tip',
          text: "The most important signal in any analysis isn't the final verdict — it's what the Lead Analyst concedes in the rebuttal round. If they concede their strongest point, watch the confidence score drop.",
        },
        {
          type: 'text',
          text: "The Judge doesn't vote with the majority. It reads the full two-round transcript and weighs argument quality. A Devil's Advocate who makes four strong, data-backed challenges will influence the verdict more than a Lead Analyst who defends every point with vague assertions.",
        },
      ],
      quiz: [
        {
          id: 'q1',
          question: "Why does the Lead Analyst's concession matter more than the Devil's Advocate's challenges?",
          options: [
            "Because the Lead Analyst has more credibility than the Devil's Advocate",
            "Because a concession is an admission from the thesis holder that a weakness is real — the Judge weights it heavily",
            "Because concessions are always about fundamental data which is more reliable than technical data",
            "They don't — challenges and concessions are weighted equally",
          ],
          correctIndex: 1,
          explanation: "The Judge explicitly looks for concessions because they represent the Lead Analyst's own acknowledgment that a challenge is valid. A concession from the person defending the thesis carries far more weight than a challenge from an adversary.",
        },
        {
          id: 'q2',
          question: "What is the primary structural advantage of adversarial debate over single-model analysis?",
          options: [
            "It uses more computing power",
            "It produces longer reports",
            "Each role has opposing incentives — the Lead Analyst can't unconsciously weight their own bias unchallenged",
            "It always produces a BULLISH verdict which is correct more often",
          ],
          correctIndex: 2,
          explanation: "Opposing incentives create genuine intellectual conflict. The Lead Analyst wants to defend their call; the Devil's Advocate wants to tear it apart. Neither can softpedal the other side because the Judge reads both.",
        },
      ],
    },
    {
      id: 'training:track1:lesson2',
      title: 'Reading a debate transcript',
      subtitle: 'What to look for in each stage',
      duration: '5 min',
      content: [
        {
          type: 'text',
          text: "Each of the six stages tells you something different. Most users read the verdict and nothing else. The users who get the most out of Consilium read the rebuttal.",
        },
        {
          type: 'debate_block',
          label: 'News Scout — Stage 1',
          color: '#60a5fa',
          text: '"Macro environment is HIGH FEAR with VIX at 28.4. SPY has declined 3.2% over the past week. Tech sector underperforming by 1.8%. Three bearish headlines in the last 24 hours: Fed minutes signal higher-for-longer, chip export restrictions expanded, and consumer confidence missed estimates."',
          annotation: "The News Scout sets the regime context. HIGH FEAR means individual stock signals are discounted — macro is in control. If you see HIGH FEAR here and a BULLISH verdict, the confidence will be lower because the council knows the tide is going out.",
        },
        {
          type: 'debate_block',
          label: 'Lead Analyst — Stage 2',
          color: '#a78bfa',
          text: '"Despite macro headwinds, NVDA shows exceptional relative strength — outperforming the semiconductor sector by 4.1% this week. Ichimoku cloud confirms structural bull trend, price above cloud for 18 sessions. RSI at 64 is constructive. Institutional buying confirmed by rising OBV..."',
          annotation: "The Lead Analyst leads with their strongest evidence. Notice they immediately address the macro weakness from Stage 1 — good analysis acknowledges the regime rather than ignoring it.",
        },
        {
          type: 'debate_block',
          label: "Devil's Advocate — Stage 3",
          color: '#f87171',
          text: '"The Lead Analyst overlooks that CCI at 142 and Williams %R at -8 both signal extreme overbought conditions. Three independent oscillators confirming overbought is not a coincidence — it\'s a distribution signal. Additionally, the 1.2x volume is below what a genuine institutional accumulation pattern requires..."',
          annotation: "The best Devil's Advocate challenges don't dispute facts — they reframe them. 'Institutional buying' becomes 'below institutional accumulation thresholds' using the same data. Learn to do this when you're evaluating your own trades.",
        },
        {
          type: 'debate_block',
          label: 'Lead Analyst Rebuttal — Stage 4',
          color: '#a78bfa',
          text: '"I concede the overbought oscillator reading — CCI at 142 is a legitimate concern and I am reducing my confidence from 78% to 68%. However, I maintain that Ichimoku cloud position overrides short-term oscillator signals in trending markets. The News Scout confirmed via live options data that institutional open interest increased 23% this week..."',
          annotation: "This is the most important stage to read. The Lead Analyst conceded on oscillators — that reduced confidence by 10 points. But they stood firm on Ichimoku with fresh data. When you see a concession, mentally note: the final confidence score will reflect this.",
        },
        {
          type: 'tip',
          text: "Skip to the rebuttal first. If the Lead Analyst concedes their strongest technical or fundamental point, the verdict will lean toward NEUTRAL even if it says BULLISH. A 58% BULLISH with 2 concessions should be sized much smaller than a 78% BULLISH with 0 concessions.",
        },
      ],
      quiz: [
        {
          id: 'q1',
          question: "The Lead Analyst concedes their strongest fundamental point in the rebuttal. The verdict is BULLISH 61%. How should you treat this?",
          options: [
            "Full confidence — a BULLISH verdict is a BULLISH verdict",
            "Reduce position size significantly — 61% with a core concession means genuine uncertainty",
            "Ignore the verdict and run the analysis again under a different persona",
            "Only trade if the Devil's Advocate also concedes in the counter",
          ],
          correctIndex: 1,
          explanation: "A 61% BULLISH with the Lead Analyst conceding their strongest point is close to NEUTRAL territory. The council is saying 'lean bullish but it's close.' Size it like a 50/50 coin flip with an edge, not a high-conviction trade.",
        },
        {
          id: 'q2',
          question: "What does it mean when the News Scout reports HIGH FEAR regime?",
          options: [
            "You should only look at bearish stocks",
            "All verdicts will be BEARISH",
            "Individual stock signals are discounted — macro is dominating, and bullish signals carry less weight",
            "The analysis will take longer to complete",
          ],
          correctIndex: 2,
          explanation: "HIGH FEAR means VIX is elevated and SPY is weak. In this environment, even technically strong stocks can be dragged down. The council adjusts conviction scores downward for bullish calls in HIGH FEAR regimes — which is why you'll see lower confidence scores on BULLISH verdicts during volatile markets.",
        },
      ],
    },
    {
      id: 'training:track1:lesson3',
      title: 'Confidence scores — what they actually mean',
      subtitle: 'How to size positions using conviction',
      duration: '4 min',
      content: [
        {
          type: 'text',
          text: "The confidence score is not a probability of profit. It's a measure of signal agreement. A 90% confidence BULLISH means almost every signal — technical, fundamental, smart money, options flow, macro — is pointing the same direction. A 45% NEUTRAL means signals are genuinely divided.",
        },
        {
          type: 'callout',
          label: 'Position sizing framework',
          color: '#34d399',
          text: "85%+ confidence → full intended position size\n70-84% → 75% of intended size\n55-69% → 50% of intended size\nBelow 55% → 25% or skip entirely\nAny verdict with 2+ concessions → drop one tier regardless of confidence number",
        },
        {
          type: 'text',
          text: "A 45% NEUTRAL verdict is not a failure of the analysis — it's the council being honest. When signals genuinely conflict, the intellectually honest output is NEUTRAL. If you see a 45% NEUTRAL and the stock subsequently moves strongly in one direction, that wasn't a bad analysis — it was a correct acknowledgment of uncertainty.",
        },
        {
          type: 'warning',
          text: "Never trade a NEUTRAL verdict at full size. Even if you believe in the stock, the council is telling you the evidence is split. Run it under a different persona to see if the Technical or Fundamental lens produces a cleaner signal.",
        },
        {
          type: 'text',
          text: "The single biggest mistake new users make is treating all BULLISH verdicts equally. An 88% BULLISH with no concessions on NVDA in a RISK ON regime is completely different from a 62% BULLISH with 2 concessions on a mid-cap in HIGH FEAR. The verdict label is the same. Everything else is different.",
        },
      ],
      quiz: [
        {
          id: 'q1',
          question: "The council gives a 52% NEUTRAL verdict. Two of your friends disagree — one says buy, one says sell. What does the verdict actually tell you?",
          options: [
            "The council is broken — it should always give a clear direction",
            "You should buy because 52% is slightly above 50%",
            "The signals genuinely conflict — the council is being honest about uncertainty, not failing",
            "Wait for the next day's analysis which will be more decisive",
          ],
          correctIndex: 2,
          explanation: "52% NEUTRAL means the signals are nearly perfectly split. This is the most honest possible output when evidence conflicts. A tool that always produces a confident BULLISH or BEARISH would be hiding this uncertainty from you.",
        },
        {
          id: 'q2',
          question: "You have $10,000 to invest. The council gives an 87% BULLISH verdict with zero concessions. What size position does the framework suggest?",
          options: [
            "$2,500 — always split across 4 positions",
            "$7,500 — 75% because you should always keep cash reserves",
            "$10,000 — 87% confidence justifies full position size",
            "$5,000 — 50% because no trade is ever certain",
          ],
          correctIndex: 2,
          explanation: "85%+ confidence with no concessions is the highest tier — full intended position size. This doesn't mean zero risk exists, but the signal agreement is as strong as it gets. Don't artificially limit a high-conviction call.",
        },
      ],
    },
    {
      id: 'training:track1:lesson4',
      title: 'How analyst personas change verdicts',
      subtitle: 'Technical vs Fundamental vs Balanced',
      duration: '3 min',
      content: [
        {
          type: 'text',
          text: "Running the same stock under all three personas and getting three different verdicts is not a bug — it's the most useful thing the platform can show you. A stock that's technically BEARISH (death cross, below SMA200) but fundamentally BULLISH (beaten-down quality business at a discount) is showing you a genuine decision: are you a trader or an investor?",
        },
        {
          type: 'callout',
          label: 'When verdicts differ by persona',
          color: '#60a5fa',
          text: "Technical BEARISH + Fundamental BULLISH = the stock is going down now but may be a value opportunity. Size smaller, wait for technical stabilization.\n\nTechnical BULLISH + Fundamental BEARISH = momentum exists but fundamentals don't support it. Take smaller profits faster — don't hold through earnings.\n\nAll three aligned = highest conviction possible. This is the trade.",
        },
        {
          type: 'debate_block',
          label: 'Technical Trader lens — same stock',
          color: '#fbbf24',
          text: '"Death cross confirmed — SMA50 crossed below SMA200 three sessions ago. Price failed to reclaim the 50-day MA on two separate attempts. BEARISH."',
          annotation: "The Technical lens doesn't care about P/E ratios or analyst upgrades. A death cross is a death cross. This is the correct view for a 2-4 week trade.",
        },
        {
          type: 'debate_block',
          label: 'Fundamental Analyst lens — same stock',
          color: '#34d399',
          text: '"Trading at 14x forward earnings vs historical average of 22x. Three analyst upgrades in the last month. Consistent EPS beater. A 35% drawdown in a business with 20% FCF yield is an opportunity, not a sell signal. BULLISH."',
          annotation: "The Fundamental lens sees the same price decline as a discount. This is the correct view for a 6-12 month hold. Both can be simultaneously correct for their respective timeframes.",
        },
        {
          type: 'tip',
          text: "Run Technical first. If it's BULLISH technically, run Fundamental to see if the business supports it. If both agree, that's a high-conviction trade. If they disagree, you've identified the exact nature of the risk before you put money in.",
        },
      ],
      quiz: [
        {
          id: 'q1',
          question: "Technical says BEARISH, Fundamental says BULLISH. What is the most useful conclusion?",
          options: [
            "The platform is contradicting itself — ignore both",
            "Always trust the Technical verdict because price action doesn't lie",
            "The stock is experiencing short-term technical weakness in a fundamentally sound business — the opportunity depends on your timeframe",
            "Always trust the Fundamental verdict because fundamentals drive long-term value",
          ],
          correctIndex: 2,
          explanation: "This divergence tells you exactly what kind of trade this is. For a 2-4 week swing trade, follow Technical. For a 3-6 month position, follow Fundamental. The conflict is information, not noise.",
        },
      ],
    },
  ],
}

// ── TRACK 2: Reading Signals ──────────────────────────────────
const track2: Track = {
  id: 'track2',
  title: 'Reading signals like an analyst',
  description: "Master the indicators that actually move verdicts — not textbook definitions, but how they're used in real debates.",
  color: '#60a5fa',
  lessons: [
    {
      id: 'training:track2:lesson1',
      title: 'The signals that change verdicts most',
      subtitle: 'Ichimoku, relative strength, and GEX',
      duration: '5 min',
      content: [
        {
          type: 'text',
          text: "Not all indicators carry equal weight in the debate. RSI, MACD, and moving averages are baseline — the council always sees them. But three newer indicators consistently shift verdicts when they conflict with the baseline picture: Ichimoku cloud position, relative strength vs sector, and GEX.",
        },
        {
          type: 'callout',
          label: 'Ichimoku cloud — the most decisive single signal',
          color: '#a78bfa',
          text: "Price above the cloud = structurally bullish regardless of short-term oscillator readings. The cloud represents 26+ sessions of price structure — it doesn't lie about trend direction.\n\nThe TK cross (Tenkan crossing Kijun while above the cloud) is an institutional entry signal. When the council sees this, the Lead Analyst almost always leads with it.",
        },
        {
          type: 'text',
          text: "Relative strength vs sector is the signal most users overlook but analysts watch most closely. If NVDA is up 2% this week but the semiconductor sector is up 8%, NVDA is underperforming by 6%. That's hidden weakness — the stock is riding the sector tide, not leading it. The Devil's Advocate uses this against BULLISH calls constantly.",
        },
        {
          type: 'callout',
          label: 'GEX — dealer positioning',
          color: '#fbbf24',
          text: "Positive GEX = dealers are long gamma = they sell into rallies and buy dips to stay neutral = price gets pinned near key levels.\n\nNegative GEX = dealers are short gamma = they buy into rallies and sell dips = moves accelerate in both directions.\n\nHigh negative GEX near a resistance level means a breakout will RUN, not grind.",
        },
        {
          type: 'tip',
          text: "When you see a BULLISH verdict near a resistance level, always check the GEX signal. Positive GEX = expect pinning, take profits quickly. Negative GEX = let it run, the move could be 2-3x larger than normal.",
        },
      ],
      quiz: [
        {
          id: 'q1',
          question: "A stock is BULLISH on RSI and MACD but showing -6% relative strength vs its sector this week. How does the council likely treat this?",
          options: [
            "Ignore relative strength — RSI and MACD are more reliable",
            "The Devil's Advocate will cite the relative weakness, potentially reducing the confidence score",
            "Run a new analysis with the Technical persona which ignores relative strength",
            "Relative strength is only relevant for ETFs, not individual stocks",
          ],
          correctIndex: 1,
          explanation: "Relative underperformance of 6% in a week is significant and the Devil's Advocate will use it. 'The stock is technically strong but lagging peers' is a legitimate challenge that often reduces confidence scores on BULLISH calls.",
        },
        {
          id: 'q2',
          question: "GEX is strongly negative and price is approaching a major resistance level. What does this suggest?",
          options: [
            "Price will be pinned at resistance — take profits immediately",
            "If resistance breaks, the move will likely accelerate — dealers will chase it higher",
            "Negative GEX is bearish — sell before resistance",
            "GEX only matters for options traders, not stock traders",
          ],
          correctIndex: 1,
          explanation: "Negative GEX means dealers are short gamma — they buy as price rises to stay neutral, which amplifies moves. A resistance break in a negative GEX environment is one of the strongest breakout setups because the natural hedging flow adds buying pressure.",
        },
      ],
    },
    {
      id: 'training:track2:lesson2',
      title: 'ATR — sizing stops and targets correctly',
      subtitle: 'Why most retail stops are too tight',
      duration: '4 min',
      content: [
        {
          type: 'text',
          text: "The single most common reason retail traders get stopped out of winning trades is a stop that's too tight. They pick a round number slightly below their entry and get hit by normal daily volatility before the trade even has a chance to work.",
        },
        {
          type: 'callout',
          label: 'The 2× ATR rule',
          color: '#34d399',
          text: "Stop = Entry − (2 × ATR)\nTarget = Entry + (3 × ATR)\nRisk/Reward = 1.5:1 minimum\n\nATR tells you how much the stock moves on a normal day. A stop tighter than 1× ATR will be hit by routine fluctuation. 2× ATR gives the trade room to breathe.",
        },
        {
          type: 'text',
          text: "A stock with 3% daily ATR and a 0.8% stop will be stopped out by the first 30 minutes of normal volatility. The same stock with a 6% stop (2× ATR) will only be stopped if something genuinely changes. The council's trade plan uses 2× ATR stops — this is why.",
        },
        {
          type: 'warning',
          text: "High ATR stocks (>3% daily ATR) require wider stops in dollar terms but smaller share counts to keep total risk the same. Don't buy 100 shares of a $50 high-volatility stock with a $2 stop — buy 50 shares with a $4 stop.",
        },
        {
          type: 'text',
          text: "The ATR signal card in the sidebar shows 'Suggested stop: $X | Target: $Y' on every analysis. These are 2× and 3× ATR levels from current price. Use them as your baseline, then adjust based on nearby support/resistance levels.",
        },
      ],
      quiz: [
        {
          id: 'q1',
          question: "A stock has ATR of $3.50 and you buy at $100. Where should your stop be?",
          options: [
            "$98.50 — $1.50 below entry (0.5× ATR)",
            "$97.00 — $3.00 below entry (just under 1× ATR)",
            "$93.00 — $7.00 below entry (2× ATR)",
            "$96.50 — the round number below entry",
          ],
          correctIndex: 2,
          explanation: "2× ATR = $7.00. Stop at $93.00. Anything tighter will be hit by normal daily moves before the trade has time to work. The council's trade plans always use 2× ATR as the floor for stop placement.",
        },
      ],
    },
  ],
}

// ── TRACK 3: Trade Execution ──────────────────────────────────
const track3: Track = {
  id: 'track3',
  title: 'Executing on verdicts',
  description: 'Turn council verdicts into actual trades — entry timing, position sizing, and when to override.',
  color: '#34d399',
  lessons: [
    {
      id: 'training:track3:lesson1',
      title: "When to override the council",
      subtitle: 'The cases where you should not follow the verdict',
      duration: '4 min',
      content: [
        {
          type: 'text',
          text: "The council is very good at synthesizing signals. It is not good at knowing things that aren't in its data: whether you already hold the stock, whether you have an earnings announcement in your calendar, whether the market is about to close for a holiday. You should override the verdict in specific circumstances.",
        },
        {
          type: 'callout',
          label: 'Valid reasons to override a BULLISH verdict',
          color: '#f87171',
          text: "1. You already hold a large position — adding more increases concentration risk beyond your comfort\n2. Earnings are within 3 days — the council may not fully price in gap risk\n3. The confidence score is below 60% — barely BULLISH means the council itself isn't sure\n4. The broader market is in extreme fear (VIX > 30) and the stock is highly correlated to SPY\n5. You have non-public information (compliance risk)",
        },
        {
          type: 'text',
          text: "The council's invalidation trigger is the most underread part of every verdict. It tells you the exact condition that would make the entire thesis wrong. If you enter a trade, set a calendar reminder to re-run the analysis if the invalidation trigger gets close to being hit.",
        },
        {
          type: 'tip',
          text: "The best time to re-run an analysis is not when a stock is moving. It's when it's quiet — the day before earnings, after a major level holds as support, or after a large volume spike day. Fresh analysis after a catalytic event often produces very different verdicts.",
        },
      ],
      quiz: [
        {
          id: 'q1',
          question: "The council gives a 79% BULLISH verdict. Earnings are in 2 days. The implied move from options is ±8%. What's the right call?",
          options: [
            "Enter at full size — 79% is high confidence",
            "Enter at half size or wait for post-earnings clarity — the council's 79% doesn't fully account for binary gap risk",
            "Don't trade — never trade before earnings",
            "Run the analysis again under Fundamental persona to see if it changes",
          ],
          correctIndex: 1,
          explanation: "A ±8% implied move means the stock can gap down 8% overnight regardless of the technical picture. The council's 79% is valid but was formed without knowing your specific entry timing. Half size or waiting for earnings is prudent risk management, not overriding the council.",
        },
      ],
    },
  ],
}


// ── TRACK 4: The Invest Journey ──────────────────────────────
const track4: Track = {
  id: 'track4',
  title: 'The investment journey',
  description: 'How to grow any starting amount using stage-matched stocks, sector momentum, and compound discipline.',
  color: '#f97316',
  lessons: [
    {
      id: 'training:track4:lesson1',
      title: 'Why the stage system works',
      subtitle: 'How price range maps to position size',
      duration: '4 min',
      content: [
        {
          type: 'text',
          text: "Most investing advice assumes you have thousands of dollars. The Invest journey assumes you have whatever you have — $5, $50, or $500 — and builds a framework that makes every amount feel like a real position.",
        },
        {
          type: 'callout',
          label: 'The position sizing insight',
          color: '#f97316',
          text: "At any balance level, a good position should let you buy 10–30 shares.\n\nAt $5: buy 2–3 shares of a $1–2 stock.\nAt $100: buy 10–15 shares of a $6–8 stock.\nAt $500: buy 15–20 shares of a $20–30 stock.\nAt $2,000: buy 20–30 shares of a $50–80 stock.\n\nThe price range shifts with your balance — you always buy a meaningful position.",
        },
        {
          type: 'text',
          text: "This is why the six milestones exist. Spark ($0–$10) and Ember ($10–$50) focus on $1–8 stocks because that\'s the range where a $5 account can build a real position. By Blaze ($200–$1K), you\'re buying $20–50 stocks where fundamentals and technical signals are more reliable.",
        },
        {
          type: 'tip',
          text: "Each stage also changes the stop strategy. At Spark, stops are wide (20–30%) because $1–5 stocks are volatile. By Inferno, stops are tight (8–12%) because you\'re in higher-quality names with more predictable movement.",
        },
      ],
      quiz: [
        {
          id: 'q1',
          question: "You have $50. The council suggests buying 20 shares of a $2.40 stock. Why is this better than buying 1 share of a $48 stock?",
          options: [
            "It isn\'t — 1 share of a $48 stock is simpler",
            "20 shares gives flexibility to sell partial positions as the stock rises",
            "A $2.40 stock always has more upside than a $48 stock",
            "You can\'t buy stocks over $10 with $50",
          ],
          correctIndex: 1,
          explanation: "With 20 shares you can sell 5 at the first target, hold 10 through the next, and keep 5 as a longer-term hold. With 1 share you have no flexibility — it\'s all or nothing. Position sizing creates optionality.",
        },
      ],
    },
    {
      id: 'training:track4:lesson2',
      title: 'Using sector momentum for stock selection',
      subtitle: 'Why the best stock in a BULLISH sector beats the best stock overall',
      duration: '4 min',
      content: [
        {
          type: 'text',
          text: "The invest council doesn\'t pick stocks in isolation. It reads the macro sector dashboard first, finds which sectors are BULLISH today, and searches for stage-appropriate stocks within those sectors — the same top-down approach professional fund managers use.",
        },
        {
          type: 'callout',
          label: 'Top-down approach',
          color: '#60a5fa',
          text: "Step 1: Check macro sector performance — which sectors are up?\nStep 2: Focus on the top 3–5 sectors\nStep 3: Find the best setup within those sectors at your price range\n\nA strong stock in a weak sector fights two headwinds. A strong stock in a strong sector has the wind at its back.",
        },
        {
          type: 'debate_block',
          label: 'Sector strip — Ideas tab',
          color: '#f97316',
          text: '"Technology: BULLISH (+2.1%) · Healthcare: BULLISH (+1.4%) · Energy: NEUTRAL (+0.2%) · Financials: BEARISH (-0.8%)"',
          annotation: "This strip shows live data from the macro dashboard. The council only searches BULLISH sectors. On a day when Energy is red, no energy stocks appear in your picks — even if a specific energy stock looks technically strong.",
        },
        {
          type: 'warning',
          text: "When a sector turns BEARISH, small-cap stocks fall harder than the sector ETF. A 2% Healthcare sector drop can mean a 10–20% drop for a small biotech. Check the sector strip before entering any position.",
        },
      ],
      quiz: [
        {
          id: 'q1',
          question: "The macro dashboard shows Technology BULLISH (+1.8%) and Energy BEARISH (-1.2%). The council finds a strong technical setup in an energy small-cap. What should you do?",
          options: [
            "Take the trade — technical setup is what matters",
            "Wait — the sector headwind will likely overwhelm the technical setup",
            "Run a full council debate first",
            "Take half a position to test the setup",
          ],
          correctIndex: 1,
          explanation: "At Spark/Ember stage, small-cap stocks amplify sector moves. A technically strong setup in a BEARISH sector is fighting against institutional flows. The probability drops significantly. Wait for the sector to turn neutral or bullish.",
        },
      ],
    },
    {
      id: 'training:track4:lesson3',
      title: 'Tracking progress and compounding wins',
      subtitle: 'How milestones, streaks, and reinvestment drive the journey',
      duration: '3 min',
      content: [
        {
          type: 'text',
          text: "The journey from Spark to Free isn\'t about any single trade. It\'s about the compound effect of closing winning trades, reinvesting the full proceeds, and gradually moving into higher-quality stocks as your balance grows.",
        },
        {
          type: 'callout',
          label: 'The compound journey',
          color: '#34d399',
          text: "Spark → Ember ($1 → $10): 10× — one $1 stock that triples, a few times.\nEmber → Flame ($10 → $50): 5× — disciplined entries and full reinvestment.\nFlame → Blaze ($50 → $200): 4× — now in $5–15 stocks with better signals.\nBlaze → Inferno ($200 → $1,000): 5× — full debate analysis on every position.\nInferno → Free ($1,000 → $10,000): 10× — compounding accelerates here.",
        },
        {
          type: 'tip',
          text: "When you close a winning trade and cross a milestone, the council immediately recalibrates — picks shift to the next stage\'s price range. The ideas after your first big win will be noticeably different from your starting picks.",
        },
        {
          type: 'text',
          text: "The \'locked in\' counter shows realized profits — money that can\'t be taken away by market moves. Even if open positions are underwater, locked-in gains represent real progress that survives any downturn.",
        },
      ],
      quiz: [
        {
          id: 'q1',
          question: "You\'re at Spark with $4.50. A stock you bought at $1.20 is now at $1.50 (up 25%). The council\'s target is $2.10. What\'s the right move?",
          options: [
            "Hold to the full $2.10 target no matter what",
            "Sell half now to lock in profit, hold half to target",
            "If it\'s approaching target and showing resistance, take the profit and redeploy",
            "Never sell early — always wait for the full target",
          ],
          correctIndex: 2,
          explanation: "At Spark, locking in a 25% win and redeploying compounds faster than waiting for a 75% gain that may never come. The goal is milestone progress, not maximizing any single trade. A locked-in win counts toward Ember.",
        },
      ],
    },
    {
      id: 'training:track4:lesson4',
      title: 'How sector momentum drives your picks',
      subtitle: 'Why the council checks the macro dashboard before suggesting stocks',
      duration: '4 min',
      content: [
        {
          type: 'text',
          text: "The worst time to buy a $2 stock in the energy sector is when energy ETFs are down 3% and the sector signal is BEARISH. Even a perfectly set-up technical play will struggle when the whole sector is selling off. The Invest council solves this by checking live sector performance before suggesting any stock.",
        },
        {
          type: 'callout',
          label: 'How sector-driven picks work',
          color: '#f97316',
          text: "1. The council pulls live performance for all 11 S&P sectors.\n2. Sectors are ranked by signal (BULLISH first) then by today\'s % change.\n3. The top 5 sectors become the hunting ground.\n4. Five stocks are selected — one per sector — priced for your current balance.\n5. The sector strip at the top shows you exactly why each stock was chosen.",
        },
        {
          type: 'text',
          text: "Small and micro-cap stocks are highly correlated to their sector. A $2 cannabis stock moves with the consumer staples sector trend. A $3 EV stock moves with consumer discretionary. Picking against the sector is fighting a headwind — picking with it is a tailwind.",
        },
        {
          type: 'debate_block',
          label: 'Reading the sector strip',
          color: '#f97316',
          text: '"Technology: BULLISH +2.1% · Healthcare: BULLISH +0.8% · Energy: NEUTRAL -0.3% · Consumer Disc.: BEARISH -1.4%"',
          annotation: "If the council suggests a consumer discretionary stock with a BEARISH sector, the individual catalyst needs to be very compelling to overcome that headwind. BULLISH sector picks always carry higher confidence.",
        },
        {
          type: 'tip',
          text: "The sector strip is also your exit signal. If you hold a healthcare stock and healthcare flips from BULLISH to BEARISH on the macro dashboard, that changes the thesis. Review your stop loss when the sector signal changes.",
        },
        {
          type: 'warning',
          text: "On HIGH FEAR days (VIX above 25, SPY down 2%+), even BULLISH sectors get dragged down. At Spark and Ember, consider waiting for stability before deploying capital — you have little buffer to absorb a broad market selloff.",
        },
      ],
      quiz: [
        {
          id: 'q1',
          question: "The sector strip shows Energy: NEUTRAL -0.3%. The council picks a $3.20 energy stock. How should you treat this pick vs one from a BULLISH sector?",
          options: [
            "More confident — NEUTRAL means less crowded, easier to move",
            "Same confidence — individual stock setup is what matters",
            "Less confident — a NEUTRAL sector provides no tailwind, the individual catalyst needs to be stronger",
            "It depends entirely on the stock's volume that day",
          ],
          correctIndex: 2,
          explanation: "A BULLISH sector creates institutional tailwinds. NEUTRAL means the council found this stock despite the sector not helping — the individual setup needs to compensate. Size smaller on NEUTRAL sector picks.",
        },
        {
          id: 'q2',
          question: "You hold a tech stock. Overnight the macro dashboard flips Technology from BULLISH to BEARISH. What's the right response?",
          options: [
            "Do nothing — the stock's technical setup hasn't changed",
            "Sell immediately at market open",
            "Review your stop — if price is near it, close. If not, watch closely and don't add",
            "Add to the position — pullbacks are buying opportunities",
          ],
          correctIndex: 2,
          explanation: "A sector flip doesn't automatically invalidate a trade but it changes the risk profile. Your stop becomes more critical, not less. Never add to a position when the sector tide has turned against you.",
        },
      ],
    },
  ],
}

export const TRAINING_TRACKS: Track[] = [track1, track2, track3, track4]

// ── Signal Glossary ───────────────────────────────────────────
export const GLOSSARY: GlossaryEntry[] = [
  {
    term: 'Ichimoku Cloud',
    oneLiner: 'The most comprehensive single trend indicator — cloud position determines structural bias.',
    explanation: "The Ichimoku system (Ichimoku Kinko Hyo) shows trend direction, momentum, and support/resistance simultaneously. The cloud (Kumo) is built from two span lines — when price is above the cloud, the trend is structurally bullish. Below is bearish. Inside is indecisive. The Tenkan-sen (9-period) and Kijun-sen (26-period) midpoints act as fast and slow moving averages.",
    debateImpact: "The Lead Analyst uses above-cloud position as their primary structural defense. The Devil's Advocate challenges by pointing to cloud thickness (thin clouds offer less support) or a recent TK bearish cross even while above the cloud.",
    example: "NVDA above the cloud for 18 sessions with a bullish TK cross = Lead Analyst opens with this as their headline technical argument.",
  },
  {
    term: 'ATR — Average True Range',
    oneLiner: 'Normalizes volatility into a dollar figure — essential for stop and target placement.',
    explanation: "ATR measures the average true range of price movement over 14 periods, accounting for gaps. A stock with 3% ATR moves $3 for every $100 of price on a typical day. This is the baseline noise level — stops set tighter than 1× ATR will be hit by routine volatility.",
    debateImpact: "The Judge uses ATR to validate the trade plan. 'Stop at $189 represents 1.5× ATR, appropriate given current volatility' or 'this stop is too tight at 0.8× ATR.' The Judge rejects trade plans with stops inside 1× ATR.",
    example: "AAPL ATR = $2.80. Entry at $195. Stop at $189.40 (2× ATR). Target at $203.40 (3× ATR). Risk/reward = 1.5:1.",
  },
  {
    term: 'GEX — Gamma Exposure',
    oneLiner: 'Dealer hedging dynamics — positive pins price, negative amplifies moves.',
    explanation: "GEX measures the net gamma exposure of market makers across all open options contracts. When dealers are net long gamma (positive GEX), they sell into rallies and buy dips to stay delta-neutral — this pins price near key levels. Negative GEX means dealers are short gamma and must chase moves in both directions, amplifying volatility.",
    debateImpact: "The Devil's Advocate cites negative GEX near resistance to challenge bullish breakout theses: 'Dealer positioning will amplify any failure at resistance into a sharp reversal.' The Lead Analyst uses positive GEX to defend expected range-bound behavior near targets.",
    example: "Stock at $148 approaching $150 resistance. GEX strongly negative. If $150 breaks, dealers must buy aggressively — move to $158 is likely faster than normal.",
  },
  {
    term: 'Relative Strength vs Sector',
    oneLiner: "How the stock performs vs its sector ETF — exposes hidden weakness or strength.",
    explanation: "Compares the stock's period return to its sector ETF return. A stock up 2% when semiconductors are up 9% is underperforming by 7% — the stock is lagging despite the positive absolute return. Relative strength is often a leading indicator: sector leaders tend to maintain leadership, laggards tend to continue lagging.",
    debateImpact: "One of the Devil's Advocate's most effective weapons. 'The Lead Analyst cites +4% performance but fails to note the sector returned +11%. This stock is losing ground to every peer.' Consistently changes verdicts from BULLISH to NEUTRAL.",
    example: "INTC up 3% in a week where NVDA and AMD are up 9-11%. INTC is showing -7% relative strength — institutional rotation out of the name despite positive absolute returns.",
  },
  {
    term: 'Williams %R',
    oneLiner: 'Oscillator from -100 to 0 — near 0 is overbought, near -100 is oversold.',
    explanation: "Williams %R measures where the closing price sits within the recent high-low range. Near 0 means the stock closed near its recent high — overbought. Near -100 means it closed near its recent low — oversold. It's most valuable when combined with RSI and CCI — three oscillators agreeing is a stronger signal than any one alone.",
    debateImpact: "Used by the Devil's Advocate to challenge overbought calls: 'RSI at 68 alone is borderline, but Williams %R at -4 and CCI at 138 confirm three independent oscillators are all reading overbought simultaneously — this is a distribution signal.' Triple oscillator confirmation shifts verdicts.",
    example: "RSI 71, Williams %R -3, CCI 145 = all three confirming overbought. Lead Analyst must address this triple confirmation or lose credibility with the Judge.",
  },
  {
    term: 'CCI — Commodity Channel Index',
    oneLiner: 'Measures deviation from average price — above +100 overbought, below -100 oversold.',
    explanation: "CCI (Commodity Channel Index) measures how far the current typical price has deviated from its 20-period average, normalized by mean deviation. It captures a different dimension of overbought/oversold than RSI — RSI measures relative momentum, CCI measures price deviation from statistical mean.",
    debateImpact: "Triple oscillator confirmation (RSI + Williams %R + CCI all extreme) is the most reliable overbought/oversold signal and almost always reduces the Lead Analyst's confidence score in the rebuttal.",
    example: "CCI at -145 with RSI at 28 and Williams %R at -91 = extremely oversold by three independent measures. High probability mean-reversion setup.",
  },
  {
    term: 'ROC — Rate of Change',
    oneLiner: 'Measures price momentum speed — acceleration vs deceleration is the key signal.',
    explanation: "ROC measures the percentage price change over a period. Unlike RSI which normalizes to 0-100, ROC shows raw momentum speed. The key insight is comparing 10-period ROC to 20-period ROC — if the short-term ROC is stronger, momentum is accelerating. If weaker, it's decelerating.",
    debateImpact: "Decelerating momentum is one of the first warning signs of a trend change, often before RSI or moving averages turn. 'ROC(10) is +3.2% vs ROC(20) of +7.1% — the rally is losing steam' is a common Devil's Advocate argument.",
    example: "Stock making new highs but ROC(10) = +2% vs ROC(20) = +9%. The price is moving up but slowly — distribution is likely occurring.",
  },
  {
    term: 'Max Pain',
    oneLiner: "The options strike where most contracts expire worthless — price is often pulled toward it.",
    explanation: "Max pain (or maximum pain theory) states that market makers have an incentive for the underlying to close near the strike price where the most options expire worthless, reducing their payout obligations. While controversial, price frequently gravitates toward max pain on expiration day — especially in smaller, option-heavy stocks.",
    debateImpact: "Used for near-term price target validation. 'Max pain at $195 aligns with the Lead Analyst's $193-198 entry range' strengthens the thesis. 'Max pain at $185 is $10 below the suggested entry' weakens it.",
    example: "SPX with max pain at 5,800, currently at 5,850 with OPEX tomorrow. Expect sideways to slightly lower as market makers hedge toward 5,800.",
  },
  {
    term: 'Conviction Score',
    oneLiner: 'Net signal agreement from -100 to +100 across all indicators.',
    explanation: "The conviction score aggregates all signals across technicals, fundamentals, smart money, options flow, and macro context into a single score. +80 means almost everything is pointing bullish. -40 means more signals are bearish than bullish but not overwhelmingly so. The score is adjusted for the current market regime.",
    debateImpact: "The conviction score directly sets the ceiling for the Lead Analyst's confidence. A +20 conviction score cannot produce a 90% BULLISH verdict — the maximum confidence in that scenario would be around 60-65%.",
    example: "14 converging BULLISH signals vs 3 diverging = high conviction. 9 converging vs 7 diverging = low conviction, expect NEUTRAL or low-confidence directional verdict.",
  },
]
