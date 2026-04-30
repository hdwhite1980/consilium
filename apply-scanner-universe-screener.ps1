# apply-scanner-universe-screener.ps1
#
# Adds to app/lib/scanner-universe.ts:
#   1. New 'source' field on PredefinedUniverse (optional, defaults to 'curated')
#   2. New 'priceMin' / 'priceMax' fields on ScannerFilter
#   3. New screener-sourced presets: most_active, top_gainers, top_losers,
#      penny_movers, all_movers
#   4. Helper getUniverseSource(presetId) for the API route to branch on
#
# All edits are additive — no existing curated entries change.

param([switch]$Apply)
$ErrorActionPreference = 'Stop'

if (-not (Test-Path 'app\lib\scanner-universe.ts')) {
    Write-Host "ERROR: app\lib\scanner-universe.ts not found" -ForegroundColor Red
    exit 1
}

function Norm([string]$s) { $s -replace "`r`n", "`n" }

$path = 'app\lib\scanner-universe.ts'
$abs = (Resolve-Path $path).Path
$work = [System.IO.File]::ReadAllText($abs, [System.Text.UTF8Encoding]::new($false))

if ($work -match "type UniverseSource") {
    Write-Host "[ok] scanner-universe.ts already patched" -ForegroundColor DarkGray
    exit 0
}

# ── Edit 1: Add UniverseSource type + extend PredefinedUniverse ───────────
$old1 = @"
export interface PredefinedUniverse {
  id: string
  label: string
  description: string
  filter: (e: UniverseEntry) => boolean
}
"@

$new1 = @"
// UniverseSource — where the scanner pulls tickers from.
//   'curated'           — the static SCANNER_UNIVERSE list (~500 hand-picked)
//   'screener-actives'  — Alpaca's most-actives (~100 by volume, real-time)
//   'screener-gainers'  — Alpaca's top gainers (~50, real-time)
//   'screener-losers'   — Alpaca's top losers (~50, real-time)
//   'screener-all'      — Union of most-actives + gainers + losers (~150-250)
//   'union'             — Curated union with screener-all (~600-650, dedup)
export type UniverseSource =
  | 'curated'
  | 'screener-actives'
  | 'screener-gainers'
  | 'screener-losers'
  | 'screener-all'
  | 'union'

export interface PredefinedUniverse {
  id: string
  label: string
  description: string
  filter: (e: UniverseEntry) => boolean
  source?: UniverseSource    // defaults to 'curated' for backward compat
}
"@

# ── Edit 2: Extend ScannerFilter with priceMin / priceMax ──────────────────
$old2 = @"
export interface ScannerFilter {
  sectors?: Sector[]            // restrict to these sectors
  caps?: CapTier[]              // restrict to these cap tiers
  priceTiers?: PriceTier[]      // restrict to these price tiers
  tagsIncludeAny?: string[]     // has at least ONE of these tags
  tagsIncludeAll?: string[]     // has ALL of these tags
  tagsExcludeAny?: string[]     // has NONE of these tags
  tickers?: string[]            // explicit ticker list override
  predefined?: string           // id from PREDEFINED_UNIVERSES
}
"@

$new2 = @"
export interface ScannerFilter {
  sectors?: Sector[]            // restrict to these sectors
  caps?: CapTier[]              // restrict to these cap tiers
  priceTiers?: PriceTier[]      // restrict to these price tiers (curated tag-based)
  priceMin?: number             // live price floor (post-bars, applies to ANY source)
  priceMax?: number             // live price ceiling (post-bars, applies to ANY source)
  tagsIncludeAny?: string[]     // has at least ONE of these tags
  tagsIncludeAll?: string[]     // has ALL of these tags
  tagsExcludeAny?: string[]     // has NONE of these tags
  tickers?: string[]            // explicit ticker list override
  predefined?: string           // id from PREDEFINED_UNIVERSES
}
"@

