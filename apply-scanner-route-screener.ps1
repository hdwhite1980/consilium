# apply-scanner-route-screener.ps1
#
# Surgical additive patch to app/api/scanner/route.ts.
# Adds screener-sourced universes (most-actives/gainers/losers/all/union)
# and live priceMin/priceMax filtering, WITHOUT touching the existing
# Directional or Fast Movers logic.
#
# 5 edits, anchor-based, all-or-nothing.

param([switch]$Apply)
$ErrorActionPreference = 'Stop'

if (-not (Test-Path 'app\api\scanner\route.ts')) {
    Write-Host "ERROR: app\api\scanner\route.ts not found" -ForegroundColor Red
    exit 1
}

function Norm([string]$s) { $s -replace "`r`n", "`n" }

$path = 'app\api\scanner\route.ts'
$abs = (Resolve-Path $path).Path
$work = [System.IO.File]::ReadAllText($abs, [System.Text.UTF8Encoding]::new($false))

if ($work -match "alpaca-screener" -and $work -match "resolveScreenerEntries") {
    Write-Host "[ok] route.ts already patched" -ForegroundColor DarkGray
    exit 0
}

# ── Edit 1: Extend scanner-universe import to include getUniverseSource and UniverseSource type
$old1 = @"
import {
  applyFilter,
  PREDEFINED_UNIVERSES,
  SCANNER_UNIVERSE,
  type ScannerFilter,
  type UniverseEntry,
} from '@/app/lib/scanner-universe'
"@

$new1 = @"
import {
  applyFilter,
  PREDEFINED_UNIVERSES,
  SCANNER_UNIVERSE,
  getUniverseSource,
  type ScannerFilter,
  type UniverseEntry,
  type UniverseSource,
} from '@/app/lib/scanner-universe'
"@

# ── Edit 2: Add alpaca-screener import after news-exposure import
$old2 = @"
import {
  buildNewsExposureMap,
  applyExposureToComposite,
  type NewsExposureContext,
} from '@/app/lib/news-exposure'
"@

$new2 = @"
import {
  buildNewsExposureMap,
  applyExposureToComposite,
  type NewsExposureContext,
} from '@/app/lib/news-exposure'
import {
  getMostActives,
  getMovers,
  getAllScreenerMovers,
  isAlpacaConfigured,
} from '@/app/lib/alpaca-screener'
"@

# ── Edit 3: Add resolveScreenerEntries helper just before "GET" section header
# Anchor is the GET section comment block — stable text just before the function
$old3 = @"
// ═════════════════════════════════════════════════════════════
// GET
// ═════════════════════════════════════════════════════════════
"@

$new3 = @"
// ─────────────────────────────────────────────────────────────
// Screener-sourced universe resolution
// ─────────────────────────────────────────────────────────────
// For 'curated' source, applyFilter() handles everything.
// For 'screener-*' sources, fetch live tickers from Alpaca and
// synthesize UniverseEntry stubs (reusing curated metadata when
// the ticker is in both lists).
// For 'union', merge curated-filtered with screener-all, deduped.

function makeStubEntry(ticker: string): UniverseEntry {
  return {
    ticker: ticker.toUpperCase(),
    sector: 'tech',
    cap: 'small',
    priceTier: 'sub10',
    tags: [],
  }
}

function dedupeEntries(entries: UniverseEntry[]): UniverseEntry[] {
  const seen = new Set<string>()
  const out: UniverseEntry[] = []
  for (const e of entries) {
    const t = e.ticker.toUpperCase()
    if (!seen.has(t)) { seen.add(t); out.push(e) }
  }
  return out
}

