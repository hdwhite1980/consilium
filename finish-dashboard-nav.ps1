# =============================================================
# finish-dashboard-nav.ps1
#
# Completes the dashboard nav refactor. Edits 1-3 already succeeded
# in your earlier run (ChevronDown imported, usePathname imported,
# NAV_TOP and NAV_GROUPS defined). This script applies edits 4 and 5
# (desktop nav render + state) using PURE ASCII anchors only.
#
# It uses a bracket-counting approach to locate the desktop nav <div>
# block instead of matching exact JSX text, which avoids all encoding
# issues with box-drawing characters in the JSX comments.
#
# Idempotent. Safe to re-run. Only completes what's missing.
# =============================================================

$ErrorActionPreference = 'Stop'

$DashboardPath = ".\app\page.tsx"

if (-not (Test-Path $DashboardPath)) {
    Write-Error "Dashboard file not found at $DashboardPath"
    exit 1
}

Write-Host "Reading $DashboardPath..."
$content = Get-Content $DashboardPath -Raw

# Normalize CRLF -> LF for matching
$originalHadCrlf = $content.Contains("`r`n")
if ($originalHadCrlf) {
    Write-Host "  (normalizing CRLF -> LF for patch)" -ForegroundColor DarkGray
    $content = $content -replace "`r`n", "`n"
}

# =============================================================
# State check: which edits already succeeded?
# =============================================================
$hasChevron       = $content -match "ChevronDown\s*\n?\s*}\s*from 'lucide-react'"
$hasUsePathname   = $content.Contains("usePathname } from 'next/navigation'")
$hasNavTop        = $content.Contains("const NAV_TOP")
$hasNavGroups     = $content.Contains("const NAV_GROUPS")
$hasGroupOpenState= $content.Contains("navGroupOpen")
$hasPathnameVar   = $content -match "const pathname = usePathname\(\)"
$hasNewNavRender  = $content -match "NAV_GROUPS\.map\(group =>"

Write-Host ""
Write-Host "Current state:" -ForegroundColor Cyan
Write-Host "  ChevronDown imported: $(if ($hasChevron) { '[OK]' } else { '[MISSING]' })"
Write-Host "  usePathname imported: $(if ($hasUsePathname) { '[OK]' } else { '[MISSING]' })"
Write-Host "  NAV_TOP defined:      $(if ($hasNavTop) { '[OK]' } else { '[MISSING]' })"
Write-Host "  NAV_GROUPS defined:   $(if ($hasNavGroups) { '[OK]' } else { '[MISSING]' })"
Write-Host "  navGroupOpen state:   $(if ($hasGroupOpenState) { '[OK]' } else { '[MISSING]' })"
Write-Host "  pathname variable:    $(if ($hasPathnameVar) { '[OK]' } else { '[MISSING]' })"
Write-Host "  New desktop nav:      $(if ($hasNewNavRender) { '[OK]' } else { '[MISSING]' })"
Write-Host ""

# Already fully patched?
if ($hasGroupOpenState -and $hasNewNavRender -and $hasPathnameVar) {
    Write-Host "Already fully patched. No changes needed." -ForegroundColor Yellow
    exit 0
}

# Edits 1-3 must have succeeded for this finishing patch to make sense
if (-not ($hasChevron -and $hasUsePathname -and $hasNavTop -and $hasNavGroups)) {
    Write-Error "Edits 1-3 did not all succeed. Cannot apply finishing patch. Revert with 'git checkout -- app/page.tsx' and start over."
    exit 1
}

# =============================================================
# EDIT 5a (apply first to avoid re-finding indices): Add navGroupOpen state
# =============================================================
if (-not $hasGroupOpenState) {
    $oldState = "  const [navOpen, setNavOpen] = useState(false)"
    $newState = "  const [navOpen, setNavOpen] = useState(false)" + "`n" + "  const [navGroupOpen, setNavGroupOpen] = useState<string | null>(null)"

    if (-not $content.Contains($oldState)) {
        Write-Error "Could not find navOpen state declaration anchor."
        exit 1
    }
    $content = $content.Replace($oldState, $newState)
    Write-Host "  [a] Added navGroupOpen state" -ForegroundColor Green
}

