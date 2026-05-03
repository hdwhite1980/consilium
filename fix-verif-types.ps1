# =============================================================
# fix-verif-types.ps1
#
# Hotfix for build error in app/lib/verification.ts:
#
#   Type error: Argument of type '(c: string) => string' is not
#   assignable to parameter of type '(value: unknown, index: number,
#   array: unknown[]) => string'. Types of parameters 'c' and 'value'
#   are incompatible.
#
# Cause:
#   The .filter() returns unknown[] because its parameter is typed as
#   unknown. The boolean return doesn't narrow the array type, so the
#   .map((c: string) => ...) call fails type check.
#
# Fix:
#   Convert the filter to a proper type predicate by adding ': c is string'
#   return type annotation. This tells TypeScript the filter is a real
#   type guard, so the resulting array is string[]. Then .map's parameter
#   is naturally string and we can drop the redundant annotation + cast.
#
# Pure ASCII. Idempotent. End-to-end verified.
#
# Usage:
#   .\fix-verif-types.ps1          (dry run)
#   .\fix-verif-types.ps1 -Apply   (write changes)
# =============================================================

param([switch]$Apply)

$ErrorActionPreference = 'Stop'

$Target = 'app\lib\verification.ts'

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
# verification.ts uses LF line endings
$LF = "`n"
$encoder = [System.Text.Encoding]::UTF8

# Old: filter returns unknown, then map with ' (c: string) => ...' fails type check
$old = "    return claims${LF}      .filter((c: unknown) => typeof c === 'string' && c.length > 10)${LF}      .map((c: string) => (c as string).trim().slice(0, 400))${LF}      .slice(0, 8)"

# New: filter is a type predicate (': c is string'), so result is string[],
# and map's parameter is naturally string with no annotation needed
$new = "    return claims${LF}      .filter((c: unknown): c is string => typeof c === 'string' && c.length > 10)${LF}      .map((c) => c.trim().slice(0, 400))${LF}      .slice(0, 8)"

# Idempotency marker: the new code has 'c is string' as type predicate
$marker = "(c: unknown): c is string =>"

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
    Write-Host "The broken filter+map block was not found in expected form." -ForegroundColor Red
    Write-Host "The verification.ts file may have been edited since the gemini-fallback patch." -ForegroundColor DarkGray
    exit 1
}

Write-Host "  [match] broken filter+map block found" -ForegroundColor Green

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
Write-Host "  2. git add -A && git commit -m 'fix(verification): type predicate in filter'" -ForegroundColor Gray
Write-Host "  3. git push" -ForegroundColor Gray
