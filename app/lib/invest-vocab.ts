// ═════════════════════════════════════════════════════════════
// app/lib/invest-vocab.ts
//
// Plain-English definitions of trading terms surfaced in /invest.
// Every definition follows three rules:
//   1. ONE sentence first that gets the idea across.
//   2. Optionally followed by a short clarifier with a concrete example.
//   3. Never assume prior knowledge of OTHER trading terms.
//
// Tone: matter-of-fact, no jargon, no marketing language. Goal is for
// someone who just opened a Robinhood account this week to nod and move on.
// ═════════════════════════════════════════════════════════════

export interface VocabDef {
  /** The term as displayed (capitalization preserved). */
  term: string
  /** One-sentence plain-English definition. */
  short: string
  /** Optional 1-2 sentence elaboration with a concrete example. */
  long?: string
  /** Optional related terms the user might also want to look up. */
  see?: string[]
}

export const VOCAB: Record<string, VocabDef> = {
  // ── Order ticket terms ──
  stop: {
    term: 'Stop',
    short: 'A price you decide in advance — if the stock falls to it, you sell to cap your loss.',
    long: 'Example: you buy at $10 and set a stop at $9. If it drops to $9, you exit. The stop is the discipline that keeps a small loss from becoming a big one.',
    see: ['target'],
  },
  target: {
    term: 'Target',
    short: 'A price where you plan to take profits if the trade works.',
    long: 'Example: you buy at $10 with a target of $12. If it reaches $12, you sell. Setting a target before you enter forces you to think about reward, not just hope.',
    see: ['stop'],
  },
  rationale: {
    term: 'Rationale',
    short: 'Your reason for taking the trade — written down before you click.',
    long: 'Forcing yourself to write the WHY filters out impulse trades. If you can\'t explain it in a sentence, you probably shouldn\'t take it.',
  },
  thesis: {
    term: 'Thesis',
    short: 'Your reason for taking the trade — same idea as rationale, more formal name.',
  },
  shares: {
    term: 'Shares',
    short: 'How many units of the stock you bought.',
    long: 'If you bought 50 shares of a $4 stock, that\'s $200 worth. Not all stocks let you buy fractional shares.',
  },

  // ── Mark to market ──
  'mark to market': {
    term: 'Mark to Market',
    short: 'Closing a trade by recording the actual price you sold at.',
    long: 'When you close a position, the desk asks for your real exit price so it can calculate the actual gain or loss. "Mark" means the recorded price; "to market" means at the price the market gave you.',
  },
  realized: {
    term: 'Realized',
    short: 'Profit or loss from trades you\'ve already closed — locked in, real money.',
    see: ['unrealized'],
  },
  unrealized: {
    term: 'Unrealized',
    short: 'Profit or loss on trades you still hold — not real until you sell.',
    long: 'A stock up 20% on paper is unrealized — if it crashes tomorrow, the gain disappears. You only know your true return when the trade closes.',
    see: ['realized'],
  },

  // ── Stats / scoring ──
  'win rate': {
    term: 'Win Rate',
    short: 'The percentage of your closed trades that made money.',
    long: 'A 50% win rate means half your trades won. You can be profitable below 50% if your wins are bigger than your losses.',
  },
  streak: {
    term: 'Streak',
    short: 'Consecutive wins (or losses) without a break.',
  },
  'process score': {
    term: 'Process Score',
    short: 'A grade for HOW you traded, not whether you won.',
    long: 'A lucky win with bad process gets a low grade. An unlucky loss with good process gets a high grade. The process is what you can control; the outcome isn\'t.',
  },

  // ── Verdict language ──
  bullish: {
    term: 'Bullish',
    short: 'Expecting the price to go UP.',
    see: ['bearish'],
  },
  bearish: {
    term: 'Bearish',
    short: 'Expecting the price to go DOWN.',
    see: ['bullish'],
  },
  confidence: {
    term: 'Confidence',
    short: 'How strongly the analysis supports the verdict — higher means stronger evidence.',
  },

  // ── Options vocabulary (Operator+ tier) ──
  call: {
    term: 'Call',
    short: 'A bet that the stock will go UP — you profit if the stock rises above your strike price before expiry.',
    see: ['put', 'strike', 'expiry'],
  },
  put: {
    term: 'Put',
    short: 'A bet that the stock will go DOWN — you profit if the stock falls below your strike price before expiry.',
    see: ['call', 'strike', 'expiry'],
  },
  strike: {
    term: 'Strike',
    short: 'The price the option contract uses as its reference point.',
    long: 'A $10 call lets you buy the stock at $10 even if the market price is $15. The "strike" is that $10 reference.',
  },
  expiry: {
    term: 'Expiry',
    short: 'The date the option contract dies — after this date, it\'s worthless.',
    long: 'Options decay over time. The closer you get to expiry, the faster the value drops if the stock isn\'t moving in your direction.',
    see: ['dte'],
  },
  premium: {
    term: 'Premium',
    short: 'The price you pay for one share of the option contract.',
    long: 'A $0.50 premium means each share of the contract costs 50 cents. One contract is 100 shares, so it costs $50 total.',
  },
  contracts: {
    term: 'Contracts',
    short: 'How many option contracts you bought. Each contract represents 100 shares.',
    long: 'If premium is $0.50 and you buy 1 contract, you pay $50 (0.50 × 100). 2 contracts = $100.',
  },
  dte: {
    term: 'DTE',
    short: 'Days To Expiry — how many days are left before the option contract expires.',
    see: ['expiry'],
  },

  // ── Council / desk vocabulary ──
  council: {
    term: 'The Council',
    short: 'The set of AI analysts that produces today\'s setups: a lead view, a devil\'s advocate, a news scout, and a judge.',
  },
  setup: {
    term: 'Setup',
    short: 'A trade idea — ticker, entry price, stop, and target — that meets the desk\'s criteria.',
  },
  signal: {
    term: 'Signal',
    short: 'The verdict from the Council on a setup — bullish, bearish, or neutral.',
  },

  // ── Tier vocabulary ──
  'book value': {
    term: 'Book Value',
    short: 'The total value of your account — cash plus the current value of all open positions.',
  },
  tier: {
    term: 'Tier',
    short: 'Your level on the desk: Buyer, Builder, Operator, Principal, or Sovereign — based on book value and demonstrated discipline.',
  },
}

// ─────────────────────────────────────────────────────────────
// Lookup helper — case-insensitive, handles plurals.
// ─────────────────────────────────────────────────────────────
export function lookupVocab(term: string): VocabDef | null {
  const key = term.trim().toLowerCase()
  if (VOCAB[key]) return VOCAB[key]

  // Strip trailing 's' for simple plurals
  if (key.endsWith('s') && VOCAB[key.slice(0, -1)]) {
    return VOCAB[key.slice(0, -1)]
  }

  return null
}
