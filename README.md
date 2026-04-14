# Consilium v2 — Signal Convergence Engine

> 50+ signals across technicals, fundamentals, smart money, and options — analyzed by three AI models that debate until a weighted judge delivers the final verdict.

## Five signal phases

| Phase | Signals | Source | Cost |
|---|---|---|---|
| 1 — Technicals | RSI, MACD, MAs (20/50/200), Bollinger, Volume, Support/Resistance | Alpaca bars | Free |
| 1 — Market context | SPY, QQQ, VIX, sector ETF, competitors, DXY proxy | Alpaca bars | Free |
| 2 — Fundamentals | P/E, margins, EPS surprises, earnings calendar, analyst ratings, price targets | Finnhub free | Free |
| 3 — Smart money | SEC Form 4 insiders, 13F institutions, congressional trades | SEC EDGAR + Quiver | Free |
| 4 — Options flow | Put/call ratio, unusual sweeps, IV skew, max pain, short interest | Tradier sandbox | Free |
| 5 — Conviction | Signal convergence matrix, regime adjustment, scenarios, invalidation | Calculated | Free |

## Four-stage AI pipeline

```
Gemini (News Scout) → Claude (Lead Analyst) → GPT-4o (Devil's Advocate) → Claude (Judge)
```

Every AI stage receives the full signal bundle — 50+ pre-computed signals, not just a price description.

## Setup

### 1. Clone & install
```bash
git clone https://github.com/YOUR_USERNAME/consilium.git
cd consilium && npm install
```

### 2. Supabase
1. Create project at supabase.com
2. SQL Editor → run supabase/migrations/002_v2_schema.sql
3. Copy Project URL, anon key, service role key

### 3. API keys needed
- Anthropic: console.anthropic.com
- OpenAI: platform.openai.com
- Google AI: aistudio.google.com (free)
- Alpaca: alpaca.markets (free paper account)
- Finnhub: finnhub.io (free tier)
- Tradier: tradier.com/create/account (free sandbox)

### 4. Configure
```bash
cp .env.local.example .env.local
# fill in all values
```

### 5. Run
```bash
npm run dev
```

## Deploy to Vercel
```bash
git init && git add . && git commit -m "Initial commit"
git remote add origin https://github.com/YOUR_USERNAME/consilium.git
git push -u origin main
# Then: vercel.com → Add New Project → Import → Add env vars → Deploy
```

## Cost per run
~$0.01-0.015 total across all three AI APIs. All data sources are free.

## Project structure
```
app/
  api/analyze/route.ts     ← SSE streaming pipeline endpoint
  lib/
    aggregator.ts          ← Assembles all 5 phases into SignalBundle
    pipeline.ts            ← 4-stage AI debate
    data/alpaca.ts         ← Price, bars, news
    signals/
      technicals.ts        ← RSI, MACD, Bollinger, MAs, Volume
      market-context.ts    ← SPY/QQQ/VIX/sector/peers/DXY
      fundamentals.ts      ← Finnhub: P/E, earnings, analysts
      smart-money.ts       ← SEC EDGAR + congressional trades
      options-flow.ts      ← Tradier options + short interest
      conviction.ts        ← Signal convergence + scenarios
  page.tsx                 ← Full dashboard UI
supabase/migrations/
  002_v2_schema.sql        ← Run this in Supabase SQL editor
```

## Disclaimer
For informational purposes only. Not financial advice. AI models can be wrong. Always do your own research.
