# =============================================================
# patch-dashboard-nav.ps1
#
# Adds Scanner / Watchlist / Options to the dashboard nav,
# reorganized as grouped dropdowns on desktop (xl:) with flat
# mobile drawer behavior preserved.
#
# Desktop (xl+): [Today] [Tomorrow] [Invest] [Discover v] [Positions v]
#                [Compare] [Track Record] [Guide]
#
#   Discover v : Screener, Scanner, Options, Macro, Altcoins
#   Positions v: Portfolio, Watchlist
#
# Mobile drawer (below xl): flat list of all 12 items - unchanged UX
#
# Idempotent. Safe to re-run. Aborts cleanly if anchors don't match.
# =============================================================

$ErrorActionPreference = 'Stop'

$DashboardPath = ".\app\page.tsx"

if (-not (Test-Path $DashboardPath)) {
    Write-Error "Dashboard file not found at $DashboardPath"
    exit 1
}

Write-Host "Reading $DashboardPath..."
$content = Get-Content $DashboardPath -Raw

# Normalize line endings to LF for reliable string matching.
# We'll preserve the original line-ending style when writing back.
$originalHadCrlf = $content.Contains("`r`n")
if ($originalHadCrlf) {
    Write-Host "  (file uses CRLF line endings - normalizing for patch)" -ForegroundColor DarkGray
    $content = $content -replace "`r`n", "`n"
}

# Idempotency
if ($content -match "NAV_GROUPS" -and $content -match "navGroupOpen") {
    Write-Host "Already patched. No changes made." -ForegroundColor Yellow
    exit 0
}

# =============================================================
# EDIT 1: Add ChevronDown + Target to lucide imports
# (Target for Scanner icon, ChevronDown for dropdown arrow)
# Target is already in the imports - check first
# =============================================================
$oldImport = @"
import {
  TrendingUp, TrendingDown, Minus, Clock, AlertTriangle,
  BarChart2, Globe, DollarSign, Activity, Shield, Zap, LogOut, BookOpen,
  Sun, Moon, Menu, X, Calendar, Flame, Briefcase, Search, Trophy,
  Scale, LineChart, PieChart, Hourglass, RotateCw, Check, Target,
  Star, ClipboardList, Wallet, RefreshCw, FileText, Coins, ShieldCheck
} from 'lucide-react'
"@

$newImport = @"
import {
  TrendingUp, TrendingDown, Minus, Clock, AlertTriangle,
  BarChart2, Globe, DollarSign, Activity, Shield, Zap, LogOut, BookOpen,
  Sun, Moon, Menu, X, Calendar, Flame, Briefcase, Search, Trophy,
  Scale, LineChart, PieChart, Hourglass, RotateCw, Check, Target,
  Star, ClipboardList, Wallet, RefreshCw, FileText, Coins, ShieldCheck,
  ChevronDown
} from 'lucide-react'
"@

if (-not $content.Contains($oldImport)) {
    Write-Error "Could not find expected lucide-react import block. File may have changed."
    exit 1
}
$content = $content.Replace($oldImport, $newImport)
Write-Host "  [1/5] Added ChevronDown to lucide imports" -ForegroundColor Green


# =============================================================
# EDIT 2: Add usePathname to next/navigation import
# =============================================================
$oldNavImport = "import { useRouter, useSearchParams } from 'next/navigation'"
$newNavImport = "import { useRouter, useSearchParams, usePathname } from 'next/navigation'"

if (-not $content.Contains($oldNavImport)) {
    Write-Error "Could not find next/navigation import."
    exit 1
}
$content = $content.Replace($oldNavImport, $newNavImport)
Write-Host "  [2/5] Added usePathname to next/navigation import" -ForegroundColor Green


