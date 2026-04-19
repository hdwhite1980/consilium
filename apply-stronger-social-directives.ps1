# apply-stronger-social-directives.ps1
# Strengthens role directives in app/lib/social-scout.ts so the debate
# models visibly cite Social Pulse data instead of weaving it in silently.
#
# The patch replaces the `roleDirective` object inside
# formatSocialSentimentForPrompt() with harder attribution language.
#
# Usage:
#   .\apply-stronger-social-directives.ps1           (dry run)
#   .\apply-stronger-social-directives.ps1 -Apply    (write changes)

param([switch]$Apply)

$ErrorActionPreference = 'Stop'

$file = 'app\lib\social-scout.ts'
if (-not (Test-Path $file)) {
    Write-Host "ERROR: $file not found. Run from repo root." -ForegroundColor Red
    exit 1
}

$path = (Resolve-Path $file).Path
$content = [System.IO.File]::ReadAllText($path, [System.Text.UTF8Encoding]::new($false))
$original = $content

function Norm([string]$s) { $s -replace "`r`n", "`n" }

Write-Host ""
Write-Host "=== social-scout.ts ===" -ForegroundColor Cyan

$oldBlock = @'
  const roleDirective = {
    lead: `You MUST address whether social sentiment supports or challenges your thesis. If sentiment diverges from news, acknowledge it explicitly.`,
    devil: `EXPLOIT any sentiment divergence. If news is positive but social is skeptical (or vice versa), that contradiction is ammunition for your challenge. Fade signals indicate the crowd may be wrong.`,
    judge: `Factor sentiment confidence into your final conviction. HIGH-confidence contrarian social sentiment warrants attention. LOW confidence should NOT move your verdict.`,
  }[role]
'@

$newBlock = @'
  const roleDirective = {
    lead: `ATTRIBUTION REQUIRED: When social sentiment reinforces or contradicts any part of your thesis, you MUST cite it explicitly in your reasoning. Use phrases like "Social sentiment confirms...", "X traders are saying...", "The Social Pulse shows...", or "Per live X data...". Do NOT silently absorb social data into your technical or fundamental reasoning — the user needs to see when a claim originates from social vs. from news or signals. If a notable voice's target or claim aligns with your thesis, name it (e.g. "@handle's $290 target aligns with our Double Bottom measured move"). If social sentiment diverges from news, you MUST call that divergence out by name.`,
    devil: `ATTRIBUTION REQUIRED: When you exploit social sentiment in your challenge, you MUST cite it explicitly. Use phrases like "Social sentiment contradicts the Lead's thesis...", "X traders are fading this move...", "The Social Pulse shows FOMO peaking...", or "Per live X data, retail is overextended while pros are quiet...". Do NOT silently use social data — the user must see when a counter-argument is backed by social vs. signals. If news is positive but social is skeptical (or vice versa), name that contradiction explicitly and use it as ammunition. Fade signals indicate the crowd may be wrong — cite them by name when you press on them.`,
    judge: `ATTRIBUTION REQUIRED: Your summary MUST explicitly reference the Social Pulse when it influenced your verdict. Use phrases like "The Social Pulse indicates...", "Social sentiment on X confirms...", or "Live X data diverges from news by...". The council has three distinct voices now — News Scout, Social Pulse, and the Lead/Devil debate — and the user must see you weighing all three. If sentiment confidence is HIGH and reinforces the winning argument, say so. If sentiment is LOW or absent, note that your verdict relies primarily on signals and news rather than social. Do NOT silently blend social into your reasoning without attribution.`,
  }[role]
'@

$nOld = Norm $oldBlock
$nNew = Norm $newBlock
$nContent = Norm $content

if ($nContent -match "ATTRIBUTION REQUIRED:") {
    Write-Host "  [ok] Strong attribution directives already present" -ForegroundColor DarkGray
} elseif ($nContent.Contains($nOld)) {
    $nContent = $nContent.Replace($nOld, $nNew)
    $content = $nContent -replace "`n", "`r`n"
    Write-Host "  [+] Role directives strengthened (Lead + Devil + Judge)" -ForegroundColor Green
} else {
    Write-Host "  [WARN] Original directive block not found" -ForegroundColor Yellow
    Write-Host "  Your social-scout.ts may have been modified already." -ForegroundColor Yellow
    Write-Host "  Check line ~218 for the roleDirective object and edit manually." -ForegroundColor Yellow
    exit 1
}

if ($content -ne $original) {
    if ($Apply) {
        [System.IO.File]::WriteAllText($path, $content, [System.Text.UTF8Encoding]::new($false))
        Write-Host "  WROTE $file" -ForegroundColor Green
    } else {
        Write-Host "  (dry run - not written)" -ForegroundColor Yellow
    }
}

Write-Host ""
if ($Apply) {
    Write-Host "Next: npm run build && test with a ticker" -ForegroundColor White
    Write-Host "After deploy, re-run AAPL analysis and look for explicit social citations" -ForegroundColor White
    Write-Host "in the Lead Analyst reasoning and Judge summary." -ForegroundColor White
} else {
    Write-Host "To apply: .\apply-stronger-social-directives.ps1 -Apply" -ForegroundColor White
}
