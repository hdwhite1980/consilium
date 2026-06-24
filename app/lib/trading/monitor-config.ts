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
  /** Fast timeframe (the "timing" chart). */
  fastTimeframe: '5Min' | '15Min'
  /** Slow timeframe (the "trend" chart for this lens). */
  slowTimeframe: '5Min' | '15Min'
  /**
   * Optional decision-threshold overrides. When undefined, the monitor uses
   * the per-user PM settings exactly as the original single monitor did.
   */
  exitThreshold5m?: number
  exitThreshold15m?: number
  tightenThreshold15m?: number
}

// Base style: this is what every new trade starts as, and what the existing
// single monitor effectively was. Values match the original behavior 1:1.
export const SWING_CONFIG: MonitorConfig = {
  mode: 'swing',
  label: 'swing-monitor',
  fastTimeframe: '5Min',
  slowTimeframe: '15Min',
}

// Fast tactical monitor. Phase 1: same timeframes/thresholds as swing (no-op);
// its faster exit profile is set in a later phase.
export const DAY_CONFIG: MonitorConfig = {
  mode: 'day',
  label: 'day-monitor',
  fastTimeframe: '5Min',
  slowTimeframe: '15Min',
}
