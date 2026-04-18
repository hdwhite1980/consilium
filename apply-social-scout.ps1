# apply-social-scout.ps1
# Integrates Social Scout (Grok) into the 6-stage debate pipeline.
#
# What this does:
#   FILE 1: app/lib/pipeline.ts
#     1.  Imports runSocialScout and formatSocialSentimentForPrompt
#     2.  Extends PipelineResult interface with social: SocialSentiment
#     3.  runPipeline: News Scout + Social Scout now run in parallel
#     4.  runPipeline: returns social in the result object
#     5.  runClaude: signature accepts optional social parameter
#     6.  runClaude: prompt includes social sentiment context (Lead role)
#     7.  runPipeline: passes social into runClaude
#     8.  runGPT: signature accepts optional social parameter
#     9.  runGPT: prompt includes social sentiment context (Devil role)
#     10. runPipeline: passes social into runGPT
#     11. runJudge: signature accepts optional social parameter
#     12. runJudge: prompt includes social sentiment context (Judge role)
#     13. runPipeline: passes social into runJudge
#
#   FILE 2: app/api/analysis/route.ts
#     14. Imports runSocialScout for cache-hit path
#     15. On cache hit: re-runs fresh Social Scout in parallel (Option 2)
#     16. On live run: saves social sentiment to Supabase analyses row
#
# Usage:
#   .\apply-social-scout.ps1           (dry run — shows what would change)
#   .\apply-social-scout.ps1 -Apply    (actually writes changes)

param([switch]$Apply)

$ErrorActionPreference = 'Stop'

$pipelineFile = 'app\lib\pipeline.ts'
$routeFile    = 'app\api\analyze\route.ts'

if (-not (Test-Path $pipelineFile)) {
    Write-Host "ERROR: $pipelineFile not found. Run from repo root." -ForegroundColor Red
    exit 1
}
if (-not (Test-Path $routeFile)) {
    Write-Host "ERROR: $routeFile not found. Run from repo root." -ForegroundColor Red
    exit 1
}

$totalChanges = 0

# Helper: normalize line endings for .Contains() comparison
function Norm([string]$s) { $s -replace "`r`n", "`n" }

# ════════════════════════════════════════════════════════════════
# FILE 1: app/lib/pipeline.ts
# ════════════════════════════════════════════════════════════════

$pipelinePath = (Resolve-Path $pipelineFile).Path
$pipelineContent = [System.IO.File]::ReadAllText($pipelinePath, [System.Text.UTF8Encoding]::new($false))
$originalPipeline = $pipelineContent

Write-Host ""
Write-Host "=== pipeline.ts ===" -ForegroundColor Cyan

# ── EDIT 1: Add social-scout import ──
$importOld = "import type { SignalBundle } from './aggregator'"
$importNew = "import type { SignalBundle } from './aggregator'`r`nimport { runSocialScout, formatSocialSentimentForPrompt, type SocialSentiment } from './social-scout'"

if ($pipelineContent -match "runSocialScout, formatSocialSentimentForPrompt") {
    Write-Host "  [ok] social-scout import already present" -ForegroundColor DarkGray
} elseif ($pipelineContent.Contains($importOld)) {
    $pipelineContent = $pipelineContent.Replace($importOld, $importNew)
    Write-Host "  [+] Added social-scout import" -ForegroundColor Green
    $totalChanges++
} else {
    Write-Host "  [WARN] import anchor not found" -ForegroundColor Yellow
}

# ── EDIT 2: Extend PipelineResult interface ──
$interfaceOld = @'
export interface PipelineResult {
  gemini: GeminiResult
  claude: ClaudeResult
  gpt: GptResult
  rebuttal?: RebuttalResult
  counter?: CounterResult
  judge: JudgeResult
  transcript: TranscriptMessage[]
}
'@

$interfaceNew = @'
export interface PipelineResult {
  gemini: GeminiResult
  claude: ClaudeResult
  gpt: GptResult
  rebuttal?: RebuttalResult
  counter?: CounterResult
  judge: JudgeResult
  transcript: TranscriptMessage[]
  social: SocialSentiment
}
'@

