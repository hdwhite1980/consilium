-- ============================================================
-- CONSILIUM — Single session enforcement
-- Run in Supabase SQL Editor
-- ============================================================

create table if not exists public.active_sessions (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  session_token text not null,
  device_hint   text,        -- browser/OS hint for display
  logged_in_at  timestamptz not null default now(),
  last_seen_at  timestamptz not null default now()
);

alter table public.active_sessions enable row level security;

-- Users can only read/write their own session row
create policy "own session read"
  on public.active_sessions for select
  using (auth.uid() = user_id);

create policy "own session write"
  on public.active_sessions for all
  using (auth.uid() = user_id);