# =============================================================
# EDIT 3: Replace NAV_ITEMS with NAV_TOP + NAV_GROUPS + flat NAV_ITEMS
# =============================================================
$oldNav = @"
  const NAV_ITEMS: Array<{ label: string; icon: React.ReactNode; path: string; color: string }> = [
    { label: 'Today',        icon: <Zap size={12} />,           path: '/news',         color: '#fbbf24' },
    { label: 'Tomorrow',     icon: <Calendar size={12} />,      path: '/tomorrow',     color: '#a78bfa' },
    { label: 'Invest',       icon: <Flame size={12} />,         path: '/invest',       color: '#f97316' },
    { label: 'Portfolio',    icon: <Briefcase size={12} />,     path: '/portfolio',    color: '#34d399' },
    { label: 'Macro',        icon: <Globe size={12} />,         path: '/macro',        color: '#60a5fa' },
    { label: 'Altcoins',     icon: <Coins size={12} />,         path: '/altcoins',     color: '#a78bfa' },
    { label: 'Screener',     icon: <Search size={12} />,        path: '/screener',     color: '#a78bfa' },
    { label: 'Compare',      icon: <Scale size={12} />,         path: '/compare',      color: '#f87171' },
    { label: 'Track Record', icon: <Trophy size={12} />,        path: '/track-record', color: '#fbbf24' },
    { label: 'Guide',        icon: <BookOpen size={12} />,      path: '/guide',        color: txt3 },
  ]
"@

$newNav = @"
  // Always-visible top-level nav items (high-frequency actions + utilities)
  const NAV_TOP: Array<{ label: string; icon: React.ReactNode; path: string; color: string }> = [
    { label: 'Today',        icon: <Zap size={12} />,           path: '/news',         color: '#fbbf24' },
    { label: 'Tomorrow',     icon: <Calendar size={12} />,      path: '/tomorrow',     color: '#a78bfa' },
    { label: 'Invest',       icon: <Flame size={12} />,         path: '/invest',       color: '#f97316' },
    { label: 'Compare',      icon: <Scale size={12} />,         path: '/compare',      color: '#f87171' },
    { label: 'Track Record', icon: <Trophy size={12} />,        path: '/track-record', color: '#fbbf24' },
    { label: 'Guide',        icon: <BookOpen size={12} />,      path: '/guide',        color: txt3 },
  ]

  // Dropdown groups for desktop nav (collapsed on mobile)
  const NAV_GROUPS: Array<{ label: string; icon: React.ReactNode; color: string; items: Array<{ label: string; icon: React.ReactNode; path: string; color: string }> }> = [
    {
      label: 'Discover',
      icon: <Search size={12} />,
      color: '#a78bfa',
      items: [
        { label: 'Screener',  icon: <Search size={12} />,   path: '/screener',  color: '#a78bfa' },
        { label: 'Scanner',   icon: <Target size={12} />,   path: '/scanner',   color: '#a78bfa' },
        { label: 'Options',   icon: <LineChart size={12} />, path: '/options',   color: '#fbbf24' },
        { label: 'Macro',     icon: <Globe size={12} />,    path: '/macro',     color: '#60a5fa' },
        { label: 'Altcoins',  icon: <Coins size={12} />,    path: '/altcoins',  color: '#a78bfa' },
      ],
    },
    {
      label: 'Positions',
      icon: <Briefcase size={12} />,
      color: '#34d399',
      items: [
        { label: 'Portfolio', icon: <Briefcase size={12} />,     path: '/portfolio', color: '#34d399' },
        { label: 'Watchlist', icon: <ClipboardList size={12} />, path: '/watchlist', color: '#60a5fa' },
      ],
    },
  ]

  // Flattened list for mobile drawer - preserves original ordering intent:
  // primary actions, then grouped items inline, then utilities.
  const NAV_ITEMS: Array<{ label: string; icon: React.ReactNode; path: string; color: string }> = [
    ...NAV_TOP.slice(0, 3),                    // Today, Tomorrow, Invest
    ...NAV_GROUPS.flatMap(g => g.items),       // Screener, Scanner, Options, Macro, Altcoins, Portfolio, Watchlist
    ...NAV_TOP.slice(3),                       // Compare, Track Record, Guide
  ]
