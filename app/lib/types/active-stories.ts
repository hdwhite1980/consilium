// =============================================================
// app/lib/types/active-stories.ts
//
// Type contracts for the Active Stories system.
// Imported by:
//   - The cron route (when parsing LLM output)
//   - The frontend (when rendering the unified Active Stories page)
//   - The classifier prompt builder (so prompt and types stay in sync)
// =============================================================

import type {
  Signal,
  SessionAnchor,
  AssetType,
  Magnitude,
  RiskLevel,
  Timeframe,
  TrackedStory,
} from '@/app/lib/story-tracker'

// ─────────────────────────────────────────────────────────────
// LLM output shape
// ─────────────────────────────────────────────────────────────

/**
 * What Claude must return on each cron run.
 * The cron route parses this, applies it to the DB via story-tracker
 * helpers, then runs verification on top stories.
 */
export interface LLMClassificationOutput {
  // Updates to existing stories (from the input list of active stories)
  storyUpdates: Array<{
    storyId: string             // matches an existing story's id
    note: string                // brief description of what's new
    newSignal?: Signal          // only if directional read changed
    newConfidence?: number      // 0-100, only if conviction shifted
    markPlayingOut?: boolean    // catalyst is unfolding right now
    markResolved?: boolean      // catalyst played out, story over
    resolutionReason?: string   // required if markResolved=true
  }>

  // New stories that emerged this run
  newStories: Array<{
    ticker: string
    companyName?: string
    assetType?: AssetType
    signal: Signal
    confidence: number          // 0-100, must be ≥ 60 to keep
    magnitude?: Magnitude
    timeframes: Timeframe[]     // ['1D'] or ['1D','1W'] etc — the trade horizons
    sessionAnchor: SessionAnchor // 'today' | 'tomorrow' | 'weekend' — when catalyst hits
    catalyst?: string
    reason?: string
    headline?: string
    riskLevel?: RiskLevel
  }>

  // Top-level run metadata for observability + dashboard display
  marketTheme: string            // single dominant theme this run
  marketStatus: string           // one sentence on overall market mood
  summary: string                // 2-3 sentences — the most important takeaways
}

// ─────────────────────────────────────────────────────────────
// Frontend dashboard shape
// ─────────────────────────────────────────────────────────────

/**
 * Output of the GET endpoint that the unified Active Stories page reads.
 * Stories are returned as a flat list; the frontend filters by
 * sessionAnchor (toggle) and groups within each session by timeframe.
 */
export interface ActiveStoriesPayload {
  generatedAt: string            // ISO of the most recent cron run
  lastRunSource: string          // 'cron_6am' | 'cron_12pm' | etc
  marketTheme: string
  marketStatus: string
  summary: string
  stories: TrackedStory[]        // active + playing_out, sorted by confidence desc
  counts: {
    total: number
    bySession: Record<SessionAnchor, number>
    byTimeframe: Record<Timeframe, number>
    bySignal: Record<Signal, number>
  }
}

// ─────────────────────────────────────────────────────────────
// Re-export commonly used types so consumers can import from one place
// ─────────────────────────────────────────────────────────────

export type {
  Signal,
  SessionAnchor,
  AssetType,
  Magnitude,
  RiskLevel,
  Timeframe,
  TrackedStory,
} from '@/app/lib/story-tracker'
