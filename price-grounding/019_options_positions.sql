-- ============================================================
-- CONSILIUM — Options positions in portfolio
-- Adds option-specific columns to portfolio_positions
-- ============================================================

ALTER TABLE public.portfolio_positions
  ADD COLUMN IF NOT EXISTS position_type text NOT NULL DEFAULT 'stock'
    CHECK (position_type IN ('stock', 'option')),
  ADD COLUMN IF NOT EXISTS option_type    text CHECK (option_type IN ('call', 'put')),
  ADD COLUMN IF NOT EXISTS strike         numeric(18,4),
  ADD COLUMN IF NOT EXISTS expiry         date,
  ADD COLUMN IF NOT EXISTS contracts      integer,         -- number of contracts (1 = 100 shares)
  ADD COLUMN IF NOT EXISTS entry_premium  numeric(18,4),   -- premium paid per share (not per contract)
  ADD COLUMN IF NOT EXISTS underlying     text;            -- underlying ticker if different from ticker (OCC symbol)

-- Index for quick options filtering
CREATE INDEX IF NOT EXISTS positions_type_idx
  ON public.portfolio_positions (portfolio_id, position_type);