async function resolveScreenerEntries(
  source: UniverseSource,
  filter: ScannerFilter,
): Promise<UniverseEntry[]> {
  if (!isAlpacaConfigured()) {
    console.warn('[scanner] Alpaca not configured — falling back to curated all')
    return applyFilter({ ...filter, predefined: 'all' })
  }

  let tickers: string[] = []

  if (source === 'screener-actives') {
    tickers = (await getMostActives(100)).map(m => m.ticker)
  } else if (source === 'screener-gainers') {
    tickers = (await getMovers(50)).gainers.map(m => m.ticker)
  } else if (source === 'screener-losers') {
    tickers = (await getMovers(50)).losers.map(m => m.ticker)
  } else if (source === 'screener-all' || source === 'union') {
    tickers = (await getAllScreenerMovers({ mostActiveTop: 100, moversTop: 50 })).map(m => m.ticker)
  }

  // Convert to UniverseEntry — reuse curated metadata when ticker is in SCANNER_UNIVERSE
  const screenerEntries: UniverseEntry[] = tickers.map(t => {
    const curated = SCANNER_UNIVERSE.find(e => e.ticker === t)
    return curated ?? makeStubEntry(t)
  })

  if (source === 'union') {
    const curatedFiltered = applyFilter(filter)
    return dedupeEntries([...curatedFiltered, ...screenerEntries])
  }

  return dedupeEntries(screenerEntries)
}

// ═════════════════════════════════════════════════════════════
// GET
// ═════════════════════════════════════════════════════════════
"@

# ── Edit 4: Replace the entries resolution to branch on source
$old4 = @"
    const effectiveFilter: ScannerFilter = { ...filter, predefined: filter.predefined ?? universe }

    const key = cacheKey(universe, mode, hashFilter(effectiveFilter), newsBoost, scanType, horizon, priceCeiling)
    const cached = scanCache.get(key)
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      const age = Math.round((Date.now() - cached.fetchedAt) / 60000)
      console.log(``[scanner] cache hit (age `${age}m, scanType=`${scanType})``)
      return NextResponse.json({ ...cached.result, cached: true, ageMinutes: age })
    }

    const entries = applyFilter(effectiveFilter)
    if (entries.length === 0) {
      return NextResponse.json({
        error: 'No tickers match your filter. Try a broader universe or remove some constraints.',
      }, { status: 400 })
    }
    console.log(``[scanner] scanning `${entries.length} tickers (universe: `${universe}, mode: `${mode}, scanType: `${scanType}, horizon: `${horizon}, ceiling: `$`${priceCeiling}, newsBoost: `${newsBoost})``)
"@

