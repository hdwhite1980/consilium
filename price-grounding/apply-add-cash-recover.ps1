# =============================================================
# apply-add-cash-recover.ps1
#
# RECOVERY: completes the 3 patches that failed in the original
# apply-add-cash.ps1 due to CRLF/LF line-ending mismatch.
#
# After this runs, app/invest/page.tsx will have:
#   - The addCash handler  (was missing — patch 2)
#   - The Capital block in the Sidebar  (was missing — patch 4)
#   - The AddCashModal component definition  (was missing — patch 5)
#
# State hooks (patch 1), modal mount (patch 3), and CSS (patch 6)
# should already be in place from the first run.
#
# Usage:
#   .\apply-add-cash-recover.ps1          (dry run)
#   .\apply-add-cash-recover.ps1 -Apply   (write changes)
# =============================================================

param([switch]$Apply)

$ErrorActionPreference = 'Stop'
$file = 'app\invest\page.tsx'

if (-not (Test-Path $file)) {
  Write-Host "ERROR: $file not found. Run from repo root." -ForegroundColor Red
  exit 1
}

# Read raw bytes; preserves CRLF as-is
$bytes   = [System.IO.File]::ReadAllBytes((Resolve-Path $file).Path)
$content = [System.Text.UTF8Encoding]::new($false).GetString($bytes)
$original = $content
$applied = 0
$skipped = 0

# Detect file's line-ending style so we use the SAME style in our replacements
$useCrlf = $content.Contains("`r`n")
$NL = if ($useCrlf) { "`r`n" } else { "`n" }
Write-Host "Detected line endings: $(if ($useCrlf) { 'CRLF' } else { 'LF' })" -ForegroundColor Cyan

# Helper: regex-based patch that tolerates either CRLF or LF
function Apply-RegexPatch {
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
    Write-Host "  ERROR $Name : pattern matches $($matches.Count) times" -ForegroundColor Red
    exit 1
  }
  $script:content = $rx.Replace($script:content, { param($m) $Replacement }, 1)
  $script:applied++
  Write-Host "  OK   $Name" -ForegroundColor Green
}

# Helper: simple Contains-based check (for verifying prior patches landed)
function Already-Has {
  param([string] $Snippet)
  return $script:content.Contains($Snippet)
}

# Sanity check: prior patches should already be present
Write-Host ""
Write-Host "Verifying prior patches are present..." -ForegroundColor Cyan
$haveStateHooks    = Already-Has 'addCashOpen, setAddCashOpen'
$haveModalMount    = Already-Has '{addCashOpen && <AddCashModal'
$haveCss           = Already-Has '.fl-capital-block'
Write-Host "  state hooks:   $(if ($haveStateHooks)    { 'YES' } else { 'NO ' })"
Write-Host "  modal mount:   $(if ($haveModalMount)    { 'YES' } else { 'NO ' })"
Write-Host "  css additions: $(if ($haveCss)           { 'YES' } else { 'NO ' })"

# Sanity check: missing patches we're about to apply should be missing
Write-Host ""
Write-Host "Verifying recovery targets are still missing..." -ForegroundColor Cyan
$haveHandler = Already-Has 'const addCash = async (amount: number)'
$haveSidebar = Already-Has 'fl-capital-add-btn'
$haveModal   = Already-Has 'function AddCashModal('
Write-Host "  handler:        $(if ($haveHandler) { 'PRESENT (will skip)' } else { 'missing (will add)' })"
Write-Host "  Sidebar block:  $(if ($haveSidebar) { 'PRESENT (will skip)' } else { 'missing (will add)' })"
Write-Host "  modal def:      $(if ($haveModal)   { 'PRESENT (will skip)' } else { 'missing (will add)' })"
Write-Host ""

# ─────────────────────────────────────────────────────────────
# Recovery patch A: addCash handler
# Inserts AFTER the setStartBalance handler block
# ─────────────────────────────────────────────────────────────
if (-not $haveHandler) {
  # Pattern: matches the entire setStartBalance function block and captures it
  # \r?\n tolerates either CRLF or LF
  $patternA = @'
(  const setStartBalance = async \(balance: number\) => \{\r?\n    await fetch\('/api/invest', \{\r?\n      method: 'POST', headers: \{ 'Content-Type': 'application/json' \},\r?\n      body: JSON\.stringify\(\{ type: 'set_balance', balance \}\),\r?\n    \}\)\r?\n    await loadData\(\)\r?\n  \})
'@

  # Build replacement: keep group 1 (the original block), then NL NL + new code
  $newHandler = @'

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

  # Convert any LF in the new code to match the file's actual line endings
  if ($useCrlf) {
    $newHandler = $newHandler -replace "`r?`n", "`r`n"
  } else {
    $newHandler = $newHandler -replace "`r`n", "`n"
  }

  $rx = [regex]::new($patternA, [System.Text.RegularExpressions.RegexOptions]::Singleline)
  $m = $rx.Match($content)
  if (-not $m.Success) {
    Write-Host "  SKIP addCash handler : setStartBalance block not found" -ForegroundColor Yellow
    $skipped++
  } elseif ($rx.Matches($content).Count -gt 1) {
    Write-Host "  ERROR addCash handler : setStartBalance block matched multiple times" -ForegroundColor Red
    exit 1
  } else {
    # Replace just this match: keep the captured group + add our handler
    $captured = $m.Groups[1].Value
    $content = $content.Remove($m.Index, $m.Length).Insert($m.Index, $captured + $newHandler)
    $applied++
    Write-Host "  OK   addCash handler" -ForegroundColor Green
  }
} else {
  Write-Host "  SKIP addCash handler : already present" -ForegroundColor DarkGray
  $skipped++
}

