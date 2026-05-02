# Wali-OS — Complete Project Handoff
**Date:** April 2026  
**Live URL:** https://wali-os.com (Railway deploy, previously consilium-production-d8e6.up.railway.app)  
**GitHub:** hdwhite1980/consilium  
**Stack:** Next.js 15, Supabase, Railway, Anthropic/OpenAI/Gemini, Alpaca Trader Plus, Finnhub, Tradier, Stripe, Resend, Twilio

---

## Architecture Overview

### AI Pipeline — 6-Stage Adversarial Debate
`app/lib/pipeline.ts` orchestrates:
1. **News Scout** (Gemini) — fetches live news, identifies catalysts
2. **Lead Analyst** (Claude) — makes directional call with technicals/fundamentals
3. **Devil's Advocate** (GPT-4o) — attacks the thesis with counter-data
4. **Rebuttal** (Claude) — defends or concedes to devil's advocate
5. **Counter** (GPT-4o) — final challenge
6. **Judge** (Claude) — reads full transcript, delivers verdict

No AI names shown in UI — all display as role names only.
Timeframe differentiation: 1D=15min/30d bars, 1W=1hr/90d, 1M=daily/500d, 3M=daily/1200d.
`timeframeContext()` injected into all 5 AI prompts.
Conviction weights: 1D tech×1.6/fund×0.2, 3M tech×0.6/fund×1.5.

### Signal Pipeline
`app/lib/aggregator.ts` → calls all signal modules → passes to pipeline.ts

Signal modules:
- `app/lib/signals/technicals.ts` — full indicator suite + **pattern detection engine**
- `app/lib/signals/fundamentals.ts` — Finnhub data (earnings, analyst consensus, P/E)
- `app/lib/signals/smart-money.ts` — real Finnhub Form 4 insider trades, congressional trades, 13F institutional
- `app/lib/signals/options-flow.ts` — Tradier primary, short interest fallback
- `app/lib/signals/market-context.ts` — SPY/VIX always daily bars regardless of analysis TF
- `app/lib/signals/conviction.ts` — weighted scoring, pattern scoring, timeframe multipliers

### Pattern Detection Engine (in technicals.ts)
12 candlestick patterns: Bullish/Bearish Engulfing, Hammer, Shooting Star, Doji variants, Morning/Evening Star, Harami, Three White Soldiers/Black Crows, Marubozu.
9 chart patterns: Double Top/Bottom, H&S, Inverse H&S, Ascending/Descending Triangle, Bull/Bear Flag. Each returns price target + invalidation level.
Gap detection: up to 5 bars back, size %, filled/unfilled status.
Trend line analysis: swing high/low detection, dynamic S/R projection via linear regression.
All patterns append to `summary` string the AI reads. Conviction engine scores them separately.

### Data Sources
- **Alpaca Trader Plus**: SIP feed, `limit=10000`, quotes `?feed=sip`, options OPRA feed. `app/lib/data/alpaca.ts`
- **Finnhub**: fundamentals, quotes, insider trades, congressional trades, 13F. Free key.
- **Tradier**: options chains with Greeks (production account required). `app/api/options-recommendations/route.ts`
- **Gemini**: news analysis (Today, Tomorrow pages). Falls back through gemini-2.5-flash → flash-lite → pro.

---

## Subscriptions
- **Standard** $29/mo — analysis, portfolio ≤15 positions, today/tomorrow/macro, academy
- **Pro** $49/mo — compare, reinvestment, forex, unlimited portfolio
- 7-day free trial (Pro tier during trial regardless of plan chosen)
- `app/lib/stripe.ts` — `hasActiveAccess()`, `syncSubscription()`, `getOrCreateCustomer()`
- Stripe webhook: `app/api/stripe/webhook/route.ts` handles `customer.subscription.*` events

---

## Key Files

### API Routes
| File | Purpose |
|------|---------|
| `app/api/analyze/route.ts` | Main analysis SSE stream. Logs verdicts to verdict_log via direct DB insert. 24h analysis cache check. |
| `app/api/compare/route.ts` | Head-to-head ticker comparison. Logs both verdicts. |
| `app/api/portfolio/route.ts` | Portfolio analysis SSE. **24h cache** — checks portfolio_analyses table first, serves cached if < 24h old. `forceRefresh` param bypasses. Upserts on save. |
| `app/api/portfolio/positions/route.ts` | CRUD for positions. Supports stock + options (call/put/strike/expiry/contracts/entry_premium). |
| `app/api/portfolio/monitor/route.ts` | Background monitor: S/R breach, P&L thresholds, LEAP-aware DTE alerts, hourly news scan. |
| `app/api/options-recommendations/route.ts` | Options strategy + contract selection. **LEAP support** (730d cap). Separate near-term/LEAP scoring pools. Raw Tradier API. |
| `app/api/track-record/route.ts` | Logs verdicts, checks outcomes via Finnhub price lookup when check_1w/1m_after <= today. |
| `app/api/tomorrow/route.ts` | Tomorrow's playbook. Daily cache keyed by date. |
| `app/api/news/route.ts` | Today's movers. Status: "The council is analyzing..." (not "Gemini is..."). |
| `app/api/macro/route.ts` | Sector ETF analysis (XLK, XLV etc). 10,000 bar limit. |
| `app/api/notifications/route.ts` | Sends email (Resend) + SMS (Twilio). Guards on env vars. |
| `app/lib/notifications.ts` | **Raw fetch against Resend/Twilio REST APIs** — no npm packages. Silently no-ops if env vars not set. |

