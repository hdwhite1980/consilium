# =============================================================
# patch-dashboard-nav.ps1
#
# Adds grouped dropdown nav (Discover, Positions) to the dashboard.
# Pure ASCII script. Uses bracket-counting to find code blocks
# instead of matching multi-line JSX text, which avoids all
# encoding issues with box-drawing characters in JSX comments.
#
# Adds Scanner / Watchlist / Options to navigation. Other items
# unchanged. Mobile drawer behavior preserved.
#
# Idempotent. Safe to re-run. Skips edits already applied.
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
# State detection
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

if ($hasChevron -and $hasUsePathname -and $hasNavTop -and $hasNavGroups -and $hasGroupOpenState -and $hasPathnameVar -and $hasNewNavRender) {
    Write-Host "Already fully patched. No changes needed." -ForegroundColor Yellow
    exit 0
}

# =============================================================
# EDIT 1: Add ChevronDown to lucide imports
# Strategy: find "ShieldCheck" then the next "} from 'lucide-react'"
# =============================================================
if (-not $hasChevron) {
    $marker = "ShieldCheck"
    $shieldIdx = $content.IndexOf($marker)
    if ($shieldIdx -lt 0) {
        Write-Error "Could not find ShieldCheck in lucide imports."
        exit 1
    }
    $closeIdx = $content.IndexOf("} from 'lucide-react'", $shieldIdx)
    if ($closeIdx -lt 0) {
        Write-Error "Could not find closing of lucide-react import."
        exit 1
    }
    # Insert ", ChevronDown" before the newline preceding "}"
    # Find the char position just after ShieldCheck text
    $after = $shieldIdx + $marker.Length
    # Slice from after up to closeIdx; this is the chunk between ShieldCheck and }
    $between = $content.Substring($after, $closeIdx - $after)
    # If $between is just whitespace + newline, we want to add ",\n  ChevronDown" right after ShieldCheck
    $newContent = $content.Substring(0, $after) + ",`n  ChevronDown" + $content.Substring($after)
    $content = $newContent
    Write-Host "  [1/5] Added ChevronDown to lucide imports" -ForegroundColor Green
}

# =============================================================
# EDIT 2: Add usePathname to next/navigation import
# =============================================================
if (-not $hasUsePathname) {
    $oldImp = "import { useRouter, useSearchParams } from 'next/navigation'"
    $newImp = "import { useRouter, useSearchParams, usePathname } from 'next/navigation'"
    if (-not $content.Contains($oldImp)) {
        Write-Error "Could not find next/navigation import."
        exit 1
    }
    $content = $content.Replace($oldImp, $newImp)
    Write-Host "  [2/5] Added usePathname to next/navigation import" -ForegroundColor Green
}

# =============================================================
# EDIT 3: Replace NAV_ITEMS array with NAV_TOP + NAV_GROUPS + flat NAV_ITEMS
# Strategy: find "const NAV_ITEMS:" line, find matching closing bracket
# =============================================================
if (-not $hasNavTop) {
    $startMarker = "const NAV_ITEMS: Array"
    $startIdx = $content.IndexOf($startMarker)
    if ($startIdx -lt 0) {
        Write-Error "Could not find NAV_ITEMS declaration."
        exit 1
    }
    # Find the opening '['
    $bracketStart = $content.IndexOf("[", $startIdx)
    if ($bracketStart -lt 0) {
        Write-Error "Could not find opening bracket of NAV_ITEMS array."
        exit 1
    }
    # Walk forward counting [ and ] until depth returns to 0
    $cursor = $bracketStart + 1
    $depth = 1
    $bracketEnd = -1
    while ($cursor -lt $content.Length -and $depth -gt 0) {
        $ch = $content[$cursor]
        if ($ch -eq '[') { $depth++ }
        elseif ($ch -eq ']') {
            $depth--
            if ($depth -eq 0) {
                $bracketEnd = $cursor
                break
            }
        }
        $cursor++
    }
    if ($bracketEnd -lt 0) {
        Write-Error "Could not find closing bracket of NAV_ITEMS array."
        exit 1
    }

    # Walk back from startIdx to find the start of the line (preserve indentation)
    $lineStart = $content.LastIndexOf("`n", $startIdx)
    if ($lineStart -lt 0) { $lineStart = 0 } else { $lineStart++ }

    # Replacement: from lineStart through bracketEnd (inclusive)
    $newNav = "  const NAV_TOP: Array<{ label: string; icon: React.ReactNode; path: string; color: string }> = [`n" +
              "    { label: 'Today',        icon: <Zap size={12} />,           path: '/news',         color: '#fbbf24' },`n" +
              "    { label: 'Tomorrow',     icon: <Calendar size={12} />,      path: '/tomorrow',     color: '#a78bfa' },`n" +
              "    { label: 'Invest',       icon: <Flame size={12} />,         path: '/invest',       color: '#f97316' },`n" +
              "    { label: 'Compare',      icon: <Scale size={12} />,         path: '/compare',      color: '#f87171' },`n" +
              "    { label: 'Track Record', icon: <Trophy size={12} />,        path: '/track-record', color: '#fbbf24' },`n" +
              "    { label: 'Guide',        icon: <BookOpen size={12} />,      path: '/guide',        color: txt3 },`n" +
              "  ]`n" +
              "`n" +
              "  const NAV_GROUPS: Array<{ label: string; icon: React.ReactNode; color: string; items: Array<{ label: string; icon: React.ReactNode; path: string; color: string }> }> = [`n" +
              "    {`n" +
              "      label: 'Discover',`n" +
              "      icon: <Search size={12} />,`n" +
              "      color: '#a78bfa',`n" +
              "      items: [`n" +
              "        { label: 'Screener', icon: <Search size={12} />,    path: '/screener', color: '#a78bfa' },`n" +
              "        { label: 'Scanner',  icon: <Target size={12} />,    path: '/scanner',  color: '#a78bfa' },`n" +
              "        { label: 'Options',  icon: <LineChart size={12} />, path: '/options',  color: '#fbbf24' },`n" +
              "        { label: 'Macro',    icon: <Globe size={12} />,     path: '/macro',    color: '#60a5fa' },`n" +
              "        { label: 'Altcoins', icon: <Coins size={12} />,     path: '/altcoins', color: '#a78bfa' },`n" +
              "      ],`n" +
              "    },`n" +
              "    {`n" +
              "      label: 'Positions',`n" +
              "      icon: <Briefcase size={12} />,`n" +
              "      color: '#34d399',`n" +
              "      items: [`n" +
              "        { label: 'Portfolio', icon: <Briefcase size={12} />,     path: '/portfolio', color: '#34d399' },`n" +
              "        { label: 'Watchlist', icon: <ClipboardList size={12} />, path: '/watchlist', color: '#60a5fa' },`n" +
              "      ],`n" +
              "    },`n" +
              "  ]`n" +
              "`n" +
              "  const NAV_ITEMS: Array<{ label: string; icon: React.ReactNode; path: string; color: string }> = [`n" +
              "    ...NAV_TOP.slice(0, 3),`n" +
              "    ...NAV_GROUPS.flatMap(g => g.items),`n" +
              "    ...NAV_TOP.slice(3),`n" +
              "  ]"

    $content = $content.Substring(0, $lineStart) + $newNav + $content.Substring($bracketEnd + 1)
    Write-Host "  [3/5] Replaced NAV_ITEMS with NAV_TOP + NAV_GROUPS + flat NAV_ITEMS" -ForegroundColor Green
}

