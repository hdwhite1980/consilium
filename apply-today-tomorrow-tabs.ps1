# =============================================================
# apply-today-tomorrow-tabs.ps1
#
# Adds a Today | Tomorrow tab pair to the headers of both:
#   - app\news\page.tsx        (Today is active)
#   - app\tomorrow\page.tsx    (Tomorrow is active)
#
# The unfocused tab navigates to the other URL, so the two pages
# feel like a single product surface with two views.
#
# Idempotent. Detects when patches are already applied.
# Pure ASCII script - non-ASCII chars in source files are left alone
# since byte-exact string replacement is used.
#
# Usage:
#   .\apply-today-tomorrow-tabs.ps1          (dry run)
#   .\apply-today-tomorrow-tabs.ps1 -Apply   (write changes)
# =============================================================

param([switch]$Apply)

$ErrorActionPreference = 'Stop'

$NewsFile     = 'app\news\page.tsx'
$TomorrowFile = 'app\tomorrow\page.tsx'

# --- Helpers -----------------------------------------------
function Read-FileBytes([string]$path) {
    if (-not (Test-Path $path)) {
        Write-Host "  ERROR: $path not found" -ForegroundColor Red
        return $null
    }
    return [System.IO.File]::ReadAllBytes($path)
}

function Write-FileBytes([string]$path, [byte[]]$bytes) {
    [System.IO.File]::WriteAllBytes($path, $bytes)
}

function Bytes-Contain([byte[]]$haystack, [byte[]]$needle) {
    if ($needle.Length -gt $haystack.Length) { return $false }
    for ($i = 0; $i -le ($haystack.Length - $needle.Length); $i++) {
        $match = $true
        for ($j = 0; $j -lt $needle.Length; $j++) {
            if ($haystack[$i + $j] -ne $needle[$j]) {
                $match = $false
                break
            }
        }
        if ($match) { return $true }
    }
    return $false
}

function Bytes-Replace([byte[]]$haystack, [byte[]]$needle, [byte[]]$replacement) {
    # Find first occurrence
    $found = -1
    for ($i = 0; $i -le ($haystack.Length - $needle.Length); $i++) {
        $match = $true
        for ($j = 0; $j -lt $needle.Length; $j++) {
            if ($haystack[$i + $j] -ne $needle[$j]) {
                $match = $false
                break
            }
        }
        if ($match) { $found = $i; break }
    }
    if ($found -lt 0) { return $null }

    $before = $haystack[0..($found - 1)]
    $afterStart = $found + $needle.Length
    $after = if ($afterStart -lt $haystack.Length) { $haystack[$afterStart..($haystack.Length - 1)] } else { @() }

    $result = New-Object byte[] ($before.Length + $replacement.Length + $after.Length)
    [Array]::Copy($before, 0, $result, 0, $before.Length)
    [Array]::Copy($replacement, 0, $result, $before.Length, $replacement.Length)
    if ($after.Length -gt 0) {
        [Array]::Copy($after, 0, $result, $before.Length + $replacement.Length, $after.Length)
    }
    return ,$result
}

# --- Patch 1: app\news\page.tsx --------------------------------
$NewsOldBlock = @"
        <div className="w-px h-4" style={{ background: 'var(--border)' }} />`r`n        <div className="flex items-center gap-2">`r`n          <Zap size={14} style={{ color: '#fbbf24' }} />`r`n          <span className="text-sm font-bold">Today&apos;s Movers</span>`r`n        </div>`r`n        <button onClick={() => router.push('/tomorrow')}`r`n          className="flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-lg transition-all hover:opacity-80"`r`n          style={{ background: 'rgba(167,139,250,0.12)', color: '#a78bfa', border: '1px solid rgba(167,139,250,0.2)' }}>`r`n          <Calendar size={12} aria-hidden="true" /> Tomorrow`r`n        </button>`r`n        <div className="flex items-center gap-2">`r`n          <span className="text-[10px] font-mono text-white/25">AI-powered market intelligence</span>`r`n        </div>`r`n
"@

