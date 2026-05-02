# =============================================================
# install-price-grounding.ps1
#
# Installs Layers 1+2+3 of the price-grounding fix:
#   1. NEW: app/lib/ground-truth-prices.ts - fetches anchor prices
#   2. NEW: app/lib/watchlist-validator.ts - post-validates Claude output
#   3. UPDATED: app/api/tomorrow/route.ts - injects ground truth into
#      prompt, runs validator after Claude, extends Gemini verification
#      to also check price-direction consistency.
#
# Backs up existing route.ts to *.bak-pre-price-grounding.
#
# /api/news still TBD - will be a follow-up patch.
#
# Usage:
#   .\install-price-grounding.ps1          (dry run)
#   .\install-price-grounding.ps1 -Apply   (write changes)
# =============================================================

param([switch]$Apply)

$ErrorActionPreference = 'Stop'
$src = "$PSScriptRoot"
$repo = (Get-Location).Path

if (-not (Test-Path "$repo\app")) {
    throw "Run this script from the repo root (E:\consilium). Could not find 'app' directory."
}

Write-Host "Price Grounding Installer" -ForegroundColor Cyan
Write-Host "Source: $src" -ForegroundColor DarkGray
Write-Host "Repo:   $repo" -ForegroundColor DarkGray
Write-Host ""

$operations = @(
    @{ SrcName = 'ground-truth-prices.ts';  DestPath = 'app\lib\ground-truth-prices.ts';      IsNew = $true  }
    @{ SrcName = 'watchlist-validator.ts';  DestPath = 'app\lib\watchlist-validator.ts';      IsNew = $true  }
    @{ SrcName = 'route.ts';                DestPath = 'app\api\tomorrow\route.ts';           IsNew = $false }
)

# Pre-flight: check the route file is the regime-fixed version
Write-Host "Pre-flight: checking route.ts has regime fix..." -ForegroundColor Cyan
$routePath = "$repo\app\api\tomorrow\route.ts"
if (Test-Path $routePath) {
    $routeContent = Get-Content $routePath -Raw
    if ($routeContent -match "fullResponse") {
        Write-Host "  [OK] route.ts has regime fix from earlier session" -ForegroundColor Green
    } else {
        Write-Host "  [WARN] route.ts may be missing the regime fix" -ForegroundColor Yellow
        Write-Host "         The new route.ts in this patch includes both regime fix AND price grounding." -ForegroundColor DarkGray
    }
} else {
    Write-Host "  [WARN] could not find $routePath" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Plan:" -ForegroundColor Cyan
foreach ($op in $operations) {
    $srcFull = "$src\$($op.SrcName)"
    $destFull = "$repo\$($op.DestPath)"
    if (-not (Test-Path $srcFull)) {
        Write-Host "  [ERROR] missing source: $srcFull" -ForegroundColor Red
        exit 1
    }
    if ($op.IsNew) {
        if (Test-Path $destFull) {
            Write-Host "  [overwrite] $($op.DestPath) (file already exists)" -ForegroundColor Yellow
        } else {
            Write-Host "  [create]    $($op.DestPath)" -ForegroundColor Green
        }
    } else {
        Write-Host "  [update]    $($op.DestPath) (backup -> *.bak-pre-price-grounding)" -ForegroundColor Green
    }
}

if (-not $Apply) {
    Write-Host ""
    Write-Host "Dry run. Re-run with -Apply to install." -ForegroundColor Yellow
    exit 0
}

Write-Host ""
Write-Host "Installing..." -ForegroundColor Cyan

foreach ($op in $operations) {
    $srcFull = "$src\$($op.SrcName)"
    $destFull = "$repo\$($op.DestPath)"
    $destDir = Split-Path -Parent $destFull

    if (-not (Test-Path $destDir)) {
        New-Item -ItemType Directory -Path $destDir -Force | Out-Null
    }

    if (-not $op.IsNew -and (Test-Path $destFull)) {
        $bakPath = "$destFull.bak-pre-price-grounding"
        Copy-Item -Path $destFull -Destination $bakPath -Force
        Write-Host "  [backup] $bakPath" -ForegroundColor DarkGray
    }

    Copy-Item -Path $srcFull -Destination $destFull -Force
    Write-Host "  [installed] $($op.DestPath)" -ForegroundColor Green
}

Write-Host ""
Write-Host "Done." -ForegroundColor Cyan
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Cyan
Write-Host "  1. npm run build" -ForegroundColor Gray
Write-Host "  2. Force-refresh /tomorrow to populate cache: visit /tomorrow?refresh=true" -ForegroundColor Gray
Write-Host "  3. Watch server logs for [ground-truth] and [validator] entries" -ForegroundColor Gray
Write-Host "  4. The XLE/oil case from earlier should no longer pass:" -ForegroundColor Gray
Write-Host "     - Validator will catch any oil-surge claim that contradicts USO actual" -ForegroundColor DarkGray
Write-Host "     - Watch logs for: '[validator] DROPPED ... Catalyst claims +X% but actual is -Y%'" -ForegroundColor DarkGray
Write-Host "  5. git commit -m 'feat: 3-layer price grounding for /tomorrow'" -ForegroundColor Gray
Write-Host ""
Write-Host "/api/news fix: TBD as follow-up patch (parallel changes)" -ForegroundColor DarkGray