$nIfaceOld = Norm $interfaceOld
$nIfaceNew = Norm $interfaceNew
$nPipe = Norm $pipelineContent

if ($nPipe -match "social: SocialSentiment\s*\n\}") {
    Write-Host "  [ok] PipelineResult already has social field" -ForegroundColor DarkGray
} elseif ($nPipe.Contains($nIfaceOld)) {
    $nPipe = $nPipe.Replace($nIfaceOld, $nIfaceNew)
    $pipelineContent = $nPipe -replace "`n", "`r`n"
    Write-Host "  [+] Extended PipelineResult with social field" -ForegroundColor Green
    $totalChanges++
} else {
    Write-Host "  [WARN] PipelineResult interface not found" -ForegroundColor Yellow
}

# ── EDIT 3: Run Social Scout in parallel with News Scout ──
$scoutsOld = @'
  // ── Stage 1: News Scout ──────────────────────────────────
  onProgress('gemini_start', {})
  const gemini = await runGemini(bundle)
  transcript.push({ role: 'gemini', stage: 'news_macro', content: gemini.summary, confidence: gemini.confidence, timestamp: ts() })
  onProgress('gemini_done', gemini)
'@

$scoutsNew = @'
  // ── Stage 1: News Scout + Social Scout (parallel) ────────
  onProgress('gemini_start', {})
  onProgress('grok_start', {})
  const [gemini, social] = await Promise.all([
    runGemini(bundle),
    runSocialScout(bundle.ticker, bundle.currentPrice, bundle.timeframe),
  ])
  transcript.push({ role: 'gemini', stage: 'news_macro', content: gemini.summary, confidence: gemini.confidence, timestamp: ts() })
  onProgress('gemini_done', gemini)
  onProgress('grok_done', social)
'@

$nScoutsOld = Norm $scoutsOld
$nScoutsNew = Norm $scoutsNew
$nPipe = Norm $pipelineContent

if ($nPipe -match "runSocialScout\(bundle\.ticker") {
    Write-Host "  [ok] Social Scout parallel call already present" -ForegroundColor DarkGray
} elseif ($nPipe.Contains($nScoutsOld)) {
    $nPipe = $nPipe.Replace($nScoutsOld, $nScoutsNew)
    $pipelineContent = $nPipe -replace "`n", "`r`n"
    Write-Host "  [+] Social Scout now runs parallel to News Scout" -ForegroundColor Green
    $totalChanges++
} else {
    Write-Host "  [WARN] News Scout stage block not found" -ForegroundColor Yellow
}

# ── EDIT 4: Return social from runPipeline ──
$returnOld = "  return { gemini, claude, gpt, rebuttal, counter, judge, transcript }"
$returnNew = "  return { gemini, claude, gpt, rebuttal, counter, judge, transcript, social }"

if ($pipelineContent -match "return \{ gemini, claude, gpt, rebuttal, counter, judge, transcript, social \}") {
    Write-Host "  [ok] runPipeline already returns social" -ForegroundColor DarkGray
} elseif ($pipelineContent.Contains($returnOld)) {
    $pipelineContent = $pipelineContent.Replace($returnOld, $returnNew)
    Write-Host "  [+] runPipeline return includes social" -ForegroundColor Green
    $totalChanges++
} else {
    Write-Host "  [WARN] return statement not found" -ForegroundColor Yellow
}

# ── EDIT 5: runClaude signature accepts social ──
$claudeSigOld = "export async function runClaude(bundle: SignalBundle, gemini: GeminiResult): Promise<ClaudeResult> {"
$claudeSigNew = "export async function runClaude(bundle: SignalBundle, gemini: GeminiResult, social?: SocialSentiment): Promise<ClaudeResult> {"

