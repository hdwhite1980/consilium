# =============================================================
# install-tomorrow-redesign.ps1
#
# Installs the redesigned /tomorrow page:
#   - Hero "Tomorrow at a glance" with 3 tiles
#   - Two-column desktop layout (left 2/3 primary, right 1/3 supporting)
#   - Mobile-collapsible right-column sections
#   - Bumped font sizes for readability
#   - Reduced color competition
#
# This REPLACES app/tomorrow/page.tsx in full.
# Backs up existing to *.bak-pre-redesign.
#
# Assumes weekend brief is already installed (route.ts + multi-source-news.ts
# + yahoo-quotes.ts). If not, install those first - the new page expects
# briefMode/worldEvents/internationalSnapshot fields from the API.
#
# Usage:
#   .\install-tomorrow-redesign.ps1          (dry run)
#   .\install-tomorrow-redesign.ps1 -Apply   (write changes)
# =============================================================

param([switch]$Apply)

$ErrorActionPreference = 'Stop'
$src = "$PSScriptRoot"
$repo = (Get-Location).Path

if (-not (Test-Path "$repo\app")) {
    throw "Run this script from the repo root (E:\consilium). Could not find 'app' directory at $repo\app"
}

Write-Host "Tomorrow Page Redesign Installer" -ForegroundColor Cyan
Write-Host "Source: $src" -ForegroundColor DarkGray
Write-Host "Repo:   $repo" -ForegroundColor DarkGray
Write-Host ""

$srcFile = "$src\page.tsx"
$destFile = "$repo\app\tomorrow\page.tsx"
$bakFile = "$destFile.bak-pre-redesign"

if (-not (Test-Path $srcFile)) {
    Write-Host "[ERROR] missing source: $srcFile" -ForegroundColor Red
    exit 1
}

if (-not (Test-Path $destFile)) {
    Write-Host "[ERROR] target page does not exist: $destFile" -ForegroundColor Red
    Write-Host "        This installer expects to update an existing /tomorrow page." -ForegroundColor DarkGray
    exit 1
}

# Pre-flight: check that the API supports briefMode field
Write-Host "Pre-flight: checking weekend brief is installed..." -ForegroundColor Cyan
$routePath = "$repo\app\api\tomorrow\route.ts"
if (Test-Path $routePath) {
    $routeContent = Get-Content $routePath -Raw
    if ($routeContent -match "briefMode") {
        Write-Host "  [OK] route.ts has briefMode field - weekend brief is installed" -ForegroundColor Green
    } else {
        Write-Host "  [WARN] route.ts does not appear to have weekend brief logic" -ForegroundColor Yellow
        Write-Host "         The redesigned page expects briefMode, worldEvents, internationalSnapshot." -ForegroundColor DarkGray
        Write-Host "         If you haven't installed the weekend brief, the page will still render" -ForegroundColor DarkGray
        Write-Host "         in weekday mode (no weekend sections shown)." -ForegroundColor DarkGray
    }
} else {
    Write-Host "  [WARN] could not find $routePath to verify weekend brief status" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Plan:" -ForegroundColor Cyan
$srcSize = [math]::Round((Get-Item $srcFile).Length / 1024, 1)
$destSize = [math]::Round((Get-Item $destFile).Length / 1024, 1)
Write-Host "  [backup]  $destFile -> $bakFile" -ForegroundColor DarkGray
Write-Host "  [replace] app\tomorrow\page.tsx ($destSize KB -> $srcSize KB)" -ForegroundColor Green

if (-not $Apply) {
    Write-Host ""
    Write-Host "Dry run. Re-run with -Apply to install." -ForegroundColor Yellow
    exit 0
}

Write-Host ""
Write-Host "Installing..." -ForegroundColor Cyan

Copy-Item -Path $destFile -Destination $bakFile -Force
Write-Host "  [backup] $bakFile" -ForegroundColor DarkGray

Copy-Item -Path $srcFile -Destination $destFile -Force
Write-Host "  [installed] $destFile" -ForegroundColor Green

Write-Host ""
Write-Host "Done." -ForegroundColor Cyan
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Cyan
Write-Host "  1. npm run build (verify TypeScript compiles)" -ForegroundColor Gray
Write-Host "  2. Visit /tomorrow on a weekday - should see Hero with Regime/Top Conviction/Big Event tiles" -ForegroundColor Gray
Write-Host "  3. Visit /tomorrow?force_weekend=true - should see Hero third tile swap to International" -ForegroundColor Gray
Write-Host "  4. On mobile: right-column sections (Earnings, Economic, etc.) should be collapsed by default" -ForegroundColor Gray
Write-Host "  5. On desktop: two-column layout with left 2/3 primary content, right 1/3 supporting" -ForegroundColor Gray
Write-Host "  6. git commit -m 'feat: redesign /tomorrow with hero section and two-column layout'" -ForegroundColor Gray
Write-Host ""
Write-Host "If anything goes wrong:" -ForegroundColor Yellow
Write-Host "  Restore: Move-Item '$bakFile' '$destFile' -Force" -ForegroundColor DarkGray
