# apply-theme-aware.ps1
# Converts hardcoded dark-only colors to theme-aware CSS variables
# across specified component files.
#
# Transforms applied:
#   text-white/XX          -> [inline style color: var(--textN)]
#   text-white             -> style color: var(--text)
#   rgba(255,255,255,X)    -> var(--textN) or var(--borderN) based on context
#   #0a0d12/#0d1117        -> var(--bg)
#   #111620                -> var(--surface)
#   #181e2a                -> var(--surface2)
#
# Usage:
#   .\apply-theme-aware.ps1           (dry run)
#   .\apply-theme-aware.ps1 -Apply    (write changes)

param([switch]$Apply)

$ErrorActionPreference = 'Stop'

$files = @(
    'app\components\OptionsRecommendations.tsx'
    'app\components\TechnicalCharts.tsx'
    'app\components\TutorialLauncher.tsx'
    'app\components\Tutorial.tsx'
)

# ---- Transformation rules ----
# Order matters: more specific patterns first.
#
# We treat these alpha levels:
#   0.9, 0.8, 0.85, 0.75   -> text  (primary)
#   0.7, 0.65, 0.6, 0.55   -> text2 (secondary body)
#   0.5, 0.4, 0.45         -> text3 (tertiary)
#   0.3, 0.25, 0.2, 0.15, 0.1, 0.08, 0.07, 0.06, 0.05, 0.04, 0.03, 0.02, 0.01
#                          -> border (subtle)

$transformations = @(
    # --- Tailwind text-white opacity classes ---
    # Replace text-white/XX with var-based inline style via attribute trick:
    # Simplest approach: convert them to plain text-current and add style in parent.
    # But that requires knowing context. Instead we rely on the fact that
    # text-white/XX are all used on dark bgs, so we convert to theme-aware.
    # We do a mechanical replace to className:  text-white/X  ->  t-text-white-X
    # Then define t-text-white-X classes in globals.css as theme-aware.

    # Actually the cleanest approach: turn them into CSS-var-based inline styles.
    # Since Tailwind text-white/XX compiles to color: rgb(255 255 255 / XX%),
    # which is DARK-MODE-ONLY, we replace with var(--textN) via pattern matching
    # on the CONTAINER.

    # Rule: any className="...text-white/XX..." becomes className="..." style={{ color: 'var(--textN)' }}
    # But that needs JSX-aware parsing. Too complex for regex.

    # Practical alternative: patch globals.css to add overrides that make
    # text-white/XX theme-aware via CSS variables.

    # ==== The approach we actually take ====
    # We patch globals.css with new rules that override text-white/XX in light mode.
    # The component files stay as-is. See companion script: apply-theme-css-overrides.ps1

    # This script instead handles the easier rgba-in-inline-style cases:

    # rgba white overlays used as backgrounds
    @{
        Find    = "'rgba(255,255,255,0.02)'"
        Replace = "'var(--surface2)'"
        Desc    = 'ultra-subtle bg -> surface2'
    }
    @{
        Find    = "'rgba(255,255,255,0.04)'"
        Replace = "'var(--surface2)'"
        Desc    = 'subtle bg -> surface2'
    }
    @{
        Find    = "'rgba(255,255,255,0.06)'"
        Replace = "'var(--surface2)'"
        Desc    = 'subtle bg -> surface2'
    }
    @{
        Find    = "'rgba(255,255,255,0.08)'"
        Replace = "'var(--border)'"
        Desc    = 'border-ish -> border var'
    }

    # rgba white text overlays
    @{
        Find    = "color: 'rgba(255,255,255,0.9)'"
        Replace = "color: 'var(--text)'"
        Desc    = 'text 0.9 -> --text'
    }
    @{
        Find    = "color: 'rgba(255,255,255,0.8)'"
        Replace = "color: 'var(--text)'"
        Desc    = 'text 0.8 -> --text'
    }
    @{
        Find    = "color: 'rgba(255,255,255,0.7)'"
        Replace = "color: 'var(--text2)'"
        Desc    = 'text 0.7 -> --text2'
    }
    @{
        Find    = "color: 'rgba(255,255,255,0.65)'"
        Replace = "color: 'var(--text2)'"
        Desc    = 'text 0.65 -> --text2'
    }
    @{
        Find    = "color: 'rgba(255,255,255,0.6)'"
        Replace = "color: 'var(--text2)'"
        Desc    = 'text 0.6 -> --text2'
    }
    @{
        Find    = "color: 'rgba(255,255,255,0.55)'"
        Replace = "color: 'var(--text2)'"
        Desc    = 'text 0.55 -> --text2'
    }
    @{
        Find    = "color: 'rgba(255,255,255,0.5)'"
        Replace = "color: 'var(--text3)'"
        Desc    = 'text 0.5 -> --text3'
    }
    @{
        Find    = "color: 'rgba(255,255,255,0.4)'"
        Replace = "color: 'var(--text3)'"
        Desc    = 'text 0.4 -> --text3'
    }
    @{
        Find    = "color: 'rgba(255,255,255,0.3)'"
        Replace = "color: 'var(--text3)'"
        Desc    = 'text 0.3 -> --text3'
    }
    @{
        Find    = "color: 'rgba(255,255,255,0.25)'"
        Replace = "color: 'var(--text3)'"
        Desc    = 'text 0.25 -> --text3'
    }
    @{
        Find    = "color: 'rgba(255,255,255,0.2)'"
        Replace = "color: 'var(--text3)'"
        Desc    = 'text 0.2 -> --text3'
    }
    @{
        Find    = "color: 'rgba(255,255,255,0.15)'"
        Replace = "color: 'var(--text3)'"
        Desc    = 'text 0.15 -> --text3'
    }

    # Hardcoded dark backgrounds in components
    @{
        Find    = "'#0a0d12'"
        Replace = "'var(--bg)'"
        Desc    = 'dark bg hex -> var'
    }
    @{
        Find    = "'#0d1117'"
        Replace = "'var(--bg)'"
        Desc    = 'dark nav bg -> var'
    }
    @{
        Find    = "'#111620'"
        Replace = "'var(--surface)'"
        Desc    = 'dark surface -> var'
    }
    @{
        Find    = "'#181e2a'"
        Replace = "'var(--surface2)'"
        Desc    = 'dark surface2 -> var'
    }
    @{
        Find    = "'#1e2535'"
        Replace = "'var(--surface3)'"
        Desc    = 'dark surface3 -> var'
    }
)

