-- ============================================================
-- WALI-OS — SEC EDGAR Fundamentals Cache
-- ============================================================

-- CIK lookup map — ticker → CIK number
CREATE TABLE IF NOT EXISTS public.edgar_cik_map (
  ticker      text PRIMARY KEY,
  cik         text NOT NULL,
  cik_padded  text NOT NULL,  -- zero-padded to 10 digits e.g. CIK0001045810
  name        text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS edgar_cik_map_cik_idx ON public.edgar_cik_map (cik);

-- Fundamentals cache — one row per ticker, refreshed quarterly
CREATE TABLE IF NOT EXISTS public.edgar_fundamentals (
  ticker              text PRIMARY KEY,
  cik                 text NOT NULL,
  company_name        text,

  -- Trailing 12 months (sum of last 4 quarters)
  revenue_ttm         numeric,
  net_income_ttm      numeric,
  eps_diluted_ttm     numeric,
  operating_income_ttm numeric,
  gross_profit_ttm    numeric,
  rd_expense_ttm      numeric,    -- R&D spend

  -- Latest quarter point-in-time
  cash                numeric,
  total_debt          numeric,
  shares_outstanding  numeric,
  book_value_per_share numeric,

  -- Year-over-year growth
  revenue_yoy_pct     numeric,
  net_income_yoy_pct  numeric,
  eps_yoy_pct         numeric,

  -- Computed signals
  earnings_trend      text,  -- accelerating | decelerating | stable | negative
  debt_trend          text,  -- increasing | decreasing | stable
  cash_trend          text,  -- building | depleting | stable

  -- Filing metadata
  last_filing_date    date,
  last_filing_type    text,   -- 10-Q | 10-K
  fiscal_year_end     text,   -- e.g. 'December'
  data_source         text DEFAULT 'SEC EDGAR XBRL',

  -- Cache management
  fetched_at          timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz NOT NULL DEFAULT (now() + interval '90 days')
);

CREATE INDEX IF NOT EXISTS edgar_fund_expires_idx ON public.edgar_fundamentals (expires_at);
CREATE INDEX IF NOT EXISTS edgar_fund_fetched_idx ON public.edgar_fundamentals (fetched_at DESC);

-- RLS — authenticated users can read, service role writes
ALTER TABLE public.edgar_cik_map ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.edgar_fundamentals ENABLE ROW LEVEL SECURITY;

CREATE POLICY "read edgar_cik_map" ON public.edgar_cik_map FOR SELECT TO authenticated USING (true);
CREATE POLICY "read edgar_fundamentals" ON public.edgar_fundamentals FOR SELECT TO authenticated USING (true);