$new4 = @"
    const effectiveFilter: ScannerFilter = { ...filter, predefined: filter.predefined ?? universe }

    // Auto-set priceMax=5 for the penny_movers preset
    if (universe === 'penny_movers' && typeof effectiveFilter.priceMax !== 'number') {
      effectiveFilter.priceMax = 5
    }

    const source = getUniverseSource(universe)

    const key = cacheKey(universe, mode, hashFilter(effectiveFilter), newsBoost, scanType, horizon, priceCeiling)
    const cached = scanCache.get(key)
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      const age = Math.round((Date.now() - cached.fetchedAt) / 60000)
      console.log(``[scanner] cache hit (age `${age}m, scanType=`${scanType}, source=`${source})``)
      return NextResponse.json({ ...cached.result, cached: true, ageMinutes: age })
    }

    // Resolve entries — curated path uses applyFilter; screener paths fetch live
    const entries = source === 'curated'
      ? applyFilter(effectiveFilter)
      : await resolveScreenerEntries(source, effectiveFilter)

    if (entries.length === 0) {
      return NextResponse.json({
        error: source === 'curated'
          ? 'No tickers match your filter. Try a broader universe or remove some constraints.'
          : 'No tickers returned from screener. The market may be closed or Alpaca is unavailable.',
      }, { status: 400 })
    }
    console.log(``[scanner] scanning `${entries.length} tickers (universe: `${universe}, source: `${source}, mode: `${mode}, scanType: `${scanType}, horizon: `${horizon}, ceiling: `$`${priceCeiling}, newsBoost: `${newsBoost})``)
"@

# ── Edit 5: Add priceMin/priceMax filter inside scanTickers, right after the
# existing fast_movers price gate. We need access to filter here, so we also
# update the function signature.
#
# First, update the scanTickers signature
$old5a = @"
async function scanTickers(
  entries: UniverseEntry[],
  spyChange10d: number,
  spyChange30d: number,
  newsExposureMap: Map<string, NewsExposureContext> | null,
  scanType: ScanType,
  horizon: Horizon,
  priceCeiling: number,
): Promise<EnrichedScore[]> {
"@

$new5a = @"
async function scanTickers(
  entries: UniverseEntry[],
  spyChange10d: number,
  spyChange30d: number,
  newsExposureMap: Map<string, NewsExposureContext> | null,
  scanType: ScanType,
  horizon: Horizon,
  priceCeiling: number,
  priceMin: number | null,
  priceMax: number | null,
): Promise<EnrichedScore[]> {
"@

# Add the priceMin/priceMax filter right after the fast_movers price gate
$old5b = @"
      // ── Fast-mover price gate ──
      // Done with FRESH price, not stale priceTier metadata. A ticker
      // tagged 'under50' last month might be `$19 today (or `$52).
      if (scanType === 'fast_movers' && data.technicals.currentPrice > priceCeiling) {
        return null
      }
"@

$new5b = @"
      // ── Fast-mover price gate ──
      // Done with FRESH price, not stale priceTier metadata. A ticker
      // tagged 'under50' last month might be `$19 today (or `$52).
      if (scanType === 'fast_movers' && data.technicals.currentPrice > priceCeiling) {
        return null
      }

      // ── Live priceMin/priceMax filter (works on any scan type) ──
      // Uses actual current price from bars, not stale priceTier metadata.
      const livePrice = data.technicals.currentPrice
      if (priceMin !== null && livePrice < priceMin) return null
      if (priceMax !== null && livePrice > priceMax) return null
"@

# Update the scanTickers call site to pass priceMin/priceMax
$old5c = @"
    // Scan
    const scanStart = Date.now()
    const allScores = await scanTickers(
      entries, spyChange10d, spyChange30d, newsExposureMap,
      scanType, horizon, priceCeiling,
    )
"@

$new5c = @"
    // Scan
    const scanStart = Date.now()
    const pmin = typeof effectiveFilter.priceMin === 'number' && effectiveFilter.priceMin > 0 ? effectiveFilter.priceMin : null
    const pmax = typeof effectiveFilter.priceMax === 'number' && effectiveFilter.priceMax > 0 ? effectiveFilter.priceMax : null
    const allScores = await scanTickers(
      entries, spyChange10d, spyChange30d, newsExposureMap,
      scanType, horizon, priceCeiling, pmin, pmax,
    )
"@

# Apply edits in order
$workNorm = Norm $work
$edits = @(
    @{ old = (Norm $old1);  new = (Norm $new1);  name = '1. scanner-universe import (add UniverseSource)' }
    @{ old = (Norm $old2);  new = (Norm $new2);  name = '2. alpaca-screener import' }
    @{ old = (Norm $old3);  new = (Norm $new3);  name = '3. resolveScreenerEntries helper' }
    @{ old = (Norm $old4);  new = (Norm $new4);  name = '4. POST entries resolution dispatch' }
    @{ old = (Norm $old5a); new = (Norm $new5a); name = '5a. scanTickers signature (add pmin/pmax)' }
    @{ old = (Norm $old5b); new = (Norm $new5b); name = '5b. priceMin/priceMax filter in loop' }
    @{ old = (Norm $old5c); new = (Norm $new5c); name = '5c. scanTickers call site' }
)

foreach ($e in $edits) {
    if (-not $workNorm.Contains($e.old)) {
        Write-Host "[FAIL] anchor missed: $($e.name)" -ForegroundColor Red
        Write-Host "  Open $path and verify the anchor exists." -ForegroundColor Yellow
        exit 1
    }
    $workNorm = $workNorm.Replace($e.old, $e.new)
    Write-Host "[+] $($e.name)" -ForegroundColor Green
}

$newWork = $workNorm -replace "`n", "`r`n"

if ($Apply) {
    [System.IO.File]::WriteAllText($abs, $newWork, [System.Text.UTF8Encoding]::new($false))
    Write-Host "  Wrote $path" -ForegroundColor Green
} else {
    Write-Host "DRY RUN — re-run with -Apply to write." -ForegroundColor Yellow
}
