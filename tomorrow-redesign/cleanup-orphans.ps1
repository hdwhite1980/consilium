# =============================================================
# cleanup-orphans.ps1
#
# Deletes superseded / orphaned files from the repo:
#
#   1. /screener page + /api/budget-screener (replaced by /scanner + /options)
#   2. /api/invest/forge (orphan API - no consumer; uses old Spark/Ember names)
#   3. app/page.tsx.bak-presocial, app/page.tsx.bak-pre-emoji-fix (backups)
#   4. /training residue (already redirected to / in middleware)
#
# Does NOT touch:
#   - /tomorrow (separate decision)
#   - /scanner, /options (kept)
#   - any active routes
#
# Pure ASCII. Idempotent. Refuses to delete anything not on the
# explicit list. Skips files that don't exist (already deleted).
#
# Usage:
#   .\cleanup-orphans.ps1          (dry run - shows what would be deleted)
#   .\cleanup-orphans.ps1 -Apply   (actually delete)
# =============================================================

param([switch]$Apply)

$ErrorActionPreference = 'Stop'

# Files and directories to delete. Listed explicitly to prevent accidents.
$targets = @(
    # Screener page + dedicated API
    @{ Path = 'app\screener\page.tsx';                    Type = 'file'; Reason = 'Superseded by /scanner (stocks) and /options (options)' },
    @{ Path = 'app\screener';                             Type = 'dir';  Reason = 'Empty after page.tsx deletion' },
    @{ Path = 'app\api\budget-screener\route.ts';         Type = 'file'; Reason = 'Backend for /screener page being deleted' },
    @{ Path = 'app\api\budget-screener';                  Type = 'dir';  Reason = 'Empty after route.ts deletion' },

    # Forge API - no consumer (page does not exist; /invest uses /api/invest/floor)
    @{ Path = 'app\api\invest\forge\route.ts';            Type = 'file'; Reason = 'Orphan - no consumer; uses old Spark/Ember stage names' },
    @{ Path = 'app\api\invest\forge';                     Type = 'dir';  Reason = 'Empty after route.ts deletion' },

    # Backup files
    @{ Path = 'app\page.tsx.bak-presocial';               Type = 'file'; Reason = 'Backup file - history is in git' },
    @{ Path = 'app\page.tsx.bak-pre-emoji-fix';           Type = 'file'; Reason = 'Backup file - history is in git' },

    # Training residue (already redirected to / in middleware)
    @{ Path = 'app\training\page.tsx';                    Type = 'file'; Reason = '/training redirected to / in middleware - dead code' },
    @{ Path = 'app\training';                             Type = 'dir';  Reason = 'Empty after page.tsx deletion' },
    @{ Path = 'app\api\tutorial\route.ts';                Type = 'file'; Reason = 'Tutorial API for removed training feature' },
    @{ Path = 'app\api\tutorial';                         Type = 'dir';  Reason = 'Empty after route.ts deletion' },
    @{ Path = 'app\lib\training-content.ts';              Type = 'file'; Reason = 'Training content for removed feature' }
)

Write-Host "Cleanup target list:" -ForegroundColor Cyan
Write-Host ""

$existingTargets = @()
$missingTargets = @()

foreach ($t in $targets) {
    if (Test-Path $t.Path) {
        $existingTargets += $t
        $size = if ($t.Type -eq 'file') {
            $bytes = (Get-Item $t.Path).Length
            "$([math]::Round($bytes / 1024, 1)) KB"
        } else {
            $items = (Get-ChildItem $t.Path -Recurse -Force -ErrorAction SilentlyContinue | Measure-Object).Count
            "$items items"
        }
        Write-Host "  [WILL DELETE] $($t.Path)" -ForegroundColor Yellow
        Write-Host "                $($t.Reason) ($size)" -ForegroundColor DarkGray
    } else {
        $missingTargets += $t
        Write-Host "  [skip]        $($t.Path) (not found, already deleted?)" -ForegroundColor DarkGray
    }
}

Write-Host ""
Write-Host "Summary:" -ForegroundColor Cyan
Write-Host "  $($existingTargets.Count) item(s) will be deleted" -ForegroundColor Yellow
Write-Host "  $($missingTargets.Count) item(s) already missing" -ForegroundColor DarkGray

if ($existingTargets.Count -eq 0) {
    Write-Host ""
    Write-Host "Nothing to delete. All targets already removed." -ForegroundColor Green
    exit 0
}

