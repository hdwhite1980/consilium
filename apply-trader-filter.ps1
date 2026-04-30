# apply-trader-filter.ps1
# Integrates the Trader Filter into the Council pipeline.
#
# What this does:
#   1. Adds runTrader call to pipeline.ts after Judge stage
#   2. Adds 'trader' field to PipelineResult interface
#   3. Updates app/api/analyze/route.ts to save trader_* fields to verdict_log
#   4. Updates analyze/route.ts to broadcast trader event via SSE
#
# Prereqs:
#   - app/lib/trader.ts must already exist (drop it in first)
#   - Migration migration_2026-04-30_trader_filter.sql must have run
#
# Usage:
#   .\apply-trader-filter.ps1           (dry run)
#   .\apply-trader-filter.ps1 -Apply    (writes only if all edits match)

param([switch]$Apply)
$ErrorActionPreference = 'Stop'

if (-not (Test-Path 'app\lib\trader.ts')) {
    Write-Host "ERROR: app\lib\trader.ts not found. Drop it in place first." -ForegroundColor Red
    exit 1
}
if (-not (Test-Path 'app\lib\pipeline.ts')) {
    Write-Host "ERROR: app\lib\pipeline.ts not found. Run from repo root." -ForegroundColor Red
    exit 1
}
if (-not (Test-Path 'app\api\analyze\route.ts')) {
    Write-Host "ERROR: app\api\analyze\route.ts not found." -ForegroundColor Red
    exit 1
}

function Norm([string]$s) { $s -replace "`r`n", "`n" }

$plan = @()

function Plan-Edit {
    param(
        [string]$Path,
        [string]$EditName,
        [string]$Old,
        [string]$New,
        [string]$AlreadyAppliedPattern
    )
    $script:plan += @{
        Path = $Path
        Name = $EditName
        Old = $Old
        New = $New
        AlreadyAppliedPattern = $AlreadyAppliedPattern
    }
}

# ═════════════════════════════════════════════════════════════
# pipeline.ts edits
# ═════════════════════════════════════════════════════════════

# EDIT 1 — Import the trader module
Plan-Edit `
    -Path 'app\lib\pipeline.ts' `
    -EditName '1. pipeline.ts: import trader' `
    -AlreadyAppliedPattern "from './trader'" `
    -Old "import { runAggregatorScout, formatAggregatorForPrompt, type AggregatorScoutResult } from './news-aggregator-scout'" `
    -New @'
import { runAggregatorScout, formatAggregatorForPrompt, type AggregatorScoutResult } from './news-aggregator-scout'
import { evaluateTrade, type TraderVerdict } from './trader'
'@

# EDIT 2 — Add trader field to PipelineResult interface
# Anchor on the existing aggregator field (added by previous patch).
Plan-Edit `
    -Path 'app\lib\pipeline.ts' `
    -EditName '2. pipeline.ts: PipelineResult.trader field' `
    -AlreadyAppliedPattern 'trader: TraderVerdict' `
    -Old @'
  social: SocialSentiment
  aggregator: AggregatorScoutResult
}
'@ `
    -New @'
  social: SocialSentiment
  aggregator: AggregatorScoutResult
  trader: TraderVerdict
}
'@

# EDIT 3 — Run Trader stage after final judge in runPipeline
# Anchor on the line that gets the final judge result.
Plan-Edit `
    -Path 'app\lib\pipeline.ts' `
    -EditName '3. pipeline.ts: run Trader after Judge' `
    -AlreadyAppliedPattern 'evaluateTrade\(judge' `
    -Old @'
  const { judge, calibration } = await runJudgeWithCalibration(bundle, gemini, claude, gpt, rebuttal, counter, 1, social, aggregator)
  transcript.push({ role: 'judge', stage: 'arbitrator', content: judge.summary, signal: judge.signal, confidence: judge.confidence, timestamp: ts() })
'@ `
    -New @'
  const { judge, calibration } = await runJudgeWithCalibration(bundle, gemini, claude, gpt, rebuttal, counter, 1, social, aggregator)
  transcript.push({ role: 'judge', stage: 'arbitrator', content: judge.summary, signal: judge.signal, confidence: judge.confidence, timestamp: ts() })

  // ── Trader Filter ─────────────────────────────────────────
  // Evaluates the Council's verdict against trader discipline rules:
  // R:R, confidence floors per setup type, conflict detection.
  // Output is TAKE / PASS / WAIT — separate from the Judge verdict.
  onProgress('trader_start', {})
  const trader = await evaluateTrade(judge, bundle, bundle.timeframe)
  onProgress('trader_done', trader)
'@

