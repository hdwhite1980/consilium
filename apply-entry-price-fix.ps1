# apply-entry-price-fix.ps1
# Fixes the malformed entry_price bug in verdict_log inserts.
#
# THE BUG:
#   const parseP = (s) => s ? parseFloat(String(s).replace(/[^0-9.-]/g,'')) || null : null
#
#   This regex strips everything except digits, periods, hyphens, and minuses.
#   When the Judge text has a hyphen BEFORE the price (e.g. "-$15.70" or
#   "stop: -2% below $15.50"), the leading hyphen is preserved, producing
#   "-15.70" or "-215.50" — both negative, both wrong. parseFloat happily
#   reads negative numbers.
#
#   This produced the $-15.70 entry on the SOFI BEARISH 72% verdict from
#   2026-04-30. Once a verdict has a malformed entry, the resolver can
#   never compute its outcome correctly.
#
# THE FIX:
#   Use the same regex pattern app/page.tsx already uses for the frontend
#   Trade Plan rendering: /\$(\d{1,6}(?:\.\d{1,2})?)/. Matches the FIRST
#   dollar-prefixed positive number, captures only the digits.
#
# WHAT THIS PATCHES:
#   1. app/api/analyze/route.ts — parseP for verdict_log inserts
#   2. app/api/compare/route.ts — same parseP in compare-mode logging
#   3. app/api/track-record/route.ts — inline parseFloat in POST handler
#
# SAFETY:
#   All-or-nothing: dry-runs every edit first, only writes if EVERY anchor
#   matches cleanly. No partial-write state possible.
#
# Usage:
#   .\apply-entry-price-fix.ps1           (dry run)
#   .\apply-entry-price-fix.ps1 -Apply    (writes only if all edits match)

param([switch]$Apply)
$ErrorActionPreference = 'Stop'

function Norm([string]$s) { $s -replace "`r`n", "`n" }

$plan = @()

function Plan-Edit {
    param(
        [string]$Path,
        [string]$EditName,
        [string]$Old,
        [string]$New,
        [string]$AlreadyAppliedPattern
    )
    $script:plan += @{
        Path = $Path
        Name = $EditName
        Old = $Old
        New = $New
        AlreadyAppliedPattern = $AlreadyAppliedPattern
    }
}

# ─────────────────────────────────────────────────────────────
# EDIT 1 — app/api/analyze/route.ts
# ─────────────────────────────────────────────────────────────
Plan-Edit `
    -Path 'app\api\analyze\route.ts' `
    -EditName 'analyze: parseP uses safe extraction' `
    -AlreadyAppliedPattern '\$\(\\d\{1,6\}\(\?:\\\.\\d\{1,2\}\)\?\)' `
    -Old "const parseP = (s: string | undefined) => s ? parseFloat(String(s).replace(/[^0-9.-]/g,'')) || null : null" `
    -New @'
const parseP = (s: string | undefined): number | null => {
            if (!s) return null
            // Match the FIRST $-prefixed positive number, e.g. $15.25 from
            // "Enter on a pullback to the $15.25 - $15.60 range".
            // Rejects bare numbers, ranges, percentages, and (critically)
            // anything with a leading minus like "-$15.70" or "$-15.70".
            const match = String(s).match(/\$(\d{1,6}(?:\.\d{1,2})?)/)
            if (!match) return null
            const num = parseFloat(match[1])
            return Number.isFinite(num) && num > 0 ? num : null
          }
'@

# ─────────────────────────────────────────────────────────────
# EDIT 2 — app/api/compare/route.ts
# ─────────────────────────────────────────────────────────────
Plan-Edit `
    -Path 'app\api\compare\route.ts' `
    -EditName 'compare: parseP uses safe extraction' `
    -AlreadyAppliedPattern '\$\(\\d\{1,6\}\(\?:\\\.\\d\{1,2\}\)\?\)' `
    -Old "const parseP = (s: string | undefined) => s ? parseFloat(String(s).replace(/[^0-9.-]/g,'')) || null : null" `
    -New @'
const parseP = (s: string | undefined): number | null => {
              if (!s) return null
              const match = String(s).match(/\$(\d{1,6}(?:\.\d{1,2})?)/)
              if (!match) return null
              const num = parseFloat(match[1])
              return Number.isFinite(num) && num > 0 ? num : null
            }
'@

# ─────────────────────────────────────────────────────────────
# EDIT 3a — app/api/track-record/route.ts: insert parsePrice helper
# ─────────────────────────────────────────────────────────────
Plan-Edit `
    -Path 'app\api\track-record\route.ts' `
    -EditName 'track-record POST: define parsePrice helper' `
    -AlreadyAppliedPattern 'const parsePrice = ' `
    -Old @'
  if (!ticker || !signal) return NextResponse.json({ error: 'ticker and signal required' }, { status: 400 })
'@ `
    -New @'
  if (!ticker || !signal) return NextResponse.json({ error: 'ticker and signal required' }, { status: 400 })

  // Safe price extractor — matches the first $-prefixed positive number.
  // Rejects negative values, ranges, and percentages.
  const parsePrice = (s: unknown): number | null => {
    if (s === null || s === undefined) return null
    if (typeof s === 'number') return Number.isFinite(s) && s > 0 ? s : null
    if (typeof s !== 'string') return null
    const dollarMatch = s.match(/\$(\d{1,6}(?:\.\d{1,2})?)/)
    if (dollarMatch) {
      const n = parseFloat(dollarMatch[1])
      return Number.isFinite(n) && n > 0 ? n : null
    }
    const bareMatch = s.match(/^\s*(\d{1,6}(?:\.\d{1,2})?)\s*$/)
    if (bareMatch) {
      const n = parseFloat(bareMatch[1])
      return Number.isFinite(n) && n > 0 ? n : null
    }
    return null
  }