# =============================================================
# EDIT 5b: Add pathname variable
# =============================================================
if (-not $hasPathnameVar) {
    $oldRouter = "  const router = useRouter()"
    $newRouter = "  const router = useRouter()" + "`n" + "  const pathname = usePathname()"

    if (-not $content.Contains($oldRouter)) {
        Write-Error "Could not find router declaration anchor."
        exit 1
    }
    $content = $content.Replace($oldRouter, $newRouter)
    Write-Host "  [b] Added pathname variable" -ForegroundColor Green
}

# =============================================================
# EDIT 4: Replace desktop nav render
# Strategy: locate the <div className="hidden xl:flex ..."> block
# (unique substring "hidden xl:flex items-center gap-1 px-3 pb-2 pt-0")
# then find its matching </div> by walking forward and counting <div>/</div>
# tags. Replace the entire block with our new content.
# =============================================================
if (-not $hasNewNavRender) {
    # Find the start of the desktop nav <div>
    $startMarker = '<div className="hidden xl:flex items-center gap-1 px-3 pb-2 pt-0">'
    $startIdx = $content.IndexOf($startMarker)
    if ($startIdx -lt 0) {
        Write-Error "Could not find desktop nav <div> opening tag."
        exit 1
    }

    # Walk forward from there counting <div opens and </div> closes
    # until depth returns to 0. The </div> that takes us to 0 is the closer.
    $cursor = $startIdx + $startMarker.Length
    $depth = 1
    $closingIdx = -1
    while ($cursor -lt $content.Length -and $depth -gt 0) {
        $openIdx  = $content.IndexOf('<div',  $cursor)
        $closeIdx = $content.IndexOf('</div>', $cursor)

        if ($closeIdx -lt 0) { break }

        if ($openIdx -ge 0 -and $openIdx -lt $closeIdx) {
            $depth++
            $cursor = $openIdx + 4
        } else {
            $depth--
            if ($depth -eq 0) {
                $closingIdx = $closeIdx + 6  # length of "</div>"
                break
            }
            $cursor = $closeIdx + 6
        }
    }

    if ($closingIdx -lt 0) {
        Write-Error "Could not find matching </div> for desktop nav block."
        exit 1
    }

    # The full block to replace is from startIdx to closingIdx
    # Walk back to include leading whitespace + the JSX comment line above
    # by finding the start of the line containing $startIdx
    $lineStart = $content.LastIndexOf("`n", $startIdx)
    if ($lineStart -lt 0) { $lineStart = 0 } else { $lineStart++ }
    # Actually go one line further back to include the JSX comment "{/* ... Row 2 ... */}"
    $prevLineStart = $content.LastIndexOf("`n", $lineStart - 2)
    if ($prevLineStart -lt 0) { $prevLineStart = 0 } else { $prevLineStart++ }
    $commentLine = $content.Substring($prevLineStart, $lineStart - $prevLineStart)
    $includeComment = $commentLine -match 'Row 2|desktop nav'
    $replaceStart = if ($includeComment) { $prevLineStart } else { $lineStart }

    $oldBlock = $content.Substring($replaceStart, $closingIdx - $replaceStart)

    # Build the new block
    $newBlock = @'
        {/* Row 2 (xl+): desktop nav with top-level buttons + dropdown groups */}
        <div className="hidden xl:flex items-center gap-1 px-3 pb-2 pt-0">
          {NAV_TOP.slice(0, 3).map(n => (
            <button
              key={n.path}
              type="button"
              onClick={() => router.push(n.path)}
              aria-label={`Go to ${n.label}`}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold transition-all hover:opacity-80 focus:outline focus:outline-2 focus:outline-offset-1"
              style={{ color: n.color, background: `${n.color}10`, border: `1px solid ${n.color}20`, outlineColor: n.color }}>
              <span className="text-[11px]" aria-hidden="true">{n.icon}</span>
              <span>{n.label}</span>
            </button>
          ))}
          {NAV_GROUPS.map(group => {
            const isOpen = navGroupOpen === group.label
            const isActive = group.items.some(item => pathname === item.path)
            return (
              <div
                key={group.label}
                className="relative"
                onMouseEnter={() => setNavGroupOpen(group.label)}
                onMouseLeave={() => setNavGroupOpen(null)}>
                <button
                  type="button"
                  onClick={() => setNavGroupOpen(isOpen ? null : group.label)}
                  aria-haspopup="menu"
                  aria-expanded={isOpen}
                  aria-label={`${group.label} menu`}
                  className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold transition-all hover:opacity-80 focus:outline focus:outline-2 focus:outline-offset-1"
                  style={{
                    color: group.color,
                    background: isActive ? `${group.color}18` : `${group.color}10`,
                    border: `1px solid ${isActive ? group.color + '40' : group.color + '20'}`,
                    outlineColor: group.color,
                  }}>
                  <span className="text-[11px]" aria-hidden="true">{group.icon}</span>
                  <span>{group.label}</span>
                  <ChevronDown
                    size={10}
                    className={'transition-transform ' + (isOpen ? 'rotate-180' : '')}
                    aria-hidden="true" />
                </button>
                {isOpen && (
                  <div
                    role="menu"
                    aria-label={`${group.label} submenu`}
                    className="absolute top-full left-0 mt-1 py-1 rounded-lg shadow-lg z-50 min-w-[170px]"
                    style={{ background: surf, border: `1px solid ` + brd }}>
                    {group.items.map(item => (
                      <button
                        key={item.path}
                        type="button"
                        role="menuitem"
                        onClick={() => { router.push(item.path); setNavGroupOpen(null) }}
                        aria-label={`Go to ${item.label}`}
                        className="w-full flex items-center gap-2 px-3 py-2 text-xs font-semibold transition-all hover:opacity-80 text-left focus:outline focus:outline-2 focus:outline-offset-1"
                        style={{
                          color: item.color,
                          background: pathname === item.path ? `${item.color}15` : 'transparent',
                          outlineColor: item.color,
                        }}>
                        <span className="text-[11px]" aria-hidden="true">{item.icon}</span>
                        <span>{item.label}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
          {NAV_TOP.slice(3).map(n => (
            <button
              key={n.path}
              type="button"
              onClick={() => router.push(n.path)}
              aria-label={`Go to ${n.label}`}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold transition-all hover:opacity-80 focus:outline focus:outline-2 focus:outline-offset-1"
              style={{ color: n.color, background: `${n.color}10`, border: `1px solid ${n.color}20`, outlineColor: n.color }}>
              <span className="text-[11px]" aria-hidden="true">{n.icon}</span>
              <span>{n.label}</span>
            </button>
          ))}
          <TutorialLauncher tutorialId="main" />
        </div>
'@

    $content = $content.Substring(0, $replaceStart) + $newBlock + $content.Substring($closingIdx)
    Write-Host "  [c] Replaced desktop nav block with grouped dropdowns" -ForegroundColor Green
}

# =============================================================
# Write back, restoring original line endings
# =============================================================
if ($originalHadCrlf) {
    $content = $content -replace "`n", "`r`n"
    Write-Host "  (converted back to CRLF)" -ForegroundColor DarkGray
}

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText((Resolve-Path $DashboardPath).Path, $content, $utf8NoBom)

Write-Host ""
Write-Host "Dashboard nav patch complete." -ForegroundColor Green
Write-Host ""
Write-Host "Desktop nav (xl+):" -ForegroundColor Cyan
Write-Host "  Today | Tomorrow | Invest | Discover[v] | Positions[v] | Compare | Track Record | Guide"
Write-Host ""
Write-Host "  Discover  : Screener, Scanner, Options, Macro, Altcoins"
Write-Host "  Positions : Portfolio, Watchlist"
Write-Host ""
Write-Host "Mobile drawer (below xl): unchanged flat list."
