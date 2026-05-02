// ═════════════════════════════════════════════════════════════
// PATCH for app/lib/exit-signals.ts
//
// Two surgical edits — adds a "today is" anchor to the exit-signal
// system prompt. This runs every 15 minutes during market hours
// for every active watchlist entry, so it's worth grounding even
// though it doesn't currently see user-supplied dates.
//
// Note: expectsUserDates=false here — this prompt only sees server
// data (technicals + verdict_log dates), not user chat. The basic
// "today is" anchor is the right level for it.
// ═════════════════════════════════════════════════════════════


// ─────────────────────────────────────────────────────────────
// EDIT 1 — Add the import
// ─────────────────────────────────────────────────────────────
// FIND near the top of the file:

import Anthropic from '@anthropic-ai/sdk'
import { fetchBars } from '@/app/lib/data/alpaca'
import { calculateTechnicals, type TechnicalSignals } from '@/app/lib/signals/technicals'
import { createClient as createAdmin } from '@supabase/supabase-js'

// REPLACE WITH:

import Anthropic from '@anthropic-ai/sdk'
import { fetchBars } from '@/app/lib/data/alpaca'
import { calculateTechnicals, type TechnicalSignals } from '@/app/lib/signals/technicals'
import { createClient as createAdmin } from '@supabase/supabase-js'
import { dateGroundingPrompt } from '@/app/lib/prompt-grounding'


// ─────────────────────────────────────────────────────────────
// EDIT 2 — Inject grounding at the top of the system prompt
// ─────────────────────────────────────────────────────────────
// FIND inside claudeEvaluateExit:

  const system = `You evaluate whether a stock position should be HELD, WATCHED, or EXITED based on current technicals vs the original Council thesis.

Framework:
  - "exit" — Original thesis has broken. ...

// REPLACE WITH:

  const system = `${dateGroundingPrompt()}

You evaluate whether a stock position should be HELD, WATCHED, or EXITED based on current technicals vs the original Council thesis.

Framework:
  - "exit" — Original thesis has broken. ...

// (leave the rest of the prompt body unchanged)
