# apply-logo-v2.ps1  --  Wali-OS brand update (encoding-safe)
#
# Matches by regex on the purple-gradient logo block and replaces the
# entire thing, regardless of what character is inside (Sigma, mojibake,
# or nothing). Works across all UTF-8 / UTF-8-BOM / Windows-1252 mixups.
#
# Usage:
#   .\apply-logo-v2.ps1          (dry run)
#   .\apply-logo-v2.ps1 -Apply   (write the changes)

param(
  [switch]$Apply
)

$ErrorActionPreference = 'Stop'

$repoRoot = Get-Location
Write-Host "Repo: $repoRoot" -ForegroundColor Cyan
if ($Apply) {
  Write-Host "Mode: APPLY" -ForegroundColor Green
} else {
  Write-Host "Mode: DRY RUN" -ForegroundColor Yellow
}
Write-Host ""

# ---- Regex-based patterns ----
# Each captures the surrounding context via named groups so we can keep
# the surrounding markup's indentation when we swap in <WaliLogo />.

# Pattern A: Sidebar logo (w-12 h-12 gradient block + wordmark + tagline)
# Matches: <div className="flex items-center gap-3 mb-12"> ... gradient div ... WALI-OS ... Signal Convergence Engine ... </div>
$rxLarge = @'
(?ms)(?<indent>[ \t]*)<div className="flex items-center gap-3 mb-12">\s*<div className="w-12 h-12 rounded-2xl [^"]*"\s*style=\{\{ background: 'linear-gradient\(135deg,#7c3aed,#4f46e5\)' \}\}>[\s\S]*?</div>\s*<div>\s*<div className="text-xl font-bold tracking-tight text-white">WALI-OS</div>\s*<div className="text-\[10px\] font-mono text-white/25">Signal Convergence Engine</div>\s*</div>\s*</div>
'@

$replaceLarge = @'
${indent}<div className="mb-12">
${indent}  <WaliLogo size="lg" priority />
${indent}</div>
'@

# Pattern B: Centered (justify-center) variant - confirm page and signup "sent" state
$rxCentered = @'
(?ms)(?<indent>[ \t]*)<div className="flex items-center justify-center gap-3 mb-(?<mb>\d+)">\s*<div className="w-10 h-10 rounded-xl [^"]*"\s*style=\{\{ background: 'linear-gradient\(135deg,#7c3aed,#4f46e5\)' \}\}>[\s\S]*?</div>\s*<div className="text-left">\s*<div className="text-lg font-bold tracking-tight text-white">WALI-OS</div>\s*<div className="text-\[10px\] font-mono text-white/25">Signal Convergence Engine</div>\s*</div>\s*</div>
'@

$replaceCentered = @'
${indent}<div className="flex justify-center mb-${mb}">
${indent}  <WaliLogo size="md" priority />
${indent}</div>
'@

# Pattern C: Medium header (non-centered) - login, disclaimer, and app/page.tsx mobile
$rxMedium = @'
(?ms)(?<indent>[ \t]*)<div className="flex items-center gap-3 mb-(?<mb>\d+)(?<extra>[^"]*)">\s*<div className="w-10 h-10 rounded-xl [^"]*"\s*style=\{\{ background: 'linear-gradient\(135deg,#7c3aed,#4f46e5\)' \}\}>[\s\S]*?</div>\s*<div>\s*<div className="text-lg font-bold tracking-tight text-white">WALI-OS</div>\s*<div className="text-\[10px\] font-mono text-white/25">Signal Convergence Engine</div>\s*</div>\s*</div>
'@

$replaceMedium = @'
${indent}<div className="mb-${mb}${extra}">
${indent}  <WaliLogo size="md" priority />
${indent}</div>
'@

# Pattern D: Small inline nav logo (w-7 h-7) - already structured inside a button.
# This is the one in app/page.tsx line 635. It sits INSIDE a <button aria-label>,
# so we replace only the inner div with a WaliLogo (no wrapper).
$rxNavInline = @'
(?ms)(?<indent>[ \t]*)<div className="w-7 h-7 rounded-lg [^"]*"\s*style=\{\{ background: 'linear-gradient\(135deg,#7c3aed,#4f46e5\)' \}\} aria-hidden="true">[\s\S]{1,10}?</div>
'@

$replaceNavInline = @'
${indent}<WaliLogo size="xs" noLink />
'@

$patterns = @(
  @{ Name = 'Large sidebar';   Regex = $rxLarge;    Replace = $replaceLarge }
  @{ Name = 'Centered';        Regex = $rxCentered; Replace = $replaceCentered }
  @{ Name = 'Medium header';   Regex = $rxMedium;   Replace = $replaceMedium }
  @{ Name = 'Nav inline (xs)'; Regex = $rxNavInline; Replace = $replaceNavInline }
)

$files = @(
  'app/page.tsx'
  'app/login/page.tsx'
  'app/signup/page.tsx'
  'app/confirm/page.tsx'
  'app/disclaimer/page.tsx'
)

$totalHits = 0

foreach ($file in $files) {
  if (-not (Test-Path $file)) {
    Write-Host "  SKIP $file (not found)" -ForegroundColor DarkGray
    continue
  }

  $content = Get-Content $file -Raw
  $original = $content
  $hits = 0
  $matchDetails = @()

  foreach ($p in $patterns) {
    $regex = [regex]$p.Regex
    $matches = $regex.Matches($content)
    if ($matches.Count -gt 0) {
      $content = $regex.Replace($content, $p.Replace)
      $hits += $matches.Count
      $matchDetails += "$($matches.Count) x $($p.Name)"
    }
  }

  if ($hits -eq 0) {
    Write-Host "  $file : no matches" -ForegroundColor DarkGray
    continue
  }

  Write-Host "  $file : $($matchDetails -join ', ')" -ForegroundColor Green
  $totalHits += $hits

  # Inject import if not present
  if ($content -notmatch "import WaliLogo from '@/app/components/WaliLogo'") {
    $lines = $content -split "`r?`n"
    $lastImportIdx = -1
    for ($i = 0; $i -lt $lines.Length; $i++) {
      if ($lines[$i] -match '^import\s') { $lastImportIdx = $i }
    }
    if ($lastImportIdx -ge 0) {
      $before = $lines[0..$lastImportIdx]
      $after  = if ($lastImportIdx + 1 -lt $lines.Length) { $lines[($lastImportIdx + 1)..($lines.Length - 1)] } else { @() }
      $lines = $before + "import WaliLogo from '@/app/components/WaliLogo'" + $after
      $content = $lines -join "`r`n"
      Write-Host "    + import added" -ForegroundColor Cyan
    }
  } else {
    Write-Host "    (import already present)" -ForegroundColor DarkGray
  }

  if ($Apply) {
    # Preserve original encoding - write as UTF-8 without BOM (what Next.js expects)
    [System.IO.File]::WriteAllText((Resolve-Path $file).Path, $content, [System.Text.UTF8Encoding]::new($false))
    Write-Host "    WROTE $file" -ForegroundColor Green
  } else {
    Write-Host "    (dry run, not written)" -ForegroundColor Yellow
  }
}

Write-Host ""
Write-Host "Total replacements: $totalHits" -ForegroundColor Cyan

if (-not $Apply -and $totalHits -gt 0) {
  Write-Host ""
  Write-Host "Dry run looked good. To apply, run:" -ForegroundColor Yellow
  Write-Host "  .\apply-logo-v2.ps1 -Apply" -ForegroundColor White
}