$NewsNewBlock = @"
        <div className="w-px h-4" style={{ background: 'var(--border)' }} />`r`n        {/* Today | Tomorrow tab pair */}`r`n        <div className="flex items-center gap-1" role="tablist" aria-label="Brief">`r`n          <button`r`n            type="button"`r`n            role="tab"`r`n            aria-selected="true"`r`n            className="flex items-center gap-1.5 text-xs font-bold px-3 py-1.5 rounded-lg transition-all"`r`n            style={{ background: 'rgba(251,191,36,0.15)', color: '#fbbf24', border: '1px solid rgba(251,191,36,0.3)' }}>`r`n            <Zap size={12} aria-hidden="true" />`r`n            <span>Today</span>`r`n          </button>`r`n          <button`r`n            type="button"`r`n            role="tab"`r`n            aria-selected="false"`r`n            onClick={() => router.push('/tomorrow')}`r`n            className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg transition-all hover:opacity-80"`r`n            style={{ background: 'transparent', color: 'var(--text3)', border: '1px solid var(--border)' }}>`r`n            <Calendar size={12} aria-hidden="true" />`r`n            <span>Tomorrow</span>`r`n          </button>`r`n        </div>`r`n        <span className="text-[10px] font-mono text-white/25 hidden sm:inline">AI-powered market intelligence</span>`r`n
"@

# --- Patch 2: app\tomorrow\page.tsx ----------------------------
$TomOldBlock = @"
        <div className="w-px h-4" style={{ background: 'var(--border)' }} />`r`n        <div className="flex items-center gap-2">`r`n          <Calendar size={14} style={{ color: '#a78bfa' }} />`r`n          <span className="text-sm font-bold">Tomorrow&apos;s Movers</span>`r`n          <span className="text-[10px] font-mono text-white/25 hidden sm:inline">Next trading day playbook</span>`r`n        </div>`r`n
"@

$TomNewBlock = @"
        <div className="w-px h-4" style={{ background: 'var(--border)' }} />`r`n        {/* Today | Tomorrow tab pair */}`r`n        <div className="flex items-center gap-1" role="tablist" aria-label="Brief">`r`n          <button`r`n            type="button"`r`n            role="tab"`r`n            aria-selected="false"`r`n            onClick={() => router.push('/news')}`r`n            className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg transition-all hover:opacity-80"`r`n            style={{ background: 'transparent', color: 'var(--text3)', border: '1px solid var(--border)' }}>`r`n            <Zap size={12} aria-hidden="true" />`r`n            <span>Today</span>`r`n          </button>`r`n          <button`r`n            type="button"`r`n            role="tab"`r`n            aria-selected="true"`r`n            className="flex items-center gap-1.5 text-xs font-bold px-3 py-1.5 rounded-lg transition-all"`r`n            style={{ background: 'rgba(167,139,250,0.15)', color: '#a78bfa', border: '1px solid rgba(167,139,250,0.3)' }}>`r`n            <Calendar size={12} aria-hidden="true" />`r`n            <span>Tomorrow</span>`r`n          </button>`r`n        </div>`r`n        <span className="text-[10px] font-mono text-white/25 hidden sm:inline">Next trading day playbook</span>`r`n
"@

# --- Apply -------------------------------------------------
$encoder = [System.Text.Encoding]::UTF8

$results = @()

# News file
Write-Host "[$NewsFile]" -ForegroundColor Cyan
$bytes = Read-FileBytes $NewsFile
if ($null -eq $bytes) {
    $results += @{ File = $NewsFile; Status = 'missing' }
} else {
    $oldBytes = $encoder.GetBytes($NewsOldBlock)
    $newBytes = $encoder.GetBytes($NewsNewBlock)
    $alreadyPatched = $encoder.GetBytes('Today | Tomorrow tab pair')

    if (Bytes-Contain $bytes $alreadyPatched) {
        Write-Host "  [skip] tab pair already present (already patched)" -ForegroundColor DarkGray
        $results += @{ File = $NewsFile; Status = 'already' }
    } elseif (Bytes-Contain $bytes $oldBytes) {
        Write-Host "  [match] anchor block found" -ForegroundColor Green
        if ($Apply) {
            $patched = Bytes-Replace $bytes $oldBytes $newBytes
            if ($null -eq $patched) {
                Write-Host "  [ERROR] replace returned null" -ForegroundColor Red
                $results += @{ File = $NewsFile; Status = 'error' }
            } else {
                Write-FileBytes $NewsFile $patched
                Write-Host "  [written] $($patched.Length) bytes (was $($bytes.Length))" -ForegroundColor Green
                $results += @{ File = $NewsFile; Status = 'applied' }
            }
        } else {
            Write-Host "  [dry-run] would replace anchor block ($($oldBytes.Length) bytes -> $($newBytes.Length) bytes)" -ForegroundColor Yellow
            $results += @{ File = $NewsFile; Status = 'pending' }
        }
    } else {
        Write-Host "  [ERROR] anchor block NOT found in file" -ForegroundColor Red
        Write-Host "          Either the file has been modified since these patches were authored," -ForegroundColor DarkGray
        Write-Host "          or this script is being run against the wrong version." -ForegroundColor DarkGray
        $results += @{ File = $NewsFile; Status = 'no-match' }
    }
}

