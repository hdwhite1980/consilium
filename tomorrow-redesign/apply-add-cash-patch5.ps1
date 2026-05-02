# =============================================================
# apply-add-cash-patch5.ps1
#
# RECOVERY: applies only patch 5 (AddCashModal component
# definition), which the original script skipped due to a
# regex encoding issue.
#
# This script is ENTIRELY ASCII to avoid encoding ambiguity
# between PowerShell, the file system, and the source file.
#
# Usage:
#   .\apply-add-cash-patch5.ps1          (dry run)
#   .\apply-add-cash-patch5.ps1 -Apply   (write changes)
# =============================================================

param([switch]$Apply)

$ErrorActionPreference = 'Stop'
$file = 'app\invest\page.tsx'

if (-not (Test-Path $file)) {
  Write-Host "ERROR: $file not found. Run from repo root." -ForegroundColor Red
  exit 1
}

# Read the file as UTF-8 bytes -> string. Preserves all line endings + non-ASCII chars.
$bytes   = [System.IO.File]::ReadAllBytes((Resolve-Path $file).Path)
$content = [System.Text.UTF8Encoding]::new($false).GetString($bytes)
$original = $content

$useCrlf = $content.Contains("`r`n")
Write-Host "Detected line endings: $(if ($useCrlf) { 'CRLF' } else { 'LF' })" -ForegroundColor Cyan
Write-Host ""

# Sanity: confirm patches 1-4 and 6 are already in place
$check = @(
  @{ Name = 'state hooks';       Marker = 'addCashOpen, setAddCashOpen' },
  @{ Name = 'addCash handler';   Marker = 'const addCash = async (amount: number)' },
  @{ Name = 'modal mount';       Marker = '{addCashOpen && <AddCashModal' },
  @{ Name = 'Capital block';     Marker = 'fl-capital-add-btn' },
  @{ Name = 'CSS additions';     Marker = '.fl-capital-block {' }
)
Write-Host "Verifying prior patches are in place..." -ForegroundColor Cyan
$allPresent = $true
foreach ($c in $check) {
  $present = $content.Contains($c.Marker)
  Write-Host "  $($c.Name): $(if ($present) { 'YES' } else { 'NO ' })"
  if (-not $present) { $allPresent = $false }
}
if (-not $allPresent) {
  Write-Host ""
  Write-Host "ERROR: prior patches are not all present. Re-run the main apply-add-cash.ps1 first." -ForegroundColor Red
  exit 1
}

# Sanity: confirm patch 5 has not already been applied
$alreadyApplied = $content.Contains('function AddCashModal(')
if ($alreadyApplied) {
  Write-Host ""
  Write-Host "AddCashModal already defined. Nothing to do." -ForegroundColor Green
  exit 0
}

# ASCII-only regex anchor.
# The // MAIN PAGE comment block has divider lines made of UTF-8 box-drawing
# characters that cause encoding issues for PowerShell regexes. We sidestep
# the issue by matching "// <anything-not-newline>" for the divider lines,
# which is pure ASCII and matches whatever character set is actually there.
$pattern = '(// [^\r\n]*\r?\n// MAIN PAGE\r?\n// [^\r\n]*\r?\nfunction FloorInner\(\) \{)'

$rx = [regex]::new($pattern, [System.Text.RegularExpressions.RegexOptions]::Singleline)
$matches = $rx.Matches($content)
if ($matches.Count -eq 0) {
  Write-Host "ERROR: anchor pattern not found." -ForegroundColor Red
  exit 1
}
if ($matches.Count -gt 1) {
  Write-Host "ERROR: anchor matched $($matches.Count) times. Refusing to patch." -ForegroundColor Red
  exit 1
}

# Build the replacement. ASCII divider (// ----...) used so this script
# stays ASCII-clean. Visually equivalent to the existing dividers.
$NL = if ($useCrlf) { "`r`n" } else { "`n" }
$divider = '// --------------------------------------------------------------'

