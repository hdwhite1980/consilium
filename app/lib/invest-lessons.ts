// ─────────────────────────────────────────────────────────────
// Invest Journey — Stage-Gated Trading Lessons
// This teaches trading skills, not product usage.
// ─────────────────────────────────────────────────────────────

export type LockType = 'stage' | 'behavioral' | 'lesson'

export interface LessonQuiz {
  question: string
  options: string[]
  correctIndex: number
  explanation: string
}

export interface InvestLesson {
  id: string
  stage: 'Spark' | 'Ember' | 'Flame' | 'Blaze' | 'Inferno'
  order: number
  title: string
  subtitle: string
  duration: string
  icon: string
  // Lock conditions — all must be met to unlock
  requiresLesson?: string        // previous lesson id
  requiresBehavior?: 'first_trade' | 'first_close' | 'three_trades'
  content: string[]              // paragraphs
  callout?: { label: string; text: string }
  tip?: string
  quiz: LessonQuiz
}

export const INVEST_LESSONS: InvestLesson[] = [

  // ─── SPARK ────────────────────────────────────────────────
  {
    id: 'spark-1',
    stage: 'Spark',
    order: 1,
    title: 'Position sizing is your survival skill',
    subtitle: 'The one rule that keeps you in the game long enough to learn',
    duration: '3 min',
    icon: '🎯',
    content: [
      "Most new traders blow up their account not because they pick bad stocks — they do it because they bet too much on each one. A 50% loss requires a 100% gain just to break even. If you put 80% of your money into one stock and it drops 50%, you need to double from there just to get back to where you started.",
      "The professional rule is simple: never risk more than 2–5% of your total capital on a single trade. At the Spark stage with $5, that means each position should be $0.10–$0.25. That sounds tiny. It is tiny. That's the point.",
      "Small positions let you make mistakes cheaply. And you will make mistakes — everyone does. The traders who survive long enough to get good are the ones who kept their losses small while they were learning. The traders who blow up are the ones who bet big before they knew what they were doing.",
    ],
    callout: {
      label: 'The math that matters',
      text: "Lose 10% → need 11% to recover\nLose 25% → need 33% to recover\nLose 50% → need 100% to recover\nLose 75% → need 300% to recover\n\nSmall losses are recoverable. Large losses are not.",
    },
    tip: "At the Spark stage, the goal isn't to get rich — it's to learn with real stakes without losing real money. Every trade you make here is practice that carries weight because it costs something.",
    quiz: {
      question: "You have $50 and you're considering putting $40 of it into one stock. What's the main problem with this?",
      options: [
        "The stock might be too expensive",
        "A 50% loss on that position would wipe out 40% of your entire account, leaving you with little to recover from",
        "You should wait until you have more money",
        "There's no problem — concentration leads to bigger gains",
      ],
      correctIndex: 1,
      explanation: "Putting 80% of your capital in one position means a bad trade can permanently damage your ability to continue. Position sizing isn't about limiting gains — it's about ensuring one wrong call doesn't end the journey.",
    },
  },

  {
    id: 'spark-2',
    stage: 'Spark',
    order: 2,
    title: 'Set your stop before you enter',
    subtitle: 'The decision you must make before emotion takes over',
    duration: '3 min',
    icon: '🛑',
    requiresLesson: 'spark-1',
    content: [
      "A stop loss is the price at which you admit the trade isn't working and exit. It sounds simple. The hard part is that most traders set a stop, then move it when the stock hits it. 'I'll give it a little more room.' That's how a 15% planned loss becomes a 40% disaster.",
      "The rule: set your stop before you enter. Write it down. The moment you buy, you already know the exact price that means you're wrong. When that price hits, you exit. No negotiation.",
      "For small-cap stocks like you're trading at the Spark and Ember stages, stops need to be wide — 20 to 30% below your entry. These stocks are volatile. A 10% stop will get triggered by normal daily noise. You're not wrong at -10%; you might just be having a bad Tuesday. But at -25%, the trade has genuinely failed.",
    ],
    callout: {
      label: 'How to set a stop',
      text: "1. Look at the stock's recent daily range\n2. Set your stop below the last significant support level\n3. Never set it at a round number — everyone else's stop is there too\n4. Size your position so hitting the stop costs you no more than 2–5% of total capital",
    },
    tip: "The stop loss isn't just a risk tool — it's a decision-making tool. When you set it before entering, you make the decision rationally. If you wait until you're losing money, fear takes over and you'll make a worse decision.",
    quiz: {
      question: "You buy a stock at $2.00 and set a stop at $1.50. The stock drops to $1.52 then bounces slightly to $1.55. What do you do?",
      options: [
        "Move the stop down to $1.20 to give it more room",
        "Hold — it bounced, which means it's recovering",
        "Your stop didn't trigger so you hold your plan, but you watch closely",
        "Sell immediately since it got close to your stop",
      ],
      correctIndex: 2,
      explanation: "Your stop is at $1.50 and the stock is at $1.55 — the plan is still intact. You hold and watch. What you must NOT do is move the stop lower just because it got close. That's the habit that turns small losses into large ones.",
    },
  },

  {
    id: 'spark-behavior',
    stage: 'Spark',
    order: 3,
    title: 'Log your first trade',
    subtitle: 'Put the theory into practice',
    duration: '—',
    icon: '🔥',
    requiresLesson: 'spark-2',
    requiresBehavior: 'first_trade',
    content: [
      "Theory without action is just reading. Log your first trade on the Invest page — any position, any size. The act of committing capital and tracking it changes how you think about everything you just learned.",
    ],
    quiz: {
      question: "Before logging your trade, what two things should you know?",
      options: [
        "The company name and its ticker symbol",
        "Your entry price and your stop loss level",
        "The stock's 52-week high and low",
        "The analyst consensus and P/E ratio",
      ],
      correctIndex: 1,
      explanation: "Entry price and stop loss. Those are the only two numbers that matter before you enter. Everything else is secondary.",
    },
  },

  // ─── EMBER ────────────────────────────────────────────────
  {
    id: 'ember-1',
    stage: 'Ember',
    order: 4,
    title: 'Volume tells you who\'s serious',
    subtitle: 'Why price moves without volume mean nothing',
    duration: '3 min',
    icon: '📊',
    requiresLesson: 'spark-behavior',
    content: [
      "Price tells you what happened. Volume tells you how many people agreed. A stock that jumps 10% on normal volume is interesting. A stock that jumps 10% on 5x its average volume is significant — institutions, funds, and large traders are involved. That move is more likely to continue.",
      "Volume is especially important for the small-cap stocks in your price range. These stocks can be moved by relatively small amounts of money, which means low-volume price spikes are often just noise — a few retail traders getting excited. High-volume moves reflect real interest.",
      "The Invest council always shows you volume ratio — today's volume divided by the 20-day average. A ratio above 2.0 means this stock is seeing double its normal activity. Above 3.0 is significant. That's the kind of move worth paying attention to.",
    ],
    callout: {
      label: 'Volume signals in practice',
      text: "Stock up 8%, volume 1.1× average → Weak move, likely to fade\nStock up 8%, volume 2.5× average → Real buyers, more conviction\nStock up 8%, volume 5× average → Institutional interest, news catalyst likely\n\nAlways check volume before interpreting a price move.",
    },
    tip: "Falling price on low volume is less bearish than falling price on high volume. High-volume selloffs mean real sellers. Low-volume drops can just be the absence of buyers — a different problem entirely.",
    quiz: {
      question: "A stock you're watching drops 12% today. Volume is 0.6× its 20-day average. What does this suggest?",
      options: [
        "This is a strong sell signal — get out immediately",
        "The drop is on low volume, suggesting weak selling pressure — could be a shakeout rather than real distribution",
        "Volume doesn't matter when the price move is this large",
        "You should buy more since it's down 12%",
      ],
      correctIndex: 1,
      explanation: "Low-volume drops are less reliable signals than high-volume drops. 0.6× average volume means fewer participants than usual are selling. That could be a temporary shakeout, not real institutional distribution. It doesn't mean buy — it means don't panic out based on price alone.",
    },
  },

  {
    id: 'ember-2',
    stage: 'Ember',
    order: 5,
    title: 'Support and resistance — where price remembers',
    subtitle: 'Why certain price levels matter more than others',
    duration: '3 min',
    icon: '📈',
    requiresLesson: 'ember-1',
    content: [
      "Support is a price level where buyers have historically stepped in. Resistance is a price level where sellers have historically appeared. These levels matter because markets have memory — traders who bought at $3.00 before and watched it fall to $2.00 will often sell when it gets back to $3.00, just to break even. That selling pressure creates resistance.",
      "For your trades, support and resistance serve two purposes. First, they help you find entries — buying near support gives you a natural stop just below it. If the stock breaks support, the thesis is wrong. Second, they help you set targets — resistance is where you expect selling pressure, so it's a natural place to take profits.",
      "The council shows you calculated support and resistance levels for every stock it analyzes. These aren't random — they're derived from recent price structure. Price that has bounced from $1.80 twice in the last month has established $1.80 as support. Respect those levels.",
    ],
    callout: {
      label: 'Entry and exit using S/R',
      text: "Good entry: Near support, stop just below it\nGood target: Just below resistance (where sellers appear)\nBad entry: Chasing a stock that just broke above resistance\nBad exit: Selling before it reaches resistance because you're nervous",
    },
    tip: "Once resistance is broken convincingly, it often becomes support. A stock that breaks above $3.00 with high volume and holds there — that $3.00 level is now support. This is one of the most reliable patterns in technical trading.",
    quiz: {
      question: "A stock has bounced off $2.20 three times in the past month. You're considering buying at $2.35. Where should your stop loss be?",
      options: [
        "At $2.00 — a round number below your entry",
        "At $2.15 — just below the established $2.20 support level",
        "At $1.80 — giving it plenty of room",
        "No stop needed since support is clearly established",
      ],
      correctIndex: 1,
      explanation: "Just below the established support level. If $2.20 has held three times, a break below it means the support has failed and the thesis is wrong. $2.15 gets you out before a bigger drop while the support level itself is your risk trigger.",
    },
  },

  {
    id: 'ember-behavior',
    stage: 'Ember',
    order: 6,
    title: 'Close your first trade',
    subtitle: 'Completing the full cycle — entry and exit',
    duration: '—',
    icon: '🔒',
    requiresLesson: 'ember-2',
    requiresBehavior: 'first_close',
    content: [
      "You've learned position sizing, stops, volume, and support/resistance. Now apply it — close a trade. Win or lose, completing the full cycle of entry and exit is a different experience than just buying. You'll feel what it's like to make a decision under pressure.",
    ],
    quiz: {
      question: "Your trade hit your target and you closed it for a 35% gain. The stock keeps rising after you sell. What's the right mindset?",
      options: [
        "Frustration — you left money on the table",
        "You executed your plan correctly. Selling at your target is the goal, not selling at the top",
        "Next time you should hold longer",
        "You should have set a higher target",
      ],
      correctIndex: 1,
      explanation: "No one sells at the exact top. If you set a target, the stock reached it, and you took profits — that's a successful trade by definition. The discipline of executing your plan is more valuable than squeezing out extra gains by second-guessing yourself.",
    },
  },

  // ─── FLAME ────────────────────────────────────────────────
  {
    id: 'flame-1',
    stage: 'Flame',
    order: 7,
    title: 'The entry zone — stop chasing moves',
    subtitle: 'Why buying at the right price changes everything',
    duration: '4 min',
    icon: '⚡',
    requiresLesson: 'ember-behavior',
    content: [
      "Chasing a move is buying a stock because it's already gone up. The stock is at $3.00 and running, you jump in at $3.40 because you're afraid to miss it. Now your risk is much higher — your logical stop is back at $2.80 or $2.90 where the move started, which means you're already risking 15% the moment you enter.",
      "The entry zone is the price range where the risk/reward makes sense. For a breakout setup, that's just above the breakout level before it runs too far. For an oversold bounce, it's near the support level where it's likely to turn. Getting the entry right means your stop is close and your target is far — the opposite of chasing.",
      "Patience is the skill here. Most traders see a setup, watch it develop, then buy too late because they convinced themselves it was still valid at a worse price. A good setup that you missed is just a missed trade. A bad entry on a good setup turns into a loss.",
    ],
    callout: {
      label: 'Entry zone vs chasing',
      text: "Good entry: Stock breaks $2.50 resistance, you buy at $2.55. Stop at $2.35. Target $3.20. Risk: 8%. Reward: 25%.\n\nChasing: Same setup, you buy at $2.90 after watching it run. Stop still at $2.35. Risk: 19%. Reward: 10%.\n\nSame stock. Completely different trade.",
    },
    tip: "If you miss the entry zone, let it go. Set an alert for a pullback to a better level and wait. There will always be another setup. There won't always be capital to take it if you've been grinding down from bad entries.",
    quiz: {
      question: "A stock breaks above resistance at $4.00 with high volume. By the time you see it, it's at $4.60. The council's target is $5.20. Should you enter?",
      options: [
        "Yes — momentum is strong and the target is still higher",
        "Yes — high volume confirms the move",
        "No — the entry zone was near $4.00. At $4.60 the risk/reward has deteriorated significantly",
        "Yes, but use a very tight stop",
      ],
      correctIndex: 2,
      explanation: "At $4.60, your logical stop is back near $3.80–$4.00 where the breakout started — a 14% risk. The target at $5.20 is only 13% away. You'd be risking more than you stand to gain. The trade had merit at $4.00–$4.15. At $4.60, it doesn't.",
    },
  },

  {
    id: 'flame-2',
    stage: 'Flame',
    order: 8,
    title: 'Taking profits — the hardest part',
    subtitle: 'Why most traders give back their gains',
    duration: '3 min',
    icon: '💰',
    requiresLesson: 'flame-1',
    content: [
      "Greed is structured into human psychology in a way that specifically sabotages trading. Studies show people feel the pain of a loss twice as intensely as the pleasure of an equivalent gain. This means that once you're up 30%, you'll do almost anything to avoid giving it back — including holding through a reversal until you're only up 5% and then selling in a panic.",
      "The solution is mechanical profit-taking. Set a target before you enter — based on the next resistance level, a percentage gain, or a time limit — and take profits when it's hit. Not when you feel like it. Not when you think it might go higher. When your plan says.",
      "Scaling out is the professional approach: sell a third when you're up 20%, another third at 40%, let the last third run with a trailed stop. This way you lock in real gains while staying in the trade if it keeps moving. You'll never sell the top, but you'll consistently capture meaningful portions of moves.",
    ],
    callout: {
      label: 'The scaling out approach',
      text: "Entry: $2.00 (100 shares = $200)\nAt $2.40 (+20%): Sell 33 shares → lock in $13.20\nAt $2.80 (+40%): Sell 33 shares → lock in $26.40\nRemainder: Trail stop up — let it run\n\nYou've locked in $39.60 no matter what happens to the last 34 shares.",
    },
    tip: "The feeling that a stock 'still has room' is not a trading strategy. Your target level is your target level. The market doesn't care that you want more. Take the profit, find the next setup.",
    quiz: {
      question: "You bought at $1.80. Your target was $2.50. The stock hits $2.50 but feels strong — volume is high and momentum is good. What do you do?",
      options: [
        "Hold everything — the setup looks great",
        "Take at least partial profits at your target. If you want to stay in, sell half and trail a stop on the rest",
        "Move your target to $3.50 and hold",
        "Sell immediately regardless of how it looks",
      ],
      correctIndex: 1,
      explanation: "Your plan said $2.50. Honor it, at least partially. Taking half off locks in a real gain. Keeping half with a trailing stop means you participate if it continues without risking your entire profit. This is the professional approach — not all-or-nothing.",
    },
  },

  {
    id: 'flame-behavior',
    stage: 'Flame',
    order: 9,
    title: 'Complete 3 trades',
    subtitle: 'Building the habit of the full cycle',
    duration: '—',
    icon: '🔥🔥',
    requiresLesson: 'flame-2',
    requiresBehavior: 'three_trades',
    content: [
      "Three complete trades — entry and exit — gives you enough data to start seeing your own patterns. Where are you entering too late? Are you holding losers too long? Are you selling winners too early? Three trades is when the self-awareness starts.",
    ],
    quiz: {
      question: "After 3 trades, you notice you've sold every winner before it hit your target. What does this likely indicate?",
      options: [
        "Your targets are too high",
        "You're letting fear of giving back gains override your plan — a psychological pattern to consciously correct",
        "The market is too volatile for your targets",
        "You have good instincts for taking profits",
      ],
      correctIndex: 1,
      explanation: "Early exits on winners is one of the most common psychological patterns in trading. It feels like protecting gains but it's actually fear overriding your plan. Recognizing the pattern is the first step to correcting it — stick to mechanical targets.",
    },
  },

  // ─── BLAZE ────────────────────────────────────────────────
  {
    id: 'blaze-1',
    stage: 'Blaze',
    order: 10,
    title: 'Risk/reward — why a 40% win rate can be profitable',
    subtitle: 'The math that separates traders from gamblers',
    duration: '4 min',
    icon: '📐',
    requiresLesson: 'flame-behavior',
    content: [
      "Most people think you need to win more than half your trades to be profitable. That's wrong. What matters is the ratio between your average win and your average loss. If you win $300 on average and lose $100 on average, you can lose 70% of your trades and still be profitable.",
      "A 2:1 risk/reward ratio means your target is twice as far from your entry as your stop. Win half your trades on a 2:1 ratio and you're profitable. Win 40% and you're still breaking even. Win 60% and you're doing very well. This is why the council always shows you entry, stop, and target — so you can calculate the ratio before you enter.",
      "The discipline required is to only take trades where the risk/reward is in your favor. A stock that could go up 10% but could also fall 15% is a bad risk/reward trade regardless of how confident you feel. Confidence is not the same as favorable odds.",
    ],
    callout: {
      label: 'Risk/reward math',
      text: "2:1 ratio, 50% win rate:\n10 trades × 50% = 5 wins × $200 = $1,000\n10 trades × 50% = 5 losses × $100 = -$500\nNet: +$500\n\n2:1 ratio, 40% win rate:\n10 trades × 40% = 4 wins × $200 = $800\n10 trades × 60% = 6 losses × $100 = -$600\nNet: +$200 — still profitable",
    },
    tip: "Before entering any trade, calculate the ratio. Entry $2.00, stop $1.75, target $2.60. Risk = $0.25, reward = $0.60. Ratio = 2.4:1. That's a trade worth taking. Entry $2.00, stop $1.75, target $2.30. Risk = $0.25, reward = $0.30. Ratio = 1.2:1. Skip it.",
    quiz: {
      question: "You have a setup with entry at $5.00, stop at $4.50, and target at $6.00. What is your risk/reward ratio?",
      options: [
        "1:1 — equal risk and reward",
        "1:2 — risking $0.50 to make $1.00",
        "2:1 — risking $1.00 to make $0.50",
        "3:1 — risking $0.33 to make $1.00",
      ],
      correctIndex: 1,
      explanation: "Risk = $5.00 - $4.50 = $0.50. Reward = $6.00 - $5.00 = $1.00. Ratio = 1:2 (risking 1 to make 2). This is expressed as 2:1 in favor — a solid trade to take.",
    },
  },

  {
    id: 'blaze-2',
    stage: 'Blaze',
    order: 11,
    title: 'Trading with the sector — not against it',
    subtitle: 'Why individual stocks rarely escape their sector\'s tide',
    duration: '3 min',
    icon: '🌊',
    requiresLesson: 'blaze-1',
    content: [
      "Individual stocks are highly correlated to their sector. When energy stocks are selling off, even a fundamentally strong energy company will feel that pressure. You can have the right stock and still lose money because you had the wrong sector. This is one of the most avoidable mistakes in trading.",
      "The practical rule: when a sector is BEARISH on the macro dashboard, require a much stronger individual catalyst before entering a stock in that sector. You're swimming against the current — it's possible, but it takes more energy and the odds are worse.",
      "Conversely, when a sector is BULLISH, even mediocre setups in that sector can work because institutional flows are lifting the whole space. The best trades are when you have a strong individual setup AND a strong sector. Both tailwinds together is when conviction is highest.",
    ],
    callout: {
      label: 'Sector alignment checklist',
      text: "Before entering any trade:\n① What sector is this stock in?\n② What is the sector signal on the macro dashboard?\n③ BULLISH sector + strong setup = high conviction\n④ NEUTRAL sector + strong setup = normal sizing\n⑤ BEARISH sector + strong setup = half size or skip",
    },
    tip: "Check the macro dashboard before the market open every day you're actively trading. 2 minutes of sector awareness saves you from entering trades into headwinds you could have avoided.",
    quiz: {
      question: "Healthcare sector is BEARISH on the macro dashboard. You find a healthcare stock with a strong technical breakout setup. What should you do?",
      options: [
        "Avoid the trade entirely — sector signal overrules individual setups",
        "Take the trade with full size — a strong setup is a strong setup",
        "Take the trade at half size or wait for the sector signal to improve",
        "Sector signals only matter for large-cap stocks",
      ],
      correctIndex: 2,
      explanation: "A strong individual setup in a bearish sector is a mixed signal trade. Half size acknowledges the setup is real while respecting that the sector headwind adds risk. Or you wait — there are always other setups in sectors that aren't fighting you.",
    },
  },

  // ─── INFERNO ──────────────────────────────────────────────
  {
    id: 'inferno-1',
    stage: 'Inferno',
    order: 12,
    title: 'Portfolio heat — how much should ever be at risk',
    subtitle: 'Managing total exposure, not just individual trades',
    duration: '4 min',
    icon: '🌡️',
    requiresLesson: 'blaze-2',
    content: [
      "At the Inferno stage you have meaningful capital. Individual position sizing is no longer enough — you need to think about total portfolio heat, which is the sum of all the risk you're carrying across all open positions simultaneously.",
      "Professional traders cap their total portfolio heat at 6–12% at any given time. If you have 6 positions, each risking 2% of your portfolio to their stop, your total heat is 12%. That means the worst-case scenario — every trade hits its stop simultaneously — costs you 12% of your portfolio. A bad week, but survivable.",
      "When total heat gets above 15–20%, a correlated market selloff can devastate a portfolio quickly. Stocks in the same sector or same risk category often fall together. Your 8 open positions might all hit stops in the same week if the market turns. Portfolio heat is the defense against that scenario.",
    ],
    callout: {
      label: 'Calculating your portfolio heat',
      text: "Position A: Entry $50, stop $45, 20 shares. Risk = $100. Portfolio = $2,000. Heat = 5%\nPosition B: Entry $30, stop $27, 15 shares. Risk = $45. Heat = 2.25%\nPosition C: Entry $80, stop $72, 10 shares. Risk = $80. Heat = 4%\n\nTotal heat = 11.25% — within the 12% professional limit",
    },
    tip: "When you add a new position, calculate what your total heat becomes. If a single trade would push you above 12%, size down or wait for an existing position to close first. Portfolio construction is as important as individual trade selection.",
    quiz: {
      question: "You have a $3,000 portfolio and 4 open trades each risking $90 to their stop. A great new setup appears. What should you consider before entering?",
      options: [
        "Enter at full size — a great setup shouldn't be missed",
        "Your current heat is 12% ($360/$3,000). Adding another $90 risk brings it to 15% — consider sizing down or waiting",
        "Close one of the existing trades first to make room",
        "Total heat only matters for portfolios over $10,000",
      ],
      correctIndex: 1,
      explanation: "4 × $90 = $360 risk / $3,000 = 12% heat — already at the professional limit. Adding another full position brings you to 15%. Either size down the new trade to keep total heat at 12%, or wait for an existing position to close. Never let excitement about a new setup override portfolio risk management.",
    },
  },

  {
    id: 'inferno-2',
    stage: 'Inferno',
    order: 13,
    title: 'The psychology of a losing streak',
    subtitle: 'How to stay disciplined when nothing is working',
    duration: '4 min',
    icon: '🧠',
    requiresLesson: 'inferno-1',
    content: [
      "Losing streaks happen to every trader — professional and amateur alike. The difference between traders who survive them and traders who blow up is entirely psychological. The wrong responses to a losing streak are: revenge trading (larger positions to recover losses faster), abandoning your strategy (it's broken, time to try something else), or stopping completely out of discouragement.",
      "The right response is counterintuitive: size down, not up. When you're losing, your judgment is compromised by emotion even if you don't feel it. Cutting position sizes in half during a losing streak means your mistakes cost less while you work out what's going wrong. You preserve capital. You stay in the game.",
      "Losing streaks also have causes worth examining. Are you entering too late? Are you using stops that are too tight for the volatility? Is the market regime wrong for your strategy — are you trading momentum setups in a choppy, low-conviction market? A losing streak is data, not a verdict on whether you should be trading.",
    ],
    callout: {
      label: 'Losing streak protocol',
      text: "3 consecutive losses → cut position size in half\nReview: Am I entering at the right level? Are my stops appropriate?\nDo not increase size until you have 2 consecutive wins at reduced size\nNever 'revenge trade' — larger size to recover faster always makes it worse",
    },
    tip: "The best traders in the world have losing months. What separates them is that a bad month costs them 5% of their portfolio, not 40%. Drawdown management is the skill that determines long-term survival. Everything else — setups, entries, exits — is secondary to this.",
    quiz: {
      question: "You've lost 4 trades in a row. You're down 8% for the month. You see what looks like a perfect setup. What's the right move?",
      options: [
        "Take the trade at double your normal size to recover faster",
        "Skip the trade — you're on a losing streak so your judgment can't be trusted",
        "Take the trade at half your normal size. Stay disciplined on the entry and stop",
        "Take a break from trading for at least 2 weeks",
      ],
      correctIndex: 2,
      explanation: "Half size keeps you active and learning while limiting damage if you're wrong. Double size to recover is revenge trading — statistically the single worst response to a losing streak. Stopping completely means you miss setups and lose momentum. Half size, disciplined execution, and reviewing what's going wrong is the professional response.",
    },
  },
]

