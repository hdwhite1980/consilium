# apply-all-themes.ps1
# Converts hardcoded dark-only styles to theme-aware CSS variables across ALL routes.
# Explicitly skips app/invest/ (user wants it to stay dark regardless).
#
# What it does in each file:
#   - Replaces hardcoded bg hex colors with var(--bg), var(--surface), etc.
#   - Replaces rgba(255,255,255,X) inline values with var(--textN) / var(--borderN)
#   - Leaves Tailwind text-white/XX classes alone (globals.css safety net handles those)
#   - Leaves brand accent colors alone (#a78bfa, #34d399, #f87171, #fbbf24, #60a5fa, etc.)
#
# Usage:
#   .\apply-all-themes.ps1          (dry run)
#   .\apply-all-themes.ps1 -Apply   (write changes)

param([switch]$Apply)

$ErrorActionPreference = 'Stop'

# All route-page files EXCEPT invest (user preference)
$files = @(
    'app\news\page.tsx'
    'app\tomorrow\page.tsx'
    'app\macro\page.tsx'
    'app\screener\page.tsx'
    'app\compare\page.tsx'
    'app\track-record\page.tsx'
    'app\portfolio\page.tsx'
    'app\reinvestment\page.tsx'
    'app\guide\page.tsx'
    'app\training\page.tsx'
    'app\subscribe\page.tsx'
    'app\components\OptionsRecommendations.tsx'
    'app\components\TechnicalCharts.tsx'
    'app\components\TutorialLauncher.tsx'
    'app\components\Tutorial.tsx'
    'app\components\PortfolioAlerts.tsx'
    'app\components\UpgradeGate.tsx'
)

# Order matters: most specific first
$transformations = @(
    # ---- Background colors ----
    @{ Find = "'#0a0d12'";  Replace = "'var(--bg)'";       Desc = 'bg hex' }
    @{ Find = "'#0d1117'";  Replace = "'var(--nav-bg)'";   Desc = 'nav-bg hex' }
    @{ Find = "'#111620'";  Replace = "'var(--surface)'";  Desc = 'surface hex' }
    @{ Find = "'#181e2a'";  Replace = "'var(--surface2)'"; Desc = 'surface2 hex' }
    @{ Find = "'#1e2535'";  Replace = "'var(--surface3)'"; Desc = 'surface3 hex' }
    @{ Find = "'#1a2236'";  Replace = "'var(--surface2)'"; Desc = 'settings surface2' }
    @{ Find = "'#0f1420'";  Replace = "'var(--bg)'";       Desc = 'dark-deep bg' }
    @{ Find = "'#0a0e17'";  Replace = "'var(--bg)'";       Desc = 'alt dark bg' }

    # ---- Inline text colors (rgba white to vars) ----
    @{ Find = "color: 'white'";                       Replace = "color: 'var(--text)'";   Desc = 'white -> --text' }
    @{ Find = "color: 'rgba(255,255,255,0.95)'";      Replace = "color: 'var(--text)'";   Desc = 'white 95' }
    @{ Find = "color: 'rgba(255,255,255,0.9)'";       Replace = "color: 'var(--text)'";   Desc = 'white 90' }
    @{ Find = "color: 'rgba(255,255,255,0.85)'";      Replace = "color: 'var(--text)'";   Desc = 'white 85' }
    @{ Find = "color: 'rgba(255,255,255,0.8)'";       Replace = "color: 'var(--text)'";   Desc = 'white 80' }
    @{ Find = "color: 'rgba(255,255,255,0.75)'";      Replace = "color: 'var(--text2)'";  Desc = 'white 75' }
    @{ Find = "color: 'rgba(255,255,255,0.7)'";       Replace = "color: 'var(--text2)'";  Desc = 'white 70' }
    @{ Find = "color: 'rgba(255,255,255,0.65)'";      Replace = "color: 'var(--text2)'";  Desc = 'white 65' }
    @{ Find = "color: 'rgba(255,255,255,0.6)'";       Replace = "color: 'var(--text2)'";  Desc = 'white 60' }
    @{ Find = "color: 'rgba(255,255,255,0.55)'";      Replace = "color: 'var(--text2)'";  Desc = 'white 55' }
    @{ Find = "color: 'rgba(255,255,255,0.5)'";       Replace = "color: 'var(--text3)'";  Desc = 'white 50' }
    @{ Find = "color: 'rgba(255,255,255,0.45)'";      Replace = "color: 'var(--text3)'";  Desc = 'white 45' }
    @{ Find = "color: 'rgba(255,255,255,0.4)'";       Replace = "color: 'var(--text3)'";  Desc = 'white 40' }
    @{ Find = "color: 'rgba(255,255,255,0.35)'";      Replace = "color: 'var(--text3)'";  Desc = 'white 35' }
    @{ Find = "color: 'rgba(255,255,255,0.3)'";       Replace = "color: 'var(--text3)'";  Desc = 'white 30' }
    @{ Find = "color: 'rgba(255,255,255,0.28)'";      Replace = "color: 'var(--text3)'";  Desc = 'white 28' }
    @{ Find = "color: 'rgba(255,255,255,0.25)'";      Replace = "color: 'var(--text3)'";  Desc = 'white 25' }
    @{ Find = "color: 'rgba(255,255,255,0.2)'";       Replace = "color: 'var(--text3)'";  Desc = 'white 20' }
    @{ Find = "color: 'rgba(255,255,255,0.15)'";      Replace = "color: 'var(--text3)'";  Desc = 'white 15' }

    # ---- Inline background rgba overlays ----
    @{ Find = "background: 'rgba(255,255,255,0.02)'"; Replace = "background: 'var(--surface2)'"; Desc = 'bg rgba 02' }
    @{ Find = "background: 'rgba(255,255,255,0.03)'"; Replace = "background: 'var(--surface2)'"; Desc = 'bg rgba 03' }
    @{ Find = "background: 'rgba(255,255,255,0.04)'"; Replace = "background: 'var(--surface2)'"; Desc = 'bg rgba 04' }
    @{ Find = "background: 'rgba(255,255,255,0.05)'"; Replace = "background: 'var(--surface2)'"; Desc = 'bg rgba 05' }
    @{ Find = "background: 'rgba(255,255,255,0.06)'"; Replace = "background: 'var(--surface2)'"; Desc = 'bg rgba 06' }

    # ---- Border colors ----
    @{ Find = "borderColor: 'rgba(255,255,255,0.05)'"; Replace = "borderColor: 'var(--border)'"; Desc = 'border 05' }
    @{ Find = "borderColor: 'rgba(255,255,255,0.06)'"; Replace = "borderColor: 'var(--border)'"; Desc = 'border 06' }
    @{ Find = "borderColor: 'rgba(255,255,255,0.07)'"; Replace = "borderColor: 'var(--border)'"; Desc = 'border 07' }
    @{ Find = "borderColor: 'rgba(255,255,255,0.08)'"; Replace = "borderColor: 'var(--border)'"; Desc = 'border 08' }
    @{ Find = "borderColor: 'rgba(255,255,255,0.1)'";  Replace = "borderColor: 'var(--border)'"; Desc = 'border 10' }
    @{ Find = "borderColor: 'rgba(255,255,255,0.13)'"; Replace = "borderColor: 'var(--border2)'"; Desc = 'border 13' }
    @{ Find = "borderColor: 'rgba(255,255,255,0.15)'"; Replace = "borderColor: 'var(--border2)'"; Desc = 'border 15' }
    @{ Find = "borderColor: 'rgba(255,255,255,0.2)'";  Replace = "borderColor: 'var(--border2)'"; Desc = 'border 20' }

    # ---- Backgrounds used as divider lines (w-px h-X) ----
    @{ Find = "background: 'rgba(255,255,255,0.1)'";  Replace = "background: 'var(--border)'";  Desc = 'bg 10 divider' }
    @{ Find = "background: 'rgba(255,255,255,0.08)'"; Replace = "background: 'var(--border)'";  Desc = 'bg 08 divider' }
    @{ Find = "background: 'rgba(255,255,255,0.07)'"; Replace = "background: 'var(--border)'";  Desc = 'bg 07 divider' }
)

