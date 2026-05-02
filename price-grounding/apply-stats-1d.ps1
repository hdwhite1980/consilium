# =============================================================
# apply-stats-1d.ps1
#
# Patches app/api/backtest/stats/route.ts to support the '1d'
# horizon. Without this patch, GET /api/backtest/stats?horizon=1d
# silently falls back to reading outcome_1m_strict (because the
# column-picker is binary 1w-vs-else), so the UI shows all 1D
# verdicts as Pending even when they are resolved in the DB.
#
# Pure ASCII. LF-aware (this file uses LF endings).
#
# Usage:
#   .\apply-stats-1d.ps1          (dry run)
#   .\apply-stats-1d.ps1 -Apply   (write)
# =============================================================

param([switch]$Apply)

$ErrorActionPreference = 'Stop'
$file = 'app\api\backtest\stats\route.ts'

if (-not (Test-Path $file)) {
  Write-Host "ERROR: $file not found. Run from repo root." -ForegroundColor Red
  exit 1
}

# Byte-exact read
$bytes = [System.IO.File]::ReadAllBytes((Resolve-Path $file).Path)
$content = [System.Text.UTF8Encoding]::new($false).GetString($bytes)
$original = $content

$useCrlf = $content.Contains("`r`n")
Write-Host "Detected line endings: $(if ($useCrlf) { 'CRLF' } else { 'LF' })" -ForegroundColor Cyan

# Idempotency
if ($content.Contains('outcome_1d_strict')) {
  Write-Host "Already patched (outcome_1d_strict present). Nothing to do." -ForegroundColor Green
  exit 0
}

# Helper: assert old appears exactly once, then replace
function Patch-Once {
  param([string] $Name, [ref] $Content, [string] $Old, [string] $New)
  $idx = $Content.Value.IndexOf($Old)
  if ($idx -lt 0) {
    Write-Host "  ERROR $Name : anchor not found" -ForegroundColor Red
    return $false
  }
  if ($Content.Value.IndexOf($Old, $idx + 1) -ge 0) {
    Write-Host "  ERROR $Name : anchor matches more than once" -ForegroundColor Red
    return $false
  }
  $Content.Value = $Content.Value.Substring(0, $idx) + $New + $Content.Value.Substring($idx + $Old.Length)
  Write-Host "  OK   $Name" -ForegroundColor Green
  return $true
}

$errors = 0

# ---------------------------------------------------------
# S1: VerdictRow interface - add 1d columns
# Uses single-quoted here-string to avoid all PS escaping.
# ---------------------------------------------------------
$oldS1 = @'
interface VerdictRow {
  ticker: string
  signal: string
  confidence: number | null
  persona: string | null
  timeframe: string | null
  verdict_date: string
  entry_price: number | null
  outcome_1w_strict: string
  outcome_1w_directional: string
  outcome_1w_price: number | null
  outcome_1m_strict: string
  outcome_1m_directional: string
  outcome_1m_price: number | null
}
'@

$newS1 = @'
interface VerdictRow {
  ticker: string
  signal: string
  confidence: number | null
  persona: string | null
  timeframe: string | null
  verdict_date: string
  entry_price: number | null
  outcome_1d_strict: string
  outcome_1d_directional: string
  outcome_1d_price: number | null
  outcome_1w_strict: string
  outcome_1w_directional: string
  outcome_1w_price: number | null
  outcome_1m_strict: string
  outcome_1m_directional: string
  outcome_1m_price: number | null
}
'@

# Strip trailing newline added by here-string and normalize to LF
$oldS1 = $oldS1.TrimEnd("`r","`n").Replace("`r`n","`n")
$newS1 = $newS1.TrimEnd("`r","`n").Replace("`r`n","`n")
if (-not (Patch-Once -Name 'S1 VerdictRow interface' -Content ([ref]$content) -Old $oldS1 -New $newS1)) { $errors++ }

