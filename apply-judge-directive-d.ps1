# apply-judge-directive-d.ps1
# Adds the "judge the debate, don't redo it" directive to the Judge's
# system prompt. Option D from the Phase 1 design discussion.
#
# What this changes:
#   - buildJudgeSystemPrompt() in app/lib/pipeline.ts gains a new
#     procedural rule that explicitly tells the Judge to weigh debate
#     quality rather than re-running the analysis itself.
#   - This is a minimal, low-risk change (one prompt edit, no
#     architectural changes, no API surface changes).
#
# Why we're doing this:
#   - Current Judge sees ~5000 tokens of evidence and effectively
#     re-does the analysis the Lead and Devil already did.
#   - Adding a clear directive about the Judge's job is a single
#     prompt change that should reduce re-analysis behavior.
#   - We can measure the effect via Phase 1 outcome resolution
#     (which we just fixed) — over 1-2 weeks of new verdicts, accuracy
#     should be similar or slightly better, and the Judge's reasoning
#     should reference role names ("Lead said X, Devil said Y") more
#     than raw signals ("RSI is 32, MACD bearish").
#
# Usage:
#   .\apply-judge-directive-d.ps1           (dry run)
#   .\apply-judge-directive-d.ps1 -Apply    (writes the change)

param([switch]$Apply)
$ErrorActionPreference = 'Stop'

$pipelineFile = 'app\lib\pipeline.ts'

if (-not (Test-Path $pipelineFile)) {
    Write-Host "ERROR: $pipelineFile not found. Run from repo root." -ForegroundColor Red
    exit 1
}

function Norm([string]$s) { $s -replace "`r`n", "`n" }

$pipelinePath = (Resolve-Path $pipelineFile).Path
$work = [System.IO.File]::ReadAllText($pipelinePath, [System.Text.UTF8Encoding]::new($false))
$original = $work

# Anchor: the existing PROCEDURAL RULES list in buildJudgeSystemPrompt.
# We're inserting two new bullets at the TOP of the list, so they're seen
# first and frame how the Judge reads everything that follows.
#
# Anchor on the unique phrase "PROCEDURAL RULES:" followed by the first
# existing bullet "Weigh argument QUALITY".
$old = @'
PROCEDURAL RULES:
- Weigh argument QUALITY, not vote count or word count.
'@

$new = @'
PROCEDURAL RULES:
- YOUR JOB IS TO JUDGE THE DEBATE, NOT REDO THE ANALYSIS. The Lead Analyst already analyzed the data. The Devil's Advocate already cross-pressured. The News Scout already filtered news. Your job is to weigh which side built the stronger case — not to re-evaluate the underlying signals from scratch. If you find yourself starting a sentence with "the RSI is..." or "the price is X% below the SMA200..." you've gone wrong. Cite the COUNCIL MEMBER, not the raw indicator. Example: "The Lead correctly identified the death cross, but the Devil's Advocate's research into insider buying at higher prices materially weakened the bearish case." That's judging. "RSI at 30 with MACD bearish suggests further downside" is re-analyzing — don't do that.
- WEIGHT NOVELTY OVER REPETITION. If the Devil's Round 2 research surfaced a fact neither side considered initially (e.g., insider buy prices, supply-chain detail, regulatory deadline), give it disproportionate weight. The debate progressed because of new information; honor that progression. Do NOT weight a point more heavily just because both sides discussed it at length.
- Weigh argument QUALITY, not vote count or word count.
'@

$nOld = Norm $old
$nNew = Norm $new
$nWork = Norm $work

# Already-applied check
if ($nWork -match 'YOUR JOB IS TO JUDGE THE DEBATE, NOT REDO THE ANALYSIS') {
    Write-Host "  [ok] Judge directive D already applied" -ForegroundColor DarkGray
    exit 0
}

if (-not $nWork.Contains($nOld)) {
    Write-Host "  [FAIL] Anchor not found: PROCEDURAL RULES + first bullet" -ForegroundColor Red
    Write-Host "         The Judge system prompt has changed since this script was written." -ForegroundColor Yellow
    Write-Host "         Open app\lib\pipeline.ts, find buildJudgeSystemPrompt, and manually" -ForegroundColor Yellow
    Write-Host "         add the directive at the top of the PROCEDURAL RULES list." -ForegroundColor Yellow
    exit 1
}

$nWork = $nWork.Replace($nOld, $nNew)
$work = $nWork -replace "`n", "`r`n"

if ($Apply) {
    [System.IO.File]::WriteAllText($pipelinePath, $work, [System.Text.UTF8Encoding]::new($false))
    Write-Host "  [+] Wrote $pipelineFile — Judge directive D added" -ForegroundColor Green
    Write-Host ""
    Write-Host "Run 'npm run build' to verify TypeScript compiles." -ForegroundColor Cyan
    Write-Host "After deploy, run a Council on any ticker — Judge reasoning should" -ForegroundColor Cyan
    Write-Host "reference 'Lead Analyst' and 'Devil's Advocate' more than raw indicators." -ForegroundColor Cyan
} else {
    Write-Host "  [+] Judge directive change ready to apply (dry run)" -ForegroundColor Green
    Write-Host "  Re-run with -Apply to write." -ForegroundColor Yellow
}
