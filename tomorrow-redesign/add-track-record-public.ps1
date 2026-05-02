# =============================================================
# add-track-record-public.ps1
#
# Adds '/track-record' to the alwaysPublic array in middleware.ts
# so unauthenticated visitors can view the public backtest stats.
#
# Idempotent - safe to run multiple times. Detects if already
# patched and exits cleanly.
#
# Usage:
#   .\add-track-record-public.ps1          (dry run)
#   .\add-track-record-public.ps1 -Apply   (write)
# =============================================================

param([switch]$Apply)

$ErrorActionPreference = 'Stop'
$file = 'middleware.ts'

if (-not (Test-Path $file)) {
  Write-Host "ERROR: $file not found. Run from repo root." -ForegroundColor Red
  exit 1
}

$bytes = [System.IO.File]::ReadAllBytes((Resolve-Path $file).Path)
$content = [System.Text.UTF8Encoding]::new($false).GetString($bytes)
$original = $content

# Idempotency check
if ($content.Contains("'/track-record'")) {
  Write-Host "/track-record already in alwaysPublic. Nothing to do." -ForegroundColor Green
  exit 0
}

# Find the alwaysPublic array. It's a single line declaration.
# Pattern matches the array regardless of which other items are in it,
# as long as the closing bracket and assignment exist.
$pattern = "(  const alwaysPublic = \[[^\]]*)\]"

$rx = [regex]::new($pattern)
$matches = $rx.Matches($content)
if ($matches.Count -eq 0) {
  Write-Host "ERROR: alwaysPublic array declaration not found." -ForegroundColor Red
  exit 1
}
if ($matches.Count -gt 1) {
  Write-Host "ERROR: alwaysPublic matches $($matches.Count) times." -ForegroundColor Red
  exit 1
}

$m = $matches[0]
$existingArrayBody = $m.Groups[1].Value   # everything from `const alwaysPublic = [` through last item

# Append ', /track-record' before the closing bracket
$newArrayBody = $existingArrayBody + ", '/track-record'"
$content = $content.Remove($m.Index, $m.Length).Insert($m.Index, $newArrayBody + ']')

Write-Host "  OK   added '/track-record' to alwaysPublic" -ForegroundColor Green

# Show the new line for confirmation
$newLine = ([regex]::Match($content, "  const alwaysPublic = \[[^\]]*\]")).Value
Write-Host ""
Write-Host "  $newLine" -ForegroundColor Cyan

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
  Write-Host "Dry run. Re-run with -Apply to write." -ForegroundColor Yellow
}
