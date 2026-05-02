# =============================================================
# apply-add-cash.ps1
#
# Applies all six patches to app/invest/page.tsx for the
# "Add cash" capital adjustment feature.
#
# This script is CRLF-aware — uses regex with explicit \r\n
# matching the actual line endings of app/invest/page.tsx.
#
# Usage:
#   .\apply-add-cash.ps1          (dry run)
#   .\apply-add-cash.ps1 -Apply   (write changes)
#
# All anchors verified to match exactly once against the
# uploaded current file. If any anchor reports SKIP or ERROR,
# stop and re-upload the file rather than attempting recovery.
# =============================================================

param([switch]$Apply)

$ErrorActionPreference = 'Stop'
$file = 'app\invest\page.tsx'

if (-not (Test-Path $file)) {
  Write-Host "ERROR: $file not found. Run from repo root." -ForegroundColor Red
  exit 1
}

# Read raw bytes -> string. Preserves whatever line endings the file uses.
$bytes   = [System.IO.File]::ReadAllBytes((Resolve-Path $file).Path)
$content = [System.Text.UTF8Encoding]::new($false).GetString($bytes)
$original = $content
$applied = 0
$skipped = 0
$errored = 0

$useCrlf = $content.Contains("`r`n")
Write-Host "Detected line endings: $(if ($useCrlf) { 'CRLF' } else { 'LF' })" -ForegroundColor Cyan
Write-Host ""

# ──────────────────────────────────────────────────────────────
# Helper: regex-based single-occurrence replacement
# ──────────────────────────────────────────────────────────────
function Apply-Patch {
  param(
    [Parameter(Mandatory=$true)] [string] $Name,
    [Parameter(Mandatory=$true)] [string] $Pattern,
    [Parameter(Mandatory=$true)] [string] $Replacement
  )
  $rx = [regex]::new($Pattern, [System.Text.RegularExpressions.RegexOptions]::Singleline)
  $matches = $rx.Matches($script:content)
  if ($matches.Count -eq 0) {
    Write-Host "  SKIP $Name : pattern not found" -ForegroundColor Yellow
    $script:skipped++
    return
  }
  if ($matches.Count -gt 1) {
    Write-Host "  ERROR $Name : pattern matches $($matches.Count) times, refusing" -ForegroundColor Red
    $script:errored++
    return
  }
  # Use a literal substitution callback (the replacement string contains
  # characters that would otherwise be interpreted as backreferences).
  $m = $matches[0]
  $script:content = $script:content.Remove($m.Index, $m.Length).Insert($m.Index, $Replacement)
  $script:applied++
  Write-Host "  OK   $Name" -ForegroundColor Green
}

# ──────────────────────────────────────────────────────────────
# Helper: convert a "logical" replacement (using LF) to match the
# file's actual line endings
# ──────────────────────────────────────────────────────────────
function To-FileLineEndings {
  param([string] $Text)
  # Normalize to LF first
  $normalized = $Text -replace "`r`n", "`n" -replace "`r", "`n"
  if ($useCrlf) {
    return $normalized -replace "`n", "`r`n"
  }
  return $normalized
}

# ─────────────────────────────────────────────────────────────
# Patch 1 — state hooks
# Insert AFTER the closeTarget state declaration line.
# Matches the FULL line including its trailing line-end so we
# can place new lines immediately after.
# ─────────────────────────────────────────────────────────────
$pat1 = '(  const \[closeTarget, setCloseTarget\] = useState<Trade \| null>\(null\)\r?\n)'
$add1 = To-FileLineEndings @'
  const [addCashOpen, setAddCashOpen] = useState(false)
  const [addCashSubmitting, setAddCashSubmitting] = useState(false)

'@
$rx = [regex]::new($pat1)
$matches = $rx.Matches($content)
if ($matches.Count -eq 1) {
  $m = $matches[0]
  # Keep the captured group (original line including newline) + add new lines after
  $content = $content.Remove($m.Index, $m.Length).Insert($m.Index, $m.Groups[1].Value + $add1)
  $applied++
  Write-Host "  OK   state hooks" -ForegroundColor Green
} elseif ($matches.Count -eq 0) {
  Write-Host "  SKIP state hooks : pattern not found" -ForegroundColor Yellow
  $skipped++
} else {
  Write-Host "  ERROR state hooks : pattern matches $($matches.Count) times" -ForegroundColor Red
  $errored++
}

