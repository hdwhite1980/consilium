// =============================================================
// app/lib/story-tracker.ts
//
// Core library for the Active Stories tracking system.
// Used by the cron job that runs 4× daily and by any route that
// needs to read or update the active stories pool.
//
// Architecture:
//   - LLM-driven decay: stories live until LLM marks them resolved.
//   - Time cap: per-timeframe ceiling (1D=36h, 1W=10d, 1M=45d, 3M=100d).
//   - Idle expiry: stories not touched by LLM in 7 consecutive runs
//     get auto-resolved (the LLM forgetting = signal it's no longer relevant).
//   - Hard cap: max 40 active stories. When at cap, oldest force-resolved
//     before new stories are added.
//
// All decay paths converge through markResolved() with a `resolved_by`
// reason for audit trail.
// =============================================================

import { createClient as createAdmin } from '@supabase/supabase-js'

// ─────────────────────────────────────────────────────────────
// Configuration constants
// ─────────────────────────────────────────────────────────────

/** Time cap by primary timeframe — story auto-resolved if older than this regardless of LLM. */
export const TIMEFRAME_TIME_CAPS_MS: Record<string, number> = {
  '1D':  36 * 60 * 60 * 1000,        // 36 hours
  '1W':  10 * 24 * 60 * 60 * 1000,   // 10 days
  '1M':  45 * 24 * 60 * 60 * 1000,   // 45 days
  '3M': 100 * 24 * 60 * 60 * 1000,   // 100 days
}

/** Max active stories. When at cap, oldest gets force-resolved before adding new. */
export const HARD_CAP = 40

/** Idle expiry threshold — stories not touched in this many consecutive runs auto-resolve. */
export const IDLE_RUN_THRESHOLD = 7

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

export type Signal = 'BULLISH' | 'BEARISH' | 'NEUTRAL'
export type Status = 'active' | 'playing_out' | 'resolved'
export type SessionAnchor = 'today' | 'tomorrow' | 'weekend'
export type AssetType = 'stock' | 'crypto' | 'forex'
export type Magnitude = 'high' | 'medium' | 'low'
export type RiskLevel = 'high' | 'medium' | 'low'
export type Timeframe = '1D' | '1W' | '1M' | '3M'
export type ResolvedBy = 'llm' | 'time_cap' | 'idle_expiry' | 'overflow'

export interface StoryUpdate {
  ts: string                 // ISO timestamp
  note: string               // What the LLM wants to flag about this run
  signalChange?: Signal      // If signal changed, the new value
  confidenceChange?: number  // If confidence changed, the new value
  runId: number              // Monotonic run ID for traceability
}

export interface TrackedStory {
  id: string
  ticker: string
  companyName: string | null
  assetType: AssetType
  signal: Signal
  confidence: number
  magnitude: Magnitude | null
  status: Status
  timeframes: Timeframe[]
  sessionAnchor: SessionAnchor
  catalyst: string | null
  reason: string | null
  headline: string | null
  riskLevel: RiskLevel | null
  firstSeen: string
  lastUpdated: string
  lastTouchedRun: number
  updates: StoryUpdate[]
  verified: boolean | null
  verificationSources: string[] | null
  verificationNote: string | null
  /** Spot price when the story was first created (immutable audit trail). Null if lookup failed. */
  entryPrice: number | null
  /** ISO timestamp the entry price was captured (~= firstSeen). Null if entry_price is null. */
  entryPriceAt: string | null
  resolvedAt: string | null
  resolutionReason: string | null
  resolvedBy: ResolvedBy | null
}

/** Shape that the LLM produces for a NEW story. Caller injects entryPrice after the price lookup. */
export interface NewStoryInput {
  ticker: string
  companyName?: string
  assetType?: AssetType
  signal: Signal
  confidence: number
  magnitude?: Magnitude
  timeframes: Timeframe[]
  sessionAnchor: SessionAnchor
  catalyst?: string
  reason?: string
  headline?: string
  riskLevel?: RiskLevel
  /** Spot price at the moment of creation. Caller (cron route) fetches via fetchCurrentPrice() before passing. */
  entryPrice?: number | null
  /** ISO timestamp of the entry-price lookup. */
  entryPriceAt?: string | null
}

/** Shape the LLM produces when updating an existing story. */
export interface StoryUpdateInput {
  storyId: string
  note: string
  newSignal?: Signal
  newConfidence?: number
  markPlayingOut?: boolean   // intermediate state — catalyst is unfolding
  markResolved?: boolean     // catalyst played out, resolution_reason expected
  resolutionReason?: string
}

