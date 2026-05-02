-- ============================================================
-- CONSILIUM — Auth-protected RLS policies
-- Run in Supabase SQL Editor
-- Replaces the open "public" policies from earlier migrations
-- ============================================================

-- ── analyses ─────────────────────────────────────────────────
drop policy if exists "public read analyses"   on public.analyses;
drop policy if exists "public insert analyses" on public.analyses;

create policy "auth read analyses"
  on public.analyses for select
  using (auth.role() = 'authenticated');

create policy "auth insert analyses"
  on public.analyses for insert
  with check (auth.role() = 'authenticated');

-- ── watchlist ─────────────────────────────────────────────────
drop policy if exists "public read watchlist"  on public.watchlist;
drop policy if exists "public write watchlist" on public.watchlist;

create policy "auth read watchlist"
  on public.watchlist for select
  using (auth.role() = 'authenticated');

create policy "auth write watchlist"
  on public.watchlist for all
  using (auth.role() = 'authenticated');

-- ── news_cache ────────────────────────────────────────────────
drop policy if exists "public read news_cache"   on public.news_cache;
drop policy if exists "public insert news_cache" on public.news_cache;
drop policy if exists "public update news_cache" on public.news_cache;

create policy "auth read news_cache"
  on public.news_cache for select
  using (auth.role() = 'authenticated');

create policy "auth write news_cache"
  on public.news_cache for all
  using (auth.role() = 'authenticated');
