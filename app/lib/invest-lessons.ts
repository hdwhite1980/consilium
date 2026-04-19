// ─────────────────────────────────────────────────────────────
// Invest Journey — Tier-Gated Desk Notes
//
// BACKWARDS COMPAT: All existing fields remain. Old viewers still
// render the legacy `content` + `callout` + `tip`. The new Desk
// Notes viewer reads `blocks` when present.
//
// NAMING: The interface key is still `stage` for DB compatibility
// with invest_lesson_progress. Values are now tier names:
// 'Buyer' | 'Builder' | 'Operator' | 'Principal' | 'Sovereign'.
// ─────────────────────────────────────────────────────────────

export type LockType = 'tier' | 'behavioral' | 'lesson'

export interface LessonQuiz {
  question: string
  options: string[]
  correctIndex: number
  explanation: string
}

export type LessonBlock =
  | { type: 'prose'; text: string }
  | { type: 'heading'; text: string }
  | { type: 'callout'; label: string; text: string; tone?: 'gold' | 'red' | 'green' }
  | { type: 'tip'; text: string }
  | { type: 'warning'; text: string }
  | { type: 'demo'; demo: DemoKind; caption?: string }
  | { type: 'pullquote'; text: string }

export type DemoKind =
  | { kind: 'position-sizer'; balance?: number; maxPct?: number }
  | { kind: 'loss-recovery' }
  | { kind: 'stop-ladder'; entry: number; atr: number }
  | { kind: 'risk-reward-tilt' }
  | { kind: 'options-payoff'; underlying?: number; strike?: number; premium?: number; optionType?: 'call' | 'put' }
  | { kind: 'options-decay'; dte?: number; premium?: number }

export type Tier = 'Buyer' | 'Builder' | 'Operator' | 'Principal' | 'Sovereign'

export interface InvestLesson {
  id: string
  stage: Tier  // DB key is "stage" for compatibility; value is a Tier
  order: number
  title: string
  subtitle: string
  duration: string
  icon: string
  requiresLesson?: string
  requiresBehavior?: 'first_trade' | 'first_close' | 'three_trades'
  content: string[]
  callout?: { label: string; text: string }
  tip?: string
  blocks?: LessonBlock[]
  triggerOn?: LessonTrigger[]
  quiz: LessonQuiz
}

export type LessonTrigger =
  | 'first_open_page'
  | 'first_trade_opened'
  | 'first_trade_closed'
  | 'first_loss'
  | 'first_win'
  | 'three_losses_in_row'
  | 'tier_up'