// Helper — get lessons available for a given stage and completed lesson IDs + behaviors
export function getAvailableLessons(
  currentStage: string,
  completedLessonIds: Set<string>,
  tradeCount: number,
  hasClosedTrade: boolean,
) {
  const STAGE_ORDER = ['Spark', 'Ember', 'Flame', 'Blaze', 'Inferno', 'Free']
  const stageIdx = STAGE_ORDER.indexOf(currentStage)

  return INVEST_LESSONS.map(lesson => {
    const lessonStageIdx = STAGE_ORDER.indexOf(lesson.stage)
    const completed = completedLessonIds.has(lesson.id)

    // Stage lock — must be at or past the lesson's stage
    if (lessonStageIdx > stageIdx) {
      return { ...lesson, locked: true, lockReason: `Reach ${lesson.stage} to unlock` }
    }

    // Lesson prerequisite
    if (lesson.requiresLesson && !completedLessonIds.has(lesson.requiresLesson)) {
      const prereq = INVEST_LESSONS.find(l => l.id === lesson.requiresLesson)
      return { ...lesson, locked: true, lockReason: `Complete "${prereq?.title}" first` }
    }

    // Behavioral prerequisite
    if (lesson.requiresBehavior) {
      if (lesson.requiresBehavior === 'first_trade' && tradeCount === 0) {
        return { ...lesson, locked: true, lockReason: 'Log your first trade to unlock' }
      }
      if (lesson.requiresBehavior === 'first_close' && !hasClosedTrade) {
        return { ...lesson, locked: true, lockReason: 'Close a trade to unlock' }
      }
      if (lesson.requiresBehavior === 'three_trades' && tradeCount < 3) {
        return { ...lesson, locked: true, lockReason: `Complete ${3 - tradeCount} more trade${3 - tradeCount !== 1 ? 's' : ''} to unlock` }
      }
    }

    return { ...lesson, locked: false, lockReason: null }
  })
}

export type LessonWithStatus = ReturnType<typeof getAvailableLessons>[0]
