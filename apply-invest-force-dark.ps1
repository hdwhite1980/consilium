# apply-invest-force-dark.ps1
# Adds data-keep-dark="true" to the root container of /invest pages
# so they stay dark even when global theme is light.
#
# Usage:
#   .\apply-invest-force-dark.ps1          (dry run)
#   .\apply-invest-force-dark.ps1 -Apply   (write changes)

param([switch]$Apply)

$ErrorActionPreference = 'Stop'

$targets = @(
    @{
        File = 'app\invest\page.tsx'
        # Match the outermost <div className="flex flex-col min-h-screen" ... of the main return
        Find = 'return (
    <div className="flex flex-col min-h-screen" style={{ background: ''var(--bg)'', color: txt }}>'
        Replace = 'return (
    <div data-keep-dark="true" className="flex flex-col min-h-screen" style={{ background: ''var(--bg)'', color: txt }}>'
    }
    @{
        File = 'app\invest\intro\page.tsx'
        Find = '  return (
    <div className="min-h-screen flex flex-col" style={{'
        Replace = '  return (
    <div data-keep-dark="true" className="min-h-screen flex flex-col" style={{'
    }
)

$totalChanges = 0

foreach ($target in $targets) {
    $file = $target.File
    if (-not (Test-Path $file)) {
        Write-Host "  SKIP $file (not found)" -ForegroundColor DarkGray
        continue
    }

    $path = (Resolve-Path $file).Path
    $content = [System.IO.File]::ReadAllText($path, [System.Text.UTF8Encoding]::new($false))

    # Check if already tagged
    if ($content -match 'data-keep-dark="true"') {
        Write-Host "  $file : already tagged" -ForegroundColor DarkGray
        continue
    }

    $findNorm = $target.Find -replace "`r`n", "`n"
    $replaceNorm = $target.Replace -replace "`r`n", "`n"
    $contentNorm = $content -replace "`r`n", "`n"

    if (-not $contentNorm.Contains($findNorm)) {
        # Try a looser alternative: find the first <div className="... min-h-screen ...">
        Write-Host "  $file : exact anchor not found, trying fallback..." -ForegroundColor Yellow
        $pattern = '(?m)^(\s*)(<div)( className="[^"]*min-h-screen[^"]*")'
        if ($contentNorm -match $pattern) {
            $contentNorm = [regex]::Replace($contentNorm, $pattern, '$1$2 data-keep-dark="true"$3', 1)
            Write-Host "  $file : tagged via fallback pattern" -ForegroundColor Green
            $content = $contentNorm -replace "`n", "`r`n"
            $totalChanges++
        } else {
            Write-Host "  $file : no suitable <div> found" -ForegroundColor Red
            continue
        }
    } else {
        $contentNorm = $contentNorm.Replace($findNorm, $replaceNorm)
        $content = $contentNorm -replace "`n", "`r`n"
        Write-Host "  $file : tagged (exact match)" -ForegroundColor Green
        $totalChanges++
    }

    if ($Apply) {
        [System.IO.File]::WriteAllText($path, $content, [System.Text.UTF8Encoding]::new($false))
        Write-Host "    WROTE" -ForegroundColor Green
    } else {
        Write-Host "    (dry run)" -ForegroundColor Yellow
    }
}

Write-Host ""
Write-Host "Total files tagged: $totalChanges" -ForegroundColor Cyan

if (-not $Apply -and $totalChanges -gt 0) {
    Write-Host "To apply: .\apply-invest-force-dark.ps1 -Apply" -ForegroundColor White
}
