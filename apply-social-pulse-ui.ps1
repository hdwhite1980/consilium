# apply-social-pulse-ui.ps1
# Wires the Social Pulse card into the main debate dashboard.
#
# What this does to app/page.tsx:
#   1. Adds SocialSentiment import from '@/app/lib/social-scout'
#   2. Adds `soc` state hook and `socOpen` UI state
#   3. Adds 'grok' to the Stage type
#   4. Adds grok_done handler to BOTH SSE loops (initial + forceRun)
#   5. Resets soc state on forceRun reset
#   6. Adds 'grok' step to the STEPS progress array (after News Scout)
#   7. Persists soc to sessionStorage
#   8. Restores soc from sessionStorage
#   9. Adds the SocialPulse Collapsible card render right after News Scout
#
# Usage:
#   .\apply-social-pulse-ui.ps1           (dry run)
#   .\apply-social-pulse-ui.ps1 -Apply    (actually write)

param([switch]$Apply)

$ErrorActionPreference = 'Stop'

$pageFile = 'app\page.tsx'

if (-not (Test-Path $pageFile)) {
    Write-Host "ERROR: $pageFile not found. Run from repo root." -ForegroundColor Red
    exit 1
}

$pagePath = (Resolve-Path $pageFile).Path
$content = [System.IO.File]::ReadAllText($pagePath, [System.Text.UTF8Encoding]::new($false))
$original = $content

$totalChanges = 0

function Norm([string]$s) { $s -replace "`r`n", "`n" }

Write-Host ""
Write-Host "=== app/page.tsx ===" -ForegroundColor Cyan

# ── EDIT 1: Add Stage type variant for 'grok' ──
$stageOld = "type Stage  = 'idle' | 'building' | 'gemini' | 'claude' | 'gpt' | 'judge' | 'done' | 'error'"
$stageNew = "type Stage  = 'idle' | 'building' | 'gemini' | 'grok' | 'claude' | 'gpt' | 'judge' | 'done' | 'error'"

if ($content -match "'gemini' \| 'grok' \|") {
    Write-Host "  [ok] Stage type already has 'grok'" -ForegroundColor DarkGray
} elseif ($content.Contains($stageOld)) {
    $content = $content.Replace($stageOld, $stageNew)
    Write-Host "  [+] Added 'grok' to Stage type" -ForegroundColor Green
    $totalChanges++
} else {
    Write-Host "  [WARN] Stage type anchor not found" -ForegroundColor Yellow
}

# ── EDIT 2: Add soc state hook ──
$stateOld = "  const [jud, setJud]           = useState<JudgeResult | null>(null)"
$stateNew = "  const [jud, setJud]           = useState<JudgeResult | null>(null)`r`n  const [soc, setSoc]           = useState<SocialSentiment | null>(null)`r`n  const [socOpen, setSocOpen]   = useState(false)"

if ($content -match "const \[soc, setSoc\]") {
    Write-Host "  [ok] soc state hook already present" -ForegroundColor DarkGray
} elseif ($content.Contains($stateOld)) {
    $content = $content.Replace($stateOld, $stateNew)
    Write-Host "  [+] Added soc + socOpen state hooks" -ForegroundColor Green
    $totalChanges++
} else {
    Write-Host "  [WARN] state hook anchor not found" -ForegroundColor Yellow
}

# ── EDIT 3: Add SocialSentiment import ──
# We look for an existing type-only import from pipeline and append alongside.
# Most apps have `import type { GeminiResult, ClaudeResult... } from '@/app/lib/pipeline'`.
# Simpler: add a standalone import right after 'use client' at the top.

$usesClient = "'use client'"
if ($content -match "import .* SocialSentiment .* from '@/app/lib/social-scout'") {
    Write-Host "  [ok] SocialSentiment import already present" -ForegroundColor DarkGray
} else {
    # Find the first import statement and insert ours right before it
    $firstImport = [regex]::Match($content, "^import ", [System.Text.RegularExpressions.RegexOptions]::Multiline)
    if ($firstImport.Success) {
        $insertAt = $firstImport.Index
        $importLine = "import type { SocialSentiment } from '@/app/lib/social-scout'`r`n"
        $content = $content.Insert($insertAt, $importLine)
        Write-Host "  [+] Added SocialSentiment import at top" -ForegroundColor Green
        $totalChanges++
    } else {
        Write-Host "  [WARN] could not find import block" -ForegroundColor Yellow
    }
}

