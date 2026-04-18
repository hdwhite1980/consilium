// ─────────────────────────────────────────────────────────────
// Invest Journey — Stage-Gated Trading Lessons (v2, Fireside)
//
// BACKWARDS COMPAT: All existing fields remain. The old
// InvestLessons.tsx component will continue to work without
// changes — it just ignores the new `blocks` and `demos` fields.
//
// The new Fireside lesson viewer uses `blocks` when present,
// falling back to the legacy `content` + `callout` + `tip`.
// ─────────────────────────────────────────────────────────────

export type LockType = 'stage' | 'behavioral' | 'lesson'

export interface LessonQuiz {
  question: string
  options: string[]
  correctIndex: number
  explanation: string
}

// ── NEW: Block-based content for scrollytelling ──────────────
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

export interface InvestLesson {
  id: string
  stage: 'Spark' | 'Ember' | 'Flame' | 'Blaze' | 'Inferno'
  order: number
  title: string
  subtitle: string
  duration: string
  icon: string
  // Lock conditions — all must be met to unlock
  requiresLesson?: string
  requiresBehavior?: 'first_trade' | 'first_close' | 'three_trades'
  // Legacy fields (still supported)
  content: string[]
  callout?: { label: string; text: string }
  tip?: string
  // NEW: block-based scrollytelling content. When present, takes priority.
  blocks?: LessonBlock[]
  // Contextual triggers — what moment in the journey should auto-surface this lesson?
  triggerOn?: LessonTrigger[]
  quiz: LessonQuiz
}

// ── NEW: Contextual trigger system ───────────────────────────
// These fire automatically when the user hits a journey moment.
export type LessonTrigger =
  | 'first_open_page'       // brand new user — their first landing
  | 'first_trade_opened'    // they just logged their first trade
  | 'first_trade_closed'    // they just closed their first trade
  | 'first_loss'            // their first losing close
  | 'first_win'             // their first winning close (beyond the existing first_win_at)
  | 'three_losses_in_row'   // danger zone — tilt prevention
  | 'stage_up'              // they just crossed a milestone
  | 'first_options_spark'   // (reserved for when options sparks arrive)

