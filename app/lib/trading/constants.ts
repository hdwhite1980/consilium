// Shared trading constants. These were previously duplicated between
// auto-trade/route.ts and decide.ts with a "keep in sync" comment — a
// landmine the day one copy changes. Single definition, imported by both.

// ── Bounded cash-only overflow ──
// Grade A/B setups may open past the base concurrent cap
// (settings.maxConcurrentPos) up to this HARD ceiling, funded exclusively
// by settled cash (never margin). See auto-trade/route.ts for the funding
// gate and kill-switches.ts for the concurrent-cap override.
export const OVERFLOW_HARD_CAP = 13
export const OVERFLOW_GRADES: ReadonlySet<string> = new Set(['A', 'B'])
