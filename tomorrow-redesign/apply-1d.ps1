# =============================================================
# apply-1d.ps1
#
# Two files patched:
#   1. app/api/backtest/outcomes/route.ts
#      - HorizonConfig gains optional timeframeFilter field
#      - 1d horizon: daysOld 1 -> 2, timeframeFilter='1D'
#      - processHorizon respects timeframeFilter
#      - GET diagnostic respects timeframeFilter
#   2. app/track-record/page.tsx
#      - horizon state type widened to include '1d'
#      - Adds "1 Day" button before "1 Week"
#
# Pure ASCII. Line-ending aware (these files use LF, not CRLF).
#
# Usage:
#   .\apply-1d.ps1          (dry run)
#   .\apply-1d.ps1 -Apply   (write)
# =============================================================

param([switch]$Apply)

$ErrorActionPreference = 'Stop'

$routeFile = 'app\api\backtest\outcomes\route.ts'
$pageFile  = 'app\track-record\page.tsx'

if (-not (Test-Path $routeFile)) {
  Write-Host "ERROR: $routeFile not found. Run from repo root." -ForegroundColor Red
  exit 1
}
if (-not (Test-Path $pageFile)) {
  Write-Host "ERROR: $pageFile not found. Run from repo root." -ForegroundColor Red
  exit 1
}

# Helper: byte-exact read, preserves whatever line endings the file uses
function Read-FileText {
  param([string] $Path)
  $bytes = [System.IO.File]::ReadAllBytes((Resolve-Path $Path).Path)
  return [System.Text.UTF8Encoding]::new($false).GetString($bytes)
}

function Write-FileText {
  param([string] $Path, [string] $Content)
  [System.IO.File]::WriteAllText((Resolve-Path $Path).Path, $Content, [System.Text.UTF8Encoding]::new($false))
}

# Helper: assert the old string appears exactly once, then replace
function Patch-Once {
  param(
    [Parameter(Mandatory=$true)] [string] $Name,
    [Parameter(Mandatory=$true)] [ref] $Content,
    [Parameter(Mandatory=$true)] [string] $Old,
    [Parameter(Mandatory=$true)] [string] $New
  )
  $idx = $Content.Value.IndexOf($Old)
  if ($idx -lt 0) {
    Write-Host "  ERROR $Name : anchor not found" -ForegroundColor Red
    return $false
  }
  $secondIdx = $Content.Value.IndexOf($Old, $idx + 1)
  if ($secondIdx -ge 0) {
    Write-Host "  ERROR $Name : anchor matches more than once" -ForegroundColor Red
    return $false
  }
  $Content.Value = $Content.Value.Substring(0, $idx) + $New + $Content.Value.Substring($idx + $Old.Length)
  Write-Host "  OK   $Name" -ForegroundColor Green
  return $true
}

$LF = "`n"

# ============================================================
# ROUTE FILE
# ============================================================
Write-Host "Patching $routeFile" -ForegroundColor Cyan
$route = Read-FileText $routeFile
$routeOriginal = $route

# Detect line endings - these files use LF, but be defensive
$routeUsesCrlf = $route.Contains("`r`n")
Write-Host "  Line endings: $(if ($routeUsesCrlf) { 'CRLF' } else { 'LF' })"

