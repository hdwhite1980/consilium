# fix-scanner-route-scoreTicker.ps1
#
# Fixes the build error: scoreTicker call missing tickerChange10d/tickerChange30d.
# Adds pctChangeOverDays import and threads true 10d/30d changes through.
# 3 edits, anchor-based, all-or-nothing.

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

if ($work -match "pctChangeOverDays") {
    Write-Host "[ok] route.ts already patched" -ForegroundColor DarkGray
    exit 0
}

# ── Edit 1: Add pctChangeOverDays to scanner-scoring import
$old1 = @"
import { scoreTicker, type TickerScore } from '@/app/lib/scanner-scoring'
"@
$new1 = @"
import { scoreTicker, pctChangeOverDays, type TickerScore } from '@/app/lib/scanner-scoring'
"@

# ── Edit 2: Update computeTickerTechnicals to return closes too
$old2 = @"
async function computeTickerTechnicals(ticker: string): Promise<{
  ticker: string
  technicals: TechnicalSignals
} | null> {
  try {
    const bars = await fetchBars(ticker, '1M')
    if (!bars || bars.length < 20) return null
    const t = calculateTechnicals(bars)
    if (!t.currentPrice || t.currentPrice <= 0) return null
    return { ticker, technicals: t }
  } catch {
    return null
  }
}
"@
$new2 = @"
async function computeTickerTechnicals(ticker: string): Promise<{
  ticker: string
  technicals: TechnicalSignals
  closes: number[]
} | null> {
  try {
    const bars = await fetchBars(ticker, '1M')
    if (!bars || bars.length < 20) return null
    const t = calculateTechnicals(bars)
    if (!t.currentPrice || t.currentPrice <= 0) return null
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const closes = bars.map((b: any) => b.c).filter((c: number) => typeof c === 'number')
    return { ticker, technicals: t, closes }
  } catch {
    return null
  }
}
"@

# ── Edit 3: Update scoreTicker call to pass true 10d/30d ticker changes
$old3 = @"
      const score = scoreTicker({
        ticker: data.ticker,
        technicals: data.technicals,
        spyChange10d,
        spyChange30d,
      })
"@
$new3 = @"
      const tickerChange10d = pctChangeOverDays(data.closes, 10)
      const tickerChange30d = pctChangeOverDays(data.closes, 30)

      const score = scoreTicker({
        ticker: data.ticker,
        technicals: data.technicals,
        tickerChange10d,
        tickerChange30d,
        spyChange10d,
        spyChange30d,
      })
"@

# Apply
$workNorm = Norm $work
$edits = @(
    @{ old = (Norm $old1); new = (Norm $new1); name = '1. pctChangeOverDays import' }
    @{ old = (Norm $old2); new = (Norm $new2); name = '2. computeTickerTechnicals returns closes' }
    @{ old = (Norm $old3); new = (Norm $new3); name = '3. scoreTicker call signature' }
)

foreach ($e in $edits) {
    if (-not $workNorm.Contains($e.old)) {
        Write-Host "[FAIL] anchor missed: $($e.name)" -ForegroundColor Red
        Write-Host "  Open $path and verify the anchor text matches." -ForegroundColor Yellow
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