# =============================================================
# EDIT 4: Add navGroupOpen state
# =============================================================
if (-not $hasGroupOpenState) {
    $oldState = "  const [navOpen, setNavOpen] = useState(false)"
    $newState = "  const [navOpen, setNavOpen] = useState(false)`n  const [navGroupOpen, setNavGroupOpen] = useState<string | null>(null)"
    if (-not $content.Contains($oldState)) {
        Write-Error "Could not find navOpen state declaration."
        exit 1
    }
    $content = $content.Replace($oldState, $newState)
    Write-Host "  [4/5] Added navGroupOpen state" -ForegroundColor Green
}

# =============================================================
# EDIT 5: Add pathname variable
# =============================================================
if (-not $hasPathnameVar) {
    $oldRouter = "  const router = useRouter()"
    $newRouter = "  const router = useRouter()`n  const pathname = usePathname()"
    if (-not $content.Contains($oldRouter)) {
        Write-Error "Could not find router declaration."
        exit 1
    }
    $content = $content.Replace($oldRouter, $newRouter)
    Write-Host "  [5/5] Added pathname variable" -ForegroundColor Green
}

# =============================================================
# EDIT 6: Replace desktop nav render block
# Strategy: locate <div className="hidden xl:flex ..."> via unique ASCII
# anchor, find matching </div> via depth counting.
# =============================================================
if (-not $hasNewNavRender) {
    $startMarker = '<div className="hidden xl:flex items-center gap-1 px-3 pb-2 pt-0">'
    $startIdx = $content.IndexOf($startMarker)
    if ($startIdx -lt 0) {
        Write-Error "Could not find desktop nav <div> opening tag."
        exit 1
    }

    # Walk forward, tag-aware
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
                $closingIdx = $closeIdx + 6
                break
            }
            $cursor = $closeIdx + 6
        }
    }

    if ($closingIdx -lt 0) {
        Write-Error "Could not find matching </div> for desktop nav block."
        exit 1
    }

    # Determine where to start the replacement (include preceding JSX comment line if it looks like ours)
    $lineStart = $content.LastIndexOf("`n", $startIdx)
    if ($lineStart -lt 0) { $lineStart = 0 } else { $lineStart++ }
    $prevLineStart = $content.LastIndexOf("`n", $lineStart - 2)
    if ($prevLineStart -lt 0) { $prevLineStart = 0 } else { $prevLineStart++ }
    $commentLine = $content.Substring($prevLineStart, $lineStart - $prevLineStart)
    $includeComment = $commentLine -match 'Row 2|desktop nav'
    $replaceStart = if ($includeComment) { $prevLineStart } else { $lineStart }

    # Build new block (verbatim string, NO PowerShell escape interpolation needed)
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
    Write-Host "  [6/6] Replaced desktop nav with grouped dropdowns" -ForegroundColor Green
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
Write-Host "Dashboard nav patched successfully." -ForegroundColor Green
Write-Host ""
Write-Host "Desktop nav (xl+):" -ForegroundColor Cyan
Write-Host "  Today | Tomorrow | Invest | Discover[v] | Positions[v] | Compare | Track Record | Guide"
Write-Host ""
Write-Host "  Discover  : Screener, Scanner, Options, Macro, Altcoins"
Write-Host "  Positions : Portfolio, Watchlist"
Write-Host ""
Write-Host "Mobile drawer (below xl): unchanged flat list of all 11 items."