# Idempotency
if ($route.Contains('timeframeFilter?:') -or $route.Contains("timeframeFilter: '1D'")) {
  Write-Host "  Already patched (timeframeFilter present). Skipping route file." -ForegroundColor Yellow
  $routeChanged = $false
} else {
  $routeChanged = $true
  $errors = 0

  # ---------------------------------------------------------
  # Patch R1: add timeframeFilter to HorizonConfig
  # ---------------------------------------------------------
  $oldR1 = @(
    "interface HorizonConfig {",
    "  key: '1d' | '1w' | '1m'",
    "  daysOld: number              // verdict must be at least this old",
    "  windowDays: number           // how many days of candles to fetch",
    "  strictColumn: string",
    "  directionalColumn: string",
    "  priceColumn: string",
    "  computedAtColumn: string",
    "  legacyColumn?: string        // for back-compat (1w/1m have legacy outcome_1w / outcome_1m)",
    "}"
  ) -join $LF

  $newR1 = @(
    "interface HorizonConfig {",
    "  key: '1d' | '1w' | '1m'",
    "  daysOld: number              // verdict must be at least this old",
    "  windowDays: number           // how many days of candles to fetch",
    "  strictColumn: string",
    "  directionalColumn: string",
    "  priceColumn: string",
    "  computedAtColumn: string",
    "  legacyColumn?: string        // for back-compat (1w/1m have legacy outcome_1w / outcome_1m)",
    "  timeframeFilter?: string     // if set, only resolve verdicts where timeframe matches",
    "}"
  ) -join $LF

  if (-not (Patch-Once -Name 'R1 HorizonConfig field' -Content ([ref]$route) -Old $oldR1 -New $newR1)) { $errors++ }

  # ---------------------------------------------------------
  # Patch R2: 1d HORIZONS entry - daysOld 1->2, timeframeFilter='1D'
  # ---------------------------------------------------------
  $oldR2 = @(
    "  {",
    "    key: '1d',",
    "    daysOld: 1,",
    "    windowDays: 2,                 // grab 2 days of bars to handle weekend gaps",
    "    strictColumn: 'outcome_1d_strict',",
    "    directionalColumn: 'outcome_1d_directional',",
    "    priceColumn: 'outcome_1d_price',",
    "    computedAtColumn: 'outcome_1d_computed_at',",
    "    // No legacy column - 1d outcomes are new",
    "  },"
  ) -join $LF

  # Note: the file uses an EM-DASH in the comment "No legacy column - 1d".
  # PowerShell here-strings + non-ASCII = encoding hell. We sidestep it by
  # matching from the start of the entry up to the line BEFORE the comment,
  # then matching everything from that point to the closing brace, replacing
  # only the daysOld + adding the timeframeFilter.
  #
  # Strategy: replace just the two lines we need to change.
  $oldR2_alt1 = "    key: '1d',$LF    daysOld: 1,"
  $newR2_alt1 = "    key: '1d',$LF    daysOld: 2,                    // wait 2 days so weekend/Friday-PM verdicts have a real trading session"
  if (-not (Patch-Once -Name 'R2a 1d daysOld 1->2' -Content ([ref]$route) -Old $oldR2_alt1 -New $newR2_alt1)) { $errors++ }

  # Add timeframeFilter line right after computedAtColumn for the 1d entry.
  # Anchor: the unique sequence "computedAtColumn: 'outcome_1d_computed_at',"
  # which only appears in the 1d block.
  $oldR2_alt2 = "    computedAtColumn: 'outcome_1d_computed_at',$LF"
  $newR2_alt2 = "    computedAtColumn: 'outcome_1d_computed_at',$LF    timeframeFilter: '1D',         // ONLY resolve verdicts whose declared timeframe is 1D$LF"
  if (-not (Patch-Once -Name 'R2b 1d add timeframeFilter' -Content ([ref]$route) -Old $oldR2_alt2 -New $newR2_alt2)) { $errors++ }

  # ---------------------------------------------------------
  # Patch R3: processHorizon query honors timeframeFilter
  # ---------------------------------------------------------
  $oldR3 = @(
    "  const { data: pending, error } = await admin",
    "    .from('verdict_log')",
    "    .select('id, ticker, signal, entry_price, stop_loss, take_profit, verdict_date')",
    "    .eq(horizon.strictColumn, 'pending')",
    "    .lte('verdict_date', cutoff)",
    "    .limit(500)"
  ) -join $LF

  $newR3 = @(
    "  let baseQuery = admin",
    "    .from('verdict_log')",
    "    .select('id, ticker, signal, entry_price, stop_loss, take_profit, verdict_date')",
    "    .eq(horizon.strictColumn, 'pending')",
    "    .lte('verdict_date', cutoff)",
    "",
    "  // For horizons that should ONLY resolve a specific timeframe (e.g. 1d",
    "  // only resolves timeframe='1D' verdicts), apply the additional filter.",
    "  if (horizon.timeframeFilter) {",
    "    baseQuery = baseQuery.eq('timeframe', horizon.timeframeFilter)",
    "  }",
    "",
    "  const { data: pending, error } = await baseQuery.limit(500)"
  ) -join $LF

  if (-not (Patch-Once -Name 'R3 processHorizon timeframeFilter' -Content ([ref]$route) -Old $oldR3 -New $newR3)) { $errors++ }

  # ---------------------------------------------------------
  # Patch R4: GET diagnostic also respects timeframeFilter
  # ---------------------------------------------------------
  $oldR4 = @(
    "  for (const h of HORIZONS) {",
    "    const cutoff = new Date(now.getTime() - h.daysOld * 86400000)",
    "      .toISOString().split('T')[0]",
    "    const { count } = await admin",
    "      .from('verdict_log')",
    "      .select('*', { count: 'exact', head: true })",
    "      .eq(h.strictColumn, 'pending')",
    "      .lte('verdict_date', cutoff)",
    "    counts[h.key] = { pending: count ?? 0, daysOld: h.daysOld }",
    "  }"
  ) -join $LF

  $newR4 = @(
    "  for (const h of HORIZONS) {",
    "    const cutoff = new Date(now.getTime() - h.daysOld * 86400000)",
    "      .toISOString().split('T')[0]",
    "    let q = admin",
    "      .from('verdict_log')",
    "      .select('*', { count: 'exact', head: true })",
    "      .eq(h.strictColumn, 'pending')",
    "      .lte('verdict_date', cutoff)",
    "    if (h.timeframeFilter) {",
    "      q = q.eq('timeframe', h.timeframeFilter)",
    "    }",
    "    const { count } = await q",
    "    counts[h.key] = { pending: count ?? 0, daysOld: h.daysOld }",
    "  }"
  ) -join $LF

  if (-not (Patch-Once -Name 'R4 GET diagnostic timeframeFilter' -Content ([ref]$route) -Old $oldR4 -New $newR4)) { $errors++ }

  if ($errors -gt 0) {
    Write-Host "  STOPPED: $errors patch(es) failed in route file" -ForegroundColor Red
    exit 1
  }
}