if ($pipelineContent -match "runClaude\(bundle: SignalBundle, gemini: GeminiResult, social\?: SocialSentiment\)") {
    Write-Host "  [ok] runClaude already accepts social" -ForegroundColor DarkGray
} elseif ($pipelineContent.Contains($claudeSigOld)) {
    $pipelineContent = $pipelineContent.Replace($claudeSigOld, $claudeSigNew)
    Write-Host "  [+] runClaude signature updated" -ForegroundColor Green
    $totalChanges++
} else {
    Write-Host "  [WARN] runClaude signature not found" -ForegroundColor Yellow
}

# ── EDIT 6: Inject social into Claude (Lead) prompt ──
$claudePromptOld = @'
NEWS SCOUT BRIEF:
${gemini.summary}
Sentiment: ${gemini.sentiment} | Regime: ${gemini.regimeAssessment}
Events: ${gemini.keyEvents.join('; ')}
'@

$claudePromptNew = @'
NEWS SCOUT BRIEF:
${gemini.summary}
Sentiment: ${gemini.sentiment} | Regime: ${gemini.regimeAssessment}
Events: ${gemini.keyEvents.join('; ')}

${social ? formatSocialSentimentForPrompt(social, 'lead') : ''}
'@

$nClaudePOld = Norm $claudePromptOld
$nClaudePNew = Norm $claudePromptNew
$nPipe = Norm $pipelineContent

if ($nPipe -match "formatSocialSentimentForPrompt\(social, 'lead'\)") {
    Write-Host "  [ok] Lead Analyst already sees social" -ForegroundColor DarkGray
} elseif ($nPipe.Contains($nClaudePOld)) {
    $nPipe = $nPipe.Replace($nClaudePOld, $nClaudePNew)
    $pipelineContent = $nPipe -replace "`n", "`r`n"
    Write-Host "  [+] Lead Analyst prompt includes social sentiment" -ForegroundColor Green
    $totalChanges++
} else {
    Write-Host "  [WARN] Lead prompt anchor not found" -ForegroundColor Yellow
}

# ── EDIT 7: Pass social to runClaude call site ──
$claudeCallOld = "  const claude = await runClaude(bundle, gemini)"
$claudeCallNew = "  const claude = await runClaude(bundle, gemini, social)"

if ($pipelineContent -match "await runClaude\(bundle, gemini, social\)") {
    Write-Host "  [ok] runPipeline already passes social to Claude" -ForegroundColor DarkGray
} elseif ($pipelineContent.Contains($claudeCallOld)) {
    $pipelineContent = $pipelineContent.Replace($claudeCallOld, $claudeCallNew)
    Write-Host "  [+] runPipeline passes social to Claude" -ForegroundColor Green
    $totalChanges++
} else {
    Write-Host "  [WARN] runClaude call site not found" -ForegroundColor Yellow
}

# ── EDIT 8: runGPT signature accepts social ──
$gptSigOld = "export async function runGPT(bundle: SignalBundle, gemini: GeminiResult, claude: ClaudeResult): Promise<GptResult> {"
$gptSigNew = "export async function runGPT(bundle: SignalBundle, gemini: GeminiResult, claude: ClaudeResult, social?: SocialSentiment): Promise<GptResult> {"

if ($pipelineContent -match "claude: ClaudeResult, social\?: SocialSentiment\): Promise<GptResult>") {
    Write-Host "  [ok] runGPT already accepts social" -ForegroundColor DarkGray
} elseif ($pipelineContent.Contains($gptSigOld)) {
    $pipelineContent = $pipelineContent.Replace($gptSigOld, $gptSigNew)
    Write-Host "  [+] runGPT signature updated" -ForegroundColor Green
    $totalChanges++
} else {
    Write-Host "  [WARN] runGPT signature not found" -ForegroundColor Yellow
}

# ── EDIT 9: Inject social into GPT (Devil) prompt ──
$gptPromptOld = @'
LEAD ANALYST (${claude.signal}, ${claude.confidence}%): ${claude.reasoning}
Target: ${claude.target} | Risks: ${claude.keyRisks.join('; ')}

