// ═════════════════════════════════════════════════════════════
// PATCH for app/api/portfolio/check/route.ts
//
// This endpoint is fed option contract details including expiry
// dates. Without a "today is" anchor, the model has to guess
// whether a given expiry is days, months, or years away. Same
// bug class as the QA chat one — just hasn't bitten yet.
//
// Two edits.
// ═════════════════════════════════════════════════════════════


// ─────────────────────────────────────────────────────────────
// EDIT 1 — Add the import
// ─────────────────────────────────────────────────────────────
// Add this import alongside the existing imports at the top of
// the file:

import { dateGroundingPrompt } from '@/app/lib/prompt-grounding'


// ─────────────────────────────────────────────────────────────
// EDIT 2 — Inject grounding into the user-message prompt
// ─────────────────────────────────────────────────────────────
// This file passes the prompt as a USER message rather than a
// system message. The grounding still works — Claude reads the
// whole context for date awareness — it just goes at the start
// of the user content.
//
// FIND the messages array inside the anthropic.messages.create call:

    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1200,
      messages: [{ role: 'user', content: `You are a trading coach reviewing live positions. Be direct and specific — cite the actual numbers. No fluff.\n\n${snapshot}\n\nFor options: consider delta (directional exposure), theta (daily decay cost), IV level, moneyness, and days to expiry together. ...

// REPLACE WITH:

    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1200,
      system: dateGroundingPrompt(),
      messages: [{ role: 'user', content: `You are a trading coach reviewing live positions. Be direct and specific — cite the actual numbers. No fluff.\n\n${snapshot}\n\nFor options: consider delta (directional exposure), theta (daily decay cost), IV level, moneyness, and days to expiry together. ...

// (rest of the messages array unchanged)
//
// Note: I added a new `system:` parameter rather than prepending
// to the user message. This is cleaner and means future edits
// to the prompt body don't risk losing the grounding.