// ─────────────────────────────────────────────────────────────
// THE DESK NOTES
// ─────────────────────────────────────────────────────────────
export const INVEST_LESSONS: InvestLesson[] = [

  // ─── BUYER ($1–$50) ──────────────────────────────────────
  {
    id: 'buyer-1',
    stage: 'Buyer',
    order: 1,
    title: 'Position sizing is the discipline that keeps you solvent',
    subtitle: 'The single habit that separates professionals from gamblers',
    duration: '3 min',
    icon: '§',
    triggerOn: ['first_open_page'],
    content: [
      "Most retail traders do not blow up their accounts because they pick bad names. They blow up because they bet too much on each one.",
      "The professional rule is simple: never risk more than two to five percent of total capital on a single trade.",
      "Small positions let you make mistakes cheaply. You will make mistakes. Everyone does.",
    ],
    blocks: [
      { type: 'prose', text: "Retail accounts do not fail because traders pick the wrong names. They fail because positions were too large when the trader was wrong." },
      { type: 'prose', text: "The math is unforgiving. Drag the slider below to see it directly." },
      { type: 'demo', demo: { kind: 'loss-recovery' }, caption: 'The recovery curve — why limiting loss size matters' },
      { type: 'pullquote', text: "A fifty percent loss requires a one hundred percent gain to break even." },
      { type: 'heading', text: "The two-to-five rule" },
      { type: 'prose', text: "Never risk more than two to five percent of total capital on any single trade. At small account sizes this feels tiny. That is the point — it keeps you in the game long enough to develop an edge." },
      { type: 'demo', demo: { kind: 'position-sizer', maxPct: 20 }, caption: 'Position size calculated against your actual balance' },
      { type: 'callout', tone: 'gold', label: 'The math of loss', text: "Lose 10% → need 11% to recover\nLose 25% → need 33% to recover\nLose 50% → need 100% to recover\nLose 75% → need 300% to recover" },
      { type: 'tip', text: "At Buyer tier, the goal is not to compound quickly — it is to learn with real stakes while preserving optionality. Every small trade here is practice with weight." },
    ],
    callout: {
      label: 'The math of loss',
      text: "Lose 10% → need 11% to recover\nLose 25% → need 33% to recover\nLose 50% → need 100% to recover\nLose 75% → need 300% to recover",
    },
    tip: "At Buyer tier, the goal is not to compound quickly — it is to learn with real stakes while preserving capital.",
    quiz: {
      question: "You have $50 and you are considering putting $40 of it into one position. What is the main problem?",
      options: [
        "The position might not be liquid enough for that size",
        "A single bad outcome could take 30–50% of your entire capital — and recovering from that is mathematically much harder than avoiding it",
        "You should diversify by putting $40 into several positions instead",
        "Nothing — at $50 total you need concentration to make meaningful gains",
      ],
      correctIndex: 1,
      explanation: "The core issue is risk concentration. If that position drops 50%, you've lost $20 — 40% of your entire capital. To recover, the remaining $30 needs to grow 67% just to get back to $50. Position sizing is the difference between surviving a losing trade and being crippled by one.",
    },
  },

  {
    id: 'buyer-2',
    stage: 'Buyer',
    order: 2,
    title: 'Stops before targets',
    subtitle: 'Why planning the exit matters more than planning the entry',
    duration: '3 min',
    icon: '⊥',
    requiresLesson: 'buyer-1',
    triggerOn: ['first_trade_opened'],
    content: [
      "Before you buy, know where you exit if you are wrong. That price is your stop.",
      "A stop protects you from your own psychology. Without a pre-planned stop, you will talk yourself into holding a losing position.",
      "Stops should be based on the chart, not on how much you are comfortable losing.",
    ],
    blocks: [
      { type: 'prose', text: "You just opened your first position. The question that matters more than anything else you will think about: where do you exit if you are wrong?" },
      { type: 'heading', text: "The stop is the plan" },
      { type: 'prose', text: "A stop-loss is not pessimism. It is the line you drew before the market could make you emotional. Without it, you will find reasons to hold a losing position until it is down forty percent." },
      { type: 'demo', demo: { kind: 'stop-ladder', entry: 5.00, atr: 0.25 }, caption: 'How ATR scales the stop — drag to explore' },
      { type: 'pullquote', text: "The stop matches the chart, not your comfort." },
      { type: 'prose', text: "A good stop sits where the setup is invalidated — below support, below the breakout level, below the moving average that held on the bounce. Not 'wherever I feel comfortable losing.'" },
      { type: 'callout', tone: 'red', label: 'The stop you do not set', text: "No stop → a 10% loss becomes 25%\nNo stop → a 25% loss becomes 50%\nNo stop → the position ends the account" },
      { type: 'tip', text: "Write the stop down before you click buy. Say it out loud. When price reaches it, honor it. That discipline is the entire game." },
    ],
    callout: {
      label: 'ATR-based stops',
      text: "A stop placed 2× ATR below entry adapts to the instrument's normal volatility. Tight instruments get tight stops. Volatile ones get wider stops. Same math, different prices.",
    },
    tip: "Your stop is non-negotiable. When price reaches it, you exit — no 'one more candle,' no hope.",
    quiz: {
      question: "You bought at $3.00 with a stop at $2.70 (10% down). Price drops to $2.72 and bounces. You held. It then drops to $2.65 and keeps going. What should you do?",
      options: [
        "Wait for a bounce to at least $2.80 before selling",
        "Sell at $2.65. You should have sold at $2.70 per your plan — now exit immediately and take the lesson",
        "Add more shares at $2.65 to lower your average cost",
        "Move your stop down to $2.50 to give it more room",
      ],
      correctIndex: 1,
      explanation: "The stop was broken at $2.70. Once broken, the plan has failed — every moment held beyond that is hope, not strategy. Adding to a loser or lowering stops are the two behaviors that turn losing trades into account-ending ones. Exit, take the lesson, find the next setup.",
    },
  },

  {
    id: 'buyer-loss',
    stage: 'Buyer',
    order: 3,
    title: 'The first loss is tuition',
    subtitle: "You just paid it. Here is what it is actually worth.",
    duration: '3 min',
    icon: '◊',
    requiresBehavior: 'first_close',
    triggerOn: ['first_loss'],
    content: [
      "A loss is not a failure. It is the market charging tuition for what you are about to learn.",
      "The only real losses are the ones you take no lessons from.",
      "What matters is the pattern across many trades — not the outcome of any single one.",
    ],
    blocks: [
      { type: 'prose', text: "You just took your first loss. Welcome to being a trader — this is the cost of admission." },
      { type: 'heading', text: "Losses are not failures" },
      { type: 'prose', text: "Every professional trader loses — often. Top-decile hedge fund managers are wrong forty-five percent of the time. Taking a loss means you are doing the thing. Never losing means you are not doing the thing." },
      { type: 'pullquote', text: "The only losses that cost you nothing are the ones you learn from." },
      { type: 'prose', text: "Right now, the instinct is to revenge-trade. To get it back quickly. That instinct has ended more accounts than any market crash. The professional response is to half-size the next trade, not double it." },
      { type: 'callout', tone: 'red', label: 'What NOT to do after a loss', text: "1. Double the size on your next trade\n2. Switch to a totally different strategy\n3. Stop following your stop-loss plan\n4. Rage-buy the first thing that moves" },
      { type: 'prose', text: "What matters now is the pattern across the next ten trades, not this one." },
      { type: 'tip', text: "Write in the journal: what went wrong? Was the entry poor, the stop too tight, did you break your own rules? A trade that taught you something was not a loss — it was tuition." },
    ],
    callout: {
      label: 'What matters',
      text: "Your emotional response to this loss is more important than the dollar amount.\n\nBreathe. Journal the trade. Keep your next position the same size. The discipline survives the trade.",
    },
    tip: "The trade is already gone. The lesson is what stays. Small size means the lesson is cheap.",
    quiz: {
      question: "You just closed your first losing trade for -12%. What is the correct next move?",
      options: [
        "Double size on your next trade to recover quickly",
        "Take a small note on what went wrong, then make your next trade the same normal size",
        "Stop trading for a month to reset",
        "Switch to a different strategy that would have avoided this loss",
      ],
      correctIndex: 1,
      explanation: "Same size, disciplined execution, eyes on the pattern. Revenge-sizing is the single most account-destroying behavior in trading. A month off breaks your learning loop. A strategy switch after one trade is overfitting to noise. The answer is always: same size, better execution, journal the lesson.",
    },
  },

  {
    id: 'buyer-behavior',
    stage: 'Buyer',
    order: 4,
    title: 'Complete your first trade cycle',
    subtitle: 'Nothing replaces executing one all the way through',
    duration: '—',
    icon: '∮',
    requiresLesson: 'buyer-2',
    requiresBehavior: 'first_trade',
    content: [
      "Reading about trading and actually doing it are different skills. Until you have logged a trade, felt the price move against you, and stayed with your plan — you are still theoretical.",
    ],
    quiz: {
      question: "You logged your first trade and it is down 3% an hour later. What does this tell you?",
      options: [
        "The trade is a loser and you should exit",
        "Normal intraday noise — the instrument will be volatile and that is expected",
        "Your stop is too far away",
        "You picked the wrong instrument",
      ],
      correctIndex: 1,
      explanation: "Small intraday moves mean almost nothing. Small-caps can easily swing 3–5% in a single hour without violating any setup. Your plan is your plan — stop out only if price hits your stop, otherwise let the setup develop.",
    },
  },

  // ─── BUILDER ($50–$200) ──────────────────────────────────
  {
    id: 'builder-1',
    stage: 'Builder',
    order: 5,
    title: 'Win rate is a distraction',
    subtitle: 'Risk-to-reward determines profitability — not how often you are right',
    duration: '4 min',
    icon: '△',
    requiresLesson: 'buyer-behavior',
    triggerOn: ['tier_up'],
    content: [
      "Most retail traders obsess over win rate. Professionals obsess over risk-to-reward.",
      "You can win 40% of your trades and still be profitable if your winners are 3× your losers.",
      "A 70% win rate with tiny winners and large losers is an account-destroyer.",
    ],
    blocks: [
      { type: 'prose', text: "You crossed into Builder. Time for the mental shift that separates retail from professional." },
      { type: 'heading', text: "The hidden variable" },
      { type: 'prose', text: "Everyone wants a high win rate. It feels good. But win rate alone tells you nothing about profitability." },
      { type: 'demo', demo: { kind: 'risk-reward-tilt' }, caption: 'Profitability = win rate × R:R — find the sweet spot' },
      { type: 'pullquote', text: "You can be wrong sixty percent of the time and still be rich." },
      { type: 'prose', text: "Top-decile traders have win rates in the 40–55% range. Their edge is that their winners are multiples of their losers. A 2:1 risk-reward ratio breaks even at a 33% win rate." },
      { type: 'callout', tone: 'gold', label: 'Break-even win rates', text: "1:1 R:R → need 50% win rate\n2:1 R:R → need 34% win rate\n3:1 R:R → need 25% win rate\n5:1 R:R → need 17% win rate" },
      { type: 'tip', text: "Optimize for setups where the target is at least 2× the distance to your stop. Pass on 1:1 setups. You do not need to trade every day." },
    ],
    callout: {
      label: 'The break-even math',
      text: "Win 50% at 1:1 R:R → break-even\nWin 40% at 2:1 R:R → +20% edge\nWin 30% at 3:1 R:R → +20% edge\n\nWin rate alone tells you nothing.",
    },
    tip: "When evaluating a setup, ask: 'Is my target at least 2× as far from entry as my stop?' If no, pass.",
    quiz: {
      question: "You have two strategies. A wins 70% of the time at 1:1 R:R. B wins 40% at 3:1 R:R. Which is more profitable over 100 trades?",
      options: [
        "A — higher win rate is always better",
        "B — winning 40% at 3:1 creates a larger total edge than winning 70% at 1:1",
        "They're the same — 70 and 40 × 3 are both positive-expectancy",
        "Depends on which instruments you're trading",
      ],
      correctIndex: 1,
      explanation: "Strategy A: 70 wins × 1 unit − 30 losses × 1 unit = +40 units. Strategy B: 40 wins × 3 units − 60 losses × 1 unit = +60 units. B wins by 50%. This is why professional traders accept being wrong often — the edge is the size of wins, not the frequency.",
    },
  },

  {
    id: 'builder-behavior',
    stage: 'Builder',
    order: 6,
    title: 'Close a winning trade',
    subtitle: 'Experience a full profitable cycle end-to-end',
    duration: '—',
    icon: '◎',
    requiresLesson: 'builder-1',
    requiresBehavior: 'first_close',
    triggerOn: ['first_win'],
    content: [
      "Feel what it is like to execute the plan end-to-end. The entry, the wait, the exit at your target. Repeatable.",
    ],
    quiz: {
      question: "Your trade hit your target and you closed it for a 35% gain. The instrument keeps rising. What is the correct mindset?",
      options: [
        "Frustration — you left money on the table",
        "You executed your plan correctly. Selling at your target is the goal, not selling at the top",
        "Next time you should hold longer",
        "You should have set a higher target",
      ],
      correctIndex: 1,
      explanation: "No one sells at the exact top. If you set a target, the instrument reached it, and you took profits — that's a successful trade by definition. Discipline over greed.",
    },
  },

  // ─── OPERATOR ($200–$1K) ─────────────────────────────────
  {
    id: 'operator-1',
    stage: 'Operator',
    order: 7,
    title: 'The entry zone — stop chasing moves',
    subtitle: 'Why buying at the right price changes everything',
    duration: '4 min',
    icon: '◇',
    requiresLesson: 'builder-behavior',
    triggerOn: ['tier_up'],
    content: [
      "Chasing a move is buying because it has already gone up.",
      "The entry zone is the price range where the risk/reward math makes sense.",
      "Patience is the skill.",
    ],
    callout: {
      label: 'Entry zone vs chasing',
      text: "Good entry: Breaks $2.50, buy at $2.55. Stop $2.35. Target $3.20. Risk 8%, Reward 25%.\n\nChasing: Same setup, buy at $2.90. Stop still $2.35. Risk 19%, Reward 10%.",
    },
    tip: "If you miss the entry zone, let it go. Set an alert for a pullback and wait.",
    quiz: {
      question: "An instrument breaks $4.00 with high volume. By the time you see it, it's at $4.60. The council's target is $5.20. Should you enter?",
      options: [
        "Yes — the target is still above current price",
        "No — risk-to-reward is now unfavorable; wait for a pullback to the breakout zone",
        "Yes, but with a tighter stop",
        "Yes, but with half size",
      ],
      correctIndex: 1,
      explanation: "At $4.60, your stop must still be below the breakout at around $3.80 (19% risk). Your target is $5.20 (13% reward). That's 1:0.7 R:R — worse than a coin flip. The discipline is to let the trade go and wait for a pullback that resets the R:R to favorable.",
    },
  },

  {
    id: 'operator-2',
    stage: 'Operator',
    order: 8,
    title: "Taking profits — the target is the target",
    subtitle: 'Why honoring your plan beats chasing every candle',
    duration: '3 min',
    icon: '◉',
    requiresLesson: 'operator-1',
    content: [
      "When an instrument reaches your target, sell at least a portion. The feeling that 'it still has room' is not a strategy.",
      "Take half at target, trail a stop on the rest if you want to stay in.",
    ],
    callout: {
      label: 'The professional exit',
      text: "Plan: Entry $1.80, stop $1.55, target $2.50.\n\nAt $2.50: sell half (+39%), move stop on the remainder to $2.20 (breakeven-plus). You cannot lose the trade now. Upside is free.",
    },
    tip: "The feeling that an instrument 'still has room' is not a strategy. Your target is your target.",
    quiz: {
      question: "You bought at $1.80. Your target was $2.50. It hits $2.50 but looks strong. What do you do?",
      options: [
        "Hold everything — the setup looks great",
        "Take at least partial profits at your target. If you want to stay in, sell half and trail a stop on the rest",
        "Move your target to $3.50 and hold",
        "Sell immediately",
      ],
      correctIndex: 1,
      explanation: "Plan said $2.50. Honor it. Half off locks in the gain; trailing stop on the remainder gives you free upside. All-or-nothing is gambling.",
    },
  },

  {
    id: 'operator-tilt',
    stage: 'Operator',
    order: 9,
    title: "Three losses in a row — read this now",
    subtitle: 'Recognizing the tilt pattern before it destroys your account',
    duration: '3 min',
    icon: '⚠',
    triggerOn: ['three_losses_in_row'],
    content: [
      "Three losses in a row is the most dangerous psychological moment in trading.",
      "Your brain is screaming to 'get it back.' That instinct has ended more accounts than any market crash.",
      "The correct response is counterintuitive: half-size, slow down, review.",
    ],
    blocks: [
      { type: 'prose', text: "Three consecutive losses. You are feeling it now — the pull to recover quickly. The voice saying 'I am due.'" },
      { type: 'heading', text: "This is the most dangerous moment" },
      { type: 'prose', text: "Statistically, this is where traders blow up their accounts. Not on the losses themselves — on what they do next. Revenge trading destroys more capital than any single bad trade ever could." },
      { type: 'pullquote', text: "You are not due. The market does not owe you anything." },
      { type: 'callout', tone: 'red', label: 'The tilt protocol', text: "1. No new trades for the rest of today\n2. Review your last 3 entries — is there a pattern?\n3. Half-size your next 3 trades\n4. Return to full size only after 2 winners" },
      { type: 'prose', text: "The difference between traders who survive this moment and traders who do not is the ability to do less, not more." },
      { type: 'tip', text: "If you cannot stop yourself from trading right now, at minimum cut your size in half. Your next trade should be 50% of what it would normally be. This is not optional." },
    ],
    callout: {
      label: 'The tilt protocol',
      text: "1. No new trades today\n2. Review last 3 entries\n3. Half-size next 3 trades\n4. Full size only after 2 winners",
    },
    tip: "The trader who survives this moment is the one who does less, not more.",
    quiz: {
      question: "You just took 3 losses in a row for a total of -18% on your account. What is the professional response?",
      options: [
        "Double size on your next trade to recover quickly",
        "Cut size by 50%, stay disciplined on entry and stop, resume full size only after 2 winners",
        "Stop trading for at least 2 weeks",
        "Switch strategy entirely",
      ],
      correctIndex: 1,
      explanation: "Half size keeps you active and learning while limiting damage. Doubling is revenge trading — the single worst statistical response. Stopping entirely breaks the learning loop. Strategy switching is overfitting to a small sample. Half size + disciplined execution = the professional response.",
    },
  },

  // ─── PRINCIPAL ($1K–$10K) ────────────────────────────────
  {
    id: 'principal-1',
    stage: 'Principal',
    order: 10,
    title: 'Expectancy — the only number that matters',
    subtitle: 'Making win rate, R:R, and frequency work together',
    duration: '4 min',
    icon: '∑',
    requiresLesson: 'operator-2',
    triggerOn: ['tier_up'],
    content: [
      "Expectancy = (Win% × Avg Win) − (Loss% × Avg Loss). This one number tells you if your system makes money.",
      "Positive expectancy with consistent execution is the entire game.",
    ],
    callout: {
      label: 'The formula',
      text: "E = (Win% × $Win) − (Loss% × $Loss)\n\nExample: 45% × $300 − 55% × $100 = $135 − $55 = +$80 per trade",
    },
    tip: "Track every trade. After 20 trades, calculate your expectancy. That's your actual edge, measured.",
    quiz: {
      question: "Your stats over 50 trades: 40% win rate, avg win $200, avg loss $80. What's your expectancy per trade?",
      options: [
        "+$32",
        "+$48 — you make $48 on average per trade taken",
        "−$20",
        "+$120",
      ],
      correctIndex: 1,
      explanation: "(0.40 × $200) − (0.60 × $80) = $80 − $48 = +$32 per trade. Strong positive expectancy. Over 50 trades, that's +$1,600. Over 200 trades at the same rate, +$6,400. Small positive expectancy, massive result over volume.",
    },
  },

  // ─── STOCK CURRICULUM FILL — BUYER/BUILDER/OPERATOR ────────────
  //
  // These lessons fill gaps in the existing curriculum. They sit at the
  // end of the array (any `order` value is fine — the UI sorts by tier
  // then by order). Each is tied to a real behavior or trigger so they
  // surface at the moment they become relevant.

  {
    id: 'buyer-no-trade',
    stage: 'Buyer',
    order: 3,
    title: 'When NOT to take a trade',
    subtitle: 'The skill of sitting on your hands',
    duration: '3 min',
    icon: '◯',
    requiresLesson: 'buyer-1',
    content: [
      "The hardest skill in trading is doing nothing when there is no setup.",
      "Most losses come from marginal trades taken because you were bored, not because the setup was there.",
      "A 'no trade' is a choice, and it is often the highest-expectancy choice available.",
    ],
    blocks: [
      { type: 'prose', text: "Boredom is the enemy. Most retail losses come from marginal trades taken because the market was 'flat' or 'there was nothing happening' — the trader forced action that was not there." },
      { type: 'heading', text: "The three conditions for a real setup" },
      { type: 'prose', text: "A real setup has (1) a specific catalyst or technical reason today, (2) a clear stop level, and (3) a target at least 2× the stop distance. If any of those is missing, the trade is marginal." },
      { type: 'callout', tone: 'gold', label: 'Pass checklist', text: "Is the sector bullish/bearish with the trade?\nIs the entry zone still fresh?\nIs R:R at least 2:1?\n\nIf any answer is no → pass." },
      { type: 'pullquote', text: "Cash is a position." },
      { type: 'tip', text: "Taking zero trades on a flat day is a win. Your cash is the resource that lets you take the trade tomorrow when the setup is real.", },
    ],
    callout: {
      label: 'The professional tell',
      text: "Amateurs trade every day.\nProfessionals skip 4 out of 5 sessions and make more money.\nThe setup finds you, not the other way around.",
    },
    tip: "If you find yourself forcing a reason to trade, close the app for 30 minutes. Come back when you have a real setup.",
    quiz: {
      question: "The market is flat. Sector winds are mixed. Your screener shows no high-conviction setups. What is the correct action?",
      options: [
        "Lower your conviction threshold so you can find at least one trade",
        "Take no trade — cash is a position, and skipping this session preserves capital for the next real setup",
        "Force a smaller trade just to stay engaged",
        "Trade the index ETF to diversify risk",
      ],
      correctIndex: 1,
      explanation: "Professional traders skip 60–80% of sessions. Forcing trades in flat markets is the single most common way retail accounts bleed slowly. Sitting on your hands is a skill. The next real setup is rarely more than a few days away.",
    },
  },

  {
    id: 'builder-rr-calc',
    stage: 'Builder',
    order: 7,
    title: 'Calculate R:R before you click buy',
    subtitle: 'The 10-second math that filters bad trades',
    duration: '3 min',
    icon: '◈',
    requiresLesson: 'builder-1',
    content: [
      "Every trade has three numbers: entry, stop, target. From those three you get one number: R:R (risk-to-reward).",
      "R:R = (target − entry) / (entry − stop). If R:R is less than 2, the trade is marginal at best.",
      "You should be able to do this math in 10 seconds before opening any position.",
    ],
    blocks: [
      { type: 'prose', text: "Every trade has three price levels: entry, stop, target. Divide the reward distance by the risk distance — that's R:R." },
      { type: 'heading', text: "The formula" },
      { type: 'callout', tone: 'gold', label: 'R:R math', text: "R:R = (target − entry) ÷ (entry − stop)\n\nExample: Entry $10.00, Stop $9.50, Target $11.50\nRisk = $0.50, Reward = $1.50\nR:R = 3:1 → good" },
      { type: 'demo', demo: { kind: 'risk-reward-tilt' }, caption: 'Sweep win rate and R:R to find profitability' },
      { type: 'prose', text: "Anything below 2:1 should raise your eyebrow. Below 1.5:1, pass unless the win rate is genuinely above 60% on similar setups." },
      { type: 'tip', text: "Write the three numbers (entry, stop, target) on paper before opening any position. If you can't explain the R:R out loud, you are not ready to click buy." },
    ],
    callout: {
      label: 'Quick filter',
      text: "R:R < 1.5  → pass\nR:R 1.5–2  → only with strong conviction\nR:R ≥ 2    → qualifying\nR:R ≥ 3    → premium setup",
    },
    tip: "If the R:R math requires a calculator, the trade is too complex. Good setups have obvious levels.",
    quiz: {
      question: "Entry at $5.00, stop at $4.60, target at $5.60. What's the R:R, and do you take it?",
      options: [
        "1.5:1 — take it, the target is above entry",
        "1.5:1 — pass or wait; you need 2:1 or better for consistent profitability",
        "3:1 — take it, excellent setup",
        "Cannot calculate without knowing the win rate",
      ],
      correctIndex: 1,
      explanation: "Risk = $5.00 − $4.60 = $0.40. Reward = $5.60 − $5.00 = $0.60. R:R = 0.60 ÷ 0.40 = 1.5:1. Below the 2:1 threshold, which means at a normal 45–50% win rate this setup is roughly break-even after slippage. Pass, or wait for a better entry that improves R:R.",
    },
  },

  {
    id: 'builder-sector-read',
    stage: 'Builder',
    order: 7,
    title: 'Never fight the sector',
    subtitle: 'Reading sector winds before you commit',
    duration: '3 min',
    icon: '∠',
    requiresLesson: 'builder-1',
    content: [
      "Most stocks move with their sector 70% of the time.",
      "A bullish setup in a bearish sector is trading into a headwind. You need more conviction, a better entry, or both.",
      "Before any trade, read the sector. The tape tells you the wind direction.",
    ],
    blocks: [
      { type: 'prose', text: "Individual stocks do not trade in a vacuum. Most move with their sector 70% of the time. Fighting the sector is possible but expensive — you need a significantly better setup to justify it." },
      { type: 'heading', text: "Checking the wind" },
      { type: 'prose', text: "The sector strip at the top of the floor shows today's sector moves. If the stock you are about to buy is in a bearish sector, ask yourself: 'Is my edge big enough to overcome the headwind?' Usually the answer is no." },
      { type: 'callout', tone: 'gold', label: 'The three reads', text: "Sector bullish, stock bullish → tailwind, take it\nSector neutral, stock bullish → standard setup\nSector bearish, stock bullish → requires 3:1+ R:R and a specific catalyst" },
      { type: 'pullquote', text: "The sector is the weather. You can sail against it — just rig accordingly." },
      { type: 'tip', text: "Before every trade, glance at the sector strip. 5 seconds. That habit prevents the most common unforced error in retail trading." },
    ],
    callout: {
      label: 'Why it matters',
      text: "A stock in a bullish sector has 3 forces pushing: company-specific, sector rotation, broad market. A stock in a bearish sector is fighting 2 of those 3 forces.",
    },
    tip: "When in doubt, trade with the sector — not against it.",
    quiz: {
      question: "You see a technical setup on a biotech stock. XLV (healthcare ETF) is down 1.8% today and has been bearish for a week. What do you do?",
      options: [
        "Take the trade — individual setups override sector moves",
        "Require significantly higher R:R (3:1+) and only take it if the specific catalyst is exceptional; otherwise pass",
        "Short the stock instead — the sector is clearly bearish",
        "Wait until XLV turns green before entering",
      ],
      correctIndex: 1,
      explanation: "A bearish sector is a headwind. You can still trade against it, but the bar is higher: the individual setup must be genuinely exceptional — specific catalyst, strong technical level, and R:R 3:1 or better. Most of the time the correct answer is to pass and wait for a setup aligned with the sector.",
    },
  },

  {
    id: 'operator-sizing',
    stage: 'Operator',
    order: 10,
    title: 'Sizing at Operator — why this tier is harder',
    subtitle: 'The math of real risk on real capital',
    duration: '3 min',
    icon: '∷',
    requiresLesson: 'operator-tilt',
    content: [
      "At $200–$1K, each position represents 10–25% of your capital. Mistakes stop being cheap.",
      "The 2–5% risk-per-trade rule tightens at this tier: aim for 2% risk per trade, not 5%.",
      "This is where the lessons from Buyer tier are tested for real.",
    ],
    blocks: [
      { type: 'prose', text: "Operator is where theory becomes expensive. At a $500 account, a 4-position book means each position is ~$125. A 20% stop-loss on that is $25 — 5% of your account in a single trade." },
      { type: 'heading', text: "The Operator sizing rule" },
      { type: 'callout', tone: 'gold', label: 'Operator per-position risk', text: "Target: 2% of account per trade at risk\n\nAccount $500, stop 15% from entry\nMax position = $500 × 2% ÷ 15% = $67\nNot $125 — $67." },
      { type: 'demo', demo: { kind: 'position-sizer', maxPct: 15 }, caption: 'Position sizer — Operator ceiling is 5% of account, target 2%' },
      { type: 'pullquote', text: "A great setup with bad sizing is a bad trade." },
      { type: 'tip', text: "If the position you want requires more than 5% risk, the stop is too wide, the position too big, or the setup too marginal. Cut one of the three." },
    ],
    callout: {
      label: 'The Operator compounding table',
      text: "5 wins at 25% gain, 3 losses at 15% loss, 2 break-even:\n\nAt 20% position sizing → +$180 on $500 (+36%)\nAt 10% position sizing → +$90 on $500 (+18%)\n\nThe larger size has 2× return — and 2× the drawdown risk.",
    },
    tip: "Principal tier starts at $1,000. You will reach it faster at 10% sizing with no blow-up than at 20% sizing with one bad week.",
    quiz: {
      question: "Account: $500. Setup: stop 12% from entry. What's the largest position size consistent with the 2% risk-per-trade rule?",
      options: [
        "$100 (20% of account)",
        "$60 — stop 12% × $60 = $7.20 risk = 1.4% of account. Fits the rule.",
        "$83 — stop 12% × $83 = $10 risk = 2% of account. This is the maximum.",
        "$500 — at Operator tier you should size up aggressively",
      ],
      correctIndex: 2,
      explanation: "Formula: position = (account × risk%) ÷ stop%. Here: ($500 × 0.02) ÷ 0.12 = $83. That's the maximum. Smaller is fine; larger breaks the rule. At Operator, disciplined sizing is the difference between reaching Principal and being stuck at Operator after a bad week.",
    },
  },

  // ─── OPTIONS CURRICULUM — OPERATOR TIER ──────────────────────
  //
  // Options unlock at Operator ($200–$1K) because below $200 a single
  // contract is more than the entire account. These lessons gate behind
  // operator-tilt so users finish the emotional discipline curriculum
  // before they take on leveraged products.

  {
    id: 'options-1-what',
    stage: 'Operator',
    order: 20,
    title: 'Options — what you are actually buying',
    subtitle: 'Calls, puts, strikes, premiums — the mechanics',
    duration: '5 min',
    icon: '⊕',
    requiresLesson: 'operator-tilt',
    content: [
      "An option is a contract that gives you the RIGHT — not the obligation — to buy (call) or sell (put) 100 shares at a specific price by a specific date.",
      "You pay a premium for that right. If the trade goes your way, you exercise or sell the contract for a profit. If it goes against you, the maximum you lose is the premium.",
      "That last part is the attraction: defined-risk exposure. The trap is that options decay every day — time itself costs you money.",
    ],
    blocks: [
      { type: 'prose', text: "You have been trading stocks. Now we introduce a different instrument: the option contract. Not a stock — a contract about a stock." },
      { type: 'heading', text: "Call and put, in one sentence each" },
      { type: 'callout', tone: 'gold', label: 'The two primitives', text: "CALL: right to BUY 100 shares at the strike, by expiry.\n   You buy a call if you expect the stock to rise.\n\nPUT: right to SELL 100 shares at the strike, by expiry.\n   You buy a put if you expect the stock to fall." },
      { type: 'prose', text: "The 'strike' is the price in the contract. The 'expiry' is the date the contract dies. The 'premium' is what you pay today." },
      { type: 'heading', text: "The unit is 100 shares" },
      { type: 'prose', text: "One contract controls 100 shares. If the premium is quoted at $1.50, you pay $150 (1.50 × 100) for the contract. This multiplier is why options feel powerful — and why sizing is critical at Operator tier." },
      { type: 'pullquote', text: "Defined risk, magnified outcome. That's the whole pitch." },
      { type: 'tip', text: "Before your first options trade: open a chain in your broker. Look at the bid, ask, and midpoint. Options are less liquid than stocks — the spread matters." },
    ],
    callout: {
      label: 'The mechanics in one line',
      text: "You pay premium × 100 per contract.\nYou profit if the underlying moves enough in your direction before expiry.\nYou lose the premium if it doesn't.",
    },
    tip: "For your first 10 options trades, only buy long calls and long puts. Skip spreads, skip selling options. Complexity kills the learning loop.",
    quiz: {
      question: "You buy 1 call contract on AAPL with strike $180, expiry 30 days out, premium $2.50. How much do you pay, and what is your max loss?",
      options: [
        "You pay $2.50 total, max loss $2.50",
        "You pay $250 total (2.50 × 100), max loss $250 — the full premium",
        "You pay $18,000 (180 × 100), max loss $18,000",
        "Cannot tell without knowing AAPL's current price",
      ],
      correctIndex: 1,
      explanation: "One contract = 100 shares. Premium $2.50 × 100 = $250 paid up front. Max loss is the premium: $250, no matter how far AAPL falls. That's the 'defined risk' feature. You never owe more than you paid. If AAPL rises past $182.50 (strike + premium), you start making money.",
    },
  },

  {
    id: 'options-2-sizing',
    stage: 'Operator',
    order: 21,
    title: 'Sizing options at Operator — the leverage trap',
    subtitle: 'Why a "cheap" contract is a big bet',
    duration: '4 min',
    icon: '⊖',
    requiresLesson: 'options-1-what',
    content: [
      "A $2 premium looks cheap. It's $200 — a big chunk of a $500 account.",
      "Options have leverage built in. A 1% move in the underlying can be a 10–30% move in the premium. That cuts both ways.",
      "At Operator tier, no more than 5% of your account should be in any single options position. Start with 2%.",
    ],
    blocks: [
      { type: 'prose', text: "Options look deceptively affordable. A $1.50 premium sounds cheap. But it's $150 — 30% of a $500 Operator account." },
      { type: 'heading', text: "Leverage cuts both ways" },
      { type: 'callout', tone: 'red', label: 'The compounding math', text: "AAPL moves 2% up.\nCall premium moves 20% up.\n\nAAPL moves 2% down.\nCall premium moves 20% down.\n\nThe leverage is the feature. It is also the risk." },
      { type: 'prose', text: "An out-of-the-money call with 30 days to expiry can lose 30% of its value in a single bad session — with no change in the underlying (just theta decay + a small adverse move)." },
      { type: 'heading', text: "The Operator options ceiling" },
      { type: 'callout', tone: 'gold', label: 'Sizing rules at Operator', text: "Max per position: 5% of account\nTarget for first trades: 2% of account\n\n$500 account → first contract costs $10–25 in premium, not $150.\n\nIf no contract is that cheap, the setup isn't ready for you yet — wait for Principal." },
      { type: 'demo', demo: { kind: 'position-sizer', maxPct: 10 }, caption: 'Size your first option as if it were a stock — then halve it' },
      { type: 'tip', text: "First three options trades: buy contracts worth under $50 each, even if the setup looks good at a higher premium. You are buying lessons, not profits. Keep the lesson cheap." },
    ],
    callout: {
      label: 'The newcomer trap',
      text: "'Only $150' sounds cheap.\nOn a $500 account it's 30% of capital.\n\nOn a $5,000 account it's 3%.\n\nSame contract, two very different bets.",
    },
    tip: "If you can't find options cheap enough to fit 2–5% of your account, trade stocks until you reach Principal.",
    quiz: {
      question: "Your account is $600. A PLTR call contract costs $220 in premium. What should you do?",
      options: [
        "Buy it — $220 is a normal options position",
        "Pass — $220 is 37% of your account, way past the 5% Operator ceiling; look for cheaper strikes/expirations or wait for Principal",
        "Buy half a contract to reduce risk",
        "Sell covered calls instead",
      ],
      correctIndex: 1,
      explanation: "$220 on a $600 account is 37% of capital — 7× the 5% Operator ceiling. You can't buy half contracts. Options: (1) a cheaper OTM strike, (2) a shorter expiry, (3) pass and wait for a better setup, (4) stick to stocks until your account grows. The discipline of refusing to over-size here is what gets you to Principal.",
    },
  },

  {
    id: 'options-3-moneyness',
    stage: 'Operator',
    order: 22,
    title: 'Moneyness — ITM, ATM, OTM',
    subtitle: 'Why the strike matters more than the premium',
    duration: '4 min',
    icon: '⊙',
    requiresLesson: 'options-2-sizing',
    content: [
      "Moneyness describes how far the strike is from the current stock price.",
      "In-the-money (ITM) options have intrinsic value — they would already pay off if exercised today.",
      "At-the-money (ATM) and out-of-the-money (OTM) options are pure time value — they decay faster and need the stock to move to make money.",
    ],
    blocks: [
      { type: 'prose', text: "Three terms you will see constantly: ITM, ATM, OTM. They describe the relationship between the strike and the current stock price." },
      { type: 'heading', text: "The three zones" },
      { type: 'callout', tone: 'gold', label: 'For a CALL (strike vs current stock price)', text: "ITM (in-the-money): strike BELOW stock price\n  → call has intrinsic value, decays slowly\n\nATM (at-the-money): strike NEAR stock price\n  → balanced time value, fastest-moving delta\n\nOTM (out-of-the-money): strike ABOVE stock price\n  → pure time value, cheap but high-decay, lotto-ticket territory" },
      { type: 'prose', text: "For a put it's reversed: ITM is strike above stock price, OTM is strike below." },
      { type: 'heading', text: "The tradeoff" },
      { type: 'prose', text: "ITM options cost more but decay slower and have higher delta (they move more directly with the stock). OTM options are cheap but need a big move to pay off, and theta eats them alive." },
      { type: 'callout', tone: 'red', label: 'The OTM trap', text: "OTM calls look 'affordable.' They're cheap because they probably expire worthless. ~70% of OTM options held to expiry pay zero.\n\nIf you buy OTM, size smaller and plan to exit before the last 2 weeks." },
      { type: 'demo', demo: { kind: 'options-payoff', underlying: 100, strike: 100, premium: 3, optionType: 'call' }, caption: 'Payoff at expiry — drag strike to see ITM vs OTM profiles' },
      { type: 'tip', text: "For your first options trades, buy slightly ITM options (1–2 strikes below current for calls). They're more expensive but behave like cheaper stock — easier to manage.", },
    ],
    callout: {
      label: 'Picking moneyness by conviction',
      text: "Low conviction / testing → skip the trade\nModerate conviction → slightly ITM (delta 0.55–0.65)\nHigh conviction → ATM or slightly OTM for more leverage\nLotto ticket → far OTM (2% of account max)",
    },
    tip: "The 'affordable' OTM call is often the wrong choice for Operator. Pay up for delta and defined movement.",
    quiz: {
      question: "AAPL trades at $180. You buy a call with strike $185, expiry 30 days, premium $2. What is this contract's moneyness and what is your primary risk?",
      options: [
        "ITM — your risk is paying too much premium",
        "OTM by $5 — primary risk is theta decay plus needing AAPL to move above $187 just to break even",
        "ATM — balanced time value, safest option choice",
        "Moneyness doesn't matter if the strike is within 5%",
      ],
      correctIndex: 1,
      explanation: "Strike $185 is above current $180 — that's OTM for a call. You paid $2 premium, so break-even is $187 (strike + premium). AAPL needs to move ~3.9% higher in 30 days just to not lose money. Theta is your main enemy: every day that passes eats premium. This is a common newcomer mistake — OTM looks cheap but the math is harder than it appears.",
    },
  },

  {
    id: 'options-4-delta',
    stage: 'Operator',
    order: 23,
    title: 'Delta — your directional exposure',
    subtitle: 'How much the option moves per $1 in the stock',
    duration: '4 min',
    icon: 'Δ',
    requiresLesson: 'options-3-moneyness',
    content: [
      "Delta is how many cents the option premium moves when the stock moves $1.",
      "A delta of 0.50 means the option moves $0.50 for every $1 in the stock. A delta of 0.80 means $0.80.",
      "Delta tells you your effective share-equivalent: a 0.50 delta call on 1 contract acts like owning 50 shares.",
    ],
    blocks: [
      { type: 'prose', text: "Delta is the most important Greek for directional traders. It tells you how sensitive the option's premium is to price moves in the underlying." },
      { type: 'heading', text: "The practical reading" },
      { type: 'callout', tone: 'gold', label: 'Delta cheat sheet (long calls)', text: "Delta 0.70–0.90 → deep ITM, acts like holding stock\nDelta 0.50–0.65 → slightly ITM / ATM, balanced\nDelta 0.30–0.45 → slightly OTM, moderate leverage\nDelta 0.15–0.25 → far OTM, lotto-style\nDelta < 0.15  → usually not worth it" },
      { type: 'prose', text: "Your contract's delta × 100 = your 'share-equivalent' exposure. A 1-contract call with 0.60 delta behaves like 60 shares of the underlying — for a fraction of the cost." },
      { type: 'heading', text: "Delta changes as price moves" },
      { type: 'prose', text: "Delta isn't static. As the stock rises, your call's delta rises (toward 1.0). As it falls, delta drops (toward 0). This is 'gamma' — but you don't need to compute it. Just know: ITM calls get more stock-like as they go further ITM, OTM calls get more lotto-like as they go further OTM." },
      { type: 'tip', text: "When buying your first few contracts, pick delta 0.55–0.70. That's the Goldilocks zone: enough leverage to matter, ITM enough to behave predictably." },
    ],
    callout: {
      label: 'Delta as a target',
      text: "Want 50-share equivalent exposure on a $180 stock?\nShare approach: $9,000 cash\nOption approach: 1 call with delta 0.50\n\nMuch cheaper — but the option also has theta working against you.",
    },
    tip: "Higher delta = more expensive = less leverage but more stock-like. Pick delta based on your conviction and your sizing.",
    quiz: {
      question: "You bought 2 call contracts, each with delta 0.60. If AAPL moves up $2, approximately how much does your position gain in premium value?",
      options: [
        "$2 per contract, $4 total",
        "$1.20 per contract × 100 × 2 contracts = $240 approx",
        "$60 per contract, $120 total",
        "Cannot calculate without knowing the strike",
      ],
      correctIndex: 1,
      explanation: "Delta 0.60 means premium moves $0.60 per $1 in the stock. $2 move × 0.60 delta = $1.20 premium change. One contract = 100 shares, so each contract gains $120. Two contracts = $240. This is your approximate share-equivalent exposure: 2 × 0.60 × 100 = 120 shares' worth of AAPL.",
    },
  },

  {
    id: 'options-5-theta',
    stage: 'Operator',
    order: 24,
    title: 'Theta — the rent you pay to hold',
    subtitle: 'Why time is the enemy of option buyers',
    duration: '4 min',
    icon: 'θ',
    requiresLesson: 'options-4-delta',
    content: [
      "Theta is how much the option premium decays per day, all else equal.",
      "A call with theta -$0.05 loses $5 per contract per day, even if the stock doesn't move.",
      "Theta accelerates in the final 30 days — and becomes brutal in the final 2 weeks. This is the single most important thing to know about options.",
    ],
    blocks: [
      { type: 'prose', text: "Stock positions are patient. You can hold a stock for a decade and it costs you nothing (except opportunity cost). Options are impatient — every day they sit in your account, they lose value." },
      { type: 'heading', text: "The theta curve" },
      { type: 'demo', demo: { kind: 'options-decay', dte: 60, premium: 4 }, caption: 'Premium decay over time — drag the slider' },
      { type: 'prose', text: "Theta is small 60 days out, meaningful at 30 days, brutal inside 14 days, and catastrophic in the final week. This acceleration is the main reason weekly options destroy retail traders." },
      { type: 'callout', tone: 'red', label: 'The 7-day trap', text: "Inside 7 days to expiry (7DTE):\n- theta can be 5–15% of premium per DAY\n- a stock move in your favor can still lose you money\n- unexpected news hits you 2× harder\n\nThis is why < 7 DTE is a specialist's game, not a beginner's." },
      { type: 'heading', text: "Your defense" },
      { type: 'callout', tone: 'gold', label: 'Theta-aware buying', text: "30–45 DTE: sweet spot for directional plays\n20–30 DTE: tighter, more theta pressure\n14–20 DTE: only if you're trading a specific catalyst this week\n< 14 DTE: skip unless you know exactly what you're doing" },
      { type: 'tip', text: "Never hold a long option into the final 7 days unless you're actively trading the expiry. Close or roll by day 10." },
    ],
    callout: {
      label: 'The one-line rule',
      text: "Time is the enemy when you're long options.\nTime is your friend when you're short them.\n\nAt Operator, you are always long. So time is the enemy.",
    },
    tip: "Set a calendar reminder for 10 days before expiry. That's your 'close or roll' trigger.",
    quiz: {
      question: "You bought a 14 DTE call for $2.00 premium. The stock is flat for 7 days. Why might your call now be worth only $1.30?",
      options: [
        "The spread widened — nothing fundamental changed",
        "Theta decay accelerated in the second week — you lost 35% of premium with no move in the underlying; this is normal and expected",
        "Someone is shorting your specific contract",
        "Implied volatility spiked",
      ],
      correctIndex: 1,
      explanation: "This is the core options lesson. With 7 days left and a flat stock, theta has eaten most of the remaining time value. Inside 14 DTE, theta can be 5–10% per day. 7 days × 5% ≈ 35% loss with no move. It's not a bug — it's the design. This is why 30–45 DTE is safer for beginners: theta is slower there.",
    },
  },

  {
    id: 'options-6-iv',
    stage: 'Operator',
    order: 25,
    title: 'Implied volatility and the earnings trap',
    subtitle: 'Why options are expensive before news and cheap after',
    duration: '4 min',
    icon: '⇅',
    requiresLesson: 'options-5-theta',
    content: [
      "Implied volatility (IV) is the market's guess at how much the stock will move before expiry.",
      "High IV → expensive options. Low IV → cheap options.",
      "IV spikes before earnings and events, then collapses after — even if the stock moves in your direction. This is 'IV crush.' It is the single most common way new options traders lose money.",
    ],
    blocks: [
      { type: 'prose', text: "Two calls on the same stock, same strike, same expiry can cost very different amounts on different days. The reason: implied volatility." },
      { type: 'heading', text: "What IV actually is" },
      { type: 'prose', text: "IV is the market pricing in expected future movement. If earnings are tomorrow, IV rises — the market expects a big move. After earnings, the move has happened, uncertainty is resolved, and IV collapses." },
      { type: 'callout', tone: 'red', label: 'The earnings trap', text: "Stock trades at $100 day before earnings.\nCall strike $105, expiry next week, premium $4.00.\n\nEarnings beat! Stock opens at $105.\nCall now worth $2.50. Not $7.00.\n\nWhat happened? IV crushed from 80% to 30%. The stock did move your way — but the 'expensive expectations' vanished." },
      { type: 'heading', text: "The pro response" },
      { type: 'callout', tone: 'gold', label: 'Three ways to avoid IV crush', text: "1. Don't buy long options into earnings. Wait until after the event.\n2. If you must be long into earnings, buy a spread (reduces IV exposure) — this is a Principal-tier topic.\n3. Use options to trade AFTER the event, when IV is low and premium is cheap, if the reaction was overdone." },
      { type: 'pullquote', text: "The stock moved your way. The IV moved against you more. That's IV crush." },
      { type: 'tip', text: "Rule of thumb at Operator: do not hold long single-leg options through earnings, FDA events, Fed meetings, or company-specific announcements. IV crush will hurt you even when you're right." },
    ],
    callout: {
      label: 'IV rank — the filter',
      text: "IV rank compares current IV to its 52-week range.\n\nIV rank > 50 → options are expensive; buying is harder\nIV rank < 30 → options are cheap; buying is easier\n\nFree data from most broker option chains.",
    },
    tip: "Check IV rank before entering an options position. If it's above 60 and there's a known event coming, you are probably paying a premium for volatility you'll watch collapse.",
    quiz: {
      question: "NVDA reports earnings tomorrow. You buy a $600 call expiring in 3 days for $12 premium. NVDA beats big and opens at $620. Your call is worth $8, not $20. Why?",
      options: [
        "The market makers shorted your contract",
        "IV was at 90% pre-earnings and crushed to 35% post-earnings — the volatility premium disappeared faster than the intrinsic value built, even though the stock moved in your direction",
        "You should have bought a longer-dated expiry",
        "The stop was hit intraday",
      ],
      correctIndex: 1,
      explanation: "This is the canonical earnings trap. You were right about direction, but IV crush ate your profit. Pre-earnings, IV inflated premium expecting a big move. Post-earnings, that uncertainty resolves instantly and IV drops. At Operator, the safe rule is: do not buy long single-leg options into known events. Wait for the event, then trade the reaction.",
    },
  },

  {
    id: 'options-7-strike-pick',
    stage: 'Operator',
    order: 26,
    title: 'Picking a strike — the 0.60 delta rule',
    subtitle: 'Practical strike selection for directional trades',
    duration: '3 min',
    icon: '⊘',
    requiresLesson: 'options-6-iv',
    content: [
      "For directional trades at Operator, pick the strike with ~0.60 delta.",
      "This gives you stock-like movement (60 cents per $1) without paying for deep-ITM overhead.",
      "OTM strikes (delta 0.20–0.30) are cheaper but have worse expected value for most setups.",
    ],
    blocks: [
      { type: 'prose', text: "Strike selection is the single biggest variable in your first dozen options trades. Get this one rule right and the rest becomes easier." },
      { type: 'heading', text: "The 0.60 rule" },
      { type: 'callout', tone: 'gold', label: 'Default strike selection', text: "Default: the strike with delta closest to 0.60\n  → slightly in-the-money\n  → behaves like owning 60 shares\n  → lower percentage gains than OTM, but higher hit rate\n  → manageable theta\n\nThis is the 'stock replacement' zone." },
      { type: 'prose', text: "Compare: a 0.30 delta OTM call is cheaper, leveraged higher — but your hit rate drops. Most of the time it expires worthless, even when the stock moves up modestly." },
      { type: 'heading', text: "When to deviate" },
      { type: 'callout', tone: 'gold', label: 'Strike deviation', text: "Lower delta (0.30–0.45) when: you are highly confident of a fast move, sizing small (< 2% of account)\n\nHigher delta (0.75–0.85) when: you want low decay and max stock-replacement behavior, willing to pay more premium" },
      { type: 'pullquote', text: "Pick the strike that matches your conviction, not your desire for cheap." },
      { type: 'tip', text: "If the delta-0.60 strike is too expensive to fit 5% of your account, the setup isn't right for options. Go back to stocks on this one.", },
    ],
    callout: {
      label: 'The rule in one line',
      text: "Default delta = 0.60.\nDeviate only with specific reason.",
    },
    tip: "Before clicking buy, write down the delta of the strike you're picking. If you don't know, you're not ready.",
    quiz: {
      question: "TSLA at $260. You have 3:1 R:R conviction for $278 over the next 3 weeks. Call options 30 DTE: $260 strike (0.55 delta, $9), $265 strike (0.45 delta, $6), $275 strike (0.25 delta, $2.50). Best pick for a first trade?",
      options: [
        "$275 strike — cheapest premium, best leverage",
        "$260 strike — 0.55 delta matches the 0.60 rule closely; stock-like movement with manageable theta; highest hit rate for this setup",
        "$265 strike — balanced between cost and leverage",
        "Skip the trade",
      ],
      correctIndex: 1,
      explanation: "The $260 strike at 0.55 delta is closest to the 0.60 rule. It behaves like owning 55 shares, has the most intrinsic value protection against theta, and highest probability of profiting on the expected move. The $275 strike looks cheap but needs TSLA above $277.50 just to break even — a much harder bet even though you expect $278.",
    },
  },

  {
    id: 'options-8-dte',
    stage: 'Operator',
    order: 27,
    title: 'Picking an expiration — the 30-45 DTE sweet spot',
    subtitle: 'Why weekly options break beginners',
    duration: '3 min',
    icon: '⏱',
    requiresLesson: 'options-7-strike-pick',
    content: [
      "Days to expiration (DTE) is the single biggest determinant of how theta hurts you.",
      "30–45 DTE is the sweet spot for directional trades: enough time for your thesis to play out, theta is manageable.",
      "Anything under 14 DTE is a specialist's game. Weekly options are how retail accounts get destroyed.",
    ],
    blocks: [
      { type: 'prose', text: "Expiration selection is the second biggest decision after strike. Most Operator-tier traders should pick one setting and stick to it." },
      { type: 'heading', text: "The three zones" },
      { type: 'callout', tone: 'gold', label: 'Days-to-expiry playbook', text: "30–45 DTE (sweet spot):\n  → slow theta, time for thesis to develop, modest IV impact\n  → default for all Operator directional trades\n\n14–30 DTE (active zone):\n  → theta picks up, need a catalyst inside the window\n  → only if you're trading a specific event in that range\n\n0–14 DTE (specialist zone):\n  → theta brutal, need to be right AND fast\n  → skip at Operator" },
      { type: 'heading', text: "The weekly options trap" },
      { type: 'pullquote', text: "0DTE is a casino. 7DTE is a hard game. 30DTE is a market." },
      { type: 'prose', text: "Social media glamorizes weekly and 0DTE trading because the returns look huge on winners. What you don't see: the 70% that lose 80–100% of premium. The expected value is negative for beginners. This is 'content' trading, not professional trading." },
      { type: 'callout', tone: 'red', label: 'The math on 7 DTE', text: "Buy a 7 DTE call at $2.00 premium.\nStock flat for 3 days → call now $1.20.\nStock flat for 5 days → call now $0.40.\n\nYou can lose 80% in a week with the stock literally not moving." },
      { type: 'tip', text: "For your first 20 options trades, do not trade anything under 21 DTE. No exceptions. The discipline is the lesson." },
    ],
    callout: {
      label: 'The default',
      text: "30–45 DTE on every trade.\nClose or roll by day 10.\nNo weeklies until Principal.",
    },
    tip: "Set your broker to default to 30–45 DTE on the option chain. Don't browse weeklies.",
    quiz: {
      question: "You see a bullish NVDA setup. You want to buy a call. The chain shows: 7 DTE 0.60 delta at $3.50, 30 DTE 0.60 delta at $8.00, 60 DTE 0.60 delta at $12.00. What do you pick at Operator tier?",
      options: [
        "7 DTE — cheapest, highest leverage if NVDA moves fast",
        "30 DTE — balanced theta, enough time for setup to play out, default sweet spot for Operator",
        "60 DTE — safest but double the premium",
        "Split between 7 and 60 DTE",
      ],
      correctIndex: 1,
      explanation: "30 DTE fits the default rule. 7 DTE looks cheap but theta will eat 5–10% per day — you need to be right fast AND get a big move. 60 DTE is safer but you're paying for time you probably won't use. 30 DTE is the professional default: enough time, manageable theta, fits the 2–4 week thesis horizon.",
    },
  },

  {
    id: 'options-9-exit',
    stage: 'Operator',
    order: 28,
    title: 'When to close — the 50% rule',
    subtitle: 'Why taking profits on options is harder than on stocks',
    duration: '3 min',
    icon: '⊡',
    requiresLesson: 'options-8-dte',
    content: [
      "On long calls and puts, take profits at 50% of maximum theoretical gain. Don't hold for 100%.",
      "Cut losers at 50% premium loss. Don't hold until expiry hoping for a reversal.",
      "The 50/50 rule is counterintuitive but backtests across decades as the highest-expectancy exit strategy for retail options traders.",
    ],
    blocks: [
      { type: 'prose', text: "Exit discipline is harder with options than stocks. Stocks can recover over weeks or months. Options have a shot clock." },
      { type: 'heading', text: "The 50/50 rule" },
      { type: 'callout', tone: 'gold', label: 'The two exit rules', text: "PROFITS: Close at 50% of theoretical max gain.\n  → Bought call at $3, theoretical max $10, close at $6.50.\n  → You leave upside on the table. You also lock in wins.\n\nLOSSES: Close at 50% of premium loss.\n  → Bought call at $4, now worth $2, close.\n  → You cut before theta destroys you." },
      { type: 'prose', text: "The instinct to hold winners for more or hope losers recover is where options traders bleed out. Theta turns both those behaviors into losing strategies over time." },
      { type: 'heading', text: "Why 50% on winners?" },
      { type: 'prose', text: "On long options, you've usually captured most of the gamma benefit by the time you're up 50%. Holding for the last 50% means you're fighting theta for dwindling incremental gains. Professional options traders (hedge funds, market makers) take profits aggressively — 30–50% of max — and reopen if the setup refreshes." },
      { type: 'callout', tone: 'red', label: 'The hold-to-expiry trap', text: "You bought a call at $3.\nIt ran to $8 (+167%).\nYou held.\nStock pulled back, option is now $2.\n\nHindsight: should have taken $6.50 profit at 50%.\nForesight: the 50% rule prevents exactly this." },
      { type: 'tip', text: "Set a take-profit alert at 50% of max gain the moment you open. Automate the exit." },
    ],
    callout: {
      label: 'The two bookends',
      text: "+50% gain → close (lock in)\n−50% loss → close (cut before theta)\n\nThe trades in the middle are where you manage with the position.",
    },
    tip: "Closing a 50% winner feels premature. Closing a 50% loser feels like quitting. Do it anyway. It's the rule.",
    quiz: {
      question: "You bought a call for $4.00 premium. It's now at $7.80. You're convinced the move will continue. What should you do per the 50% rule?",
      options: [
        "Hold — you have high conviction and the setup is still valid",
        "Close at $7.80 (+95% on premium). The 50% rule triggered at $6 — you're already past it. Book the win, re-enter if a fresh setup appears.",
        "Close half, let the rest run",
        "Add more contracts",
      ],
      correctIndex: 1,
      explanation: "Per the 50% rule, your exit was $6 (50% gain on $4 premium). You're now at +95%, deep into 'house money' territory. The professional move is to close the full position and look for a new setup. 'Letting it run' on options, especially with theta present, turns wins into round-trips frequently. The 50% rule feels premature but it's the rule that makes you money across 100 trades, not 1.",
    },
  },

  {
    id: 'options-10-mistakes',
    stage: 'Operator',
    order: 29,
    title: 'The seven deadly options mistakes',
    subtitle: 'Cataloged errors that destroy beginner accounts',
    duration: '4 min',
    icon: '☒',
    requiresLesson: 'options-9-exit',
    content: [
      "Almost every Operator-tier options loss falls into one of seven categories.",
      "If you can recognize them while they're happening, you save the trade. If you can't, you repeat them.",
      "These aren't exotic mistakes — they're the same seven errors every beginner makes.",
    ],
    blocks: [
      { type: 'prose', text: "You've now covered the core mechanics. Before your first real trade, read this list. Every item comes from a real account blow-up." },
      { type: 'heading', text: "The seven" },
      { type: 'callout', tone: 'red', label: '1. Buying 0DTE or weeklies', text: "The content says big wins. The math says negative expectancy. Skip until Principal at minimum." },
      { type: 'callout', tone: 'red', label: '2. Over-sizing a single position', text: "The 'just one good trade' mindset. A single 20% position can end your month. Stay under 5%." },
      { type: 'callout', tone: 'red', label: '3. Buying into earnings', text: "IV crush will hurt you even when you're right. Trade the reaction, not the event." },
      { type: 'callout', tone: 'red', label: '4. Holding losers hoping for a reversal', text: "Theta doesn't reverse. 50% loss → close. No 'just one more day'." },
      { type: 'callout', tone: 'red', label: '5. Chasing a runner', text: "A call that already ran 40% is not a cheap entry. The delta has shifted, the risk/reward is worse. Let it go." },
      { type: 'callout', tone: 'red', label: '6. Buying OTM because it is cheap', text: "OTM expires worthless most of the time. If you want cheap, trade stocks. For options, pay for delta." },
      { type: 'callout', tone: 'red', label: '7. Ignoring the spread', text: "Some options have 20% bid-ask spreads. You lose 10% to slippage on entry and exit alone. Skip illiquid contracts." },
      { type: 'pullquote', text: "Your first loss will be one of these seven. Knowing that doesn't prevent it — but it shortens the recovery." },
      { type: 'tip', text: "Screenshot this lesson. When a trade goes wrong, review this list first. The mistake is almost always here." },
    ],
    callout: {
      label: 'The pattern',
      text: "Every deadly mistake has the same root: taking a shortcut around the discipline the lesson taught.\n\nOver-sizing skips sizing rules.\nChasing skips entry rules.\nEarnings trades skip IV rules.\n\nThe rules are the profession.",
    },
    tip: "Your first options account blow-up will cost between $50 and $500 depending on your size. Make sure it's closer to $50 by keeping Operator positions small.",
    quiz: {
      question: "You closed an options trade for a 40% loss. Which of the seven deadly mistakes is most likely to be the root cause?",
      options: [
        "The market moved unexpectedly — unavoidable",
        "Likely one of: over-sizing, buying OTM for cheapness, trading into earnings, or holding past the 50% loss rule — the root cause is almost always a discipline shortcut",
        "The broker's fill was bad",
        "Can't tell without more information",
      ],
      correctIndex: 1,
      explanation: "A 40% options loss in a few days is almost never 'market moved unexpectedly.' It's usually a discipline failure: too much size, wrong strike (OTM), bad timing (earnings), or holding too long. The post-mortem on every loss should start with 'which of the seven did I do?' — that's how you actually learn.",
    },
  },

  // ─── PRINCIPAL ($1K–$10K) — ADDITIONAL LESSONS ───────────────
  {
    id: 'principal-size-up',
    stage: 'Principal',
    order: 11,
    title: 'The pain of sizing up',
    subtitle: "Why the same strategy feels harder with more money",
    duration: '4 min',
    icon: '↗',
    requiresLesson: 'principal-1',
    content: [
      "At $1,000 → $10,000, a 2% loss is $20–$200. The math hasn't changed but the dollars feel very different.",
      "Traders who crushed it at Operator often stall at Principal because the emotional weight of each trade is larger.",
      "The fix is to stick to percentages, not dollars. Ignore the dollar amounts.",
    ],
    blocks: [
      { type: 'prose', text: "You compounded from Operator to Principal. Now each trade matters in dollars in a way it didn't before. This is the most underrated emotional test in trading." },
      { type: 'heading', text: "The psychological shift" },
      { type: 'callout', tone: 'gold', label: 'The dollar trap', text: "At $500, a 2% loss = $10. Easy to absorb.\nAt $5,000, a 2% loss = $100. Same percentage, different feeling.\n\nMost traders freeze or second-guess when the dollar stakes rise — even though the rules that worked at Operator still work." },
      { type: 'prose', text: "Your edge comes from repetition of the same rules. If the rules change because the dollars feel bigger, your edge evaporates." },
      { type: 'heading', text: "The practical move" },
      { type: 'callout', tone: 'gold', label: 'Percentage discipline', text: "Look at every trade outcome as a percentage.\n\nYour last trade: +1.8%? Same as the +1.8% you made at $200.\nYour last loss: -2.3%? Same percentage as the losses at Buyer tier.\n\nDollars are the side-effect. Percentages are the discipline." },
      { type: 'tip', text: "If you find yourself hesitating on a setup because the dollar amount feels large, take the trade anyway at the correct percentage size. The hesitation is the test — pass it.", },
    ],
    callout: {
      label: 'The professional tell',
      text: "Pro traders react the same way to +2% and -2% whether it's $20 or $20,000.\n\nThe process is the process.",
    },
    tip: "Track your trades by percentage return, not dollar return. The percentage is the signal.",
    quiz: {
      question: "You just crossed $1,000 (Principal). Your next trade loses $80 — a 2.5% loss, exactly in line with your normal distribution. How should you feel and act?",
      options: [
        "Reduce size on the next trade — the losses are getting too large",
        "This is a normal loss percentage-wise — act identically to any prior Operator loss; next trade same size, same rules",
        "Move to safer trades with lower expected returns",
        "Take a break — you're clearly tilted",
      ],
      correctIndex: 1,
      explanation: "2.5% is within your normal loss distribution regardless of account size. The dollars are larger but the percentage is the signal. If you start shrinking size because dollars feel big, you eventually under-size your edge away. The correct Principal-tier move: same rules, same percentage sizing, same execution. Over time the dollar amounts of wins and losses both scale — that's compounding.",
    },
  },
]