# ── EDIT 4: Add grok_done handler to FIRST SSE loop ──
# Anchor: the gemini_done line in the first loop
$sse1Old = @'
            case 'gemini_start': setStage('gemini'); scroll(); break
            case 'gemini_done':  setGem(data); scroll(); break
'@

$sse1New = @'
            case 'gemini_start': setStage('gemini'); scroll(); break
            case 'gemini_done':  setGem(data); scroll(); break
            case 'grok_start':   setStage('grok'); scroll(); break
            case 'grok_done':    setSoc(data); scroll(); break
'@

$nSse1Old = Norm $sse1Old
$nSse1New = Norm $sse1New
$nContent = Norm $content

# Count occurrences — should be 2 (in both SSE loops)
$matches = ([regex]::Matches($nContent, [regex]::Escape($nSse1Old))).Count

if ($nContent -match "case 'grok_done':\s+setSoc") {
    Write-Host "  [ok] grok_done handler already present in SSE loops" -ForegroundColor DarkGray
} elseif ($matches -eq 2) {
    # Replace ALL occurrences (both loops get the same patch)
    $nContent = $nContent.Replace($nSse1Old, $nSse1New)
    $content = $nContent -replace "`n", "`r`n"
    Write-Host "  [+] Added grok_start/grok_done to both SSE loops" -ForegroundColor Green
    $totalChanges += 2
} elseif ($matches -eq 1) {
    $nContent = $nContent.Replace($nSse1Old, $nSse1New)
    $content = $nContent -replace "`n", "`r`n"
    Write-Host "  [+] Added grok handlers to ONE SSE loop (expected 2)" -ForegroundColor Yellow
    $totalChanges++
} else {
    Write-Host "  [WARN] SSE loop anchor not found ($matches matches)" -ForegroundColor Yellow
}

# ── EDIT 5: Reset soc state in forceRun ──
$resetOld = "setStage('building'); setStatus(''); setMd(null); setGem(null); setCla(null); setGpt(null); setReb(null); setCtr(null); setJud(null); setErr(null); setCached(null)"
$resetNew = "setStage('building'); setStatus(''); setMd(null); setGem(null); setCla(null); setGpt(null); setReb(null); setCtr(null); setJud(null); setSoc(null); setErr(null); setCached(null)"

if ($content -match "setSoc\(null\); setErr") {
    Write-Host "  [ok] soc reset already present" -ForegroundColor DarkGray
} elseif ($content.Contains($resetOld)) {
    $content = $content.Replace($resetOld, $resetNew)
    Write-Host "  [+] soc now reset on forceRun" -ForegroundColor Green
    $totalChanges++
} else {
    Write-Host "  [WARN] reset anchor not found" -ForegroundColor Yellow
}

# ── EDIT 6: Add 'grok' step to STEPS progress array ──
$stepsOld = @'
    { key: 'gemini',   label: 'News Scout' },
    { key: 'claude',   label: 'Lead Analyst' },
'@

$stepsNew = @'
    { key: 'gemini',   label: 'News Scout' },
    { key: 'grok',     label: 'Social Pulse' },
    { key: 'claude',   label: 'Lead Analyst' },
'@

$nStepsOld = Norm $stepsOld
$nStepsNew = Norm $stepsNew
$nContent = Norm $content

if ($nContent -match "key: 'grok',\s+label: 'Social Pulse'") {
    Write-Host "  [ok] STEPS already has Social Pulse" -ForegroundColor DarkGray
} elseif ($nContent.Contains($nStepsOld)) {
    $nContent = $nContent.Replace($nStepsOld, $nStepsNew)
    $content = $nContent -replace "`n", "`r`n"
    Write-Host "  [+] Added Social Pulse step to STEPS" -ForegroundColor Green
    $totalChanges++
} else {
    Write-Host "  [WARN] STEPS anchor not found" -ForegroundColor Yellow
}