### Components
| File | Purpose |
|------|---------|
| `app/components/TechnicalCharts.tsx` | Full indicator charts + **Pattern Detection section** above FinViz chart. Candle/chart/gap/trend cards with plain-English explanations per ticker. FinViz chart overlay badges. |
| `app/components/OptionsRecommendations.tsx` | Options strategy display. **Single unified contracts block** (was duplicated). LEAP badge (purple) on contracts >180d. LEAP explanation note per contract. |
| `app/components/PortfolioAlerts.tsx` | **Mounted globally in app/page.tsx nav** (not just portfolio page). Auto-runs on mount. Stable interval (no re-registration). Countdown timer (1s ticker, M:SS). Three places: header, empty state, footer. |
| `app/components/Tutorial.tsx` | Step-by-step tutorial overlay. Targets `data-tutorial="..."` attributes. Launcher resets progress before replaying. |

### Pages
| File | Purpose |
|------|---------|
| `app/page.tsx` | Main analysis page. Imports PortfolioAlerts globally. Tutorial auto-start + relaunch handler (resets progress). WALI-OS branding. |
| `app/portfolio/page.tsx` | Portfolio page. Auto-loads cached analysis on mount via `loadCachedAnalysis()`. Shows "analysis Xh old" + "↻ Re-analyze" button. cachedAge=0 = "just analyzed". |
| `app/track-record/page.tsx` | Track record page. Check outcomes button calls `?check=true`. Only updates verdicts where 7/30 days have passed — new verdicts stay "pending" until due date. |

---

## Database Schema (Supabase)
All migrations in `supabase/migrations/`. Run in order.

Key tables:
- `analyses` — cached analysis results (per user per ticker)
- `portfolio_positions` — stock + options positions (position_type, option_type, strike, expiry, contracts, entry_premium, underlying)
- `portfolio_analyses` — **UNIQUE constraint on portfolio_id** (one row per portfolio, upserted). 24h cache.
- `portfolio_alerts` — monitor alerts with severity/type/notified
- `verdict_log` — track record entries. Generated columns: check_1w_after = verdict_date + 7d, check_1m_after = verdict_date + 30d.
- `subscriptions` — Stripe subscription state per user
- `tutorial_progress` — per user per tutorial_id, step/completed/skipped
- `news_cache` — keyed by cache_key (e.g. "tomorrow_2026-04-16")
- `notification_preferences` — email_enabled, sms_enabled, phone, min_severity
- `invest_journey` — starting_balance, trades, stats for paper trading simulator
- `reinvestment_trades` — logged reinvestment ideas and their outcomes

Critical SQL already run:
```sql
-- 021: portfolio analysis cache unique constraint
ALTER TABLE public.portfolio_analyses
  ADD CONSTRAINT portfolio_analyses_portfolio_id_key UNIQUE (portfolio_id);
```

---

## Railway Environment Variables
```
NEXT_PUBLIC_APP_URL=https://wali-os.com
NEXT_PUBLIC_SUPABASE_URL=https://xxxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=xxxx
SUPABASE_SERVICE_ROLE_KEY=xxxx
ANTHROPIC_API_KEY=xxxx
OPENAI_API_KEY=xxxx
GEMINI_API_KEY=xxxx
ALPACA_API_KEY=xxxx
ALPACA_SECRET_KEY=xxxx
FINNHUB_API_KEY=xxxx
TRADIER_API_KEY=xxxx          ← production account required for live options
STRIPE_SECRET_KEY=sk_live_xxxx
STRIPE_WEBHOOK_SECRET=whsec_xxxx   ← regenerate after updating webhook URL
STRIPE_STANDARD_PRICE_ID=price_xxxx
STRIPE_PRO_PRICE_ID=price_xxxx
RESEND_API_KEY=re_xxxx         ← optional, notifications silent without it
RESEND_FROM=alerts@wali-os.com
TWILIO_ACCOUNT_SID=xxxx        ← optional
TWILIO_AUTH_TOKEN=xxxx
TWILIO_PHONE_NUMBER=+1xxxx
```

---

## Domain Migration (Consilium → Wali-OS)

