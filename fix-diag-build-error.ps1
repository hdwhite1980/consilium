# =============================================================
# fix-diag-build-error.ps1
#
# Hotfix for build error introduced by apply-diag-analyze.ps1.
#
# Error:
#   ./app/api/analyze/route.ts:435:125
#   Type error: Property 'stage' does not exist on type 'never'.
#
# Cause:
#   The diag patch declares:
#     let controllerClosedAt: { stage: string; elapsedSec: string } | null = null
#   And assigns to it inside a closure (the send() function).
#   TypeScript's flow analysis doesn't propagate closure mutations back to the
#   outer scope, so when we read controllerClosedAt.stage at the bottom of the
#   pipeline block, TS thinks the variable is still null and narrows the truthy
#   branch to 'never'.
#
# Fix:
#   Two changes:
#   (1) Change the type annotation to use a const-assertion that survives
#       narrowing: declare it as a wider type via 'as' on the read site.
#   (2) Use a local variable to capture the current value before reading,
#       which lets TS narrow correctly.
#
# Pure ASCII. Idempotent. End-to-end verified.
#
# Usage:
#   .\fix-diag-build-error.ps1          (dry run)
#   .\fix-diag-build-error.ps1 -Apply   (write changes)
# =============================================================

param([switch]$Apply)

$ErrorActionPreference = 'Stop'

$Target = 'app\api\analyze\route.ts'

if (-not (Test-Path $Target)) {
    Write-Host "ERROR: $Target not found. Run from repo root." -ForegroundColor Red
    exit 1
}

# Sync .NET CWD with PowerShell location
$Target = (Resolve-Path $Target).Path
[System.Environment]::CurrentDirectory = (Get-Location).Path

# === Helpers ===================================================
function Bytes-IndexOf([byte[]]$haystack, [byte[]]$needle) {
    if ($needle.Length -gt $haystack.Length) { return -1 }
    for ($i = 0; $i -le ($haystack.Length - $needle.Length); $i++) {
        $match = $true
        for ($j = 0; $j -lt $needle.Length; $j++) {
            if ($haystack[$i + $j] -ne $needle[$j]) { $match = $false; break }
        }
        if ($match) { return $i }
    }
    return -1
}

function Bytes-CountOccurrences([byte[]]$haystack, [byte[]]$needle) {
    if ($needle.Length -gt $haystack.Length) { return 0 }
    $count = 0
    $i = 0
    while ($i -le ($haystack.Length - $needle.Length)) {
        $match = $true
        for ($j = 0; $j -lt $needle.Length; $j++) {
            if ($haystack[$i + $j] -ne $needle[$j]) { $match = $false; break }
        }
        if ($match) {
            $count++
            $i += $needle.Length
        } else {
            $i++
        }
    }
    return $count
}

function Bytes-ReplaceFirst([byte[]]$haystack, [byte[]]$needle, [byte[]]$replacement) {
    $idx = Bytes-IndexOf $haystack $needle
    if ($idx -lt 0) { return $null }
    $before = if ($idx -gt 0) { $haystack[0..($idx - 1)] } else { @() }
    $afterStart = $idx + $needle.Length
    $after = if ($afterStart -lt $haystack.Length) { $haystack[$afterStart..($haystack.Length - 1)] } else { @() }
    $result = New-Object byte[] ($before.Length + $replacement.Length + $after.Length)
    [Array]::Copy($before, 0, $result, 0, $before.Length)
    [Array]::Copy($replacement, 0, $result, $before.Length, $replacement.Length)
    if ($after.Length -gt 0) {
        [Array]::Copy($after, 0, $result, $before.Length + $replacement.Length, $after.Length)
    }
    return ,$result
}

# === Patch =====================================================
# Replace the broken read site with a type-safe version using a local copy
# that TypeScript's flow analysis can narrow correctly.

$encoder = [System.Text.Encoding]::UTF8

# Old: the broken inline ternary that narrows controllerClosedAt to never
# New: use a local variable so TS can narrow it correctly
$old = "        dlog(``DONE via live run (controllerClosed=`${controllerClosed}`${controllerClosedAt ? `` at stage=`${controllerClosedAt.stage}`` : ''})``)`r`n"

$new = "        const _cca = controllerClosedAt as { stage: string; elapsedSec: string } | null`r`n        const _ccaTag = _cca ? `` at stage=`${_cca.stage}`` : ''`r`n        dlog(``DONE via live run (controllerClosed=`${controllerClosed}`${_ccaTag})``)`r`n"

$marker = 'const _ccaTag = _cca'

Write-Host "Patching $Target" -ForegroundColor Cyan
Write-Host ""

$bytes = [System.IO.File]::ReadAllBytes($Target)
$originalLength = $bytes.Length

$markerBytes = $encoder.GetBytes($marker)
$markerCount = Bytes-CountOccurrences $bytes $markerBytes
if ($markerCount -ge 1) {
    Write-Host "  [skip] hotfix already applied (marker present)" -ForegroundColor DarkGray
    Write-Host ""
    Write-Host "Nothing to do." -ForegroundColor Green
    exit 0
}

$oldBytes = $encoder.GetBytes($old)
$newBytes = $encoder.GetBytes($new)
$count = Bytes-CountOccurrences $bytes $oldBytes

if ($count -ne 1) {
    Write-Host "  [FAIL] anchor count = $count (expected 1)" -ForegroundColor Red
    Write-Host ""
    Write-Host "The broken line was not found in the expected form." -ForegroundColor Red
    Write-Host "Either the file has been edited since the diagnostic patch was applied," -ForegroundColor DarkGray
    Write-Host "or the diagnostic patch was never applied. Aborting." -ForegroundColor DarkGray
    exit 1
}

Write-Host "  [match] broken read-site anchor found" -ForegroundColor Green

if (-not $Apply) {
    Write-Host ""
    Write-Host "Dry run complete. Re-run with -Apply to write changes." -ForegroundColor Yellow
    exit 0
}

$bytes = Bytes-ReplaceFirst $bytes $oldBytes $newBytes
if ($null -eq $bytes) {
    Write-Host "  [FAIL] replace returned null" -ForegroundColor Red
    exit 1
}

[System.IO.File]::WriteAllBytes($Target, $bytes)
Write-Host "  [+] patch applied (was $originalLength bytes, now $($bytes.Length) bytes)" -ForegroundColor Green
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Cyan
Write-Host "  1. npm run build" -ForegroundColor Gray
Write-Host "  2. git add -A && git commit -m 'fix(diag): typescript narrowing in analyze route diag'" -ForegroundColor Gray
Write-Host "  3. git push" -ForegroundColor Gray