# ─────────────────────────────────────────────────────────────
# Patch 2 — addCash handler, AFTER setStartBalance block
# ─────────────────────────────────────────────────────────────
$pat2 = '(  const setStartBalance = async \(balance: number\) => \{\r?\n    await fetch\(''/api/invest'', \{\r?\n      method: ''POST'', headers: \{ ''Content-Type'': ''application/json'' \},\r?\n      body: JSON\.stringify\(\{ type: ''set_balance'', balance \}\),\r?\n    \}\)\r?\n    await loadData\(\)\r?\n  \})'
$add2 = To-FileLineEndings @'


  const addCash = async (amount: number): Promise<{ ok: boolean; clamped: boolean; appliedAmount: number; newBalance: number; error?: string }> => {
    setAddCashSubmitting(true)
    try {
      const res = await fetch('/api/invest/cash', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount }),
      })
      const body = await res.json()
      if (!res.ok) return { ok: false, clamped: false, appliedAmount: 0, newBalance: 0, error: body.error ?? 'request failed' }
      await loadData()
      return {
        ok: true,
        clamped: !!body.clamped,
        appliedAmount: Number(body.appliedAmount ?? 0),
        newBalance: Number(body.newBalance ?? 0),
      }
    } catch (e) {
      return { ok: false, clamped: false, appliedAmount: 0, newBalance: 0, error: (e as Error).message }
    } finally {
      setAddCashSubmitting(false)
    }
  }
'@
$rx = [regex]::new($pat2, [System.Text.RegularExpressions.RegexOptions]::Singleline)
$matches = $rx.Matches($content)
if ($matches.Count -eq 1) {
  $m = $matches[0]
  $content = $content.Remove($m.Index, $m.Length).Insert($m.Index, $m.Groups[1].Value + $add2)
  $applied++
  Write-Host "  OK   addCash handler" -ForegroundColor Green
} elseif ($matches.Count -eq 0) {
  Write-Host "  SKIP addCash handler : pattern not found" -ForegroundColor Yellow
  $skipped++
} else {
  Write-Host "  ERROR addCash handler : pattern matches $($matches.Count) times" -ForegroundColor Red
  $errored++
}

# ─────────────────────────────────────────────────────────────
# Patch 3 — modal mount alongside MarkToMarket
# ─────────────────────────────────────────────────────────────
$pat3 = '(      \{closeTarget && <MarkToMarket trade=\{closeTarget\} onClose=\{\(\) => setCloseTarget\(null\)\} onSave=\{closePosition\} />\}\r?\n)'
$add3 = To-FileLineEndings @'
      {addCashOpen && <AddCashModal currentBalance={data?.journey?.starting_balance ?? 0} submitting={addCashSubmitting} onClose={() => setAddCashOpen(false)} onSubmit={addCash} />}
'@
$rx = [regex]::new($pat3)
$matches = $rx.Matches($content)
if ($matches.Count -eq 1) {
  $m = $matches[0]
  # Insert AFTER the captured line
  $content = $content.Remove($m.Index, $m.Length).Insert($m.Index, $m.Groups[1].Value + $add3 + $(if ($useCrlf) { "`r`n" } else { "`n" }))
  $applied++
  Write-Host "  OK   modal mount" -ForegroundColor Green
} elseif ($matches.Count -eq 0) {
  Write-Host "  SKIP modal mount : pattern not found" -ForegroundColor Yellow
  $skipped++
} else {
  Write-Host "  ERROR modal mount : pattern matches $($matches.Count) times" -ForegroundColor Red
  $errored++
}

# ─────────────────────────────────────────────────────────────
# Patch 4 — Capital block INSERTED BEFORE "to next tier" metric
# ─────────────────────────────────────────────────────────────
$pat4 = '(      <div className="fl-metric-block">\r?\n        <div className="fl-metric-row">\r?\n          <span className="k">to \{tier\.nextTierName \?\? ''apex''\}</span>)'
$capitalBlock = To-FileLineEndings @'
      <div className="fl-metric-block fl-capital-block">
        <div className="fl-capital-row">
          <span className="k">capital</span>
          <button type="button" className="fl-capital-add-btn" onClick={() => setAddCashOpen(true)}>
            + add
          </button>
        </div>
        <div className="fl-capital-detail mono">
          <span>starting</span>
          <span>${(data?.journey?.starting_balance ?? 0).toFixed(2)}</span>
        </div>
      </div>


