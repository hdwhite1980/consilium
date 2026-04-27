# =============================================================
# fix-ellipses.ps1
#
# Replaces all U+2026 (...) ellipsis characters with three ASCII
# dots ('...') in app/page.tsx. ASCII-safe, encoding-proof.
#
# Idempotent: re-running does nothing on already-fixed file.
# =============================================================

$ErrorActionPreference = 'Stop'

$DashboardPath = ".\app\page.tsx"

if (-not (Test-Path $DashboardPath)) {
    Write-Error "Dashboard file not found at $DashboardPath"
    exit 1
}

# Read raw bytes to avoid any encoding interpretation
$bytes = [System.IO.File]::ReadAllBytes((Resolve-Path $DashboardPath).Path)

# U+2026 in UTF-8 = 0xE2 0x80 0xA6
$ellipsisBytes = [byte[]] @(0xE2, 0x80, 0xA6)
# Three ASCII dots
$threeDots = [byte[]] @(0x2E, 0x2E, 0x2E)

# Count occurrences
$count = 0
for ($i = 0; $i -le ($bytes.Length - 3); $i++) {
    if ($bytes[$i] -eq 0xE2 -and $bytes[$i + 1] -eq 0x80 -and $bytes[$i + 2] -eq 0xA6) {
        $count++
    }
}

Write-Host "Found $count ellipsis character(s) in $DashboardPath"

if ($count -eq 0) {
    Write-Host "Nothing to replace. Already fixed." -ForegroundColor Yellow
    exit 0
}

# Build new byte array with replacements
$newBytes = New-Object System.Collections.Generic.List[byte]
$i = 0
while ($i -lt $bytes.Length) {
    if ($i -le ($bytes.Length - 3) -and $bytes[$i] -eq 0xE2 -and $bytes[$i + 1] -eq 0x80 -and $bytes[$i + 2] -eq 0xA6) {
        # Replace with three dots
        $newBytes.Add([byte] 0x2E)
        $newBytes.Add([byte] 0x2E)
        $newBytes.Add([byte] 0x2E)
        $i += 3
    } else {
        $newBytes.Add($bytes[$i])
        $i++
    }
}

# Write back
[System.IO.File]::WriteAllBytes((Resolve-Path $DashboardPath).Path, $newBytes.ToArray())

Write-Host "Replaced $count ellipsis(es) with '...'" -ForegroundColor Green
Write-Host "File size: $($newBytes.Count) bytes (was $($bytes.Length))"
