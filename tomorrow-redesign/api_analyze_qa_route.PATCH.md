// ═════════════════════════════════════════════════════════════
// PATCH for app/api/analyze/qa/route.ts
//
// Three surgical edits to fix the date-grounding bug seen in
// production where the chat told the user their stated date
// "can't be correct."
// ═════════════════════════════════════════════════════════════


// ─────────────────────────────────────────────────────────────
// EDIT 1 — Add the import
// ─────────────────────────────────────────────────────────────
// FIND:

import Anthropic from '@anthropic-ai/sdk'
import { createClient } from '@/app/lib/auth/server'

// REPLACE WITH:

import Anthropic from '@anthropic-ai/sdk'
import { createClient } from '@/app/lib/auth/server'
import { dateGroundingPrompt } from '@/app/lib/prompt-grounding'


// ─────────────────────────────────────────────────────────────
// EDIT 2 — Add `generatedAt` to the AnalysisContext interface
// ─────────────────────────────────────────────────────────────
// The Council pipeline already produces this timestamp; we just
// need the QA endpoint to accept it and pass it to the model.
//
// FIND the AnalysisContext interface — specifically the top of it
// where ticker and currentPrice live:

interface AnalysisContext {
  ticker: string
  currentPrice: number
  // Final verdict
  verdict: {
    signal: 'BULLISH' | 'BEARISH' | 'NEUTRAL'
    ...

// REPLACE the top of the interface with:

interface AnalysisContext {
  ticker: string
  currentPrice: number
  /** ISO timestamp of when the Council analysis was generated.
   *  Optional for back-compat with older client builds, but the
   *  client should pass it whenever available so the QA model
   *  can reason about how stale the underlying analysis is. */
  generatedAt?: string | null
  // Final verdict
  verdict: {
    signal: 'BULLISH' | 'BEARISH' | 'NEUTRAL'
    ...

// (leave the rest of the interface unchanged)


// ─────────────────────────────────────────────────────────────
// EDIT 3 — Inject the date grounding at the top of buildSystemPrompt
// ─────────────────────────────────────────────────────────────
// FIND the start of buildSystemPrompt:

function buildSystemPrompt(ctx: AnalysisContext): string {
  const v = ctx.verdict
  const sections: string[] = []

  sections.push(`You are a senior market analyst answering follow-up questions about a Council analysis you helped produce for ${ctx.ticker} at $${ctx.currentPrice.toFixed(2)}.`)
  sections.push(``)
  sections.push(`Your job is to answer questions clearly and directly using the analysis below. Stay grounded in the evidence already gathered. If asked something the data doesn't support, say so plainly. Do not speculate beyond what the analysis shows.`)
  sections.push(``)
  sections.push(`Be concise. 2-4 paragraphs typically. Use plain language. No emojis. No disclaimers about not being financial advice unless directly relevant.`)
  sections.push(``)
  sections.push(`If the user asks something genuinely outside the scope (e.g., "should I buy SPY instead?"), redirect them to running a fresh analysis on that ticker.`)

// REPLACE WITH (date grounding goes FIRST, before role description):

function buildSystemPrompt(ctx: AnalysisContext): string {
  const v = ctx.verdict
  const sections: string[] = []

  // ── Date grounding — MUST come before role description ──
  // The chat sees user-supplied dates (option expirations, "today is",
  // transaction dates) so we use expectsUserDates=true. We also pass
  // generatedAt so the model knows how stale the underlying analysis is.
  sections.push(dateGroundingPrompt({
    expectsUserDates: true,
    analysisTimestamp: ctx.generatedAt ?? null,
  }))
  sections.push(``)

  sections.push(`You are a senior market analyst answering follow-up questions about a Council analysis you helped produce for ${ctx.ticker} at $${ctx.currentPrice.toFixed(2)}.`)
  sections.push(``)
  sections.push(`Your job is to answer questions clearly and directly using the analysis below. Stay grounded in the evidence already gathered. If asked something the data doesn't support, say so plainly. Do not speculate beyond what the analysis shows.`)
  sections.push(``)
  sections.push(`Be concise. 2-4 paragraphs typically. Use plain language. No emojis. No disclaimers about not being financial advice unless directly relevant.`)
  sections.push(``)
  sections.push(`If the user asks something genuinely outside the scope (e.g., "should I buy SPY instead?"), redirect them to running a fresh analysis on that ticker.`)


// ═════════════════════════════════════════════════════════════
// PATCH for the client component that calls this endpoint
// ═════════════════════════════════════════════════════════════
// app/components/AnalysisQA.tsx (or wherever the analysisContext
// object is built before calling /api/analyze/qa)
//
// The component currently passes `context` straight from props.
// Make sure that context object includes `generatedAt` from the
// Council analysis. Look for where the context is constructed
// in the parent (probably app/page.tsx) — when the verdict comes
// back from /api/analyze, capture `result.generatedAt` (or the
// equivalent timestamp field) and put it in the context object.
//
// Find in app/page.tsx (or wherever):

const analysisContext = {
  ticker,
  currentPrice: entryPrice,
  verdict: jud,
  ...
}

// Add:

const analysisContext = {
  ticker,
  currentPrice: entryPrice,
  generatedAt: result.generatedAt ?? new Date().toISOString(),
  // ↑ falls back to "now" if the pipeline didn't return a timestamp,
  //   which is still better than leaving it null.
  verdict: jud,
  ...
}

// If you can't easily find the right spot, just leave generatedAt
// off — the buildSystemPrompt change still works (the analysisTimestamp
// section just won't appear). The critical fix is the date anchor
// + trust-the-user, which works regardless.