'@
$rx = [regex]::new($pat4, [System.Text.RegularExpressions.RegexOptions]::Singleline)
$matches = $rx.Matches($content)
if ($matches.Count -eq 1) {
  $m = $matches[0]
  $content = $content.Remove($m.Index, $m.Length).Insert($m.Index, $capitalBlock + $m.Groups[1].Value)
  $applied++
  Write-Host "  OK   Capital block (Sidebar)" -ForegroundColor Green
} elseif ($matches.Count -eq 0) {
  Write-Host "  SKIP Capital block (Sidebar) : pattern not found" -ForegroundColor Yellow
  $skipped++
} else {
  Write-Host "  ERROR Capital block (Sidebar) : matches $($matches.Count)" -ForegroundColor Red
  $errored++
}

# ─────────────────────────────────────────────────────────────
# Patch 5 — AddCashModal component definition
# Inserts BEFORE the "// MAIN PAGE" comment block that precedes
# `function FloorInner() {`
# ─────────────────────────────────────────────────────────────
$pat5 = '(// ═+\r?\n// MAIN PAGE\r?\n// ═+\r?\nfunction FloorInner\(\) \{)'
$modalDef = To-FileLineEndings @'
// ══════════════════════════════════════════════════════════════
// ADD CASH MODAL
// ══════════════════════════════════════════════════════════════
function AddCashModal({ currentBalance, submitting, onClose, onSubmit }: {
  currentBalance: number
  submitting: boolean
  onClose: () => void
  onSubmit: (amount: number) => Promise<{ ok: boolean; clamped: boolean; appliedAmount: number; newBalance: number; error?: string }>
}) {
  const [amount, setAmount] = useState('')
  const [mode, setMode] = useState<'deposit' | 'withdraw'>('deposit')
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const presets = mode === 'deposit' ? [10, 50, 100, 500] : [10, 25, 50]
  const num = parseFloat(amount)
  const valid = !isNaN(num) && num > 0
  const maxWithdraw = currentBalance

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const handleSubmit = async () => {
    if (!valid) return
    setError(null)
    setSuccess(null)
    const signedAmount = mode === 'deposit' ? num : -num
    const result = await onSubmit(signedAmount)
    if (!result.ok) {
      setError(result.error ?? 'failed')
      return
    }
    const verb = mode === 'deposit' ? 'Added' : 'Withdrew'
    const dollars = '$' + Math.abs(result.appliedAmount).toFixed(2)
    const newBal = '$' + result.newBalance.toFixed(2)
    if (result.clamped) {
      setSuccess('Withdrew ' + dollars + ' (clamped to available). New starting: ' + newBal + '.')
    } else {
      setSuccess(verb + ' ' + dollars + '. New starting: ' + newBal + '.')
    }
    setAmount('')
    setTimeout(onClose, 1400)
  }

  return (
    <div className="fl-ticket-overlay" onClick={onClose}>
      <div className="fl-ticket fl-cash-ticket" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="add-cash-title">
        <div className="fl-ticket-header">
          <div>
            <span className="fl-eyebrow">capital adjustment</span>
            <div className="fl-ticket-time mono">{nowETShort()}</div>
          </div>
          <button className="fl-close-btn" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </div>

        <div className="fl-ticket-body">
          <h2 id="add-cash-title" className="fl-ticket-title">
            {mode === 'deposit' ? 'Add cash to your account' : 'Withdraw from your account'}
          </h2>
          <p className="fl-ticket-sub">
            {mode === 'deposit'
              ? 'Deposits raise your starting balance and total value. Tier-up still requires passing the desk qualifications.'
              : 'Withdrawals reduce your starting balance. Cannot go below zero.'}
          </p>

          <div className="fl-cash-mode-toggle">
            <button
              type="button"
              className={'fl-cash-mode-btn ' + (mode === 'deposit' ? 'active' : '')}
              onClick={() => { setMode('deposit'); setError(null); setSuccess(null); setAmount('') }}>
              Deposit
            </button>
            <button
              type="button"
              className={'fl-cash-mode-btn ' + (mode === 'withdraw' ? 'active' : '')}
              disabled={maxWithdraw <= 0}
              onClick={() => { setMode('withdraw'); setError(null); setSuccess(null); setAmount('') }}>
              Withdraw
            </button>
          </div>

          <div className="fl-start-presets" style={{ marginTop: 4 }}>
            {presets.map(p => (
              <button
                key={p}
                type="button"
                className={'fl-preset-chip ' + (num === p ? 'active' : '')}
                onClick={() => setAmount(String(p))}>
                ${p}
              </button>
            ))}
          </div>

          <div className="fl-start-input-row" style={{ marginTop: 12 }}>
            <span className="fl-dollar">$</span>
            <input
              type="number"
              value={amount}
              onChange={e => setAmount(e.target.value)}
              placeholder="0.00"
              min="0.01"
              step="0.01"
              inputMode="decimal"
              autoFocus
            />
          </div>

          {mode === 'withdraw' && (
            <div className="fl-cash-meta mono">
              available to withdraw: ${maxWithdraw.toFixed(2)}
            </div>
          )}

          {error && <div className="fl-cash-error">{error}</div>}
          {success && <div className="fl-cash-success">{success}</div>}
        </div>

        <div className="fl-ticket-footer">
          <button className="fl-ghost-btn" onClick={onClose}>Cancel</button>
          <button
            className="fl-primary-btn"
            disabled={!valid || submitting}
            onClick={handleSubmit}>
            {submitting ? 'Processing...' : (mode === 'deposit' ? 'Confirm deposit' : 'Confirm withdrawal')}
          </button>
        </div>
      </div>
    </div>
  )
}