# ---- Tailwind class transformations ----
# Maps text-white/XX Tailwind utility to a replacement that works in both themes.
# We replace with a custom class defined in globals.css (t-text2, t-text3, etc.)
$tailwindMap = @{
    'text-white/90'        = 't-text'
    'text-white/80'        = 't-text'
    'text-white/75'        = 't-text'
    'text-white/70'        = 't-text2'
    'text-white/65'        = 't-text2'
    'text-white/60'        = 't-text2'
    'text-white/55'        = 't-text2'
    'text-white/50'        = 't-text3'
    'text-white/45'        = 't-text3'
    'text-white/40'        = 't-text3'
    'text-white/35'        = 't-text3'
    'text-white/30'        = 't-text3'
    'text-white/25'        = 't-text3'
    'text-white/20'        = 't-text3'
    'text-white/15'        = 't-text3'
    'text-white/10'        = 't-text3'
    'text-white'           = 't-text'
}

$totalChanges = 0
$fileReports = @()

foreach ($file in $files) {
    if (-not (Test-Path $file)) {
        $fileReports += "  SKIP $file (not found)"
        continue
    }

    $path = (Resolve-Path $file).Path
    $content = [System.IO.File]::ReadAllText($path, [System.Text.UTF8Encoding]::new($false))
    $original = $content
    $fileHits = 0
    $ruleHits = @{}

    # Apply inline-style transformations
    foreach ($t in $transformations) {
        $find = $t.Find
        $replace = $t.Replace
        $count = ([regex]::Matches($content, [regex]::Escape($find))).Count
        if ($count -gt 0) {
            $content = $content.Replace($find, $replace)
            $fileHits += $count
            $ruleHits[$t.Desc] = ($ruleHits[$t.Desc] | ForEach-Object { $_ }) + $count
        }
    }

    # Apply Tailwind class swaps.
    # We do these via word-boundary regex so we don't accidentally touch partial matches.
    foreach ($tw in $tailwindMap.Keys) {
        $repl = $tailwindMap[$tw]
        # Escape / for regex - / is not special in .NET but we escape the whole thing anyway
        $escaped = [regex]::Escape($tw)
        $matches = [regex]::Matches($content, "(?<![A-Za-z0-9-])$escaped(?![A-Za-z0-9])")
        if ($matches.Count -gt 0) {
            $content = [regex]::Replace($content, "(?<![A-Za-z0-9-])$escaped(?![A-Za-z0-9])", $repl)
            $fileHits += $matches.Count
            $ruleHits["tw $tw -> $repl"] = $matches.Count
        }
    }

    if ($fileHits -eq 0) {
        $fileReports += "  $file : no changes"
        continue
    }

    $fileReports += "  $file : $fileHits total changes"
    foreach ($desc in ($ruleHits.Keys | Sort-Object)) {
        $fileReports += "    $($ruleHits[$desc]) x $desc"
    }
    $totalChanges += $fileHits

    if ($Apply) {
        [System.IO.File]::WriteAllText($path, $content, [System.Text.UTF8Encoding]::new($false))
        $fileReports += "    WROTE"
    } else {
        $fileReports += "    (dry run)"
    }
}

Write-Host ""
if ($Apply) {
    Write-Host "Mode: APPLY" -ForegroundColor Green
} else {
    Write-Host "Mode: DRY RUN" -ForegroundColor Yellow
}
Write-Host ""

foreach ($line in $fileReports) {
    Write-Host $line
}

Write-Host ""
Write-Host "Total changes: $totalChanges" -ForegroundColor Cyan

if (-not $Apply -and $totalChanges -gt 0) {
    Write-Host ""
    Write-Host "To apply: .\apply-theme-aware.ps1 -Apply" -ForegroundColor White
}