SIGNAL DATA:
'@

$gptPromptNew = @'
LEAD ANALYST (${claude.signal}, ${claude.confidence}%): ${claude.reasoning}
Target: ${claude.target} | Risks: ${claude.keyRisks.join('; ')}

${social ? formatSocialSentimentForPrompt(social, 'devil') : ''}

SIGNAL DATA:
'@

$nGptPOld = Norm $gptPromptOld
$nGptPNew = Norm $gptPromptNew
$nPipe = Norm $pipelineContent

if ($nPipe -match "formatSocialSentimentForPrompt\(social, 'devil'\)") {
    Write-Host "  [ok] Devil's Advocate already sees social" -ForegroundColor DarkGray
} elseif ($nPipe.Contains($nGptPOld)) {
    $nPipe = $nPipe.Replace($nGptPOld, $nGptPNew)
    $pipelineContent = $nPipe -replace "`n", "`r`n"
    Write-Host "  [+] Devil's Advocate prompt includes social sentiment" -ForegroundColor Green
    $totalChanges++
} else {
    Write-Host "  [WARN] Devil prompt anchor not found" -ForegroundColor Yellow
}

# ── EDIT 10: Pass social to runGPT call site ──
$gptCallOld = "    runGPT(bundle, gemini, claude),"
$gptCallNew = "    runGPT(bundle, gemini, claude, social),"

if ($pipelineContent -match "runGPT\(bundle, gemini, claude, social\)") {
    Write-Host "  [ok] runPipeline already passes social to GPT" -ForegroundColor DarkGray
} elseif ($pipelineContent.Contains($gptCallOld)) {
    $pipelineContent = $pipelineContent.Replace($gptCallOld, $gptCallNew)
    Write-Host "  [+] runPipeline passes social to GPT" -ForegroundColor Green
    $totalChanges++
} else {
    Write-Host "  [WARN] runGPT call site not found" -ForegroundColor Yellow
}