# Pre-flight: check for references to /screener in the nav before deleting it
Write-Host ""
Write-Host "Pre-flight check: scanning for references to deleted paths..." -ForegroundColor Cyan
$refsToCheck = @(
    @{ Pattern = "/screener'"; Description = "links to /screener" },
    @{ Pattern = '/screener"'; Description = 'links to /screener' },
    @{ Pattern = '/training'; Description = 'links to /training' },
    @{ Pattern = '/api/budget-screener'; Description = 'references to budget-screener API' },
    @{ Pattern = '/api/invest/forge'; Description = 'references to forge API' },
    @{ Pattern = '/api/tutorial'; Description = 'references to tutorial API' }
)

$foundRefs = $false
foreach ($r in $refsToCheck) {
    $matches = Get-ChildItem -Path 'app' -Recurse -Include '*.tsx','*.ts' -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -notmatch '\.bak-' } |
        Where-Object { $_.FullName -notmatch '\\screener\\' } |
        Where-Object { $_.FullName -notmatch '\\training\\' } |
        Where-Object { $_.FullName -notmatch '\\budget-screener\\' } |
        Where-Object { $_.FullName -notmatch '\\forge\\' } |
        Where-Object { $_.FullName -notmatch '\\tutorial\\' } |
        Select-String -Pattern ([regex]::Escape($r.Pattern)) -SimpleMatch -List
    if ($matches) {
        $foundRefs = $true
        Write-Host "  [WARNING] Found $($r.Description):" -ForegroundColor Yellow
        foreach ($m in $matches) {
            $relPath = $m.Path.Replace((Get-Location).Path + '\', '')
            Write-Host "            $relPath" -ForegroundColor DarkYellow
        }
    }
}

if ($foundRefs) {
    Write-Host ""
    Write-Host "Files above still reference paths we are about to delete." -ForegroundColor Yellow
    Write-Host "Common cases:" -ForegroundColor DarkGray
    Write-Host "  - /screener referenced in app/page.tsx (NAV_GROUPS) - update needed" -ForegroundColor DarkGray
    Write-Host "  - /training referenced in middleware.ts (the redirect rule) - keep that, no action" -ForegroundColor DarkGray
    Write-Host "  - /api/invest/forge referenced in /api/invest/journey or /api/invest/floor - investigate" -ForegroundColor DarkGray
    Write-Host ""
    Write-Host "Delete-only-orphan-files: re-run with -Apply if the warnings above are acceptable" -ForegroundColor Yellow
    Write-Host "Or fix the references first (see app/page.tsx NAV_GROUPS for /screener removal)" -ForegroundColor Yellow
} else {
    Write-Host "  No references found to deleted paths. Safe to proceed." -ForegroundColor Green
}

if (-not $Apply) {
    Write-Host ""
    Write-Host "Dry run. Re-run with -Apply to actually delete." -ForegroundColor Yellow
    exit 0
}

Write-Host ""
Write-Host "Deleting..." -ForegroundColor Cyan

$deleted = 0
$errors = 0

# Sort: files before dirs (so dirs are empty when we get to them)
$sortedTargets = $existingTargets | Sort-Object {
    if ($_.Type -eq 'file') { 0 } else { 1 }
}

foreach ($t in $sortedTargets) {
    try {
        if ($t.Type -eq 'file') {
            Remove-Item -Path $t.Path -Force
            Write-Host "  [deleted] $($t.Path)" -ForegroundColor Green
            $deleted++
        } else {
            # Only delete directory if it's actually empty
            $remaining = Get-ChildItem -Path $t.Path -Force -ErrorAction SilentlyContinue
            if ($remaining.Count -eq 0) {
                Remove-Item -Path $t.Path -Force
                Write-Host "  [deleted] $($t.Path) (empty dir)" -ForegroundColor Green
                $deleted++
            } else {
                Write-Host "  [skip]    $($t.Path) (not empty - $($remaining.Count) items remain)" -ForegroundColor Yellow
            }
        }
    } catch {
        Write-Host "  [ERROR]   $($t.Path) : $_" -ForegroundColor Red
        $errors++
    }
}

Write-Host ""
Write-Host "Done. Deleted $deleted item(s), $errors error(s)." -ForegroundColor Cyan
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Cyan
Write-Host "  1. Update app\page.tsx NAV_GROUPS to remove /screener entry" -ForegroundColor Gray
Write-Host "  2. Search the repo for any remaining references to deleted paths" -ForegroundColor Gray
Write-Host "  3. Run: npm run build" -ForegroundColor Gray
Write-Host "  4. Test in incognito - confirm /screener returns 404 cleanly" -ForegroundColor Gray
