# =============================================================
# Patch: update deprecated claude-sonnet-4-20250514 -> claude-sonnet-4-6
#
# Anthropic deprecated the dated model alias claude-sonnet-4-20250514.
# All API calls using it return 404 not_found_error.
# This patch updates 21 occurrences across 19 active files to the
# current model alias claude-sonnet-4-6.
#
# Skips .bak files (historical snapshots) intentionally.
# =============================================================

$ErrorActionPreference = 'Stop'

# 19 active files (excluding 3 .bak files)
$files = @(
    'app/api/analyze/qa/route.ts',
    'app/api/compare/route.ts',
    'app/api/invest/analyze-trade/route.ts',
    'app/api/invest/ideas/route.ts',
    'app/api/invest/options-scanner/route.ts',
    'app/api/invest/route.ts',
    'app/api/news/route.ts',
    'app/api/options-recommendations/route.ts',
    'app/api/portfolio/check/route.ts',
    'app/api/portfolio/route.ts',
    'app/api/reinvestment/ideas/route.ts',
    'app/api/tomorrow/route.ts',
    'app/api/trade-journal/route.ts',
    'app/api/why-moving/route.ts',
    'app/lib/active-stories-classifier.ts',
    'app/lib/active-stories-forex-classifier.ts',
    'app/lib/exit-signals.ts',
    'app/lib/market-digest.ts'
)

$old = 'claude-sonnet-4-20250514'
$new = 'claude-sonnet-4-6'

$total = 0
$updated = 0
$missing = 0

foreach ($f in $files) {
    if (-not (Test-Path $f)) {
        Write-Host "MISSING: $f" -ForegroundColor Yellow
        $missing++
        continue
    }

    $content = Get-Content $f -Raw
    $countBefore = ([regex]::Matches($content, [regex]::Escape($old))).Count

    if ($countBefore -eq 0) {
        Write-Host "NO-OCC: $f (no occurrences, already updated?)" -ForegroundColor DarkGray
        continue
    }

    $newContent = $content -replace [regex]::Escape($old), $new

    # Verify the replacement: old is 23 chars, new is 16 chars, diff is 7 per occurrence
    $expectedDelta = $countBefore * ($old.Length - $new.Length)
    $actualDelta = $content.Length - $newContent.Length
    if ($actualDelta -ne $expectedDelta) {
        Write-Host "MISMATCH: $f expected delta $expectedDelta got $actualDelta" -ForegroundColor Red
        continue
    }

    Set-Content -Path $f -Value $newContent -NoNewline
    Write-Host "UPDATED: $f $countBefore occurrences" -ForegroundColor Green
    $total += $countBefore
    $updated++
}

Write-Host ""
Write-Host "== Summary ==" -ForegroundColor Cyan
Write-Host "Files updated:    $updated"
Write-Host "Files missing:    $missing"
Write-Host "Total occurrences updated: $total"
Write-Host ""

# Verify nothing remaining
Write-Host "== Verification ==" -ForegroundColor Cyan
$remaining = git grep -l "claude-sonnet-4-20250514" 2>$null
if ($remaining) {
    Write-Host "Files still containing the deprecated name:" -ForegroundColor Yellow
    $remaining | ForEach-Object { Write-Host "  $_" }
    Write-Host "(.bak files are expected, they are historical snapshots)" -ForegroundColor DarkGray
} else {
    Write-Host "Clean: no remaining occurrences." -ForegroundColor Green
}