### Completed in code
- All `CONSILIUM`/`Consilium`/`consilium` text replaced with `WALI-OS`/`Wali-OS`/`wali_os`
- localStorage key: `wali_os_theme`
- sessionStorage key: `wali_os_last`
- Custom event: `wali_os:launch_tutorial`
- Email from: `alerts@wali-os.com`
- Signup auth callback: `https://wali-os.com/auth/callback`

### Still needed in external services
**Supabase** → Authentication → URL Configuration:
- Site URL: `https://wali-os.com`
- Redirect URLs: add `https://wali-os.com/auth/callback`

**Stripe** → Developers → Webhooks:
- Update endpoint URL to `https://wali-os.com/api/stripe/webhook`
- Copy new `whsec_` signing secret → update `STRIPE_WEBHOOK_SECRET` in Railway

**Resend** → Domains:
- Add and verify `wali-os.com`
- Add DKIM/SPF DNS records at registrar

**Railway**:
- Custom domain: `wali-os.com` + `www.wali-os.com`
- DNS: CNAME `@` and `www` → Railway app URL
- Update `NEXT_PUBLIC_APP_URL=https://wali-os.com`

---

## Known Issues / Pending Items

### Track Record "Check Outcomes" appears to do nothing
This is correct behavior. It only updates verdicts where `check_1w_after <= today` (7+ days since analysis). Brand new verdicts stay "pending" until the due date passes. Nothing is broken — there's just no data old enough yet.

### Notifications (email/SMS) not yet configured
`app/lib/notifications.ts` uses raw fetch against Resend/Twilio REST APIs (no npm packages). Guards on env vars — silently no-ops until `RESEND_API_KEY` and Twilio vars are set. Set them in Railway when ready.

### Tutorial shows for new users automatically
First visit auto-shows tutorial. Returning users click the Tutorial button in the nav (purple bookmark icon). The launcher resets `completed=false` in DB then remounts — should replay cleanly.

---

## Recent Major Changes (this session)

### Bugs Fixed
- `syncSubscription` in stripe.ts — `.single()` threw for new users, breaking Stripe webhooks for new subscribers
- `getOrCreatePortfolio` — same issue, threw for new users
- 10+ other `.single()` → `.maybeSingle()` fixes across invest, portfolio, reinvestment, tutorial, track-record routes
- Track record verdict logging was broken — server-to-server fetch lost auth cookies; fixed to direct DB insert
- Timeframe differentiation — 1D/1W/1M/3M were all returning identical analysis (wrong bar resolution)
- `priceChange1D` fixed to walk bar timestamps for true yesterday's close on intraday bars
- Market context SPY/VIX forced to daily bars regardless of analysis timeframe
- Portfolio alerts only polling when portfolio page was open (component not globally mounted)
- Portfolio alerts interval kept resetting (runCheck in dep array → re-registration on every check)
- Options contracts showing twice (4 duplicate conditional blocks all rendering same data)
- LEAP options not appearing (dteScore formula completely suppressed LEAPs in scoring)
- Duplicate contracts in options UI (4 blocks rendering same data, now 1 unified block)
- `avg_cost: number | null | undefined` type error in portfolio route
- Build failure: resend/twilio packages not resolving on Railway — rewrote as raw fetch
- CONSILIUM branding remaining in header, login, signup, confirm, disclaimer pages

### Features Added
- **Pattern Detection Engine** — 12 candlestick patterns, 9 chart patterns, gap detection, trend line analysis with dynamic S/R projection. All shown in TechnicalCharts with plain-English "what it means for [ticker]" explanations + FinViz chart overlay badges. Patterns score in conviction engine and are cited by AI.
- **LEAP options** — full support: 730d cap, separate scoring pool (near-term 2 + LEAP 1), LEAP badge in portfolio + options UI, LEAP-aware DTE alerts (180d watch, 90d alert)
- **Portfolio analysis 24h cache** — auto-loads on mount, shows age, "↻ Re-analyze" button
- **Portfolio alerts countdown timer** — M:SS to next check, shown in header/footer/empty state
- **Track Record page** — auto-logs BULLISH/BEARISH verdicts, 1W/1M outcome checking, win rate stats
- **Alpaca Trader Plus upgrades** — SIP feed everywhere, 10,000 bar limit, extended lookbacks
- **Smart money real data** — Finnhub Form 4 insider trades (was hardcoded zeros), congressional trades via Finnhub (was QuiverQuant 403)

---

## Navigation Structure
Home (analyze), Today (news), Tomorrow, Invest 🔥, Portfolio, Reinvest, Macro, Compare, Academy, Track Record 🏆, Guide, Settings

## Subscription Gates
`app/components/UpgradeGate.tsx` — wraps Pro features. `app/lib/use-subscription.ts` — client hook.
Standard: analysis, portfolio, today, tomorrow, macro, academy
Pro: compare, reinvestment, forex analysis, unlimited portfolio positions
