# =============================================================
# fix-helper-types.ps1
#
# Hotfix for build error in app/lib/gemini-helper.ts:
#
#   Type error: Argument of type 'Record<string, unknown>' is not
#   assignable to parameter of type 'ModelParams'.
#   Property 'model' is missing in type 'Record<string, unknown>'
#   but required in type 'ModelParams'.
#
# Cause:
#   I built modelConfig as Record<string, unknown> intending to make
#   conditional field assignment easier, but TypeScript loses track
#   of the 'model' property type after the cast.
#
# Fix:
#   Replace the intermediate Record<string, unknown> variable with
#   an inline object literal at the getGenerativeModel call. Use
#   conditional spread (...(tools.length > 0 ? { tools } : {})) to
#   only include tools when grounding is requested.
#
# Pure ASCII. Idempotent. End-to-end verified.
#
# Usage:
#   .\fix-helper-types.ps1          (dry run)
#   .\fix-helper-types.ps1 -Apply   (write changes)
# =============================================================

param([switch]$Apply)

$ErrorActionPreference = 'Stop'

$Target = 'app\lib\gemini-helper.ts'

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
# The file uses LF line endings (we wrote it that way originally)
$LF = "`n"
$encoder = [System.Text.Encoding]::UTF8

# Old: the broken Record<string, unknown> block
$old = "  const modelConfig: Record<string, unknown> = { model: modelName }${LF}  if (Object.keys(generationConfig).length > 0) modelConfig.generationConfig = generationConfig${LF}  if (tools.length > 0) modelConfig.tools = tools${LF}${LF}  const model = getGenAI().getGenerativeModel(modelConfig)${LF}  return model.generateContent(opts.prompt)${LF}}"

# New: inline object literal with conditional spread
$new = "  // Build the model params inline so TypeScript can see the required 'model' field.${LF}  // Use conditional spread for tools so we don't pass an empty array.${LF}  const model = getGenAI().getGenerativeModel({${LF}    model: modelName,${LF}    generationConfig,${LF}    ...(tools.length > 0 ? { tools } : {}),${LF}  })${LF}  return model.generateContent(opts.prompt)${LF}}"

# Idempotency marker - the new code has this comment
$marker = "Build the model params inline"

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
    if ($count -eq 0) {
        Write-Host "The broken Record<string, unknown> block was not found." -ForegroundColor Red
        Write-Host "The helper file may have been edited or use different line endings." -ForegroundColor DarkGray
        Write-Host ""
        Write-Host "Quick check:" -ForegroundColor Yellow
        Write-Host "  Get-Content app\lib\gemini-helper.ts | Select-String -Pattern 'Record<string, unknown>'" -ForegroundColor Gray
    }
    exit 1
}

Write-Host "  [match] broken Record<string, unknown> block found" -ForegroundColor Green

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
Write-Host "  2. git add -A && git commit -m 'fix(gemini): typescript types in gemini-helper'" -ForegroundColor Gray
Write-Host "  3. git push" -ForegroundColor Gray
