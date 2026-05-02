// ═════════════════════════════════════════════════════════════
// app/lib/prompt-grounding.ts
//
// Shared helpers for grounding LLM prompts in the current date and
// preventing the model from substituting its training-cutoff
// assumptions for the user's reality.
//
// Why this exists — the bug it fixes
// ───────────────────────────────────
// Without an explicit "today is" anchor, models default to assuming
// "today" is somewhere near their training cutoff. When a user sends
// a message containing dates that are FUTURE relative to the model's
// training, the model concludes the user must be confused about the
// date, rather than that the model's knowledge is stale.
//
// Real example from production (29 April 2026):
//   User: "today is 04/29/2026"
//   Bot:  "I need to clarify something - that can't be correct."
//
// The fix is twofold:
//   1. Inject an authoritative "Today is YYYY-MM-DD" line at the top
//      of every system prompt, computed from server time.
//   2. Add a "trust the user's stated dates" instruction that overrides
//      the model's tendency to second-guess the user.
//
// Use it like this:
//
//   import { dateGroundingPrompt } from '@/app/lib/prompt-grounding'
//
//   const sections: string[] = []
//   sections.push(dateGroundingPrompt())   // <-- always at the top
//   sections.push('Your role-specific instructions go here…')
//   ...
//
// For Q&A or chat-style endpoints where the model gets user input that
// might contain dates, pass `expectsUserDates: true` to enable the
// stronger trust-the-user instruction:
//
//   sections.push(dateGroundingPrompt({ expectsUserDates: true }))
//
// Optional: for endpoints that have analyzed data with their own
// timestamp (e.g. a Council verdict produced an hour ago), pass
// `analysisTimestamp` so the model can reason about the gap between
// "when the analysis was run" and "now":
//
//   sections.push(dateGroundingPrompt({
//     expectsUserDates: true,
//     analysisTimestamp: ctx.verdict.generatedAt,
//   }))
// ═════════════════════════════════════════════════════════════

export interface DateGroundingOptions {
  /**
   * Set to true for chat / QA endpoints where the user's messages
   * might contain dates (option expirations, "as of last Tuesday",
   * etc.). Adds a stronger "trust the user's stated dates" rule.
   */
  expectsUserDates?: boolean

  /**
   * ISO timestamp of when the underlying analysis or data was
   * generated. The prompt will explain to the model how to reason
   * about the gap between then and now (e.g. "the verdict is 2
   * hours old; the user is asking now").
   */
  analysisTimestamp?: string | null

  /**
   * Override "now" for testing. Defaults to current server time.
   */
  now?: Date
}

/**
 * Returns a multi-line prompt fragment to drop in near the top of any
 * LLM system prompt. Always returns at least one line (the date anchor).
 */
export function dateGroundingPrompt(opts: DateGroundingOptions = {}): string {
  const now = opts.now ?? new Date()
  const isoDate = now.toISOString().split('T')[0]                       // 2026-04-29
  const longDate = now.toUTCString().split(' ').slice(0, 4).join(' ')   // Wed, 29 Apr 2026
  const utcTime = now.toISOString().split('T')[1].slice(0, 5)           // 13:42

  const lines: string[] = []

  // ── Always-on: authoritative "today" anchor ─────────────
  lines.push(`Today is ${longDate} (ISO: ${isoDate}, ${utcTime} UTC).`)
  lines.push(
    `This is the actual current date. Your training data may be older, ` +
    `but the date above is authoritative. If anything in your reasoning ` +
    `requires "today's date," use this — never substitute your training cutoff.`
  )

  // ── Optional: chat endpoints get the trust-the-user rule ──
  if (opts.expectsUserDates) {
    lines.push('')
    lines.push(
      `When the user states a date (e.g. an option expiration, a transaction ` +
      `date, "today is X"), TRUST IT. Do not tell the user their date "can't ` +
      `be right" or "must be a typo" — even if it conflicts with what your ` +
      `training data suggests. The user has access to a calendar and you do not. ` +
      `If the user's date is in your future relative to your training, that just ` +
      `means time has passed since you were trained.`
    )
    lines.push(
      `When computing time-deltas (days until expiration, days since an event), ` +
      `use today's date from above as the reference point. Do not silently ` +
      `assume "today" is somewhere near your training cutoff.`
    )
  }

  // ── Optional: analysis-was-run-at context ─────────────
  if (opts.analysisTimestamp) {
    const analysisDate = new Date(opts.analysisTimestamp)
    if (!Number.isNaN(analysisDate.getTime())) {
      const ageMs = now.getTime() - analysisDate.getTime()
      const ageMinutes = Math.round(ageMs / 60_000)
      const ageHours = Math.round(ageMs / 3_600_000)
      const ageDays = Math.round(ageMs / 86_400_000)

      let ageStr: string
      if (ageMinutes < 60) {
        ageStr = `${ageMinutes} minute${ageMinutes === 1 ? '' : 's'} ago`
      } else if (ageHours < 48) {
        ageStr = `${ageHours} hour${ageHours === 1 ? '' : 's'} ago`
      } else {
        ageStr = `${ageDays} day${ageDays === 1 ? '' : 's'} ago`
      }

      lines.push('')
      lines.push(
        `The underlying analysis you are referencing was generated ${ageStr} ` +
        `(at ${analysisDate.toISOString()}). Prices and indicator values inside ` +
        `that analysis are from then, not now. If the user mentions a current ` +
        `price that differs, both can be true — the price has moved since the ` +
        `analysis ran.`
      )
    }
  }

  return lines.join('\n')
}

/**
 * Convenience: just the ISO "today" string. Useful when a prompt
 * builder wants to inject the date itself into a sentence rather
 * than the full grounding block.
 */
export function todayISO(now?: Date): string {
  return (now ?? new Date()).toISOString().split('T')[0]
}
