# =============================================================
# fix-capital-block-scope.ps1
#
# Recovery for a scoping bug: the Capital block was inserted
# into the TierLadder component, but setAddCashOpen lives in
# FloorInner. This script:
#
#   1. REMOVES the misplaced Capital block from TierLadder
#   2. ADDS a properly scoped Capital block in FloorInner,
#      adjacent to the <TierLadder /> render
#
# Pure ASCII throughout. CRLF-aware.
#
# Usage:
#   .\fix-capital-block-scope.ps1          (dry run)
#   .\fix-capital-block-scope.ps1 -Apply   (write changes)
# =============================================================

param([switch]$Apply)

$ErrorActionPreference = 'Stop'
$file = 'app\invest\page.tsx'

if (-not (Test-Path $file)) {
  Write-Host "ERROR: $file not found. Run from repo root." -ForegroundColor Red
  exit 1
}

$bytes   = [System.IO.File]::ReadAllBytes((Resolve-Path $file).Path)
$content = [System.Text.UTF8Encoding]::new($false).GetString($bytes)
$original = $content

$useCrlf = $content.Contains("`r`n")
$NL = if ($useCrlf) { "`r`n" } else { "`n" }
Write-Host "Detected line endings: $(if ($useCrlf) { 'CRLF' } else { 'LF' })" -ForegroundColor Cyan
Write-Host ""

# --------------------------------------------------------------
# Step 1 - REMOVE the misplaced Capital block from TierLadder.
# Match the entire fl-capital-block div + its trailing blank line.
# --------------------------------------------------------------
$removalPattern = '      <div className="fl-metric-block fl-capital-block">\r?\n        <div className="fl-capital-row">\r?\n          <span className="k">capital</span>\r?\n          <button type="button" className="fl-capital-add-btn" onClick=\{\(\) => setAddCashOpen\(true\)\}>\r?\n            \+ add\r?\n          </button>\r?\n        </div>\r?\n        <div className="fl-capital-detail mono">\r?\n          <span>starting</span>\r?\n          <span>\$\{\(data\?\.journey\?\.starting_balance \?\? 0\)\.toFixed\(2\)\}</span>\r?\n        </div>\r?\n      </div>\r?\n\r?\n'

$rxRemoval = [regex]::new($removalPattern, [System.Text.RegularExpressions.RegexOptions]::Singleline)
$matches = $rxRemoval.Matches($content)
if ($matches.Count -eq 0) {
  Write-Host "  SKIP removal: misplaced Capital block not found (already moved? or shape changed)" -ForegroundColor Yellow
  $removed = $false
} elseif ($matches.Count -gt 1) {
  Write-Host "  ERROR removal: matched $($matches.Count) Capital blocks. Refusing." -ForegroundColor Red
  exit 1
} else {
  $m = $matches[0]
  $content = $content.Remove($m.Index, $m.Length)
  Write-Host "  OK   removed misplaced Capital block (was at offset $($m.Index))" -ForegroundColor Green
  $removed = $true
}

# --------------------------------------------------------------
# Step 2 - ADD a properly scoped Capital block in FloorInner,
# right after the <TierLadder /> render. Wrap it in the same
# mobileView fl-show/fl-hide div so it follows the same
# responsive behavior as the tier ladder itself.
# --------------------------------------------------------------
$insertPattern = '(        \{/\* LEFT [^\r\n]*\*/\}\r?\n        <div className=\{mobileView === ''portfolio'' \? ''fl-show'' : ''fl-hide''\}>\r?\n          <TierLadder tiers=\{tiers\} tier=\{tier\} stats=\{stats\} value=\{value\} processTrend=\{data\.processTrend\} />\r?\n        </div>\r?\n)'

$insertion = @(
  '',
  '        {/* Capital block - deposit / withdraw */}',
  "        <div className={mobileView === 'portfolio' ? 'fl-show' : 'fl-hide'}>",
  '          <div className="fl-metric-block fl-capital-block" style={{ marginTop: 12 }}>',
  '            <div className="fl-capital-row">',
  '              <span className="k">capital</span>',
  '              <button type="button" className="fl-capital-add-btn" onClick={() => setAddCashOpen(true)}>',
  '                + add',
  '              </button>',
  '            </div>',
  '            <div className="fl-capital-detail mono">',
  '              <span>starting</span>',
  '              <span>${(data?.journey?.starting_balance ?? 0).toFixed(2)}</span>',
  '            </div>',
  '          </div>',
  '        </div>',
  ''
) -join $NL

$rxInsert = [regex]::new($insertPattern, [System.Text.RegularExpressions.RegexOptions]::Singleline)
$matches = $rxInsert.Matches($content)
if ($matches.Count -eq 0) {
  Write-Host "  ERROR insert: TierLadder render site not found" -ForegroundColor Red
  exit 1
}
if ($matches.Count -gt 1) {
  Write-Host "  ERROR insert: TierLadder render matched $($matches.Count) times" -ForegroundColor Red
  exit 1
}

$m = $matches[0]
# Insert AFTER the matched group (the existing TierLadder wrapper div)
$content = $content.Insert($m.Index + $m.Length, $insertion)
Write-Host "  OK   inserted Capital block after TierLadder (offset $($m.Index + $m.Length))" -ForegroundColor Green

# --------------------------------------------------------------
# Done
# --------------------------------------------------------------
if ($content -eq $original) {
  Write-Host ""
  Write-Host "No changes made." -ForegroundColor Yellow
  exit 0
}

# Sanity check: setAddCashOpen should now be referenced AFTER it's declared
$hookIdx = $content.IndexOf('setAddCashOpen] = useState(false)')
$useIdx  = $content.IndexOf('onClick={() => setAddCashOpen(true)}')
if ($hookIdx -lt 0) {
  Write-Host "ERROR: state hook missing. Refusing to write." -ForegroundColor Red
  exit 1
}
if ($useIdx -lt 0) {
  Write-Host "ERROR: Capital block onClick reference missing. Refusing to write." -ForegroundColor Red
  exit 1
}
if ($useIdx -lt $hookIdx) {
  Write-Host "ERROR: Capital block onClick at offset $useIdx is BEFORE state hook at $hookIdx. Refusing to write." -ForegroundColor Red
  exit 1
}
# Both must live inside the same FloorInner function. Verify by checking that
# there's no `function ` declaration between them.
$between = $content.Substring($hookIdx, $useIdx - $hookIdx)
$priorFunctionInBetween = [regex]::Match($between, '\nfunction \w+\(')
if ($priorFunctionInBetween.Success) {
  Write-Host "ERROR: a function declaration appears between hook and use site." -ForegroundColor Red
  Write-Host "       This means the Capital block landed in a different component." -ForegroundColor Red
  Write-Host "       Refusing to write." -ForegroundColor Red
  exit 1
}
Write-Host ""
Write-Host "Sanity: state hook at offset $hookIdx, used at offset $useIdx (same scope)" -ForegroundColor Cyan

if ($Apply) {
  [System.IO.File]::WriteAllText((Resolve-Path $file).Path, $content, [System.Text.UTF8Encoding]::new($false))
  Write-Host ""
  Write-Host "WROTE $file" -ForegroundColor Green
  Write-Host ""
  Write-Host "Next: npm run build" -ForegroundColor Cyan
} else {
  Write-Host ""
  Write-Host "Dry run looked good. Re-run with -Apply to write." -ForegroundColor Yellow
}
