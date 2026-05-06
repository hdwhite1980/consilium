// =============================================================
// app/lib/system-versions.ts
//
// System version registry — single source of truth for version
// metadata that both the dashboard widget and the /track-record
// page consume.
//
// To ship a new version:
//   1. Bump the version_number in the cron / verdict insertion code
//   2. Add an entry here describing what changed (user-facing)
//   3. That's it — UI updates automatically
//
// USER-FACING COPY GUIDELINES:
//   - Describe what's better for the user, not what was broken
//   - Avoid implementation language ("we now query EDGAR", "fixed
//     a Form 4 classification bug", "Trader prompt updated")
//   - Lead with the user benefit
//   - 3-5 bullets per version is the sweet spot
//
// Internal notes can go in the `internalTags` field — those are
// for our reference, never rendered.
// =============================================================

export type SystemVersionMaturity = 'preview' | 'mature' | 'historical'

export interface SystemVersion {
  /** Integer that matches verdict_log.version_number */
  number: number

  /** Display name — short. Used in dropdowns. */
  label: string

  /** Optional subtitle for richer displays */
  subtitle?: string

  /** ISO date the version became active */
  releasedAt: string

  /** User-facing summary in 1 sentence */
  summary: string

  /** 3-5 user-facing bullets describing what improved.
   *  These get rendered on the track-record page. */
  improvements: string[]

  /** Sample-size + maturity hint for UI honesty.
   *  - 'preview' = too few graded outcomes to evaluate (default for new versions)
   *  - 'mature'  = enough graded outcomes to draw conclusions (~30+ verdicts)
   *  - 'historical' = previous version, retained for baseline comparison */
  maturity: SystemVersionMaturity

  /** Internal-only tags for our reference. Never rendered to users. */
  internalTags?: string[]
}

// ─────────────────────────────────────────────────────────────
// Version registry
// ─────────────────────────────────────────────────────────────

export const SYSTEM_VERSIONS: SystemVersion[] = [
  {
    number: 3,
    label: 'Version 3',
    subtitle: 'Smarter evidence gathering',
    releasedAt: '2026-05-04',
    summary: 'Doubled the breadth of evidence gathered per verdict, with better discipline around insider activity and earnings risk.',
    improvements: [
      'Each verdict now considers a wider range of evidence per round of analysis',
      'Refined how we read insider transactions to separate executive trades from large fund rebalancing',
      'Trade plans now adjust risk parameters by holding period (1D, 1W, 1M, 3M)',
      'Better recognition of when insider activity is statistically meaningful versus routine',
      'Improved continuity — repeated analyses on the same ticker explore complementary angles instead of repeating',
      'Smarter framing of stocks that have already moved on a recent catalyst — distinguishes fresh setups from continuation trades and calibrates confidence accordingly',
    ],
    maturity: 'preview',
    internalTags: ['bugs-5,7,9,10,11,12,13,14,15,16,17,18,19', 'first-multi-question-r2', 'post-catalyst-awareness'],
  },
  {
    number: 2,
    label: 'Version 2',
    subtitle: 'Initial Council architecture',
    releasedAt: '2026-04-01',
    summary: 'The original four-stage Council with single-pass research and basic risk filters.',
    improvements: [
      'Multi-persona Council with Lead Analyst, Devil\'s Advocate, and Judge',
      'Quantitative conviction engine alongside qualitative reasoning',
      'Trade plan generation with entry, stop, and target levels',
      'Earnings-aware risk filtering',
    ],
    maturity: 'historical',
    internalTags: ['baseline'],
  },
]

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

/** Return the most recent (highest-numbered) version. */
export function getCurrentVersion(): SystemVersion {
  if (SYSTEM_VERSIONS.length === 0) {
    throw new Error('SYSTEM_VERSIONS registry is empty — at least one version must be defined')
  }
  return SYSTEM_VERSIONS.reduce((max, v) => (v.number > max.number ? v : max))
}

/** Look up a version by number. Returns null if not registered. */
export function getVersionByNumber(n: number): SystemVersion | null {
  return SYSTEM_VERSIONS.find(v => v.number === n) ?? null
}

/** Versions sorted newest-first. Useful for timeline rendering. */
export function getVersionsNewestFirst(): SystemVersion[] {
  return [...SYSTEM_VERSIONS].sort((a, b) => b.number - a.number)
}

/** Default version_number used when inserting fresh verdicts. */
export const CURRENT_VERSION_NUMBER = getCurrentVersion().number
