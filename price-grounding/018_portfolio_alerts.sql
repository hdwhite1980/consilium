-- Portfolio monitoring alerts
CREATE TABLE IF NOT EXISTS public.portfolio_alerts (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  ticker       text not null,
  severity     text not null check (severity in ('watch', 'alert', 'urgent')),
  alert_type   text not null, -- 'support_break', 'resistance_break', 'pnl_threshold', 'stop_loss', 'news', 'pattern_change', 'volume_spike'
  title        text not null,
  message      text not null,
  price        numeric(18,4),
  trigger_value numeric(18,4),   -- the value that triggered it (price level, pct, etc)
  acknowledged boolean not null default false,
  created_at   timestamptz not null default now()
);

ALTER TABLE public.portfolio_alerts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "users manage own alerts"
  ON public.portfolio_alerts FOR ALL USING (auth.uid() = user_id);
CREATE INDEX IF NOT EXISTS portfolio_alerts_user_idx
  ON public.portfolio_alerts (user_id, created_at desc);
CREATE INDEX IF NOT EXISTS portfolio_alerts_unacked_idx
  ON public.portfolio_alerts (user_id, acknowledged) WHERE acknowledged = false;

-- Portfolio monitor state — tracks last check time and last known values
CREATE TABLE IF NOT EXISTS public.portfolio_monitor_state (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  last_checked timestamptz,
  last_news_scan timestamptz,
  position_states jsonb default '{}'::jsonb,  -- {ticker: {price, support, resistance, pnl_pct}}
  updated_at   timestamptz not null default now()
);

ALTER TABLE public.portfolio_monitor_state ENABLE ROW LEVEL SECURITY;
CREATE POLICY "users manage own monitor state"
  ON public.portfolio_monitor_state FOR ALL USING (auth.uid() = user_id);