# ── Edit 3: Add screener-sourced presets to PREDEFINED_UNIVERSES ──────────
# Append before the closing ']' of the array. We anchor to the existing
# 'meme' entry which is the last one in the file.
$old3 = @"
  { id: 'meme', label: 'Meme / Volatile',
    description: 'High-volatility retail favorites',
    filter: (e) => e.tags.includes('meme') || e.tags.includes('volatile') },
]
"@

$new3 = @"
  { id: 'meme', label: 'Meme / Volatile',
    description: 'High-volatility retail favorites',
    filter: (e) => e.tags.includes('meme') || e.tags.includes('volatile') },

  // ── Live screener-sourced presets ──────────────────────────────
  // These don't filter the curated universe — they pull from Alpaca's
  // real-time screener API. The 'filter' is a no-op so applyFilter()
  // returns nothing; the API route checks the source field and fetches
  // from Alpaca instead of SCANNER_UNIVERSE.
  { id: 'most_active', label: 'Most Active (live)',
    description: 'Top 100 stocks by volume today (Alpaca screener)',
    filter: () => false,
    source: 'screener-actives' },

  { id: 'top_gainers', label: 'Top Gainers (live)',
    description: 'Top 50 daily gainers across the market (Alpaca screener)',
    filter: () => false,
    source: 'screener-gainers' },

  { id: 'top_losers', label: 'Top Losers (live)',
    description: 'Top 50 daily losers across the market (Alpaca screener)',
    filter: () => false,
    source: 'screener-losers' },

  { id: 'all_movers', label: 'All Movers (live)',
    description: 'Most active + gainers + losers (~150-250 unique tickers)',
    filter: () => false,
    source: 'screener-all' },

  { id: 'penny_movers', label: 'Penny Movers (live)',
    description: 'All movers, filtered to under \$5 by live price',
    filter: () => false,
    source: 'screener-all' },

  { id: 'union_full', label: 'Curated + Movers',
    description: 'Curated universe joined with live movers (~600-650 tickers)',
    filter: () => true,           // curated side: include everything
    source: 'union' },
]
"@

# ── Edit 4: Add helper getUniverseSource() at end of file ─────────────────
$old4 = @"
export function getPredefinedUniverse(id: string): UniverseEntry[] {
  const preset = PREDEFINED_UNIVERSES.find(p => p.id === id)
  if (!preset) return []
  return SCANNER_UNIVERSE.filter(preset.filter)
}
"@

$new4 = @"
export function getPredefinedUniverse(id: string): UniverseEntry[] {
  const preset = PREDEFINED_UNIVERSES.find(p => p.id === id)
  if (!preset) return []
  return SCANNER_UNIVERSE.filter(preset.filter)
}

// Returns the source for a preset id. Defaults to 'curated' for any
// preset that doesn't explicitly declare one (i.e. all the original
// PREDEFINED_UNIVERSES entries).
export function getUniverseSource(presetId: string | undefined): UniverseSource {
  if (!presetId) return 'curated'
  const preset = PREDEFINED_UNIVERSES.find(p => p.id === presetId)
  return preset?.source ?? 'curated'
}
"@

# Apply all edits
$workNorm = Norm $work
$edits = @(
    @{ old = (Norm $old1); new = (Norm $new1); name = 'PredefinedUniverse + UniverseSource' }
    @{ old = (Norm $old2); new = (Norm $new2); name = 'ScannerFilter price range' }
    @{ old = (Norm $old3); new = (Norm $new3); name = 'screener-sourced presets' }
    @{ old = (Norm $old4); new = (Norm $new4); name = 'getUniverseSource helper' }
)

foreach ($e in $edits) {
    if (-not $workNorm.Contains($e.old)) {
        Write-Host "[FAIL] anchor missed: $($e.name)" -ForegroundColor Red
        Write-Host "  Open $path and verify the file matches what the patch expects." -ForegroundColor Yellow
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
