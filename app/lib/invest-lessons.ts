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
