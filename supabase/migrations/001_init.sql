-- ============================================================
-- CONSILIUM — Database Schema
-- Run this in your Supabase SQL editor or via supabase db push
-- ============================================================

-- Analyses table: stores every pipeline run
create table if not exists public.analyses (
  id            uuid primary key default gen_random_uuid(),
  ticker        text not null,
  timeframe     text not null default '1W',
  created_at    timestamptz not null default now(),

  -- Market snapshot at time of analysis
  price         numeric,
  price_change  numeric,
  volume        bigint,

  -- Pipeline results
  gemini_news   jsonb,   -- { summary, headlines[], sentiment, confidence }
  claude_analysis jsonb, -- { signal, reasoning, target, confidence, technicals }
  gpt_validation  jsonb, -- { agrees, signal, reasoning, confidence, challenges[] }
  judge_verdict   jsonb, -- { signal, confidence, target, risk, summary, rounds }

  -- Final consensus
  final_signal     text check (final_signal in ('BULLISH','BEARISH','NEUTRAL')),
  final_confidence integer,
  final_target     text,
  final_risk       text,
  rounds_taken     integer default 1,

  -- Full debate transcript for replay
  transcript    jsonb default '[]'::jsonb
);

-- Index for fast ticker lookups
create index if not exists analyses_ticker_idx on public.analyses (ticker, created_at desc);

-- Watchlist table: saved tickers per user session
create table if not exists public.watchlist (
  id         uuid primary key default gen_random_uuid(),
  ticker     text not null unique,
  added_at   timestamptz not null default now(),
  last_signal text,
  last_run    timestamptz
);

-- Enable Row Level Security (open for now — lock down when you add auth)
alter table public.analyses enable row level security;
alter table public.watchlist enable row level security;

-- Permissive policies (open read/write — tighten when adding Supabase Auth)
create policy "public read analyses"  on public.analyses for select using (true);
create policy "public insert analyses" on public.analyses for insert with check (true);
create policy "public read watchlist"  on public.watchlist for select using (true);
create policy "public write watchlist" on public.watchlist for all using (true);