# ---------------------------------------------------------
# S2: computeHitRate - widen horizon type, fix column picker
# ---------------------------------------------------------
$oldS2 = @'
function computeHitRate(rows: VerdictRow[], horizon: '1w' | '1m'): {
  wins: number; losses: number; expired: number; total: number; hitRate: number
} {
  const strictCol = horizon === '1w' ? 'outcome_1w_strict' : 'outcome_1m_strict'
'@

$newS2 = @'
function computeHitRate(rows: VerdictRow[], horizon: '1d' | '1w' | '1m'): {
  wins: number; losses: number; expired: number; total: number; hitRate: number
} {
  const strictCol =
    horizon === '1d' ? 'outcome_1d_strict' :
    horizon === '1w' ? 'outcome_1w_strict' :
    'outcome_1m_strict'
'@

$oldS2 = $oldS2.TrimEnd("`r","`n").Replace("`r`n","`n")
$newS2 = $newS2.TrimEnd("`r","`n").Replace("`r`n","`n")
if (-not (Patch-Once -Name 'S2 computeHitRate' -Content ([ref]$content) -Old $oldS2 -New $newS2)) { $errors++ }

# ---------------------------------------------------------
# S3: computeDirectionAccuracy - same treatment
# ---------------------------------------------------------
$oldS3 = @'
function computeDirectionAccuracy(rows: VerdictRow[], horizon: '1w' | '1m'): {
  correct: number; incorrect: number; pending: number; total: number; accuracy: number
} {
  const col = horizon === '1w' ? 'outcome_1w_directional' : 'outcome_1m_directional'
'@

$newS3 = @'
function computeDirectionAccuracy(rows: VerdictRow[], horizon: '1d' | '1w' | '1m'): {
  correct: number; incorrect: number; pending: number; total: number; accuracy: number
} {
  const col =
    horizon === '1d' ? 'outcome_1d_directional' :
    horizon === '1w' ? 'outcome_1w_directional' :
    'outcome_1m_directional'
'@

$oldS3 = $oldS3.TrimEnd("`r","`n").Replace("`r`n","`n")
$newS3 = $newS3.TrimEnd("`r","`n").Replace("`r`n","`n")
if (-not (Patch-Once -Name 'S3 computeDirectionAccuracy' -Content ([ref]$content) -Old $oldS3 -New $newS3)) { $errors++ }

# ---------------------------------------------------------
# S4: GET handler horizon param type
# ---------------------------------------------------------
$oldS4 = "  const horizon = (url.searchParams.get('horizon') ?? '1w') as '1w' | '1m'"
$newS4 = "  const horizon = (url.searchParams.get('horizon') ?? '1w') as '1d' | '1w' | '1m'"
if (-not (Patch-Once -Name 'S4 horizon param type' -Content ([ref]$content) -Old $oldS4 -New $newS4)) { $errors++ }

# ---------------------------------------------------------
# S5: SELECT query - add 1d columns
# ---------------------------------------------------------
$oldS5 = ".select('ticker, signal, confidence, persona, timeframe, verdict_date, entry_price, outcome_1w_strict, outcome_1w_directional, outcome_1w_price, outcome_1m_strict, outcome_1m_directional, outcome_1m_price')"
$newS5 = ".select('ticker, signal, confidence, persona, timeframe, verdict_date, entry_price, outcome_1d_strict, outcome_1d_directional, outcome_1d_price, outcome_1w_strict, outcome_1w_directional, outcome_1w_price, outcome_1m_strict, outcome_1m_directional, outcome_1m_price')"
if (-not (Patch-Once -Name 'S5 SELECT query columns' -Content ([ref]$content) -Old $oldS5 -New $newS5)) { $errors++ }

# ---------------------------------------------------------
# S6: 'recent' mapping column-pickers
# ---------------------------------------------------------
$oldS6 = @'
  // Recent verdicts (last 100 for display)
  const horizonStrict = horizon === '1w' ? 'outcome_1w_strict' : 'outcome_1m_strict'
  const horizonDir    = horizon === '1w' ? 'outcome_1w_directional' : 'outcome_1m_directional'
  const horizonPrice  = horizon === '1w' ? 'outcome_1w_price' : 'outcome_1m_price'
'@

$newS6 = @'
  // Recent verdicts (last 100 for display)
  const horizonStrict =
    horizon === '1d' ? 'outcome_1d_strict' :
    horizon === '1w' ? 'outcome_1w_strict' :
    'outcome_1m_strict'
  const horizonDir =
    horizon === '1d' ? 'outcome_1d_directional' :
    horizon === '1w' ? 'outcome_1w_directional' :
    'outcome_1m_directional'
  const horizonPrice =
    horizon === '1d' ? 'outcome_1d_price' :
    horizon === '1w' ? 'outcome_1w_price' :
    'outcome_1m_price'
'@

$oldS6 = $oldS6.TrimEnd("`r","`n").Replace("`r`n","`n")
$newS6 = $newS6.TrimEnd("`r","`n").Replace("`r`n","`n")
if (-not (Patch-Once -Name 'S6 recent mapping' -Content ([ref]$content) -Old $oldS6 -New $newS6)) { $errors++ }

# ---------------------------------------------------------
# S7: doc comment (cosmetic)
# ---------------------------------------------------------
$oldS7 = "//   horizon: '1w' (default) | '1m'"
$newS7 = "//   horizon: '1w' (default) | '1d' | '1m'"
if (-not (Patch-Once -Name 'S7 doc comment' -Content ([ref]$content) -Old $oldS7 -New $newS7)) { $errors++ }

if ($errors -gt 0) {
  Write-Host ""
  Write-Host "STOPPED: $errors patch(es) failed. File NOT written." -ForegroundColor Red
  exit 1
}

if ($content -eq $original) {
  Write-Host "No change. Aborting." -ForegroundColor Yellow
  exit 0
}

if ($Apply) {
  [System.IO.File]::WriteAllText((Resolve-Path $file).Path, $content, [System.Text.UTF8Encoding]::new($false))
  Write-Host ""
  Write-Host "WROTE $file" -ForegroundColor Green
  Write-Host ""
  Write-Host "Next: npm run build" -ForegroundColor Cyan
} else {
  Write-Host ""
  Write-Host "Dry run looked good. Re-run with -Apply to write." -ForegroundColor Yellow
}
