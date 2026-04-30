# apply-trader-card-ui.ps1
# Adds the Trader Assessment card UI to app/page.tsx.
#
# What this does:
#   1. Imports TraderVerdict type from @/app/lib/trader
#   2. Adds const [trader, setTrader] = useState near existing state hooks
#   3. Adds 'trader_done' SSE handler to BOTH switch blocks (initial run + forceRun)
#   4. Adds setTrader(null) to BOTH state-reset lines
#   5. Renders the Trader Assessment card between Council Verdict and Trade Plan
#
# Anchors verified against actual app/page.tsx structure:
#   line 321 — useState<JudgeResult>
#   lines 472, 528 — setJud(null) reset lines
#   lines 501, 553 — grok_done SSE handlers
#   line 1721 — TRADE PLAN comment
#
# Safety: all-or-nothing. Dry-runs every edit; only writes if all succeed.
#
# Usage:
#   .\apply-trader-card-ui.ps1           (dry run)
#   .\apply-trader-card-ui.ps1 -Apply    (writes only if all 6 edits match)

param([switch]$Apply)
$ErrorActionPreference = 'Stop'

if (-not (Test-Path 'app\page.tsx')) {
    Write-Host "ERROR: app\page.tsx not found. Run from repo root." -ForegroundColor Red
    exit 1
}
if (-not (Test-Path 'app\lib\trader.ts')) {
    Write-Host "ERROR: app\lib\trader.ts not found. Backend must be applied first." -ForegroundColor Red
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

# ─────────────────────────────────────────────────────────────
# EDIT 1 — Add TraderVerdict import
# Anchor: the existing useState<JudgeResult> declaration. We add the
# import as a new line right at the top of the state hooks section,
# which is also where the other type imports get used. This is safer
# than trying to find the import block at the top of the file (which
# could be 50+ lines long with many variations).
#
# We add it as a separate type import statement just above the state
# hook line. TS will hoist this regardless of where it appears in the
# file, so it works even though it's not at the top.
# ─────────────────────────────────────────────────────────────
Plan-Edit `
    -Path 'app\page.tsx' `
    -EditName '1. Add TraderVerdict type import' `
    -AlreadyAppliedPattern "import type \{ TraderVerdict \}" `
    -Old @'
  const [jud, setJud]           = useState<JudgeResult | null>(null)
  const [verify, setVerify]     = useState<{ totalVerified: number; totalStripped: number; allSourceUrls: string[] } | null>(null)
  const [soc, setSoc]           = useState<SocialSentiment | null>(null)
  const [socOpen, setSocOpen]   = useState(false)
'@ `
    -New @'
  const [jud, setJud]           = useState<JudgeResult | null>(null)
  const [verify, setVerify]     = useState<{ totalVerified: number; totalStripped: number; allSourceUrls: string[] } | null>(null)
  const [soc, setSoc]           = useState<SocialSentiment | null>(null)
  const [socOpen, setSocOpen]   = useState(false)
  const [trader, setTrader]     = useState<TraderVerdict | null>(null)
'@

# ─────────────────────────────────────────────────────────────
# EDIT 1b — Actually add the import statement at the top of file
# We anchor on a known existing import. Using SocialSentiment as the
# anchor since it's used in the same useState that's near our trader
# state. If this anchor misses, the user can manually add the import.
# ─────────────────────────────────────────────────────────────
Plan-Edit `
    -Path 'app\page.tsx' `
    -EditName '2. Add TraderVerdict import statement at top of file' `
    -AlreadyAppliedPattern "from '@/app/lib/trader'" `
    -Old @'
'use client'
'@ `
    -New @'
'use client'
import type { TraderVerdict } from '@/app/lib/trader'
'@

# ─────────────────────────────────────────────────────────────
# EDIT 2 — Add 'trader_done' SSE handler to FIRST switch block
# Each occurrence of `grok_done` is identical, so we anchor with
# enough surrounding context to disambiguate. The first occurrence
# is at line 500-501; we anchor on the preceding line 472 marker
# context (this is the FIRST reset line, before the FIRST switch).
#
# Strategy: anchor on the unique 5-line block that contains
# grok_start, grok_done, claude_start, claude_done, gpt_start.
# This 5-line block appears identically TWICE — but since the
# old code is identical in both places, the SAME replacement
# works for both. We do TWO Plan-Edit calls with the same anchor;
# the second .Replace() finds the still-unmodified instance.
#
# But Replace() only replaces the FIRST occurrence. So we use the
# .NET String.Replace with no count limit, which replaces ALL
# occurrences — exactly what we want here. The Norm-then-Replace
# pattern in the script handles this correctly because
# String.Replace(string, string) replaces every occurrence.
# ─────────────────────────────────────────────────────────────
Plan-Edit `
    -Path 'app\page.tsx' `
    -EditName '3. Add trader_done SSE handler to BOTH switch blocks' `
    -AlreadyAppliedPattern "case 'trader_done'" `
    -Old @'
            case 'grok_start':   setStage('grok'); scroll(); break
            case 'grok_done':    setSoc(data); scroll(); break
            case 'claude_start': setStage('claude'); scroll(); break
            case 'claude_done':  setCla(data); scroll(); break
'@ `
    -New @'
            case 'grok_start':   setStage('grok'); scroll(); break
            case 'grok_done':    setSoc(data); scroll(); break
            case 'trader_start': /* trader runs after judge */ break
            case 'trader_done':  setTrader(data); scroll(); break
            case 'claude_start': setStage('claude'); scroll(); break
            case 'claude_done':  setCla(data); scroll(); break
'@

# ─────────────────────────────────────────────────────────────
# EDIT 3 — Add setTrader(null) to BOTH state reset lines
# The reset line is identical in both places (lines 473 and 528),
# so we use the same trick — String.Replace replaces all occurrences.
# Anchor: the full setJud reset chain.
# ─────────────────────────────────────────────────────────────
Plan-Edit `
    -Path 'app\page.tsx' `
    -EditName '4. Add setTrader(null) to BOTH reset lines' `
    -AlreadyAppliedPattern "setTrader\(null\)" `
    -Old "setStage('building'); setStatus(''); setMd(null); setGem(null); setCla(null); setGpt(null); setReb(null); setCtr(null); setJud(null); setSoc(null); setErr(null); setCached(null); setVerify(null)" `
    -New "setStage('building'); setStatus(''); setMd(null); setGem(null); setCla(null); setGpt(null); setReb(null); setCtr(null); setJud(null); setSoc(null); setErr(null); setCached(null); setVerify(null); setTrader(null)"

# ─────────────────────────────────────────────────────────────
# EDIT 4 — Insert the Trader Assessment JSX
# Anchor: the unique TRADE PLAN comment on line 1721.
# We insert the entire trader card block BEFORE the comment so
# the card renders between Council Verdict and Trade Plan.
# ─────────────────────────────────────────────────────────────
Plan-Edit `
    -Path 'app\page.tsx' `
    -EditName '5. Insert Trader Assessment JSX before Trade Plan' `
    -AlreadyAppliedPattern "Trader Assessment" `
    -Old @'
                {/* ── TRADE PLAN — prominent, right under verdict ── */}
'@ `
    -New @'
                {/* ── TRADER ASSESSMENT — between Council Verdict and Trade Plan ── */}
                {trader && (
                  <div className="rounded-2xl p-4 mt-1" style={{
                    background: trader.decision === 'TAKE' ? 'rgba(52,211,153,0.08)'
                              : trader.decision === 'WAIT' ? 'rgba(251,191,36,0.08)'
                              : 'rgba(248,113,113,0.08)',
                    border: `2px solid ${
                      trader.decision === 'TAKE' ? 'rgba(52,211,153,0.3)'
                      : trader.decision === 'WAIT' ? 'rgba(251,191,36,0.3)'
                      : 'rgba(248,113,113,0.3)'}`
                  }}>
                    <div className="flex items-center gap-2 flex-wrap mb-3">
                      <span className="text-[10px] font-mono uppercase tracking-widest" style={{
                        color: trader.decision === 'TAKE' ? '#34d399'
                             : trader.decision === 'WAIT' ? '#fbbf24'
                             : '#f87171'
                      }}>
                        Trader Assessment
                      </span>
                      <span className="font-mono font-bold text-lg px-2.5 py-0.5 rounded-full" style={{
                        background: trader.decision === 'TAKE' ? 'rgba(52,211,153,0.15)'
                                  : trader.decision === 'WAIT' ? 'rgba(251,191,36,0.15)'
                                  : 'rgba(248,113,113,0.15)',
                        color: trader.decision === 'TAKE' ? '#34d399'
                             : trader.decision === 'WAIT' ? '#fbbf24'
                             : '#f87171',
                        border: `1px solid ${
                          trader.decision === 'TAKE' ? '#34d39940'
                          : trader.decision === 'WAIT' ? '#fbbf2440'
                          : '#f8717140'}`
                      }}>
                        {trader.decision}
                      </span>
                      {trader.grade && (
                        <span className="text-xs font-mono px-2 py-0.5 rounded-full" style={{
                          background: 'rgba(255,255,255,0.05)',
                          color: 'var(--text)',
                          border: '1px solid rgba(255,255,255,0.1)'
                        }}>
                          Grade {trader.grade}
                        </span>
                      )}
                      {trader.decision === 'TAKE' && trader.positionSizePct > 0 && (
                        <span className="text-xs font-mono" style={{ color: 'var(--text2)' }}>
                          {Math.round(trader.positionSizePct * 100)}% position size
                        </span>
                      )}
                      {trader.riskReward !== null && trader.riskReward > 0 && (
                        <span className="ml-auto text-xs font-mono" style={{ color: 'var(--text3)' }}>
                          R:R {trader.riskReward.toFixed(2)}:1
                        </span>
                      )}
                    </div>
                    {trader.rationale && (
                      <p className="text-sm leading-relaxed mb-3" style={{ color: 'var(--text)' }}>
                        {trader.rationale}
                      </p>
                    )}
                    {trader.passReasons && trader.passReasons.length > 0 && (
                      <div className="space-y-1.5">
                        <div className="text-[10px] font-mono uppercase tracking-widest" style={{ color: 'var(--text3)' }}>
                          Why
                        </div>
                        {trader.passReasons.map((reason: string, i: number) => (
                          <div key={i} className="text-xs flex gap-2 leading-relaxed" style={{ color: 'var(--text2)' }}>
                            <span style={{ color: '#f87171', flexShrink: 0 }}>•</span>
                            <span>{reason}</span>
                          </div>
                        ))}
                      </div>
                    )}
                    {trader.waitConditions && trader.waitConditions.length > 0 && (
                      <div className="space-y-1.5 mt-3">
                        <div className="text-[10px] font-mono uppercase tracking-widest" style={{ color: '#fbbf24' }}>
                          What Would Change This
                        </div>
                        {trader.waitConditions.map((condition: string, i: number) => (
                          <div key={i} className="text-xs flex gap-2 leading-relaxed" style={{ color: 'var(--text2)' }}>
                            <span style={{ color: '#fbbf24', flexShrink: 0 }}>→</span>
                            <span>{condition}</span>
                          </div>
                        ))}
                      </div>
                    )}
                    {trader.diagnostics?.setupType && trader.diagnostics.setupType !== 'unknown' && (
                      <div className="mt-3 pt-3 border-t text-[10px] font-mono" style={{
                        borderColor: 'rgba(255,255,255,0.05)',
                        color: 'var(--text3)'
                      }}>
                        Setup: {trader.diagnostics.setupType.replace('_', ' ')}
                        {trader.diagnostics.conflicts && trader.diagnostics.conflicts.length > 0 && (
                          <> · {trader.diagnostics.conflicts.length} conflict{trader.diagnostics.conflicts.length === 1 ? '' : 's'} flagged</>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {/* ── TRADE PLAN — prominent, right under verdict ── */}
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
        # String.Replace replaces ALL occurrences — perfect for the
        # double-occurrence anchors (state reset and SSE handler).
        $newWork = $workNorm.Replace($oldNorm, $newNorm) -replace "`n", "`r`n"
        $fileWork[$path] = $newWork
        $results += [pscustomobject]@{ Path=$path; Name=$edit.Name; Status='applied'; Detail='' }
    } else {
        $results += [pscustomobject]@{ Path=$path; Name=$edit.Name; Status='MISS'; Detail='anchor not found' }
    }
}

# ═════════════════════════════════════════════════════════════
# Report
# ═════════════════════════════════════════════════════════════
Write-Host ""
Write-Host "=== Trader card UI integration ===" -ForegroundColor Cyan
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

if ($Apply) {
    foreach ($entry in $fileWork.GetEnumerator()) {
        $abs = (Resolve-Path $entry.Key).Path
        [System.IO.File]::WriteAllText($abs, $entry.Value, [System.Text.UTF8Encoding]::new($false))
    }
    Write-Host ""
    Write-Host "  WROTE $($fileWork.Count) file(s) — $applied edit(s) applied" -ForegroundColor Green
    Write-Host ""
    Write-Host "Next: npm run build" -ForegroundColor Cyan
} else {
    Write-Host ""
    Write-Host "DRY RUN — re-run with -Apply to write." -ForegroundColor Yellow
}