'@
$rx = [regex]::new($pat5, [System.Text.RegularExpressions.RegexOptions]::Singleline)
$matches = $rx.Matches($content)
if ($matches.Count -eq 1) {
  $m = $matches[0]
  $content = $content.Remove($m.Index, $m.Length).Insert($m.Index, $modalDef + $m.Groups[1].Value)
  $applied++
  Write-Host "  OK   AddCashModal component" -ForegroundColor Green
} elseif ($matches.Count -eq 0) {
  Write-Host "  SKIP AddCashModal component : pattern not found" -ForegroundColor Yellow
  $skipped++
} else {
  Write-Host "  ERROR AddCashModal component : matches $($matches.Count)" -ForegroundColor Red
  $errored++
}

# ─────────────────────────────────────────────────────────────
# Patch 6 — CSS additions, BEFORE .fl-tier-rules-body ul {
# ─────────────────────────────────────────────────────────────
$pat6 = '(      \.fl-tier-rules-body ul \{)'
$cssAdditions = To-FileLineEndings @'
      /* ── Add Cash modal + Capital block (sidebar) ───────── */
      .fl-capital-block {
        background: rgba(212, 168, 87, 0.04);
        border: 1px solid rgba(212, 168, 87, 0.18);
        border-radius: 4px;
        padding: 10px 12px;
      }
      .fl-capital-row {
        display: flex; align-items: center; justify-content: space-between;
        gap: 8px;
        margin-bottom: 6px;
      }
      .fl-capital-row .k {
        font-family: 'IBM Plex Mono', monospace;
        font-size: 10px;
        letter-spacing: 0.14em;
        text-transform: uppercase;
        color: rgba(212, 168, 87, 0.8);
        font-weight: 500;
      }
      .fl-capital-add-btn {
        font-family: 'IBM Plex Mono', monospace;
        font-size: 10px;
        letter-spacing: 0.12em;
        text-transform: uppercase;
        background: rgba(212, 168, 87, 0.12);
        border: 1px solid rgba(212, 168, 87, 0.3);
        color: #d4a857;
        padding: 4px 10px;
        border-radius: 3px;
        cursor: pointer;
        transition: all 0.15s ease;
        font-weight: 600;
      }
      .fl-capital-add-btn:hover {
        background: rgba(212, 168, 87, 0.2);
        border-color: rgba(212, 168, 87, 0.5);
      }
      .fl-capital-detail {
        display: flex; justify-content: space-between;
        font-size: 11px;
        color: rgba(226, 232, 240, 0.85);
      }
      .fl-capital-detail span:first-child {
        color: rgba(148, 163, 184, 0.6);
      }
      .fl-cash-ticket .fl-ticket-body { padding: 18px 20px; }
      .fl-cash-mode-toggle {
        display: grid; grid-template-columns: 1fr 1fr;
        gap: 0;
        background: rgba(15, 23, 42, 0.5);
        border: 1px solid rgba(148, 163, 184, 0.18);
        border-radius: 4px;
        overflow: hidden;
        margin: 14px 0 10px;
      }
      .fl-cash-mode-btn {
        background: transparent;
        border: 0;
        padding: 9px 12px;
        font-family: 'IBM Plex Mono', monospace;
        font-size: 10px;
        letter-spacing: 0.14em;
        text-transform: uppercase;
        color: rgba(148, 163, 184, 0.7);
        cursor: pointer;
        font-weight: 500;
        transition: all 0.15s ease;
      }
      .fl-cash-mode-btn:not(:last-child) {
        border-right: 1px solid rgba(148, 163, 184, 0.12);
      }
      .fl-cash-mode-btn:hover:not(:disabled) {
        background: rgba(212, 168, 87, 0.05);
        color: rgba(226, 232, 240, 0.9);
      }
      .fl-cash-mode-btn.active {
        background: rgba(212, 168, 87, 0.12);
        color: #d4a857;
      }
      .fl-cash-mode-btn:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }
      .fl-cash-meta {
        font-size: 10px;
        color: rgba(148, 163, 184, 0.55);
        margin-top: 8px;
        text-align: right;
      }
      .fl-cash-error {
        margin-top: 12px;
        padding: 8px 10px;
        background: rgba(220, 38, 38, 0.08);
        border: 1px solid rgba(220, 38, 38, 0.25);
        border-radius: 4px;
        color: #fca5a5;
        font-size: 12px;
      }
      .fl-cash-success {
        margin-top: 12px;
        padding: 8px 10px;
        background: rgba(16, 185, 129, 0.08);
        border: 1px solid rgba(16, 185, 129, 0.25);
        border-radius: 4px;
        color: #6ee7b7;
        font-size: 12px;
        font-family: 'IBM Plex Mono', monospace;
      }