# ── EDIT 11: runJudge signature accepts social ──
$judgeSigOld = @'
export async function runJudge(
  bundle: SignalBundle,
  gemini: GeminiResult,
  claude: ClaudeResult,
  gpt: GptResult,
  rebuttal?: RebuttalResult,
  counter?: CounterResult,
  round = 1
): Promise<JudgeResult> {
'@

$judgeSigNew = @'
export async function runJudge(
  bundle: SignalBundle,
  gemini: GeminiResult,
  claude: ClaudeResult,
  gpt: GptResult,
  rebuttal?: RebuttalResult,
  counter?: CounterResult,
  round = 1,
  social?: SocialSentiment
): Promise<JudgeResult> {
'@

$nJudgeSigOld = Norm $judgeSigOld
$nJudgeSigNew = Norm $judgeSigNew
$nPipe = Norm $pipelineContent

if ($nPipe -match "round = 1,\s*\n\s*social\?: SocialSentiment") {
    Write-Host "  [ok] runJudge already accepts social" -ForegroundColor DarkGray
} elseif ($nPipe.Contains($nJudgeSigOld)) {
    $nPipe = $nPipe.Replace($nJudgeSigOld, $nJudgeSigNew)
    $pipelineContent = $nPipe -replace "`n", "`r`n"
    Write-Host "  [+] runJudge signature updated" -ForegroundColor Green
    $totalChanges++
} else {
    Write-Host "  [WARN] runJudge signature not found" -ForegroundColor Yellow
}

# ── EDIT 12: Inject social into Judge prompt ──
$judgePromptOld = @'
NEWS SCOUT: ${gemini.sentiment} sentiment, ${gemini.confidence}% confidence
${gemini.summary}
Regime: ${gemini.regimeAssessment}

━━━ ROUND 1 ━━━
'@

$judgePromptNew = @'
NEWS SCOUT: ${gemini.sentiment} sentiment, ${gemini.confidence}% confidence
${gemini.summary}
Regime: ${gemini.regimeAssessment}

${social ? formatSocialSentimentForPrompt(social, 'judge') : ''}

━━━ ROUND 1 ━━━
'@

$nJudgePOld = Norm $judgePromptOld
$nJudgePNew = Norm $judgePromptNew
$nPipe = Norm $pipelineContent

if ($nPipe -match "formatSocialSentimentForPrompt\(social, 'judge'\)") {
    Write-Host "  [ok] Judge already sees social" -ForegroundColor DarkGray
} elseif ($nPipe.Contains($nJudgePOld)) {
    $nPipe = $nPipe.Replace($nJudgePOld, $nJudgePNew)
    $pipelineContent = $nPipe -replace "`n", "`r`n"
    Write-Host "  [+] Judge prompt includes social sentiment" -ForegroundColor Green
    $totalChanges++
} else {
    Write-Host "  [WARN] Judge prompt anchor not found" -ForegroundColor Yellow
}

# ── EDIT 13: Pass social to runJudge call site ──
$judgeCallOld = "  const judge = await runJudge(bundle, gemini, claude, gpt, rebuttal, counter, 1)"
$judgeCallNew = "  const judge = await runJudge(bundle, gemini, claude, gpt, rebuttal, counter, 1, social)"

if ($pipelineContent -match "runJudge\(bundle, gemini, claude, gpt, rebuttal, counter, 1, social\)") {
    Write-Host "  [ok] runPipeline already passes social to Judge" -ForegroundColor DarkGray
} elseif ($pipelineContent.Contains($judgeCallOld)) {
    $pipelineContent = $pipelineContent.Replace($judgeCallOld, $judgeCallNew)
    Write-Host "  [+] runPipeline passes social to Judge" -ForegroundColor Green
    $totalChanges++
} else {
    Write-Host "  [WARN] runJudge call site not found" -ForegroundColor Yellow
}

# ── Write pipeline.ts ──
if ($pipelineContent -ne $originalPipeline) {
    if ($Apply) {
        [System.IO.File]::WriteAllText($pipelinePath, $pipelineContent, [System.Text.UTF8Encoding]::new($false))
        Write-Host "  WROTE $pipelineFile" -ForegroundColor Green
    } else {
        Write-Host "  (dry run - not written)" -ForegroundColor Yellow
    }
}

# ════════════════════════════════════════════════════════════════
# FILE 2: app/api/analysis/route.ts
# ════════════════════════════════════════════════════════════════

$routePath = (Resolve-Path $routeFile).Path
$routeContent = [System.IO.File]::ReadAllText($routePath, [System.Text.UTF8Encoding]::new($false))
$originalRoute = $routeContent

Write-Host ""
Write-Host "=== analyze/route.ts ===" -ForegroundColor Cyan

# ── EDIT 14: Add runSocialScout import ──
$rImportOld = "import { runPipeline } from '@/app/lib/pipeline'"
$rImportNew = "import { runPipeline } from '@/app/lib/pipeline'`r`nimport { runSocialScout } from '@/app/lib/social-scout'"

if ($routeContent -match "import \{ runSocialScout \} from '@/app/lib/social-scout'") {
    Write-Host "  [ok] runSocialScout import already present" -ForegroundColor DarkGray
} elseif ($routeContent.Contains($rImportOld)) {
    $routeContent = $routeContent.Replace($rImportOld, $rImportNew)
    Write-Host "  [+] Added runSocialScout import" -ForegroundColor Green
    $totalChanges++
} else {
    Write-Host "  [WARN] route import anchor not found" -ForegroundColor Yellow
}

# ── EDIT 15: Cache-hit re-runs fresh Social Scout (Option 2) ──
$cacheOld = @'
            // Stream each AI stage result with a small delay so the UI animates
            await new Promise(r => setTimeout(r, 300))
            send('gemini_done', cached.gemini_news)
'@

$cacheNew = @'
            // Option 2: re-run Social Scout even on cache hit (sentiment decays fast).
            // Runs in parallel with cached replay so UI stays snappy. Non-blocking.
            const freshSocialPromise = runSocialScout(symbol, cached.price ?? 0, tf)
              .then(fresh => send('grok_done', fresh))
              .catch(() => { /* silent fallback - social is optional */ })

            // Stream each AI stage result with a small delay so the UI animates
            await new Promise(r => setTimeout(r, 300))
            send('gemini_done', cached.gemini_news)

            // Ensure social promise doesn't leak if user disconnects
            void freshSocialPromise
'@

$nCacheOld = Norm $cacheOld
$nCacheNew = Norm $cacheNew
$nRoute = Norm $routeContent

if ($nRoute -match "freshSocialPromise") {
    Write-Host "  [ok] cache-hit social refresh already present" -ForegroundColor DarkGray
} elseif ($nRoute.Contains($nCacheOld)) {
    $nRoute = $nRoute.Replace($nCacheOld, $nCacheNew)
    $routeContent = $nRoute -replace "`n", "`r`n"
    Write-Host "  [+] Cache hit triggers fresh Social Scout" -ForegroundColor Green
    $totalChanges++
} else {
    Write-Host "  [WARN] cache-hit anchor not found" -ForegroundColor Yellow
}

# ── EDIT 16: Save social_sentiment on live run insert ──
$insertOld = @'
          claude_analysis: result.claude,
          gpt_validation: result.gpt,
'@

$insertNew = @'
          claude_analysis: result.claude,
          gpt_validation: result.gpt,
          social_sentiment: result.social,
'@

$nInsertOld = Norm $insertOld
$nInsertNew = Norm $insertNew
$nRoute = Norm $routeContent

if ($nRoute -match "social_sentiment: result\.social") {
    Write-Host "  [ok] social_sentiment save already present" -ForegroundColor DarkGray
} elseif ($nRoute.Contains($nInsertOld)) {
    $nRoute = $nRoute.Replace($nInsertOld, $nInsertNew)
    $routeContent = $nRoute -replace "`n", "`r`n"
    Write-Host "  [+] social_sentiment saved to analyses row" -ForegroundColor Green
    $totalChanges++
} else {
    Write-Host "  [WARN] insert block anchor not found" -ForegroundColor Yellow
}

# ── Write route.ts ──
if ($routeContent -ne $originalRoute) {
    if ($Apply) {
        [System.IO.File]::WriteAllText($routePath, $routeContent, [System.Text.UTF8Encoding]::new($false))
        Write-Host "  WROTE $routeFile" -ForegroundColor Green
    } else {
        Write-Host "  (dry run - not written)" -ForegroundColor Yellow
    }
}

# ════════════════════════════════════════════════════════════════
# SUMMARY
# ════════════════════════════════════════════════════════════════

Write-Host ""
Write-Host "=== Summary ===" -ForegroundColor Cyan
if ($Apply) {
    Write-Host "Mode: APPLY" -ForegroundColor Green
} else {
    Write-Host "Mode: DRY RUN" -ForegroundColor Yellow
}
Write-Host "Total edits applied: $totalChanges / 16" -ForegroundColor Cyan

if (-not $Apply) {
    Write-Host ""
    Write-Host "To apply:  .\apply-social-scout.ps1 -Apply" -ForegroundColor White
} else {
    Write-Host ""
    Write-Host "Next steps:" -ForegroundColor White
    Write-Host "  1. Ensure XAI_API_KEY is in Railway env vars" -ForegroundColor White
    Write-Host "  2. Run SQL migration in Supabase:" -ForegroundColor White
    Write-Host "     ALTER TABLE analyses ADD COLUMN IF NOT EXISTS social_sentiment jsonb;" -ForegroundColor Gray
    Write-Host "  3. npm run build" -ForegroundColor White
    Write-Host "  4. Test locally with one ticker before committing" -ForegroundColor White
    Write-Host "  5. git add . && git commit && git push" -ForegroundColor White
}