'@

# ─────────────────────────────────────────────────────────────
# EDIT 3b — track-record: use parsePrice for entry/stop/target
# ─────────────────────────────────────────────────────────────
Plan-Edit `
    -Path 'app\api\track-record\route.ts' `
    -EditName 'track-record POST: use parsePrice for entry/stop/target' `
    -AlreadyAppliedPattern 'entry_price: parsePrice\(entry_price\)' `
    -Old @'
      entry_price: entry_price ? parseFloat(String(entry_price).replace(/[^0-9.-]/g,'')) : null,
      stop_loss: stop_loss ? parseFloat(String(stop_loss).replace(/[^0-9.-]/g,'')) : null,
      take_profit: take_profit ? parseFloat(String(take_profit).replace(/[^0-9.-]/g,'')) : null,
'@ `
    -New @'
      entry_price: parsePrice(entry_price),
      stop_loss: parsePrice(stop_loss),
      take_profit: parsePrice(take_profit),
'@

# ═════════════════════════════════════════════════════════════
# DRY-RUN
# ═════════════════════════════════════════════════════════════

$fileWork = @{}
$results = @()

foreach ($edit in $plan) {
    $path = $edit.Path
    if (-not (Test-Path $path)) {
        $results += [pscustomobject]@{ Path=$path; Name=$edit.Name; Status='SKIP'; Detail='file not found' }
        continue
    }

    if (-not $fileWork.ContainsKey($path)) {
        $abs = (Resolve-Path $path).Path
        $fileWork[$path] = [System.IO.File]::ReadAllText($abs, [System.Text.UTF8Encoding]::new($false))
    }

    $work = $fileWork[$path]
    if ($work -match $edit.AlreadyAppliedPattern) {
        $results += [pscustomobject]@{ Path=$path; Name=$edit.Name; Status='already'; Detail='' }
        continue
    }

    $oldNorm = Norm $edit.Old
    $workNorm = Norm $work
    if ($workNorm.Contains($oldNorm)) {
        $newNorm = Norm $edit.New
        $newWork = $workNorm.Replace($oldNorm, $newNorm) -replace "`n", "`r`n"
        $fileWork[$path] = $newWork
        $results += [pscustomobject]@{ Path=$path; Name=$edit.Name; Status='applied'; Detail='' }
    } else {
        $results += [pscustomobject]@{ Path=$path; Name=$edit.Name; Status='MISS'; Detail='anchor not found' }
    }
}

# ═════════════════════════════════════════════════════════════
# Report
# ═════════════════════════════════════════════════════════════
Write-Host ""
Write-Host "=== entry_price fix ===" -ForegroundColor Cyan
$applied = 0; $already = 0; $missed = 0; $skipped = 0
foreach ($r in $results) {
    $color = switch ($r.Status) {
        'applied' { 'Green'; $applied++ }
        'already' { 'DarkGray'; $already++ }
        'MISS'    { 'Red'; $missed++ }
        'SKIP'    { 'Yellow'; $skipped++ }
    }
    $tag = switch ($r.Status) {
        'applied' { '[+]' }
        'already' { '[ok]' }
        'MISS'    { '[FAIL]' }
        'SKIP'    { '[skip]' }
    }
    $detail = if ($r.Detail) { " — $($r.Detail)" } else { '' }
    Write-Host "  $tag $($r.Path) → $($r.Name)$detail" -ForegroundColor $color
}
Write-Host ""
Write-Host "Summary: $applied applied, $already already-applied, $missed MISSED, $skipped SKIPPED" -ForegroundColor Cyan

if ($missed -gt 0) {
    Write-Host ""
    Write-Host "ABORTING — $missed edit(s) could not find their anchors." -ForegroundColor Red
    Write-Host "No changes written." -ForegroundColor Red
    exit 1
}

if ($applied -eq 0) {
    Write-Host "All edits already applied. No changes needed." -ForegroundColor DarkGray
    exit 0
}

# ═════════════════════════════════════════════════════════════
# Write only if -Apply
# ═════════════════════════════════════════════════════════════
if ($Apply) {
    foreach ($entry in $fileWork.GetEnumerator()) {
        $abs = (Resolve-Path $entry.Key).Path
        [System.IO.File]::WriteAllText($abs, $entry.Value, [System.Text.UTF8Encoding]::new($false))
    }
    Write-Host ""
    Write-Host "  WROTE $($fileWork.Count) file(s) — $applied edit(s) applied" -ForegroundColor Green
    Write-Host ""
    Write-Host "Run 'npm run build' to verify TypeScript compiles." -ForegroundColor Cyan
    Write-Host ""
    Write-Host "After the build passes, run cleanup_existing_bad_rows.sql in" -ForegroundColor Cyan
    Write-Host "Supabase SQL Editor to NULL out entry/stop/target on existing" -ForegroundColor Cyan
    Write-Host "verdicts with malformed values. The resolver will then mark" -ForegroundColor Cyan
    Write-Host "those rows 'expired' instead of trying to compute against bad data." -ForegroundColor Cyan
} else {
    Write-Host ""
    Write-Host "DRY RUN — $applied edit(s) ready to apply across $($fileWork.Count) file(s)." -ForegroundColor Yellow
    Write-Host "Re-run with -Apply to write." -ForegroundColor Yellow
}