$lines = @(
  $divider,
  '// ADD CASH MODAL',
  $divider,
  'function AddCashModal({ currentBalance, submitting, onClose, onSubmit }: {',
  '  currentBalance: number',
  '  submitting: boolean',
  '  onClose: () => void',
  '  onSubmit: (amount: number) => Promise<{ ok: boolean; clamped: boolean; appliedAmount: number; newBalance: number; error?: string }>',
  '}) {',
  "  const [amount, setAmount] = useState('')",
  "  const [mode, setMode] = useState<'deposit' | 'withdraw'>('deposit')",
  '  const [error, setError] = useState<string | null>(null)',
  '  const [success, setSuccess] = useState<string | null>(null)',
  "  const presets = mode === 'deposit' ? [10, 50, 100, 500] : [10, 25, 50]",
  '  const num = parseFloat(amount)',
  '  const valid = !isNaN(num) && num > 0',
  '  const maxWithdraw = currentBalance',
  '',
  '  useEffect(() => {',
  "    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }",
  "    window.addEventListener('keydown', onKey)",
  "    return () => window.removeEventListener('keydown', onKey)",
  '  }, [onClose])',
  '',
  '  const handleSubmit = async () => {',
  '    if (!valid) return',
  '    setError(null)',
  '    setSuccess(null)',
  "    const signedAmount = mode === 'deposit' ? num : -num",
  '    const result = await onSubmit(signedAmount)',
  '    if (!result.ok) {',
  "      setError(result.error ?? 'failed')",
  '      return',
  '    }',
  "    const verb = mode === 'deposit' ? 'Added' : 'Withdrew'",
  "    const dollars = '$' + Math.abs(result.appliedAmount).toFixed(2)",
  "    const newBal = '$' + result.newBalance.toFixed(2)",
  '    if (result.clamped) {',
  "      setSuccess('Withdrew ' + dollars + ' (clamped to available). New starting: ' + newBal + '.')",
  '    } else {',
  "      setSuccess(verb + ' ' + dollars + '. New starting: ' + newBal + '.')",
  '    }',
  "    setAmount('')",
  '    setTimeout(onClose, 1400)',
  '  }',
  '',
  '  return (',
  '    <div className="fl-ticket-overlay" onClick={onClose}>',
  '      <div className="fl-ticket fl-cash-ticket" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="add-cash-title">',
  '        <div className="fl-ticket-header">',
  '          <div>',
  '            <span className="fl-eyebrow">capital adjustment</span>',
  '            <div className="fl-ticket-time mono">{nowETShort()}</div>',
  '          </div>',
  '          <button className="fl-close-btn" onClick={onClose} aria-label="Close"><X size={16} /></button>',
  '        </div>',
  '',
  '        <div className="fl-ticket-body">',
  '          <h2 id="add-cash-title" className="fl-ticket-title">',
  "            {mode === 'deposit' ? 'Add cash to your account' : 'Withdraw from your account'}",
  '          </h2>',
  '          <p className="fl-ticket-sub">',
  "            {mode === 'deposit'",
  "              ? 'Deposits raise your starting balance and total value. Tier-up still requires passing the desk qualifications.'",
  "              : 'Withdrawals reduce your starting balance. Cannot go below zero.'}",
  '          </p>',
  '',
  '          <div className="fl-cash-mode-toggle">',
  '            <button',
  '              type="button"',
  "              className={'fl-cash-mode-btn ' + (mode === 'deposit' ? 'active' : '')}",
  "              onClick={() => { setMode('deposit'); setError(null); setSuccess(null); setAmount('') }}>",
  '              Deposit',
  '            </button>',
  '            <button',
  '              type="button"',
  "              className={'fl-cash-mode-btn ' + (mode === 'withdraw' ? 'active' : '')}",
  '              disabled={maxWithdraw <= 0}',
  "              onClick={() => { setMode('withdraw'); setError(null); setSuccess(null); setAmount('') }}>",
  '              Withdraw',
  '            </button>',
  '          </div>',
  '',
  '          <div className="fl-start-presets" style={{ marginTop: 4 }}>',
  '            {presets.map(p => (',
  '              <button',
  '                key={p}',
  '                type="button"',
  "                className={'fl-preset-chip ' + (num === p ? 'active' : '')}",
  '                onClick={() => setAmount(String(p))}>',
  '                ${p}',
  '              </button>',
  '            ))}',
  '          </div>',
  '',
  '          <div className="fl-start-input-row" style={{ marginTop: 12 }}>',
  '            <span className="fl-dollar">$</span>',
  '            <input',
  '              type="number"',
  '              value={amount}',
  '              onChange={e => setAmount(e.target.value)}',
  '              placeholder="0.00"',
  '              min="0.01"',
  '              step="0.01"',
  '              inputMode="decimal"',
  '              autoFocus',
  '            />',
  '          </div>',
  '',
  "          {mode === 'withdraw' && (",
  '            <div className="fl-cash-meta mono">',
  '              available to withdraw: ${maxWithdraw.toFixed(2)}',
  '            </div>',
  '          )}',
  '',
  '          {error && <div className="fl-cash-error">{error}</div>}',
  '          {success && <div className="fl-cash-success">{success}</div>}',
  '        </div>',
  '',
  '        <div className="fl-ticket-footer">',
  '          <button className="fl-ghost-btn" onClick={onClose}>Cancel</button>',
  '          <button',
  '            className="fl-primary-btn"',
  '            disabled={!valid || submitting}',
  '            onClick={handleSubmit}>',
  "            {submitting ? 'Processing...' : (mode === 'deposit' ? 'Confirm deposit' : 'Confirm withdrawal')}",
  '          </button>',
  '        </div>',
  '      </div>',
  '    </div>',
  '  )',
  '}',
  '',
  ''
)
$modalDef = ($lines -join $NL) + $NL

$m = $matches[0]
# Insert BEFORE the captured group (the original MAIN PAGE comment + FloorInner)
$content = $content.Remove($m.Index, $m.Length).Insert($m.Index, $modalDef + $m.Groups[1].Value)

Write-Host "  OK   AddCashModal component (inserted at offset $($m.Index))" -ForegroundColor Green

if ($content -eq $original) {
  Write-Host "No change after patch attempt. Aborting." -ForegroundColor Yellow
  exit 0
}

if ($Apply) {
  [System.IO.File]::WriteAllText((Resolve-Path $file).Path, $content, [System.Text.UTF8Encoding]::new($false))
  Write-Host ""
  Write-Host "WROTE $file" -ForegroundColor Green
  Write-Host ""
  Write-Host "Next: npm run build" -ForegroundColor Cyan
} else {
  Write-Host ""
  Write-Host "Dry run looked good. Re-run with -Apply to write." -ForegroundColor Yellow
}
