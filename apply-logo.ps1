# apply-logo.ps1  --  Wali-OS brand update
#
# Replaces every legacy Sigma-div logo block with <WaliLogo />
# across all pages, and injects the import statement.
#
# Usage:
#    .\apply-logo.ps1          (dry run - shows what would change)
#    .\apply-logo.ps1 -Apply   (actually writes the changes)

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

# ---- Patterns (each uses the Greek capital letter sigma as placeholder) ----

# 1. Large auth sidebar (w-12 h-12)
$patternLg = @'
          <div className="flex items-center gap-3 mb-12">
            <div className="w-12 h-12 rounded-2xl flex items-center justify-center text-xl font-bold text-white"
              style={{ background: 'linear-gradient(135deg,#7c3aed,#4f46e5)' }}>Σ</div>
            <div>
              <div className="text-xl font-bold tracking-tight text-white">WALI-OS</div>
              <div className="text-[10px] font-mono text-white/25">Signal Convergence Engine</div>
            </div>
          </div>
'@

$replacementLg = @'
          <div className="mb-12">
            <WaliLogo size="lg" priority />
          </div>
'@

# 2. Medium auth header (w-10 h-10) - inline Sigma variant
$patternMd = @'
      <div className="flex items-center gap-3 mb-10">
        <div className="w-10 h-10 rounded-xl flex items-center justify-center text-lg font-bold text-white"
          style={{ background: 'linear-gradient(135deg,#7c3aed,#4f46e5)' }}>
          Σ
        </div>
        <div>
          <div className="text-lg font-bold tracking-tight text-white">WALI-OS</div>
          <div className="text-[10px] font-mono text-white/25">Signal Convergence Engine</div>
        </div>
      </div>
'@

$replacementMd = @'
      <div className="mb-10">
        <WaliLogo size="md" priority />
      </div>
'@

# 3. Medium centered (confirm page)
$patternCenter = @'
        <div className="flex items-center justify-center gap-3 mb-8">
          <div className="w-10 h-10 rounded-xl flex items-center justify-center text-lg font-bold text-white"
            style={{ background: 'linear-gradient(135deg,#7c3aed,#4f46e5)' }}>Σ</div>
          <div className="text-left">
            <div className="text-lg font-bold tracking-tight text-white">WALI-OS</div>
            <div className="text-[10px] font-mono text-white/25">Signal Convergence Engine</div>
          </div>
        </div>
'@

$replacementCenter = @'
        <div className="flex justify-center mb-8">
          <WaliLogo size="md" priority />
        </div>
'@

# 4. Disclaimer page
$patternDisclaimer = @'
      <div className="flex items-center gap-3 mb-8">
        <div className="w-10 h-10 rounded-xl flex items-center justify-center text-lg font-bold text-white"
          style={{ background: 'linear-gradient(135deg,#7c3aed,#4f46e5)' }}>Σ</div>
        <div>
          <div className="text-lg font-bold tracking-tight text-white">WALI-OS</div>
          <div className="text-[10px] font-mono text-white/25">Signal Convergence Engine</div>
        </div>
      </div>
'@

$replacementDisclaimer = @'
      <div className="mb-8">
        <WaliLogo size="md" priority />
      </div>
'@

# 5. app/page.tsx mobile (lg:hidden)
$patternMobile = @'
        <div className="flex items-center gap-3 mb-10 lg:hidden">
          <div className="w-10 h-10 rounded-xl flex items-center justify-center text-lg font-bold text-white"
            style={{ background: 'linear-gradient(135deg,#7c3aed,#4f46e5)' }}>Σ</div>
          <div>
            <div className="text-lg font-bold tracking-tight text-white">WALI-OS</div>
            <div className="text-[10px] font-mono text-white/25">Signal Convergence Engine</div>
          </div>
        </div>
'@

$replacementMobile = @'
        <div className="mb-10 lg:hidden">
          <WaliLogo size="md" priority />
        </div>
'@

# 6. app/page.tsx "sent" state (email sent confirmation)
$patternSent = @'
          <div className="flex items-center justify-center gap-3 mb-6">
            <div className="w-10 h-10 rounded-xl flex items-center justify-center text-lg font-bold text-white"
              style={{ background: 'linear-gradient(135deg,#7c3aed,#4f46e5)' }}>Σ</div>
            <div className="text-left">
              <div className="text-lg font-bold tracking-tight text-white">WALI-OS</div>
              <div className="text-[10px] font-mono text-white/25">Signal Convergence Engine</div>
            </div>
          </div>
'@

$replacementSent = @'
          <div className="flex justify-center mb-6">
            <WaliLogo size="md" priority />
          </div>
'@

$patterns = @(
  @{ Pattern = $patternLg;         Replacement = $replacementLg;         Name = 'Large auth sidebar (w-12 h-12)' }
  @{ Pattern = $patternMd;         Replacement = $replacementMd;         Name = 'Medium auth header (w-10 h-10)' }
  @{ Pattern = $patternCenter;     Replacement = $replacementCenter;     Name = 'Centered confirm logo' }
  @{ Pattern = $patternDisclaimer; Replacement = $replacementDisclaimer; Name = 'Disclaimer logo' }
  @{ Pattern = $patternMobile;     Replacement = $replacementMobile;     Name = 'Mobile-only logo' }
  @{ Pattern = $patternSent;       Replacement = $replacementSent;       Name = 'Email-sent confirmation logo' }
)

# ---- Files to process ----
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
  $hits = 0

  foreach ($p in $patterns) {
    $contentNorm = $content -replace "`r`n", "`n"
    $patternNorm = $p.Pattern -replace "`r`n", "`n"
    $replacementNorm = $p.Replacement -replace "`r`n", "`n"

    $count = ([regex]::Matches($contentNorm, [regex]::Escape($patternNorm))).Count
    if ($count -gt 0) {
      $contentNorm = $contentNorm.Replace($patternNorm, $replacementNorm)
      $content = $contentNorm -replace "`n", "`r`n"
      Write-Host "  $file  : $count x $($p.Name)" -ForegroundColor Green
      $hits += $count
    }
  }

  if ($hits -eq 0) {
    Write-Host "  $file  : no matches" -ForegroundColor DarkGray
    continue
  }

  $totalHits += $hits

  # Inject import if not present
  if ($content -notmatch "import WaliLogo from '@/app/components/WaliLogo'") {
    $lines = $content -split "`r`n"
    $lastImportIdx = -1
    for ($i = 0; $i -lt $lines.Length; $i++) {
      if ($lines[$i] -match '^import\s') { $lastImportIdx = $i }
    }
    if ($lastImportIdx -ge 0) {
      $lines = $lines[0..$lastImportIdx] + "import WaliLogo from '@/app/components/WaliLogo'" + $lines[($lastImportIdx + 1)..($lines.Length - 1)]
      $content = $lines -join "`r`n"
      Write-Host "    + import added" -ForegroundColor Cyan
    }
  }

  if ($Apply) {
    Set-Content -Path $file -Value $content -NoNewline
    Write-Host "    WROTE $file" -ForegroundColor Green
  } else {
    Write-Host "    (dry run, not written)" -ForegroundColor Yellow
  }
}

Write-Host ""
Write-Host "Total replacements: $totalHits" -ForegroundColor Cyan

if (-not $Apply -and $totalHits -gt 0) {
  Write-Host ""
  Write-Host "To apply these changes, run:" -ForegroundColor Yellow
  Write-Host "  .\apply-logo.ps1 -Apply" -ForegroundColor White
}