# ─────────────────────────────────────────────────────────────
# Recovery patch B: Capital block in Sidebar
# Inserts BEFORE the existing "to next tier" metric block
# ─────────────────────────────────────────────────────────────
if (-not $haveSidebar) {
  # Pattern matches the opening of the existing "to nextTierName" metric block
  # We capture it, then insert our Capital block + a blank line + the captured opener
  $patternB = '(      <div className="fl-metric-block">\r?\n        <div className="fl-metric-row">\r?\n          <span className="k">to \{tier\.nextTierName \?\? ''apex''\}</span>)'

  $capitalBlock = @'
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

  if ($useCrlf) {
    $capitalBlock = $capitalBlock -replace "`r?`n", "`r`n"
  } else {
    $capitalBlock = $capitalBlock -replace "`r`n", "`n"
  }

  $rx = [regex]::new($patternB, [System.Text.RegularExpressions.RegexOptions]::Singleline)
  $matches = $rx.Matches($content)
  if ($matches.Count -eq 0) {
    Write-Host "  SKIP Capital block : pattern not found" -ForegroundColor Yellow
    $skipped++
  } elseif ($matches.Count -gt 1) {
    Write-Host "  ERROR Capital block : matched $($matches.Count) times, refusing" -ForegroundColor Red
    exit 1
  } else {
    $m = $matches[0]
    $captured = $m.Groups[1].Value
    $content = $content.Remove($m.Index, $m.Length).Insert($m.Index, $capitalBlock + $captured)
    $applied++
    Write-Host "  OK   Capital block" -ForegroundColor Green
  }
} else {
  Write-Host "  SKIP Capital block : already present" -ForegroundColor DarkGray
  $skipped++
}

# ─────────────────────────────────────────────────────────────
# Recovery patch C: AddCashModal component definition
# Inserts BEFORE the FloorInner main page comment+function
# ─────────────────────────────────────────────────────────────
if (-not $haveModal) {
  # The header comment + function FloorInner declaration
  $patternC = '(// [═]+\r?\n// MAIN PAGE\r?\n// [═]+\r?\n)(function FloorInner\(\) \{)'

  $modalDef = @'
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

  if ($useCrlf) {
    $modalDef = $modalDef -replace "`r?`n", "`r`n"
  } else {
    $modalDef = $modalDef -replace "`r`n", "`n"
  }

  $rx = [regex]::new($patternC, [System.Text.RegularExpressions.RegexOptions]::Singleline)
  $matches = $rx.Matches($content)
  if ($matches.Count -eq 0) {
    Write-Host "  SKIP AddCashModal def : MAIN PAGE comment block + FloorInner not found" -ForegroundColor Yellow
    $skipped++
  } elseif ($matches.Count -gt 1) {
    Write-Host "  ERROR AddCashModal def : matched multiple times, refusing" -ForegroundColor Red
    exit 1
  } else {
    $m = $matches[0]
    $g1 = $m.Groups[1].Value     # the comment header
    $g2 = $m.Groups[2].Value     # function FloorInner() {
    # Replace match with: modalDef + g1 + g2
    $content = $content.Remove($m.Index, $m.Length).Insert($m.Index, $modalDef + $g1 + $g2)
    $applied++
    Write-Host "  OK   AddCashModal def" -ForegroundColor Green
  }
} else {
  Write-Host "  SKIP AddCashModal def : already present" -ForegroundColor DarkGray
  $skipped++
}

# ─────────────────────────────────────────────────────────────
# Done
# ─────────────────────────────────────────────────────────────
$totalChanged = $content -ne $original

Write-Host ""
Write-Host "Applied: $applied / Skipped: $skipped" -ForegroundColor Cyan

if (-not $totalChanged) {
  Write-Host "No changes to write." -ForegroundColor Yellow
  exit 0
}

if ($Apply) {
  # Write back as UTF-8 without BOM, preserving the line-ending style
  [System.IO.File]::WriteAllText((Resolve-Path $file).Path, $content, [System.Text.UTF8Encoding]::new($false))
  Write-Host ""
  Write-Host "WROTE $file" -ForegroundColor Green
  Write-Host ""
  Write-Host "Next: npm run build" -ForegroundColor Cyan
} else {
  Write-Host ""
  Write-Host "Dry run looked good. Re-run with -Apply to write." -ForegroundColor Yellow
}
