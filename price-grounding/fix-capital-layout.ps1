# =============================================================
# fix-capital-layout.ps1
#
# Collapses two sibling <div className="fl-show/fl-hide"> blocks
# into one in the LEFT column of the .fl-stage grid, so the
# 3-column grid layout works correctly.
#
# Before this fix:
#   .fl-stage has 4 children (TierLadder div, Capital div, main, aside)
#   -> grid template only has 3 columns -> book value gets pushed to
#      column 3, layout breaks.
#
# After this fix:
#   .fl-stage has 3 children (LEFT div containing TierLadder AND
#   Capital block, main, aside).
#
# Pure ASCII. CRLF-aware.
#
# Usage:
#   .\fix-capital-layout.ps1          (dry run)
#   .\fix-capital-layout.ps1 -Apply   (write changes)
# =============================================================

param([switch]$Apply)

$ErrorActionPreference = 'Stop'
$file = 'app\invest\page.tsx'

if (-not (Test-Path $file)) {
  Write-Host "ERROR: $file not found. Run from repo root." -ForegroundColor Red
  exit 1
}

# Byte-exact read
$bytes   = [System.IO.File]::ReadAllBytes((Resolve-Path $file).Path)
$content = [System.Text.UTF8Encoding]::new($false).GetString($bytes)
$original = $content

$useCrlf = $content.Contains("`r`n")
$NL = if ($useCrlf) { "`r`n" } else { "`n" }
Write-Host "Detected line endings: $(if ($useCrlf) { 'CRLF' } else { 'LF' })" -ForegroundColor Cyan
Write-Host ""

# Sanity: confirm the broken state exists. We expect TWO sibling fl-show/fl-hide
# divs in the LEFT-column area (between fl-stage opening and the <main fl-center>).
$stageStartIdx = $content.IndexOf('<div className="fl-stage">')
if ($stageStartIdx -lt 0) {
  Write-Host "ERROR: <div className=`"fl-stage`"> not found." -ForegroundColor Red
  exit 1
}
$mainStartIdx = $content.IndexOf('<main className=`fl-center', $stageStartIdx)
if ($mainStartIdx -lt 0) {
  $mainStartIdx = $content.IndexOf('<main className={`fl-center', $stageStartIdx)
}
if ($mainStartIdx -lt 0) {
  Write-Host "ERROR: <main className=...fl-center> not found." -ForegroundColor Red
  exit 1
}
$leftArea = $content.Substring($stageStartIdx, $mainStartIdx - $stageStartIdx)
$siblingMarker = "<div className={mobileView === 'portfolio' ? 'fl-show' : 'fl-hide'}>"
$siblingCount = ([regex]::Matches($leftArea, [regex]::Escape($siblingMarker))).Count
Write-Host "Sibling fl-show/fl-hide divs in LEFT area: $siblingCount" -ForegroundColor Cyan
if ($siblingCount -eq 1) {
  Write-Host "Already fixed (1 sibling div). Nothing to do." -ForegroundColor Green
  exit 0
}
if ($siblingCount -ne 2) {
  Write-Host "ERROR: expected 2 sibling fl-show/fl-hide divs, found $siblingCount." -ForegroundColor Red
  exit 1
}

# Pattern: match the entire broken structure. The comment text contains
# non-ASCII chars (em-dash) so we wildcard the comment text with [^\r\n]*
# to avoid encoding issues.
$pattern = (
  "        \{/\* LEFT [^\r\n]* \*/\}\r?\n" +
  "        <div className=\{mobileView === 'portfolio' \? 'fl-show' : 'fl-hide'\}>\r?\n" +
  "          <TierLadder tiers=\{tiers\} tier=\{tier\} stats=\{stats\} value=\{value\} processTrend=\{data\.processTrend\} />\r?\n" +
  "        </div>\r?\n" +
  "\r?\n" +
  "        \{/\* Capital block[^\r\n]* \*/\}\r?\n" +
  "        <div className=\{mobileView === 'portfolio' \? 'fl-show' : 'fl-hide'\}>\r?\n" +
  '          <div className="fl-metric-block fl-capital-block" style=\{\{ marginTop: 12 \}\}>\r?\n' +
  '            <div className="fl-capital-row">\r?\n' +
  '              <span className="k">capital</span>\r?\n' +
  '              <button type="button" className="fl-capital-add-btn" onClick=\{\(\) => setAddCashOpen\(true\)\}>\r?\n' +
  "                \+ add\r?\n" +
  "              </button>\r?\n" +
  "            </div>\r?\n" +
  '            <div className="fl-capital-detail mono">\r?\n' +
  "              <span>starting</span>\r?\n" +
  '              <span>\$\{\(data\?\.journey\?\.starting_balance \?\? 0\)\.toFixed\(2\)\}</span>\r?\n' +
  "            </div>\r?\n" +
  "          </div>\r?\n" +
  "        </div>\r?\n"
)

$rx = [regex]::new($pattern, [System.Text.RegularExpressions.RegexOptions]::Singleline)
$matches = $rx.Matches($content)
if ($matches.Count -eq 0) {
  Write-Host "ERROR: pattern not found." -ForegroundColor Red
  exit 1
}
if ($matches.Count -gt 1) {
  Write-Host "ERROR: pattern matched $($matches.Count) times." -ForegroundColor Red
  exit 1
}

# Replacement - single LEFT column wrapper with both TierLadder and Capital block inside.
# Uses ASCII-only comment text to avoid encoding issues.
$lines = @(
  '        {/* LEFT - tier ladder + capital */}',
  "        <div className={mobileView === 'portfolio' ? 'fl-show' : 'fl-hide'}>",
  '          <TierLadder tiers={tiers} tier={tier} stats={stats} value={value} processTrend={data.processTrend} />',
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
)
$replacement = ($lines -join $NL)

$m = $matches[0]
$content = $content.Remove($m.Index, $m.Length).Insert($m.Index, $replacement)

Write-Host "  OK   collapsed sibling divs into one LEFT column wrapper" -ForegroundColor Green

# Re-verify the structure is correct
$stageStartIdx = $content.IndexOf('<div className="fl-stage">')
$mainStartIdx2 = $content.IndexOf('<main className={`fl-center', $stageStartIdx)
if ($mainStartIdx2 -lt 0) { $mainStartIdx2 = $content.IndexOf('<main className=`fl-center', $stageStartIdx) }
$leftArea2 = $content.Substring($stageStartIdx, $mainStartIdx2 - $stageStartIdx)
$siblingCount2 = ([regex]::Matches($leftArea2, [regex]::Escape($siblingMarker))).Count
Write-Host "  Sibling fl-show/fl-hide divs after fix: $siblingCount2 (target: 1)" -ForegroundColor Cyan

if ($siblingCount2 -ne 1) {
  Write-Host "ERROR: structure check failed after fix. Refusing to write." -ForegroundColor Red
  exit 1
}

# Sanity: TierLadder, Capital block, and the closing </div> for the LEFT column
# must all be in the right order.
$ladderIdx = $content.IndexOf('<TierLadder tiers')
$capitalIdx = $content.IndexOf('fl-capital-add-btn')
if ($ladderIdx -lt 0 -or $capitalIdx -lt 0) {
  Write-Host "ERROR: TierLadder or Capital block missing after fix." -ForegroundColor Red
  exit 1
}
if ($capitalIdx -lt $ladderIdx) {
  Write-Host "ERROR: Capital block comes before TierLadder. Refusing to write." -ForegroundColor Red
  exit 1
}

if ($content -eq $original) {
  Write-Host "No change after patch. Aborting." -ForegroundColor Yellow
  exit 0
}

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