// ─────────────────────────────────────────────────────────────
// LESSON CONTENT
// Only a subset is rebuilt here with rich `blocks`.
// The rest continue to use the legacy content[] which still
// renders fine in the Fireside viewer (prose fallback).
// ─────────────────────────────────────────────────────────────
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
    triggerOn: ['first_open_page'],
    content: [
      "Most new traders blow up their account not because they pick bad stocks — they do it because they bet too much on each one. A 50% loss requires a 100% gain just to break even.",
      "The professional rule is simple: never risk more than 2–5% of your total capital on a single trade.",
      "Small positions let you make mistakes cheaply. And you will make mistakes — everyone does.",
    ],
    blocks: [
      { type: 'prose', text: "Most new traders don't blow up their accounts because they pick bad stocks. They blow up because they bet too much on each one." },
      { type: 'prose', text: "The math is cruel and unforgiving. Drag the slider below to see it yourself." },
      { type: 'demo', demo: { kind: 'loss-recovery' }, caption: 'The recovery curve — why small losses matter' },
      { type: 'pullquote', text: "A 50% loss needs a 100% gain just to break even." },
      { type: 'heading', text: "The rule that keeps you alive" },
      { type: 'prose', text: "Never risk more than 2–5% of your total capital on any single trade. It sounds tiny. That's the point." },
      { type: 'demo', demo: { kind: 'position-sizer', maxPct: 20 }, caption: 'Your position sized to your actual balance' },
      { type: 'callout', tone: 'gold', label: 'The math that matters', text: "Lose 10% → need 11% to recover\nLose 25% → need 33% to recover\nLose 50% → need 100% to recover\nLose 75% → need 300% to recover" },
      { type: 'tip', text: "At Spark, the goal isn't to get rich. It's to learn with real stakes without losing real money." },
    ],
    callout: {
      label: 'The math that matters',
      text: "Lose 10% → need 11% to recover\nLose 25% → need 33% to recover\nLose 50% → need 100% to recover\nLose 75% → need 300% to recover",
    },
    tip: "At the Spark stage, the goal isn't to get rich — it's to learn with real stakes without losing real money.",
    quiz: {
      question: "You have $50 and you're considering putting $40 of it into one stock. What's the main problem with this?",
      options: [
        "The stock might not be liquid enough for that size",
        "One bad trade could take 30–50% of your entire capital — and recovering from that is mathematically much harder than avoiding it",
        "You should diversify by putting $40 into several stocks instead",
        "Nothing — at $50 total you need concentration to make meaningful gains",
      ],
      correctIndex: 1,
      explanation: "The core issue is risk concentration. If that one stock drops 50%, you've lost $20 — which is 40% of your entire capital. To recover, the remaining $30 needs to grow 67% just to get back to $50. Position sizing is the difference between surviving a losing trade and being crippled by one.",
    },
  },

  {
    id: 'spark-2',
    stage: 'Spark',
    order: 2,
    title: 'Stops before targets',
    subtitle: 'Why planning your exit matters more than planning your entry',
    duration: '3 min',
    icon: '🛑',
    requiresLesson: 'spark-1',
    triggerOn: ['first_trade_opened'],
    content: [
      "Before you buy, know where you'll sell if you're wrong. That price is your stop.",
      "A stop protects you from your own psychology. Without a pre-planned stop, you'll talk yourself into holding a loser.",
      "Stops should be based on the chart, not on how much you're comfortable losing.",
    ],
    blocks: [
      { type: 'prose', text: "You just opened your first trade. Welcome. Here's the question that matters more than anything else you'll think about: where will you exit if you're wrong?" },
      { type: 'heading', text: "The stop is the plan" },
      { type: 'prose', text: "A stop-loss isn't pessimism. It's the line you drew in the sand before the market could make you emotional. Without it, you'll find reasons to hold a losing trade until it's down 40%." },
      { type: 'demo', demo: { kind: 'stop-ladder', entry: 5.00, atr: 0.25 }, caption: 'How ATR scales your stop — drag to explore' },
      { type: 'pullquote', text: "Stops should match the chart, not your comfort." },
      { type: 'prose', text: "A good stop is where the setup is invalidated — below support, below the breakout level, below the moving average that held on the bounce. Not 'wherever I feel comfortable losing.'" },
      { type: 'callout', tone: 'red', label: 'The stop you don\'t set', text: "No stop → a 10% loss becomes 25%\nNo stop → a 25% loss becomes 50%\nNo stop → the trade ends your account" },
      { type: 'tip', text: "Write your stop down before you click buy. Say it out loud. When price gets there, honor it. That discipline is the entire game." },
    ],
    callout: {
      label: 'ATR-based stops',
      text: "A stop placed 2× ATR below entry adapts to the stock's normal volatility. Tight stocks get tight stops. Wild stocks get wider stops. Same math, different prices.",
    },
    tip: "Your stop is non-negotiable. When price gets there, you exit — no 'one more candle,' no hope.",
    quiz: {
      question: "You bought a stock at $3.00 with a stop at $2.70 (10% down). Price drops to $2.72 and bounces. You held. It then drops to $2.65 and keeps going. What should you do?",
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
    id: 'spark-loss',
    stage: 'Spark',
    order: 3,
    title: 'Losses are tuition',
    subtitle: "You just took one. Here's what it's actually worth.",
    duration: '3 min',
    icon: '💧',
    requiresBehavior: 'first_close',
    triggerOn: ['first_loss'],
    content: [
      "A loss is not a failure. It's the market charging you tuition for what you're about to learn.",
      "The only real losses are the ones you take lessons from. The ones you dismiss are pure cost.",
      "What matters is the pattern across many trades — not the outcome of any single one.",
    ],
    blocks: [
      { type: 'prose', text: "You just took your first loss. Welcome to being a trader." },
      { type: 'heading', text: "Losses are not failures" },
      { type: 'prose', text: "Every professional trader loses — often. The S&P 500's best-performing fund managers are wrong 45% of the time. Losing on a trade means you're doing the thing. Not losing means you're not doing the thing." },
      { type: 'pullquote', text: "The only losses that cost you nothing are the ones you learn from." },
      { type: 'prose', text: "Right now, your instinct is to revenge-trade. To get it back fast. That instinct is a bear trap built by evolution. The calm play is to half-size your next trade, not double it." },
      { type: 'callout', tone: 'red', label: 'What NOT to do after a loss', text: "1. Double your size on the next trade\n2. Switch to a totally different strategy\n3. Stop following your stop-loss plan\n4. Rage-buy the first thing that moves" },
      { type: 'prose', text: "What matters now is the pattern across your next 10 trades, not this one." },
      { type: 'tip', text: "Write down in your journal: what went wrong? Was your entry bad, was your stop too tight, did you break your own rules? The trade that taught you something was not a loss — it was tuition." },
    ],
    callout: {
      label: 'What matters',
      text: "Your emotional response to this loss is more important than the dollar amount.\n\nBreathe. Journal the trade. Keep your next position the same size. The discipline survives the trade.",
    },
    tip: "The trade is already gone. The lesson is what stays. Small size means the lesson is cheap.",
    quiz: {
      question: "You just closed your first losing trade for -12%. What's the right next move?",
      options: [
        "Double size on your next trade to get it back",
        "Take a small note on what went wrong, then make your next trade the same normal size",
        "Stop trading for a month to reset",
        "Switch to a different strategy that would have avoided this loss",
      ],
      correctIndex: 1,
      explanation: "Same size, disciplined execution, eyes on the pattern. Revenge-sizing is the single most account-destroying behavior. A month off breaks your learning loop. A strategy switch after one trade is overfitting to noise. The answer is always: same size, better execution, journal the lesson.",
    },
  },

  {
    id: 'spark-behavior',
    stage: 'Spark',
    order: 4,
    title: 'Complete your first trade',
    subtitle: 'Nothing replaces doing it once',
    duration: '—',
    icon: '🔥',
    requiresLesson: 'spark-2',
    requiresBehavior: 'first_trade',
    content: [
      "Reading about trading and actually doing it are different skills. Until you've logged a trade, felt the price move against you, and stayed with your plan — you're still theoretical.",
    ],
    quiz: {
      question: "You logged your first trade and it's down 3% an hour later. What does this tell you?",
      options: [
        "The trade is a loser and you should exit",
        "Normal intraday noise — the stock will be volatile and that's expected",
        "Your stop is too far away",
        "You picked the wrong stock",
      ],
      correctIndex: 1,
      explanation: "Small intraday moves mean nothing. Small-caps can easily swing 3–5% in a single hour without violating any setup. Your plan is your plan — stop out only if price hits your stop, otherwise let the setup develop.",
    },
  },

  // ─── EMBER ────────────────────────────────────────────────
  {
    id: 'ember-1',
    stage: 'Ember',
    order: 5,
    title: 'Win rate is a distraction',
    subtitle: "Risk-to-reward matters more than how often you're right",
    duration: '4 min',
    icon: '⚖️',
    requiresLesson: 'spark-behavior',
    triggerOn: ['stage_up'],
    content: [
      "Most new traders obsess over win rate. Professionals obsess over risk-to-reward.",
      "You can win 40% of your trades and still be profitable if your winners are 3× your losers.",
      "A 70% win rate with tiny winners and big losers is an account-destroyer.",
    ],
    blocks: [
      { type: 'prose', text: "You just leveled up to Ember. Time for the mental shift that separates gamblers from traders." },
      { type: 'heading', text: "The hidden variable" },
      { type: 'prose', text: "Everyone wants a high win rate. It feels good. But win rate alone tells you nothing about profitability." },
      { type: 'demo', demo: { kind: 'risk-reward-tilt' }, caption: 'Profitability = win rate × R:R — find the sweet spot' },
      { type: 'pullquote', text: "You can be wrong 60% of the time and still be rich." },
      { type: 'prose', text: "The pros have win rates in the 40–55% range. Their edge is that their winners are multiples of their losers. A 2:1 risk-reward ratio breaks even at a 33% win rate." },
      { type: 'callout', tone: 'gold', label: 'Break-even win rates', text: "1:1 R:R → need 50% win rate\n2:1 R:R → need 34% win rate\n3:1 R:R → need 25% win rate\n5:1 R:R → need 17% win rate" },
      { type: 'tip', text: "Optimize for setups where the target is at least 2× the distance to your stop. Pass on 1:1 setups. You don't need to trade every day." },
    ],
    callout: {
      label: 'The break-even math',
      text: "Win 50% at 1:1 R:R → break-even\nWin 40% at 2:1 R:R → +20% edge\nWin 30% at 3:1 R:R → +20% edge\n\nWin rate alone tells you nothing.",
    },
    tip: "When evaluating a setup, ask: 'Is my target at least 2× as far from entry as my stop?' If no, skip it.",
    quiz: {
      question: "You have two strategies. A wins 70% of the time at 1:1 R:R. B wins 40% at 3:1 R:R. Which is more profitable over 100 trades?",
      options: [
        "A — higher win rate is always better",
        "B — winning 40% at 3:1 creates a larger total edge than winning 70% at 1:1",
        "They're the same — 70 and 40 × 3 are both positive-expectancy",
        "Depends on which stocks you're trading",
      ],
      correctIndex: 1,
      explanation: "Strategy A: 70 wins × 1 unit − 30 losses × 1 unit = +40 units. Strategy B: 40 wins × 3 units − 60 losses × 1 unit = +60 units. B wins by 50%. This is why professional traders accept being wrong often — they've built their edge on the size of their wins, not the frequency.",
    },
  },

  {
    id: 'ember-behavior',
    stage: 'Ember',
    order: 6,
    title: 'Close a winning trade',
    subtitle: 'Experience a full profitable cycle',
    duration: '—',
    icon: '💰',
    requiresLesson: 'ember-1',
    requiresBehavior: 'first_close',
    triggerOn: ['first_win'],
    content: [
      "Feel what it's like to execute your plan end-to-end. The entry, the wait, the exit at your target. Repeatable.",
    ],
    quiz: {
      question: "Your trade hit your target and you closed it for a 35% gain. The stock keeps rising. What's the right mindset?",
      options: [
        "Frustration — you left money on the table",
        "You executed your plan correctly. Selling at your target is the goal, not selling at the top",
        "Next time you should hold longer",
        "You should have set a higher target",
      ],
      correctIndex: 1,
      explanation: "No one sells at the exact top. If you set a target, the stock reached it, and you took profits — that's a successful trade by definition. Discipline over greed.",
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
    triggerOn: ['stage_up'],
    content: [
      "Chasing a move is buying a stock because it's already gone up.",
      "The entry zone is the price range where the risk/reward makes sense.",
      "Patience is the skill here.",
    ],
    callout: {
      label: 'Entry zone vs chasing',
      text: "Good entry: Stock breaks $2.50, buy at $2.55. Stop $2.35. Target $3.20. Risk 8%, Reward 25%.\n\nChasing: Same setup, buy at $2.90. Stop still $2.35. Risk 19%, Reward 10%.",
    },
    tip: "If you miss the entry zone, let it go. Set an alert for a pullback and wait.",
    quiz: {
      question: "A stock breaks $4.00 with high volume. By the time you see it, it's at $4.60. The council's target is $5.20. Enter?",
      options: [
        "Yes — the target is still above current price",
        "No — risk-to-reward is now unfavorable; wait for a pullback to the breakout zone",
        "Yes but with a tighter stop",
        "Yes but with half size",
      ],
      correctIndex: 1,
      explanation: "At $4.60, your stop must still be below the breakout at around $3.80 (19% risk). Your target is $5.20 (13% reward). That's 1:0.7 R:R — worse than a coin flip. The discipline is to let the trade go and wait for a pullback that resets the R:R to favorable.",
    },
  },

  {
    id: 'flame-2',
    stage: 'Flame',
    order: 8,
    title: "Taking profits — the target is the target",
    subtitle: 'Why honoring your plan beats chasing every candle',
    duration: '3 min',
    icon: '🎯',
    requiresLesson: 'flame-1',
    content: [
      "When a stock reaches your target, sell at least a portion. The feeling that 'it still has room' is not a strategy.",
      "Take half at target, trail a stop on the rest if you want to stay in.",
    ],
    callout: {
      label: 'The professional exit',
      text: "Plan: Entry $1.80, stop $1.55, target $2.50.\n\nAt $2.50: sell half (+39%), move stop on remainder to $2.20 (breakeven-plus). You can't lose the trade now. Upside is free.",
    },
    tip: "The feeling that a stock 'still has room' is not a strategy. Your target is your target.",
    quiz: {
      question: "You bought at $1.80. Your target was $2.50. It hits $2.50 but looks strong. What do you do?",
      options: [
        "Hold everything — the setup looks great",
        "Take at least partial profits at your target. If you want to stay in, sell half and trail a stop on the rest",
        "Move your target to $3.50 and hold",
        "Sell immediately",
      ],
      correctIndex: 1,
      explanation: "Plan said $2.50. Honor it. Half off locks in the gain, trailing stop on the remainder gives you free upside. All-or-nothing is gambling.",
    },
  },

  {
    id: 'flame-tilt',
    stage: 'Flame',
    order: 9,
    title: "Three losses in a row — read this now",
    subtitle: 'Recognizing the tilt pattern before it destroys your account',
    duration: '3 min',
    icon: '⚠️',
    triggerOn: ['three_losses_in_row'],
    content: [
      "Three losses in a row is the most dangerous psychological moment in trading.",
      "Your brain is screaming to 'get it back.' That instinct has killed more accounts than any market crash.",
      "The correct response is counterintuitive: half-size, slow down, review.",
    ],
    blocks: [
      { type: 'prose', text: "Three losses in a row. You're feeling it now — the itch to get it back fast. The voice saying 'I'm due.'" },
      { type: 'heading', text: "This is the most dangerous moment" },
      { type: 'prose', text: "Statistically, this is where traders blow up their accounts. Not on the losses themselves — on what they do next. Revenge trading destroys more capital than any single bad trade ever could." },
      { type: 'pullquote', text: "You are not 'due.' The market does not owe you anything." },
      { type: 'callout', tone: 'red', label: 'The tilt protocol', text: "1. No new trades for the rest of today\n2. Review your last 3 entries — pattern?\n3. Half-size your next 3 trades\n4. Return to full size only after 2 winners" },
      { type: 'prose', text: "The difference between traders who survive this moment and traders who don't is the ability to do less, not more." },
      { type: 'tip', text: "If you can't stop yourself from trading right now, at minimum cut your size in half. Your next trade should be 50% of what it would normally be. This is not optional." },
    ],
    callout: {
      label: 'The tilt protocol',
      text: "1. No new trades today\n2. Review last 3 entries\n3. Half-size next 3 trades\n4. Full size only after 2 winners",
    },
    tip: "The trader who survives this moment is the one who does less, not more.",
    quiz: {
      question: "You've just taken 3 losses in a row for a total of -18% on your account. What's the professional response?",
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

  // ─── BLAZE ────────────────────────────────────────────────
  {
    id: 'blaze-1',
    stage: 'Blaze',
    order: 10,
    title: 'Expectancy — the only number that matters',
    subtitle: 'Making win rate, R:R, and frequency work together',
    duration: '4 min',
    icon: '📐',
    requiresLesson: 'flame-2',
    triggerOn: ['stage_up'],
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
  const STAGE_ORDER = ['Spark', 'Ember', 'Flame', 'Blaze', 'Inferno', 'Free']
  const stageIdx = STAGE_ORDER.indexOf(currentStage)

  return INVEST_LESSONS.map(lesson => {
    const lessonStageIdx = STAGE_ORDER.indexOf(lesson.stage)

    if (lessonStageIdx > stageIdx) {
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