export interface RunSummary {
  runId: number
  storiesActiveBefore: number
  storiesActiveAfter: number
  storiesAdded: number
  storiesUpdated: number
  storiesResolved: number
  storiesForceResolved: number
  durationMs: number
}

// ─────────────────────────────────────────────────────────────
// Supabase client (admin/service-role for server-side cron access)
// ─────────────────────────────────────────────────────────────

function getAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    throw new Error('Missing Supabase env vars (NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY)')
  }
  return createAdmin(url, key)
}

// ─────────────────────────────────────────────────────────────
// DB row → typed object
// ─────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rowToStory(r: any): TrackedStory {
  // Postgres NUMERIC columns may serialize as strings depending on driver — coerce defensively
  const entryPriceRaw = r.entry_price
  const entryPrice =
    entryPriceRaw === null || entryPriceRaw === undefined
      ? null
      : typeof entryPriceRaw === 'number'
        ? entryPriceRaw
        : Number(entryPriceRaw)

  return {
    id: r.id,
    ticker: r.ticker,
    companyName: r.company_name ?? null,
    assetType: r.asset_type ?? 'stock',
    signal: r.signal,
    confidence: r.confidence,
    magnitude: r.magnitude ?? null,
    status: r.status,
    timeframes: r.timeframes ?? [],
    sessionAnchor: r.session_anchor ?? 'today',
    catalyst: r.catalyst ?? null,
    reason: r.reason ?? null,
    headline: r.headline ?? null,
    riskLevel: r.risk_level ?? null,
    firstSeen: r.first_seen,
    lastUpdated: r.last_updated,
    lastTouchedRun: r.last_touched_run ?? 0,
    updates: Array.isArray(r.updates) ? r.updates : [],
    verified: r.verified ?? null,
    verificationSources: r.verification_sources ?? null,
    verificationNote: r.verification_note ?? null,
    entryPrice: Number.isFinite(entryPrice) ? entryPrice : null,
    entryPriceAt: r.entry_price_at ?? null,
    resolvedAt: r.resolved_at ?? null,
    resolutionReason: r.resolution_reason ?? null,
    resolvedBy: r.resolved_by ?? null,
  }
}

// ─────────────────────────────────────────────────────────────
// Read helpers
// ─────────────────────────────────────────────────────────────

/**
 * Load all currently-active or playing-out stories.
 * Used at the start of each cron run so the LLM sees existing context.
 */
export async function loadActiveStories(): Promise<TrackedStory[]> {
  const admin = getAdmin()
  const { data, error } = await admin
    .from('tracked_stories')
    .select('*')
    .in('status', ['active', 'playing_out'])
    .order('last_updated', { ascending: false })
  if (error) throw new Error(`loadActiveStories failed: ${error.message}`)
  return (data ?? []).map(rowToStory)
}

/**
 * Load stories filtered by session anchor — used by the dashboard route.
 * Only returns active/playing_out (no resolved).
 */
export async function loadStoriesBySession(
  sessionAnchor: SessionAnchor,
): Promise<TrackedStory[]> {
  const admin = getAdmin()
  const { data, error } = await admin
    .from('tracked_stories')
    .select('*')
    .eq('session_anchor', sessionAnchor)
    .in('status', ['active', 'playing_out'])
    .order('confidence', { ascending: false })
  if (error) throw new Error(`loadStoriesBySession failed: ${error.message}`)
  return (data ?? []).map(rowToStory)
}

/**
 * Find an existing story for a ticker + similar catalyst.
 * Used so the LLM doesn't accidentally create duplicates when news
 * about the same situation appears across runs. Returns the most
 * recently updated active story for the ticker, or null.
 */
