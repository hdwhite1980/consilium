// =============================================================
// app/lib/trading/monitor-config.ts
//
// Configuration for the dual-monitor system. The position-monitor core is
// parameterized by a MonitorConfig so the SAME hardened logic can run as two
// independent crons with different lenses:
//
//   • swing — holds for the week; higher-timeframe context (specialized in a
//             later phase). Owns positions by default.
//   • day   — fast tactical exits on the intraday timeframes; only acquires
//             positions via hand-off.
//
// Ownership: a position is managed by exactly one monitor (trade_attempts.
// monitor_mode). Each cron acts only on what it owns. Attribution: every
// position_monitor_log row is stamped with the acting monitor's mode.
//
// Phase 1 note: both configs intentionally use the SAME timeframes/thresholds
// as the original single monitor, so introducing the config is a pure no-op.
// The swing/day lens divergence (e.g. swing → 15m/1h/daily) lands in a later
// phase by changing ONLY the values below.
// =============================================================

export type MonitorMode = 'day' | 'swing'

export interface MonitorConfig {
  mode: MonitorMode
  /** Human label for logs, e.g. 'swing-monitor'. */
  label: string
  /** Fast timeframe (the "timing" chart for this lens). */
  fastTimeframe: '5Min' | '15Min' | '1H' | '1D'
  /** Slow timeframe (the "trend / thesis" chart — the decision authority). */
  slowTimeframe: '5Min' | '15Min' | '1H' | '1D'
  /**
   * Optional decision-threshold overrides. When undefined, the monitor uses
   * the per-user PM settings exactly as the original single monitor did.
   */
  exitThreshold5m?: number
  exitThreshold15m?: number
  tightenThreshold15m?: number
}

// SWING lens — "hold for the week."
//
// The DAILY chart is the thesis authority (the slow timeframe the decision
// engine treats as primary), and the 1-HOUR is the timing chart. This is the
// higher-timeframe view that judges whether the week-long setup is still valid,
// so the monitor stops whipsaw-exiting on intraday noise: a 1h flurry against
// the position is dismissed unless the DAILY structure has also broken.
//
// The thresholds are deliberately loose so discretionary exits are rare — the
// hard bracket stop still protects the downside, and the R-multiple trailing
// stop still ratchets gains on live price every cycle regardless of timeframe.
//
// NOTE: countSignals/decide name their inputs "5m"/"15m" — those are really
// FAST/SLOW roles. Under this config the "5m" slot carries the 1h snapshot and
// the "15m" slot carries the daily snapshot; the thresholds apply to fast/slow.
export const SWING_CONFIG: MonitorConfig = {
  mode: 'swing',
  label: 'swing-monitor',
  fastTimeframe: '1H',
  slowTimeframe: '1D',
  // Daily breakdown must be clear to exit (slow=daily); never exit on the
  // hourly alone (fast threshold set very high); tighten on real daily weakness.
  exitThreshold15m: 4,   // slow (daily) bearish signals required for an exit
  exitThreshold5m: 6,    // fast (hourly) "overwhelming alone" — effectively off
  tightenThreshold15m: 3,
}

// DAY lens — fast tactical exits (the original day-trader 5m/15m setup).
// Only ever manages positions handed off from swing. Thresholds left undefined
// so it uses each user's PM settings exactly as the single monitor did.
export const DAY_CONFIG: MonitorConfig = {
  mode: 'day',
  label: 'day-monitor',
  fastTimeframe: '5Min',
  slowTimeframe: '15Min',
}
