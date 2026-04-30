# apply-positions-status-filter.ps1
# Updates /api/portfolio/positions GET to only return status='open' positions.
# Without this, after closing a position it would still appear in the holdings tab.
#
# Single edit. All-or-nothing.

param([switch]$Apply)
$ErrorActionPreference = 'Stop'

if (-not (Test-Path 'app\api\portfolio\positions\route.ts')) {
    Write-Host "ERROR: app\api\portfolio\positions\route.ts not found." -ForegroundColor Red
    exit 1
}

function Norm([string]$s) { $s -replace "`r`n", "`n" }

$path = 'app\api\portfolio\positions\route.ts'
$abs = (Resolve-Path $path).Path
$work = [System.IO.File]::ReadAllText($abs, [System.Text.UTF8Encoding]::new($false))

# Already-applied check
if ($work -match "\.eq\('status', 'open'\)") {
    Write-Host "[ok] positions route already filters status='open'" -ForegroundColor DarkGray
    exit 0
}

$old = @"
  const { data: positions } = await admin()
    .from('portfolio_positions')
    .select('*')
    .eq('portfolio_id', portfolio.id)
    .order('added_at', { ascending: true })
"@

$new = @"
  // Only return open positions; closed/partial show in /api/portfolio/closed
  const { data: positions } = await admin()
    .from('portfolio_positions')
    .select('*')
    .eq('portfolio_id', portfolio.id)
    .eq('status', 'open')
    .order('added_at', { ascending: true })
"@

$oldNorm = Norm $old
$workNorm = Norm $work

if (-not $workNorm.Contains($oldNorm)) {
    Write-Host "[FAIL] Anchor not found in $path" -ForegroundColor Red
    Write-Host "  Looking for the GET handler's positions query." -ForegroundColor Yellow
    Write-Host "  Open the file and manually add .eq('status', 'open') to the GET handler's query." -ForegroundColor Yellow
    exit 1
}

$newWork = $workNorm.Replace($oldNorm, (Norm $new)) -replace "`n", "`r`n"

Write-Host "[+] $path : status='open' filter ready to apply" -ForegroundColor Green

if ($Apply) {
    [System.IO.File]::WriteAllText($abs, $newWork, [System.Text.UTF8Encoding]::new($false))
    Write-Host "  Wrote $path" -ForegroundColor Green
} else {
    Write-Host "DRY RUN — re-run with -Apply to write." -ForegroundColor Yellow
}