// ─── Helpers ────────────────────────────────────────────────
export function getAvailableLessons(
  currentStage: string,
  completedLessonIds: Set<string>,
  tradeCount: number,
  hasClosedTrade: boolean,
) {
  const TIER_ORDER = ['Buyer', 'Builder', 'Operator', 'Principal', 'Sovereign']
  const tierIdx = TIER_ORDER.indexOf(currentStage)

  return INVEST_LESSONS.map(lesson => {
    const lessonTierIdx = TIER_ORDER.indexOf(lesson.stage)

    if (lessonTierIdx > tierIdx) {
      return { ...lesson, locked: true, lockReason: `Reach ${lesson.stage} to unlock` }
    }
    if (lesson.requiresLesson && !completedLessonIds.has(lesson.requiresLesson)) {
      const prereq = INVEST_LESSONS.find(l => l.id === lesson.requiresLesson)
      return { ...lesson, locked: true, lockReason: `Complete "${prereq?.title}" first` }
    }
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
  }).sort((a, b) => {
    // Sort by tier order, then by lesson.order within tier
    const TIER_ORDER = ['Buyer', 'Builder', 'Operator', 'Principal', 'Sovereign']
    const ta = TIER_ORDER.indexOf(a.stage)
    const tb = TIER_ORDER.indexOf(b.stage)
    if (ta !== tb) return ta - tb
    return a.order - b.order
  })
}

export function findLessonByTrigger(
  trigger: LessonTrigger,
  currentStage: string,
  completedIds: Set<string>,
  tradeCount: number,
  hasClosedTrade: boolean,
): InvestLesson | null {
  const available = getAvailableLessons(currentStage, completedIds, tradeCount, hasClosedTrade)
  const candidates = available.filter(l =>
    !l.locked &&
    !completedIds.has(l.id) &&
    l.triggerOn?.includes(trigger)
  )
  return candidates[0] ?? null
}

export type LessonWithStatus = ReturnType<typeof getAvailableLessons>[0]