'@
$rx = [regex]::new($pat6)
$matches = $rx.Matches($content)
if ($matches.Count -eq 1) {
  $m = $matches[0]
  $content = $content.Remove($m.Index, $m.Length).Insert($m.Index, $cssAdditions + $m.Groups[1].Value)
  $applied++
  Write-Host "  OK   CSS additions" -ForegroundColor Green
} elseif ($matches.Count -eq 0) {
  Write-Host "  SKIP CSS additions : pattern not found" -ForegroundColor Yellow
  $skipped++
} else {
  Write-Host "  ERROR CSS additions : matches $($matches.Count)" -ForegroundColor Red
  $errored++
}

# ─────────────────────────────────────────────────────────────
# Done
# ─────────────────────────────────────────────────────────────
$totalChanged = $content -ne $original

Write-Host ""
Write-Host "Applied: $applied / Skipped: $skipped / Errored: $errored" -ForegroundColor Cyan

if ($errored -gt 0) {
  Write-Host ""
  Write-Host "STOPPED — at least one anchor matched multiple times. File NOT written." -ForegroundColor Red
  Write-Host "Re-upload app/invest/page.tsx so the script can be regenerated against the live state." -ForegroundColor Red
  exit 1
}

if ($skipped -gt 0 -and $applied -gt 0) {
  Write-Host ""
  Write-Host "WARNING — partial application. File NOT written to avoid leaving an inconsistent state." -ForegroundColor Yellow
  Write-Host "Re-upload app/invest/page.tsx and we'll regenerate the script." -ForegroundColor Yellow
  exit 1
}

if (-not $totalChanged) {
  Write-Host "No changes to write." -ForegroundColor Yellow
  exit 0
}

if ($Apply) {
  [System.IO.File]::WriteAllText((Resolve-Path $file).Path, $content, [System.Text.UTF8Encoding]::new($false))
  Write-Host ""
  Write-Host "WROTE $file" -ForegroundColor Green
  Write-Host ""
  Write-Host "Next steps:" -ForegroundColor Cyan
  Write-Host "  1. Run migration.sql in Supabase SQL editor (if not already done)"
  Write-Host "  2. Drop route.ts into app\api\invest\cash\route.ts (if not already done)"
  Write-Host "  3. npm run build"
} else {
  Write-Host ""
  Write-Host "Dry run looked good. Re-run with -Apply to write." -ForegroundColor Yellow
}