Write-Host ""

# Tomorrow file
Write-Host "[$TomorrowFile]" -ForegroundColor Cyan
$bytes = Read-FileBytes $TomorrowFile
if ($null -eq $bytes) {
    $results += @{ File = $TomorrowFile; Status = 'missing' }
} else {
    $oldBytes = $encoder.GetBytes($TomOldBlock)
    $newBytes = $encoder.GetBytes($TomNewBlock)
    $alreadyPatched = $encoder.GetBytes('Today | Tomorrow tab pair')

    if (Bytes-Contain $bytes $alreadyPatched) {
        Write-Host "  [skip] tab pair already present (already patched)" -ForegroundColor DarkGray
        $results += @{ File = $TomorrowFile; Status = 'already' }
    } elseif (Bytes-Contain $bytes $oldBytes) {
        Write-Host "  [match] anchor block found" -ForegroundColor Green
        if ($Apply) {
            $patched = Bytes-Replace $bytes $oldBytes $newBytes
            if ($null -eq $patched) {
                Write-Host "  [ERROR] replace returned null" -ForegroundColor Red
                $results += @{ File = $TomorrowFile; Status = 'error' }
            } else {
                Write-FileBytes $TomorrowFile $patched
                Write-Host "  [written] $($patched.Length) bytes (was $($bytes.Length))" -ForegroundColor Green
                $results += @{ File = $TomorrowFile; Status = 'applied' }
            }
        } else {
            Write-Host "  [dry-run] would replace anchor block ($($oldBytes.Length) bytes -> $($newBytes.Length) bytes)" -ForegroundColor Yellow
            $results += @{ File = $TomorrowFile; Status = 'pending' }
        }
    } else {
        Write-Host "  [ERROR] anchor block NOT found in file" -ForegroundColor Red
        $results += @{ File = $TomorrowFile; Status = 'no-match' }
    }
}

Write-Host ""
Write-Host "Summary:" -ForegroundColor Cyan
foreach ($r in $results) {
    $color = switch ($r.Status) {
        'applied'  { 'Green' }
        'pending'  { 'Yellow' }
        'already'  { 'DarkGray' }
        default    { 'Red' }
    }
    Write-Host "  [$($r.Status.ToUpper().PadRight(8))] $($r.File)" -ForegroundColor $color
}

if (-not $Apply) {
    $hasPending = ($results | Where-Object { $_.Status -eq 'pending' }).Count -gt 0
    if ($hasPending) {
        Write-Host ""
        Write-Host "Dry run complete. Re-run with -Apply to write changes." -ForegroundColor Yellow
    }
}

if ($Apply) {
    Write-Host ""
    Write-Host "Next steps:" -ForegroundColor Cyan
    Write-Host "  1. Manual edit: in app\page.tsx, remove the 'Tomorrow' entry from NAV_TOP" -ForegroundColor Gray
    Write-Host "     (the line starting with: { label: 'Tomorrow', icon: <Calendar size={12} />, ... })" -ForegroundColor DarkGray
    Write-Host "  2. npm run build" -ForegroundColor Gray
    Write-Host "  3. Test: visit /news, click Tomorrow tab, should land on /tomorrow with Tomorrow tab active" -ForegroundColor Gray
    Write-Host "  4. Test: visit /tomorrow, click Today tab, should land on /news with Today tab active" -ForegroundColor Gray
    Write-Host "  5. git commit" -ForegroundColor Gray
}