export async function findActiveStoryForTicker(
  ticker: string,
): Promise<TrackedStory | null> {
  const admin = getAdmin()
  const { data, error } = await admin
    .from('tracked_stories')
    .select('*')
    .eq('ticker', ticker.toUpperCase())
    .in('status', ['active', 'playing_out'])
    .order('last_updated', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw new Error(`findActiveStoryForTicker failed: ${error.message}`)
  return data ? rowToStory(data) : null
}

// ─────────────────────────────────────────────────────────────
// Write helpers
// ─────────────────────────────────────────────────────────────

/**
 * Insert a new story.
 * Returns the inserted row's id.
 * Does NOT enforce hard cap — caller (cron) does that explicitly via enforceHardCap.
 */
export async function insertStory(input: NewStoryInput, runId: number): Promise<string> {
  const admin = getAdmin()
  const { data, error } = await admin
    .from('tracked_stories')
    .insert({
      ticker: input.ticker.toUpperCase(),
      company_name: input.companyName ?? null,
      asset_type: input.assetType ?? 'stock',
      signal: input.signal,
      confidence: input.confidence,
      magnitude: input.magnitude ?? null,
      timeframes: input.timeframes,
      session_anchor: input.sessionAnchor,
      catalyst: input.catalyst ?? null,
      reason: input.reason ?? null,
      headline: input.headline ?? null,
      risk_level: input.riskLevel ?? null,
      last_touched_run: runId,
      updates: [],
      entry_price: input.entryPrice ?? null,
      entry_price_at: input.entryPriceAt ?? null,
    })
    .select('id')
    .single()
  if (error) throw new Error(`insertStory failed: ${error.message}`)
  return data.id
}

/**
 * Update an existing story. Append to its updates array, optionally
 * change signal/confidence/status. Used both by LLM-driven updates
 * and by automatic resolution (time cap, idle, overflow).
 */
export async function updateStory(
  input: StoryUpdateInput,
  runId: number,
): Promise<void> {
  const admin = getAdmin()

  // Read existing to merge updates
  const { data: existing, error: readErr } = await admin
    .from('tracked_stories')
    .select('updates, signal, confidence')
    .eq('id', input.storyId)
    .single()
  if (readErr) throw new Error(`updateStory read failed: ${readErr.message}`)

  const existingUpdates: StoryUpdate[] = Array.isArray(existing?.updates) ? existing.updates : []
  const newUpdate: StoryUpdate = {
    ts: new Date().toISOString(),
    note: input.note,
    runId,
  }
  if (input.newSignal && input.newSignal !== existing.signal) {
    newUpdate.signalChange = input.newSignal
  }
  if (input.newConfidence !== undefined && input.newConfidence !== existing.confidence) {
    newUpdate.confidenceChange = input.newConfidence
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const updateRow: any = {
    updates: [...existingUpdates, newUpdate],
    last_touched_run: runId,
  }
  if (input.newSignal) updateRow.signal = input.newSignal
  if (input.newConfidence !== undefined) updateRow.confidence = input.newConfidence
  if (input.markPlayingOut) updateRow.status = 'playing_out'
  if (input.markResolved) {
    updateRow.status = 'resolved'
    updateRow.resolved_at = new Date().toISOString()
    updateRow.resolution_reason = input.resolutionReason ?? 'LLM marked resolved'
    updateRow.resolved_by = 'llm'
  }

  const { error: writeErr } = await admin
    .from('tracked_stories')
    .update(updateRow)
    .eq('id', input.storyId)
  if (writeErr) throw new Error(`updateStory write failed: ${writeErr.message}`)
}

/**
 * Mark a story resolved with explicit non-LLM reason (time cap, idle, overflow).
 * Centralized so the audit trail (`resolved_by`) is consistent.
 */
export async function markResolved(
  storyId: string,
  resolvedBy: ResolvedBy,
  reason: string,
): Promise<void> {
  const admin = getAdmin()
  const { error } = await admin
    .from('tracked_stories')
    .update({
      status: 'resolved',
      resolved_at: new Date().toISOString(),
      resolution_reason: reason,
      resolved_by: resolvedBy,
    })
    .eq('id', storyId)
    .in('status', ['active', 'playing_out'])  // don't overwrite already-resolved
  if (error) throw new Error(`markResolved failed: ${error.message}`)
}

// ─────────────────────────────────────────────────────────────
// Decay enforcement helpers
// ─────────────────────────────────────────────────────────────

/**
 * Sweep stories that have exceeded their timeframe time cap.
 * For multi-timeframe stories, uses the LARGEST timeframe's cap
 * (most permissive — story stays alive while ANY of its tagged horizons
 * is still in window).
 *
 * Returns count of stories force-resolved.
 */
export async function expireTimeCapped(): Promise<number> {
  const stories = await loadActiveStories()
  let count = 0
  const now = Date.now()
  for (const s of stories) {
    const firstSeenMs = new Date(s.firstSeen).getTime()
    const ageMs = now - firstSeenMs
    // Find the most permissive cap among the story's timeframes
    let maxCap = 0
    for (const tf of s.timeframes) {
      const cap = TIMEFRAME_TIME_CAPS_MS[tf] ?? 0
      if (cap > maxCap) maxCap = cap
    }
    // Default to 1W cap if timeframes are absent or unknown
    if (maxCap === 0) maxCap = TIMEFRAME_TIME_CAPS_MS['1W']
    if (ageMs > maxCap) {
      await markResolved(
        s.id,
        'time_cap',
        `Auto-resolved: exceeded ${formatMs(maxCap)} time cap for timeframes [${s.timeframes.join(',')}]`,
      )
      count++
    }
  }
  return count
}

/**
 * Sweep stories that haven't been touched by the LLM in IDLE_RUN_THRESHOLD
 * consecutive runs. The reasoning: if the LLM keeps seeing the story in its
 * input and never updates it, the story is no longer materially relevant.
 *
 * Returns count of stories force-resolved.
 */
export async function expireIdle(currentRunId: number): Promise<number> {
  const stories = await loadActiveStories()
  let count = 0
  const threshold = currentRunId - IDLE_RUN_THRESHOLD
  for (const s of stories) {
    if (s.lastTouchedRun > 0 && s.lastTouchedRun < threshold) {
      const runsIdle = currentRunId - s.lastTouchedRun
      await markResolved(
        s.id,
        'idle_expiry',
        `Auto-resolved: untouched by LLM for ${runsIdle} consecutive runs (threshold: ${IDLE_RUN_THRESHOLD})`,
      )
      count++
    }
  }
  return count
}

/**
 * Enforce the hard cap. If active count exceeds HARD_CAP, force-resolve
 * the oldest stories (by last_updated) until at cap.
 *
 * Run this BEFORE inserting new stories in a cron run, so we make space.
 *
 * Returns count of stories force-resolved.
 */
export async function enforceHardCap(): Promise<number> {
  const stories = await loadActiveStories()
  if (stories.length < HARD_CAP) return 0
  // Sort oldest first (oldest = lowest last_updated)
  const sorted = [...stories].sort(
    (a, b) => new Date(a.lastUpdated).getTime() - new Date(b.lastUpdated).getTime(),
  )
  const toEvict = sorted.slice(0, stories.length - HARD_CAP + 1)  // +1 to make room for at least one new
  for (const s of toEvict) {
    await markResolved(
      s.id,
      'overflow',
      `Auto-resolved: hard cap (${HARD_CAP}) reached, oldest story evicted to make room for fresh classification`,
    )
  }
  return toEvict.length
}

// ─────────────────────────────────────────────────────────────
// Run-log helpers
// ─────────────────────────────────────────────────────────────

/**
 * Start a new run. Returns the monotonic runId that all writes during
 * this run should reference.
 */
export async function startRun(triggerSource: string): Promise<number> {
  const admin = getAdmin()
  const { data, error } = await admin
    .from('tracked_stories_run_log')
    .insert({ trigger_source: triggerSource })
    .select('run_id')
    .single()
  if (error) throw new Error(`startRun failed: ${error.message}`)
  return data.run_id
}

/**
 * Finish a run — record summary statistics for observability.
 * Errors here are non-fatal; we don't want a logging failure to take
 * down the actual story-tracking work.
 */
export async function finishRun(runId: number, summary: RunSummary, errorMessage?: string): Promise<void> {
  const admin = getAdmin()
  await admin
    .from('tracked_stories_run_log')
    .update({
      stories_active_before: summary.storiesActiveBefore,
      stories_active_after: summary.storiesActiveAfter,
      stories_added: summary.storiesAdded,
      stories_updated: summary.storiesUpdated,
      stories_resolved: summary.storiesResolved,
      stories_force_resolved: summary.storiesForceResolved,
      duration_ms: summary.durationMs,
      error_message: errorMessage ?? null,
    })
    .eq('run_id', runId)
    .then(undefined, (e: Error) => console.warn('[story-tracker] finishRun log failed:', e.message))
}

// ─────────────────────────────────────────────────────────────
// Utility
// ─────────────────────────────────────────────────────────────

function formatMs(ms: number): string {
  const hours = ms / (60 * 60 * 1000)
  if (hours < 48) return `${hours.toFixed(0)}h`
  const days = hours / 24
  return `${days.toFixed(0)}d`
}

/**
 * Determine the cron source label from a Date.
 * Used by the cron route to identify which scheduled time triggered it.
 */
export function cronSourceLabel(now: Date = new Date()): string {
  const etHour = parseInt(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour: 'numeric',
      hour12: false,
    }).formatToParts(now).find(p => p.type === 'hour')?.value ?? '0',
    10,
  )
  if (etHour >= 5 && etHour < 8) return 'cron_6am'
  if (etHour >= 11 && etHour < 14) return 'cron_12pm'
  if (etHour >= 16 && etHour < 18) return 'cron_5pm'
  if (etHour >= 20 && etHour < 22) return 'cron_9pm'
  return 'manual'
}