"@

if (-not $content.Contains($oldNav)) {
    Write-Error "Could not find expected NAV_ITEMS block. File diverged from expected version."
    exit 1
}
$content = $content.Replace($oldNav, $newNav)
Write-Host "  [3/5] Replaced NAV_ITEMS with NAV_TOP + NAV_GROUPS + flat NAV_ITEMS" -ForegroundColor Green


# =============================================================
# EDIT 4: Replace desktop nav render with grouped version
# Anchor is the Row 2 desktop nav that uses `hidden xl:flex`
# =============================================================
$oldDesktopNav = @"
        {/* ── Row 2 (xl+): desktop nav links inline ── */}
        <div className="hidden xl:flex items-center gap-1 px-3 pb-2 pt-0">
          {NAV_ITEMS.map(n => (
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
"@

$newDesktopNav = @"
        {/* ── Row 2 (xl+): desktop nav with top-level buttons + dropdown groups ── */}
        <div className="hidden xl:flex items-center gap-1 px-3 pb-2 pt-0">
          {/* First 3 always-visible items: Today, Tomorrow, Invest */}
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

          {/* Dropdown groups */}
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

          {/* Remaining always-visible items: Compare, Track Record, Guide */}
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
"@

if (-not $content.Contains($oldDesktopNav)) {
    Write-Error "Could not find expected desktop nav render block (Row 2 xl+)."
    exit 1
}
$content = $content.Replace($oldDesktopNav, $newDesktopNav)
Write-Host "  [4/5] Replaced desktop nav with grouped dropdowns" -ForegroundColor Green


# =============================================================
# EDIT 5: Add navGroupOpen state + pathname variable
# =============================================================
$oldState = "  const [navOpen, setNavOpen] = useState(false)"
$newState = @"
  const [navOpen, setNavOpen] = useState(false)
  const [navGroupOpen, setNavGroupOpen] = useState<string | null>(null)
"@

if (-not $content.Contains($oldState)) {
    Write-Error "Could not find navOpen state declaration."
    exit 1
}
$content = $content.Replace($oldState, $newState)

# Add pathname hook call near router
$oldRouter = "  const router = useRouter()"
$newRouter = @"
  const router = useRouter()
  const pathname = usePathname()
"@

if (-not $content.Contains($oldRouter)) {
    Write-Error "Could not find useRouter() call."
    exit 1
}
$content = $content.Replace($oldRouter, $newRouter)
Write-Host "  [5/5] Added navGroupOpen state + pathname variable" -ForegroundColor Green


# =============================================================
# Write back with UTF-8 no BOM, preserving original line endings
# =============================================================
if ($originalHadCrlf) {
    $content = $content -replace "`n", "`r`n"
    Write-Host "  (converted back to CRLF to match original file)" -ForegroundColor DarkGray
}

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText((Resolve-Path $DashboardPath).Path, $content, $utf8NoBom)

Write-Host ""
Write-Host "[OK] Dashboard nav patched successfully." -ForegroundColor Green
Write-Host ""
Write-Host "Desktop nav (xl+):" -ForegroundColor Cyan
Write-Host "  [Today] [Tomorrow] [Invest] [Discover v] [Positions v] [Compare] [Track Record] [Guide]"
Write-Host ""
Write-Host "  Discover v  : Screener, Scanner, Options, Macro, Altcoins"
Write-Host "  Positions v : Portfolio, Watchlist"
Write-Host ""
Write-Host "Mobile / tablet drawer (below xl): flat list of all 11 items - preserves previous UX."
Write-Host ""
Write-Host "Dropdowns:"
Write-Host "  - Open on hover (desktop) or click"
Write-Host "  - Close when mouse leaves"
Write-Host "  - Active group button highlighted when on a child page"
Write-Host "  - ChevronDown rotates 180 deg when open"
Write-Host "  - ARIA roles (menu, menuitem) and aria-expanded for screen readers"
