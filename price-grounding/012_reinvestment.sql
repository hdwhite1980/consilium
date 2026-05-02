-- ============================================================
-- CONSILIUM — Reinvestment tracker
-- Run in Supabase SQL Editor
-- ============================================================

create table if not exists public.reinvestment_trades (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users(id) on delete cascade,
  ticker         text not null,
  shares         numeric(18,4) not null,
  entry_price    numeric(18,4) not null,
  exit_price     numeric(18,4),                -- null = still open
  exit_date      timestamptz,
  analysis_id    uuid,                          -- links to analyses table
  council_signal text,                          -- BULLISH/BEARISH/NEUTRAL at entry
  confidence     integer,                       -- 0-100 at entry
  persona        text default 'balanced',
  notes          text,
  opened_at      timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

alter table public.reinvestment_trades enable row level security;

create policy "users manage own reinvestment trades"
  on public.reinvestment_trades for all using (auth.uid() = user_id);

create index if not exists reinvestment_user_idx
  on public.reinvestment_trades (user_id, opened_at desc);

create index if not exists reinvestment_ticker_idx
  on public.reinvestment_trades (user_id, ticker);