# ── EDIT 7: Persist soc to sessionStorage ──
$persistOld = "          ticker, tf, stage, md, gem, cla, gpt, reb, ctr, jud, cached"
$persistNew = "          ticker, tf, stage, md, gem, cla, gpt, reb, ctr, jud, soc, cached"

if ($content -match "ctr, jud, soc, cached") {
    Write-Host "  [ok] soc already persisted" -ForegroundColor DarkGray
} elseif ($content.Contains($persistOld)) {
    $content = $content.Replace($persistOld, $persistNew)
    Write-Host "  [+] soc persisted to sessionStorage" -ForegroundColor Green
    $totalChanges++
} else {
    Write-Host "  [WARN] persist anchor not found" -ForegroundColor Yellow
}

# ── EDIT 8: Restore soc from sessionStorage ──
$restoreOld = "          setJud(s.jud ?? null)`r`n          setCached(s.cached ?? null)"
$restoreNew = "          setJud(s.jud ?? null)`r`n          setSoc(s.soc ?? null)`r`n          setCached(s.cached ?? null)"

if ($content -match "setSoc\(s\.soc \?\? null\)") {
    Write-Host "  [ok] soc already restored" -ForegroundColor DarkGray
} elseif ($content.Contains($restoreOld)) {
    $content = $content.Replace($restoreOld, $restoreNew)
    Write-Host "  [+] soc restored from sessionStorage" -ForegroundColor Green
    $totalChanges++
} else {
    Write-Host "  [WARN] restore anchor not found" -ForegroundColor Yellow
}

# ── EDIT 9: Insert the Social Pulse card AFTER News Scout, BEFORE Lead Analyst ──
# The News Scout block ends with `</Collapsible>` followed by `)}` and a blank line,
# then the Lead Analyst comment `{/* Lead Analyst */}`. We anchor on the comment.

$cardOld = @'
            {/* Lead Analyst */}
            {stage === 'claude' && !cla && <Think label="Lead Analyst" color="#a78bfa" />}
'@

