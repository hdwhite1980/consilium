-- ============================================================
-- CONSILIUM v2 — Full schema with all 5 signal phases
-- Run in Supabase SQL Editor (replaces 001_init.sql)
-- ============================================================

drop table if exists public.analyses cascade;
drop table if exists public.watchlist cascade;

create table public.analyses (
  id              uuid primary key default gen_random_uuid(),
  ticker          text not null,
  timeframe       text not null default '1W',
  created_at      timestamptz not null default now(),

  -- Market snapshot
  price           numeric,

  -- AI results
  gemini_news     jsonb,
  claude_analysis jsonb,
  gpt_validation  jsonb,
  judge_verdict   jsonb,

  -- Final consensus
  final_signal     text check (final_signal in ('BULLISH','BEARISH','NEUTRAL')),
  final_confidence integer,
  final_target     text,
  final_risk       text,
  rounds_taken     integer default 1,

  -- Signal bundle metadata (for history/screening)
  signal_bundle   jsonb default '{}'::jsonb,

  -- Full debate transcript
  transcript      jsonb default '[]'::jsonb
);

create table public.watchlist (
  id          uuid primary key default gen_random_uuid(),
  ticker      text not null unique,
  added_at    timestamptz not null default now(),
  last_signal text,
  last_run    timestamptz,
  notes       text
);

-- Indexes
create index analyses_ticker_idx on public.analyses (ticker, created_at desc);
create index analyses_signal_idx on public.analyses (final_signal);
create index analyses_created_idx on public.analyses (created_at desc);

-- RLS (open — add auth when you add user accounts)
alter table public.analyses enable row level security;
alter table public.watchlist enable row level security;
create policy "public read analyses"   on public.analyses for select using (true);
create policy "public insert analyses" on public.analyses for insert with check (true);
create policy "public read watchlist"  on public.watchlist for select using (true);
create policy "public write watchlist" on public.watchlist for all using (true);