# EDIT 4 — Return trader from runPipeline
Plan-Edit `
    -Path 'app\lib\pipeline.ts' `
    -EditName '4. pipeline.ts: runPipeline returns trader' `
    -AlreadyAppliedPattern 'transcript, social, aggregator, trader' `
    -Old "return { gemini, claude, gpt, rebuttal, counter, judge, calibration, verifications, transcript, social, aggregator }" `
    -New "return { gemini, claude, gpt, rebuttal, counter, judge, calibration, verifications, transcript, social, aggregator, trader }"

# ═════════════════════════════════════════════════════════════
# analyze/route.ts edits
# ═════════════════════════════════════════════════════════════

# EDIT 5 — Add trader fields to verdict_log insert
# Anchor on the existing entry_price/stop_loss/take_profit insert block.
Plan-Edit `
    -Path 'app\api\analyze\route.ts' `
    -EditName '5. analyze/route.ts: persist trader_* fields' `
    -AlreadyAppliedPattern 'trader_decision: result\.trader' `
    -Old @'
              await supabase.from('verdict_log').insert({
                user_id: currentUserId,
                ticker: symbol,
                signal: result.judge.signal,
                confidence: result.judge.confidence ?? null,
                entry_price: parseP(result.judge.entryPrice),
                stop_loss: parseP(result.judge.stopLoss),
                take_profit: parseP(result.judge.takeProfit),
                time_horizon: result.judge.timeHorizon ?? null,
                persona: persona ?? 'balanced',
                timeframe: tf,
                outcome_1w: 'pending',
                outcome_1m: 'pending',
              })
'@ `
    -New @'
              await supabase.from('verdict_log').insert({
                user_id: currentUserId,
                ticker: symbol,
                signal: result.judge.signal,
                confidence: result.judge.confidence ?? null,
                entry_price: parseP(result.judge.entryPrice),
                stop_loss: parseP(result.judge.stopLoss),
                take_profit: parseP(result.judge.takeProfit),
                time_horizon: result.judge.timeHorizon ?? null,
                persona: persona ?? 'balanced',
                timeframe: tf,
                outcome_1w: 'pending',
                outcome_1m: 'pending',
                trader_decision: result.trader?.decision ?? null,
                trader_grade: result.trader?.grade ?? null,
                trader_position_size: result.trader?.positionSizePct ?? null,
                trader_risk_reward: result.trader?.riskReward ?? null,
                trader_pass_reasons: result.trader?.passReasons ?? null,
                trader_wait_conditions: result.trader?.waitConditions ?? null,
                trader_rationale: result.trader?.rationale ?? null,
                trader_evaluated_at: result.trader?.evaluatedAt ?? null,
              })
'@

# ═════════════════════════════════════════════════════════════
# DRY-RUN
# ═════════════════════════════════════════════════════════════

$fileWork = @{}
$results = @()

foreach ($edit in $plan) {
    $path = $edit.Path
    if (-not (Test-Path $path)) {
        $results += [pscustomobject]@{ Path=$path; Name=$edit.Name; Status='SKIP'; Detail='file not found' }
        continue
    }

    if (-not $fileWork.ContainsKey($path)) {
        $abs = (Resolve-Path $path).Path
        $fileWork[$path] = [System.IO.File]::ReadAllText($abs, [System.Text.UTF8Encoding]::new($false))
    }

    $work = $fileWork[$path]
    if ($work -match $edit.AlreadyAppliedPattern) {
        $results += [pscustomobject]@{ Path=$path; Name=$edit.Name; Status='already'; Detail='' }
        continue
    }

    $oldNorm = Norm $edit.Old
    $workNorm = Norm $work
    if ($workNorm.Contains($oldNorm)) {
        $newNorm = Norm $edit.New
        $newWork = $workNorm.Replace($oldNorm, $newNorm) -replace "`n", "`r`n"
        $fileWork[$path] = $newWork
        $results += [pscustomobject]@{ Path=$path; Name=$edit.Name; Status='applied'; Detail='' }
    } else {
        $results += [pscustomobject]@{ Path=$path; Name=$edit.Name; Status='MISS'; Detail='anchor not found' }
    }
}

# Report
Write-Host ""
Write-Host "=== Trader Filter integration ===" -ForegroundColor Cyan
$applied = 0; $already = 0; $missed = 0; $skipped = 0
foreach ($r in $results) {
    $color = switch ($r.Status) {
        'applied' { 'Green'; $applied++ }
        'already' { 'DarkGray'; $already++ }
        'MISS'    { 'Red'; $missed++ }
        'SKIP'    { 'Yellow'; $skipped++ }
    }
    $tag = switch ($r.Status) {
        'applied' { '[+]' }
        'already' { '[ok]' }
        'MISS'    { '[FAIL]' }
        'SKIP'    { '[skip]' }
    }
    $detail = if ($r.Detail) { " — $($r.Detail)" } else { '' }
    Write-Host "  $tag $($r.Name)$detail" -ForegroundColor $color
}
Write-Host ""
Write-Host "Summary: $applied applied, $already already-applied, $missed MISSED, $skipped SKIPPED" -ForegroundColor Cyan

if ($missed -gt 0) {
    Write-Host ""
    Write-Host "ABORTING — $missed edit(s) could not find their anchors." -ForegroundColor Red
    Write-Host "No changes written. Investigate the [FAIL] anchors." -ForegroundColor Red
    exit 1
}

if ($applied -eq 0) {
    Write-Host "All edits already applied. No changes needed." -ForegroundColor DarkGray
    exit 0
}

# Write
if ($Apply) {
    foreach ($entry in $fileWork.GetEnumerator()) {
        $abs = (Resolve-Path $entry.Key).Path
        [System.IO.File]::WriteAllText($abs, $entry.Value, [System.Text.UTF8Encoding]::new($false))
    }
    Write-Host ""
    Write-Host "  WROTE $($fileWork.Count) file(s) — $applied edit(s) applied" -ForegroundColor Green
    Write-Host ""
    Write-Host "Next steps:" -ForegroundColor Cyan
    Write-Host "  1. Run migration_2026-04-30_trader_filter.sql in Supabase SQL Editor" -ForegroundColor Cyan
    Write-Host "  2. Run 'npm run build' to verify TypeScript compiles" -ForegroundColor Cyan
    Write-Host "  3. After build passes, commit and push" -ForegroundColor Cyan
    Write-Host "  4. The UI rendering for the Trader Assessment card is a separate" -ForegroundColor Cyan
    Write-Host "     manual edit to app/page.tsx (see README.md for the snippet)" -ForegroundColor Cyan
} else {
    Write-Host ""
    Write-Host "DRY RUN — re-run with -Apply to write." -ForegroundColor Yellow
}