$cardNew = @'
            {/* Social Pulse — live X sentiment from Grok */}
            {stage === 'grok' && !soc && <Think label="Social Pulse" color="#1d9bf0" />}
            {soc && !soc.isFallback && (
              <Collapsible
                title="Social Pulse"
                icon={<span className="text-xs font-bold">X</span>}
                color="#1d9bf0"
                badge={<><span className="text-[10px] font-mono px-2 py-0.5 rounded-full" style={{ background: 'rgba(29,155,240,0.12)', color: '#1d9bf0' }}>{soc.overallMood}</span><span className="text-[10px] font-mono ml-1" style={{ color: 'var(--text3)' }}>Live · X</span></>}
                defaultOpen={false}>
              <div className="pt-2">
                <div className="flex items-center gap-2 mb-2 text-[10px] font-mono uppercase tracking-wider" style={{ color: 'var(--text3)' }}>
                  <span>Intensity: <span style={{ color: '#1d9bf0' }}>{soc.intensity}</span></span>
                  <span>·</span>
                  <span>Confidence: <span style={{ color: '#1d9bf0' }}>{soc.confidence}</span></span>
                </div>
                <p className="text-sm leading-relaxed mb-3" style={{ color: 'var(--text2)' }}>{soc.keyNarrative}</p>

                {soc.sentimentDivergence && (
                  <div className="text-xs italic mb-3 px-3 py-2 rounded-lg" style={{ background: 'rgba(29,155,240,0.08)', border: '1px solid rgba(29,155,240,0.2)', color: 'var(--text2)' }}>
                    Divergence: {soc.sentimentDivergence}
                  </div>
                )}

                {soc.bullishTalkingPoints.length > 0 && (
                  <div className="mb-3">
                    <div className="text-[10px] font-mono uppercase tracking-widest mb-1.5" style={{ color: '#34d399' }}>Bulls</div>
                    <div className="space-y-1">
                      {soc.bullishTalkingPoints.map((p, i) => (
                        <div key={i} className="text-xs flex gap-1.5" style={{ color: 'var(--text3)' }}>
                          <span className="text-[8px] mt-0.5 shrink-0" style={{ color: '#34d39960' }}>●</span>{p}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {soc.bearishTalkingPoints.length > 0 && (
                  <div className="mb-3">
                    <div className="text-[10px] font-mono uppercase tracking-widest mb-1.5" style={{ color: '#f87171' }}>Bears</div>
                    <div className="space-y-1">
                      {soc.bearishTalkingPoints.map((p, i) => (
                        <div key={i} className="text-xs flex gap-1.5" style={{ color: 'var(--text3)' }}>
                          <span className="text-[8px] mt-0.5 shrink-0" style={{ color: '#f8717160' }}>●</span>{p}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {soc.notableVoices.length > 0 && (
                  <div className="mb-3">
                    <div className="text-[10px] font-mono uppercase tracking-widest mb-1.5" style={{ color: 'var(--text3)' }}>Notable voices</div>
                    <div className="space-y-1.5">
                      {soc.notableVoices.map((v, i) => {
                        const voiceColor = v.stance === 'bullish' ? '#34d399' : v.stance === 'bearish' ? '#f87171' : 'var(--text3)'
                        return (
                          <div key={i} className="text-xs flex gap-2 items-start">
                            <span className="font-mono font-bold shrink-0" style={{ color: voiceColor }}>{v.handle}</span>
                            <span className="leading-relaxed" style={{ color: 'var(--text2)' }}>{v.claim}</span>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )}

                {soc.fadeSignals.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mb-2">
                    {soc.fadeSignals.map((f, i) => <Chip key={i} label={`fade: ${f}`} color="#fbbf24" />)}
                  </div>
                )}

                <div className="text-xs italic border-t pt-2" style={{ borderColor: 'var(--border)', color: 'var(--text3)' }}>
                  Retail vs pro: {soc.retailVsPro}
                </div>

                <div className="text-[10px] font-mono mt-2" style={{ color: 'var(--text3)' }}>
                  Live from X · Grok · {new Date(soc.collectedAt).toLocaleTimeString()}
                </div>
              </div>
              </Collapsible>
            )}

            {/* Lead Analyst */}
            {stage === 'claude' && !cla && <Think label="Lead Analyst" color="#a78bfa" />}
'@

$nCardOld = Norm $cardOld
$nCardNew = Norm $cardNew
$nContent = Norm $content

if ($nContent -match "Social Pulse .* live X sentiment") {
    Write-Host "  [ok] Social Pulse card already rendered" -ForegroundColor DarkGray
} elseif ($nContent.Contains($nCardOld)) {
    $nContent = $nContent.Replace($nCardOld, $nCardNew)
    $content = $nContent -replace "`n", "`r`n"
    Write-Host "  [+] Social Pulse card inserted after News Scout" -ForegroundColor Green
    $totalChanges++
} else {
    Write-Host "  [WARN] card insertion anchor not found" -ForegroundColor Yellow
}

# ── Write ──
if ($content -ne $original) {
    if ($Apply) {
        [System.IO.File]::WriteAllText($pagePath, $content, [System.Text.UTF8Encoding]::new($false))
        Write-Host "  WROTE $pageFile" -ForegroundColor Green
    } else {
        Write-Host "  (dry run - not written)" -ForegroundColor Yellow
    }
}

Write-Host ""
Write-Host "=== Summary ===" -ForegroundColor Cyan
if ($Apply) {
    Write-Host "Mode: APPLY" -ForegroundColor Green
} else {
    Write-Host "Mode: DRY RUN" -ForegroundColor Yellow
}
Write-Host "Total edits applied: $totalChanges" -ForegroundColor Cyan

if (-not $Apply) {
    Write-Host ""
    Write-Host "To apply:  .\apply-social-pulse-ui.ps1 -Apply" -ForegroundColor White
} else {
    Write-Host ""
    Write-Host "Next: npm run build" -ForegroundColor White
}
