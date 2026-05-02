-- ============================================================
-- CONSILIUM — News cache table
-- Run in Supabase SQL Editor
-- ============================================================

create table if not exists public.news_cache (
  id           uuid primary key default gen_random_uuid(),
  cache_date   date not null default current_date,
  generated_at timestamptz not null default now(),
  data         jsonb not null
);

-- Only one row per day
create unique index if not exists news_cache_date_idx on public.news_cache (cache_date);

-- RLS
alter table public.news_cache enable row level security;
create policy "public read news_cache"   on public.news_cache for select using (true);
create policy "public insert news_cache" on public.news_cache for insert with check (true);
create policy "public update news_cache" on public.news_cache for update using (true);