# ============================================================
# PAGE FILE
# ============================================================
Write-Host ""
Write-Host "Patching $pageFile" -ForegroundColor Cyan
$page = Read-FileText $pageFile
$pageOriginal = $page

$pageUsesCrlf = $page.Contains("`r`n")
Write-Host "  Line endings: $(if ($pageUsesCrlf) { 'CRLF' } else { 'LF' })"

# Idempotency check
if ($page.Contains("setHorizon('1d')") -or $page.Contains("'1d' | '1w' | '1m'")) {
  Write-Host "  Already patched (1d state/button present). Skipping page file." -ForegroundColor Yellow
  $pageChanged = $false
} else {
  $pageChanged = $true
  $errors = 0

  # ---------------------------------------------------------
  # Patch P1: widen horizon state type
  # ---------------------------------------------------------
  $oldP1 = "const [horizon, setHorizon] = useState<'1w' | '1m'>('1w')"
  $newP1 = "const [horizon, setHorizon] = useState<'1d' | '1w' | '1m'>('1w')"
  if (-not (Patch-Once -Name 'P1 horizon state type' -Content ([ref]$page) -Old $oldP1 -New $newP1)) { $errors++ }

  # ---------------------------------------------------------
  # Patch P2: insert "1 Day" button before "1 Week" button.
  # Uses single-quoted here-strings (@'...'@) which are 100%
  # literal in PowerShell - no escaping for backticks, dollar
  # signs, or quotes. Only restriction: no '@ at start of line.
  # ---------------------------------------------------------
  $oldP2 = @'
          <div className="flex bg-gray-900 rounded overflow-hidden">
            <button
              onClick={() => setHorizon('1w')}
              className={`px-4 py-2 ${horizon === '1w' ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white'}`}
            >
              1 Week
            </button>
            <button
              onClick={() => setHorizon('1m')}
              className={`px-4 py-2 ${horizon === '1m' ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white'}`}
            >
              1 Month
            </button>
          </div>
'@

  $newP2 = @'
          <div className="flex bg-gray-900 rounded overflow-hidden">
            <button
              onClick={() => setHorizon('1d')}
              className={`px-4 py-2 ${horizon === '1d' ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white'}`}
            >
              1 Day
            </button>
            <button
              onClick={() => setHorizon('1w')}
              className={`px-4 py-2 ${horizon === '1w' ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white'}`}
            >
              1 Week
            </button>
            <button
              onClick={() => setHorizon('1m')}
              className={`px-4 py-2 ${horizon === '1m' ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white'}`}
            >
              1 Month
            </button>
          </div>
'@

  # Strip trailing newline that here-strings add (Patch-Once needs exact match)
  $oldP2 = $oldP2.TrimEnd("`r", "`n")
  $newP2 = $newP2.TrimEnd("`r", "`n")

  # PowerShell here-strings preserve the file's saved line endings (CRLF in
  # this script). The page file uses LF. Normalize both blocks to LF before
  # the patch so they match the target file.
  $oldP2 = $oldP2.Replace("`r`n", "`n")
  $newP2 = $newP2.Replace("`r`n", "`n")

  if (-not (Patch-Once -Name 'P2 add 1 Day button' -Content ([ref]$page) -Old $oldP2 -New $newP2)) { $errors++ }

  if ($errors -gt 0) {
    Write-Host "  STOPPED: $errors patch(es) failed in page file" -ForegroundColor Red
    exit 1
  }
}

# ============================================================
# WRITE
# ============================================================
Write-Host ""

if ($Apply) {
  if ($routeChanged) {
    Write-FileText $routeFile $route
    Write-Host "WROTE $routeFile" -ForegroundColor Green
  }
  if ($pageChanged) {
    Write-FileText $pageFile $page
    Write-Host "WROTE $pageFile" -ForegroundColor Green
  }
  if (-not $routeChanged -and -not $pageChanged) {
    Write-Host "Nothing to write - both files already patched." -ForegroundColor Yellow
  }
  Write-Host ""
  Write-Host "Next:" -ForegroundColor Cyan
  Write-Host "  1. Apply migration.sql in Supabase if not already done"
  Write-Host "  2. npm run build"
} else {
  Write-Host "Dry run looked good. Re-run with -Apply to write." -ForegroundColor Yellow
}