$totalChanges = 0
$filesReport = @()

foreach ($file in $files) {
    if (-not (Test-Path $file)) {
        $filesReport += "  SKIP $file (not found)"
        continue
    }

    # Guard: make absolutely sure we're not hitting invest
    if ($file -like '*invest*') {
        $filesReport += "  SKIP $file (invest preserved)"
        continue
    }

    $path = (Resolve-Path $file).Path
    $content = [System.IO.File]::ReadAllText($path, [System.Text.UTF8Encoding]::new($false))
    $original = $content
    $fileHits = 0
    $ruleHits = @{}

    foreach ($t in $transformations) {
        $count = ([regex]::Matches($content, [regex]::Escape($t.Find))).Count
        if ($count -gt 0) {
            $content = $content.Replace($t.Find, $t.Replace)
            $fileHits += $count
            if ($ruleHits.ContainsKey($t.Desc)) {
                $ruleHits[$t.Desc] = $ruleHits[$t.Desc] + $count
            } else {
                $ruleHits[$t.Desc] = $count
            }
        }
    }

    if ($fileHits -eq 0) {
        $filesReport += "  $file : no changes"
        continue
    }

    $filesReport += "  $file : $fileHits changes"
    foreach ($desc in ($ruleHits.Keys | Sort-Object)) {
        $filesReport += "    $($ruleHits[$desc]) x $desc"
    }

    $totalChanges += $fileHits

    if ($Apply) {
        [System.IO.File]::WriteAllText($path, $content, [System.Text.UTF8Encoding]::new($false))
        $filesReport += "    WROTE"
    } else {
        $filesReport += "    (dry run)"
    }
}

if ($Apply) {
    Write-Host "Mode: APPLY" -ForegroundColor Green
} else {
    Write-Host "Mode: DRY RUN" -ForegroundColor Yellow
}
Write-Host ""

foreach ($line in $filesReport) {
    Write-Host $line
}

Write-Host ""
Write-Host "Total changes across all files: $totalChanges" -ForegroundColor Cyan
Write-Host "Excluded: app/invest/ (preserved as dark-only)" -ForegroundColor DarkGray

if (-not $Apply -and $totalChanges -gt 0) {
    Write-Host ""
    Write-Host "To apply: .\apply-all-themes.ps1 -Apply" -ForegroundColor White
}
