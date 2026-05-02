-- ============================================================
-- CONSILIUM — Invest journey tracker
-- Separate from reinvestment_trades — different audience/flow
-- ============================================================

create table if not exists public.invest_trades (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users(id) on delete cascade,
  ticker         text not null,
  shares         numeric(18,4) not null,
  entry_price    numeric(18,4) not null,
  exit_price     numeric(18,4),
  exit_date      timestamptz,
  council_signal text,
  confidence     integer,
  notes          text,
  opened_at      timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

alter table public.invest_trades enable row level security;

create policy "users manage own invest trades"
  on public.invest_trades for all using (auth.uid() = user_id);

create index if not exists invest_user_idx
  on public.invest_trades (user_id, opened_at desc);

-- Journey state — starting balance + milestone tracking
create table if not exists public.invest_journey (
  user_id           uuid primary key references auth.users(id) on delete cascade,
  starting_balance  numeric(10,2) not null default 0,
  win_streak        integer not null default 0,
  best_streak       integer not null default 0,
  total_trades      integer not null default 0,
  winning_trades    integer not null default 0,
  first_win_at      timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

alter table public.invest_journey enable row level security;

create policy "users manage own journey"
  on public.invest_journey for all using (auth.uid() = user_id);
