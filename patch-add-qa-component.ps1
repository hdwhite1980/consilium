# =============================================================
# patch-add-qa-component.ps1
#
# Adds the AnalysisQA component to app/page.tsx:
#   1. Adds import at top of file
#   2. Renders <AnalysisQA /> below Signal matrix when stage === 'done'
#
# Idempotent. Pure ASCII anchors. Uses simple find-and-insert
# (no bracket counting needed - both anchors are exact matches).
# =============================================================

$ErrorActionPreference = 'Stop'

$DashboardPath = ".\app\page.tsx"

if (-not (Test-Path $DashboardPath)) {
    Write-Error "Dashboard file not found at $DashboardPath"
    exit 1
}

Write-Host "Reading $DashboardPath..."
$content = Get-Content $DashboardPath -Raw

$originalHadCrlf = $content.Contains("`r`n")
if ($originalHadCrlf) {
    $content = $content -replace "`r`n", "`n"
}

# State checks
$hasImport = $content.Contains("import AnalysisQA")
$hasRender = $content.Contains("<AnalysisQA")

Write-Host ""
Write-Host "Current state:" -ForegroundColor Cyan
Write-Host "  AnalysisQA import: $(if ($hasImport) { '[OK]' } else { '[MISSING]' })"
Write-Host "  AnalysisQA render: $(if ($hasRender) { '[OK]' } else { '[MISSING]' })"
Write-Host ""

if ($hasImport -and $hasRender) {
    Write-Host "Already patched. No changes." -ForegroundColor Yellow
    exit 0
}

# =============================================================
# EDIT 1: Add import next to PortfolioAlerts import
# =============================================================
if (-not $hasImport) {
    $oldImport = "import PortfolioAlerts from '@/app/components/PortfolioAlerts'"
    $newImport = "import PortfolioAlerts from '@/app/components/PortfolioAlerts'`nimport AnalysisQA, { AnalysisQAContext } from '@/app/components/AnalysisQA'"

    if (-not $content.Contains($oldImport)) {
        Write-Error "Could not find PortfolioAlerts import anchor."
        exit 1
    }
    $content = $content.Replace($oldImport, $newImport)
    Write-Host "  [1/2] Added AnalysisQA import" -ForegroundColor Green
}

# =============================================================
# EDIT 2: Add <AnalysisQA /> render block after Signal matrix
# Anchor: the line with "Signal matrix - " in a comment, find the
# closing of that conditional block, insert ours right after.
# =============================================================
if (-not $hasRender) {
    # Find the err rendering block - we insert OUR block right before it
    # The err block is unique (only one alert role for analysis errors)
    $errAnchor = "{err && ("
    $errIdx = $content.IndexOf($errAnchor)
    if ($errIdx -lt 0) {
        Write-Error "Could not find err display block anchor."
        exit 1
    }

    # Find start of the line containing this anchor
    $lineStart = $content.LastIndexOf("`n", $errIdx)
    if ($lineStart -lt 0) { $lineStart = 0 } else { $lineStart++ }

    # Build the QA render block
    # We pass the full Council context. mdSafe ensures md is non-null
    # (we already check stage === 'done' && jud && md elsewhere).
    $qaBlock = @'
            {/* Follow-up Q&A panel - opens explicitly via toggle */}
            {stage === 'done' && jud && md && (
              <AnalysisQA
                context={{
                  ticker,
                  currentPrice: md.currentPrice ?? 0,
                  verdict: jud,
                  news: gem ? {
                    summary: gem.summary,
                    sentiment: gem.sentiment,
                    headlines: gem.headlines,
                    keyEvents: gem.keyEvents,
                    macroFactors: gem.macroFactors,
                    regimeAssessment: gem.regimeAssessment,
                  } : null,
                  leadAnalyst: cla,
                  devilsAdvocate: gpt,
                  rebuttal: reb,
                  counter: ctr,
                  technicals: md.technicals ? {
                    rsi: md.technicals.rsi,
                    macd: md.technicals.macdCrossover,
                    sma50: md.technicals.sma50,
                    sma200: md.technicals.sma200,
                    bias: md.technicals.technicalBias,
                    keySignals: md.conviction?.signals?.slice(0, 8).map(s => `${s.category}: ${s.signal}`),
                  } : null,
                  social: soc ? {
                    summary: soc.keyNarrative,
                    bullishCount: soc.bullishTalkingPoints?.length ?? 0,
                    bearishCount: soc.bearishTalkingPoints?.length ?? 0,
                    keyThemes: [...(soc.bullishTalkingPoints ?? []), ...(soc.bearishTalkingPoints ?? [])].slice(0, 6),
                  } : null,
                } satisfies AnalysisQAContext}
              />
            )}

'@

    $content = $content.Substring(0, $lineStart) + $qaBlock + $content.Substring($lineStart)
    Write-Host "  [2/2] Added AnalysisQA render block" -ForegroundColor Green
}

# =============================================================
# Write back
# =============================================================
if ($originalHadCrlf) {
    $content = $content -replace "`n", "`r`n"
}

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText((Resolve-Path $DashboardPath).Path, $content, $utf8NoBom)

Write-Host ""
Write-Host "Done. The Q&A panel will appear below the Signal Matrix once analysis completes." -ForegroundColor Green
Write-Host ""
Write-Host "Files needed:"
Write-Host "  app/components/AnalysisQA.tsx       (new)"
Write-Host "  app/api/analyze/qa/route.ts         (new)"
Write-Host "  app/page.tsx                        (patched)"
