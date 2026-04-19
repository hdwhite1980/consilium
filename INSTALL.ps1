# Install script for Wali-OS Invest Options feature
# Run from E:\consilium after downloading the package.
# ------------------------------------------------------------

$ErrorActionPreference = 'Stop'
$src = "$PSScriptRoot"
$repo = "E:\consilium"

if (!(Test-Path $repo)) { throw "Repo not found at $repo" }

Write-Host "Installing Invest Options files to $repo..." -ForegroundColor Cyan

# 1. Lessons content
Copy-Item "$src\invest-lessons.ts" "$repo\app\lib\invest-lessons.ts" -Force
Write-Host "  [OK] app/lib/invest-lessons.ts"

# 2. Lesson demos (widgets)
Copy-Item "$src\LessonDemos.tsx" "$repo\app\components\LessonDemos.tsx" -Force
Write-Host "  [OK] app/components/LessonDemos.tsx"

# 3. Ideas route (5-tier system + options generation)
Copy-Item "$src\ideas_route.ts" "$repo\app\api\invest\ideas\route.ts" -Force
Write-Host "  [OK] app/api/invest/ideas/route.ts"

# 4. Main invest route (option trade support)
Copy-Item "$src\invest_route.ts" "$repo\app\api\invest\route.ts" -Force
Write-Host "  [OK] app/api/invest/route.ts"

# 5. Analyze-trade route (new endpoint)
$analyzeDir = "$repo\app\api\invest\analyze-trade"
if (!(Test-Path $analyzeDir)) { New-Item -ItemType Directory -Path $analyzeDir | Out-Null }
Copy-Item "$src\analyze-trade_route.ts" "$analyzeDir\route.ts" -Force
Write-Host "  [OK] app/api/invest/analyze-trade/route.ts (NEW)"

# 6. Invest page (options UI + post-mortems)
Copy-Item "$src\page.tsx" "$repo\app\invest\page.tsx" -Force
Write-Host "  [OK] app/invest/page.tsx"

Write-Host ""
Write-Host "Files installed." -ForegroundColor Green
Write-Host ""
Write-Host "NEXT STEPS:" -ForegroundColor Yellow
Write-Host "  1. Open Supabase dashboard > SQL editor"
Write-Host "  2. Paste contents of MIGRATION.sql and run once"
Write-Host "  3. git add -A && git commit -m 'feat(invest): options trading at Operator + trade post-mortems'"
Write-Host "  4. git push (Railway auto-deploys)"
