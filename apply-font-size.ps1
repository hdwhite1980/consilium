# apply-font-size.ps1 -- add font-size picker to Settings page
#
# Usage:
#   .\apply-font-size.ps1          (dry run)
#   .\apply-font-size.ps1 -Apply   (write changes)

param([switch]$Apply)

$ErrorActionPreference = 'Stop'

$file = "app\settings\page.tsx"

if (-not (Test-Path $file)) {
    Write-Host "ERROR: $file not found" -ForegroundColor Red
    exit 1
}

$content = [System.IO.File]::ReadAllText((Resolve-Path $file).Path, [System.Text.UTF8Encoding]::new($false))
$originalContent = $content

# ---- Edit 1: Add useTheme import ----
# Before: import { createClient } from '@/app/lib/auth/client'
# After:  import { createClient } from '@/app/lib/auth/client'
#         import { useTheme } from '@/app/lib/theme'

$importMarker = "import { createClient } from '@/app/lib/auth/client'"
$importReplacement = "import { createClient } from '@/app/lib/auth/client'`r`nimport { useTheme } from '@/app/lib/theme'"

if ($content -match "import \{ useTheme \} from '@/app/lib/theme'") {
    Write-Host "[OK] useTheme import already present" -ForegroundColor DarkGray
} elseif ($content.Contains($importMarker)) {
    $content = $content.Replace($importMarker, $importReplacement)
    Write-Host "[+] useTheme import added" -ForegroundColor Green
} else {
    Write-Host "[WARN] couldn't find import anchor" -ForegroundColor Yellow
}

# ---- Edit 2: Add Type icon import from lucide-react ----
# The Appearance section uses a Type icon
$lucideMarker = "import { ArrowLeft, Shield, ShieldCheck, ShieldOff, LogOut, CreditCard, Zap, Crown, CheckCircle, ExternalLink } from 'lucide-react'"
$lucideReplacement = "import { ArrowLeft, Shield, ShieldCheck, ShieldOff, LogOut, CreditCard, Zap, Crown, CheckCircle, ExternalLink, Type, Palette } from 'lucide-react'"

if ($content -match "Type, Palette") {
    Write-Host "[OK] Type/Palette icons already imported" -ForegroundColor DarkGray
} elseif ($content.Contains($lucideMarker)) {
    $content = $content.Replace($lucideMarker, $lucideReplacement)
    Write-Host "[+] Type/Palette icons added to lucide import" -ForegroundColor Green
} else {
    Write-Host "[WARN] couldn't find lucide import" -ForegroundColor Yellow
}

# ---- Edit 3: Darken light-mode text colors (match globals.css) ----
$colorOld = @"
  const txt  = isDark ? 'rgba(255,255,255,0.9)' : 'rgba(0,0,0,0.9)'
  const txt2 = isDark ? 'rgba(255,255,255,0.55)' : 'rgba(0,0,0,0.55)'
  const txt3 = isDark ? 'rgba(255,255,255,0.28)' : 'rgba(0,0,0,0.35)'
"@

$colorNew = @"
  const txt  = isDark ? 'rgba(255,255,255,0.95)' : 'rgba(0,0,0,0.95)'
  const txt2 = isDark ? 'rgba(255,255,255,0.75)' : 'rgba(0,0,0,0.85)'
  const txt3 = isDark ? 'rgba(255,255,255,0.5)'  : 'rgba(0,0,0,0.65)'
"@

$colorOldNorm = $colorOld -replace "`r`n", "`n"
$colorNewNorm = $colorNew -replace "`r`n", "`n"
$contentNorm = $content -replace "`r`n", "`n"

if ($contentNorm.Contains($colorNewNorm)) {
    Write-Host "[OK] text colors already darkened" -ForegroundColor DarkGray
} elseif ($contentNorm.Contains($colorOldNorm)) {
    $contentNorm = $contentNorm.Replace($colorOldNorm, $colorNewNorm)
    $content = $contentNorm -replace "`n", "`r`n"
    Write-Host "[+] text colors darkened" -ForegroundColor Green
} else {
    Write-Host "[WARN] couldn't find text color block" -ForegroundColor Yellow
}

# ---- Edit 4: Hook into useTheme inside SettingsPage component ----
# Insert after `const isDark = useDarkMode()`
$hookMarker = "  const isDark = useDarkMode()"
$hookReplacement = "  const isDark = useDarkMode()`r`n  const { fontSize, setFontSize } = useTheme()"

if ($content -match "const \{ fontSize, setFontSize \} = useTheme\(\)") {
    Write-Host "[OK] useTheme hook already called" -ForegroundColor DarkGray
} elseif ($content.Contains($hookMarker)) {
    $content = $content.Replace($hookMarker, $hookReplacement)
    Write-Host "[+] useTheme hook added" -ForegroundColor Green
} else {
    Write-Host "[WARN] couldn't find useDarkMode anchor" -ForegroundColor Yellow
}

# ---- Edit 5: Inject Appearance section right after Account section ----
# The Account section is:
#   {/* Account */}
#   <Section title="Account">
#     <div>...email...</div>
#   </Section>
# We add Appearance immediately after its closing </Section>

$appearanceInsertionMarker = @"
        {/* Account */}
        <Section title="Account">
          <div>
            <div className="text-[10px] font-mono uppercase tracking-widest mb-1" style={{ color: txt3 }}>Email</div>
            <div className="text-sm font-mono" style={{ color: txt }}>{user?.email}</div>
          </div>
        </Section>
"@

$appearanceBlock = @"
        {/* Account */}
        <Section title="Account">
          <div>
            <div className="text-[10px] font-mono uppercase tracking-widest mb-1" style={{ color: txt3 }}>Email</div>
            <div className="text-sm font-mono" style={{ color: txt }}>{user?.email}</div>
          </div>
        </Section>

        {/* Appearance */}
        <Section title="Appearance">
          <div>
            <div className="flex items-center gap-2 mb-2">
              <Type size={14} style={{ color: txt2 }} />
              <div className="text-sm font-semibold" style={{ color: txt }}>Text size</div>
            </div>
            <div className="text-xs mb-3" style={{ color: txt3 }}>
              Adjust text size across the entire app. Changes apply immediately and persist across sessions.
            </div>
            <div className="grid grid-cols-4 gap-2">
              {([
                { key: 'sm' as const, label: 'Small',    sample: '14px' },
                { key: 'md' as const, label: 'Default',  sample: '16px' },
                { key: 'lg' as const, label: 'Large',    sample: '18px' },
                { key: 'xl' as const, label: 'X-Large',  sample: '20px' },
              ]).map(opt => {
                const active = fontSize === opt.key
                return (
                  <button
                    key={opt.key}
                    type="button"
                    onClick={() => setFontSize(opt.key)}
                    aria-pressed={active}
                    className="rounded-lg py-3 px-2 transition-all hover:opacity-90 focus:outline focus:outline-2 focus:outline-offset-1"
                    style={{
                      background: active ? 'rgba(167,139,250,0.15)' : surf2,
                      border: `1px solid $\{active ? '#a78bfa' : brd\}`,
                      color: active ? '#a78bfa' : txt,
                      outlineColor: '#a78bfa',
                    }}>
                    <div className="text-sm font-semibold">{opt.label}</div>
                    <div className="text-[10px] font-mono mt-0.5" style={{ color: active ? '#a78bfa' : txt3 }}>{opt.sample}</div>
                  </button>
                )
              })}
            </div>
          </div>

          <div className="pt-3 border-t" style={{ borderColor: brd }}>
            <div className="flex items-center gap-2 mb-2">
              <Palette size={14} style={{ color: txt2 }} />
              <div className="text-sm font-semibold" style={{ color: txt }}>Theme</div>
            </div>
            <div className="text-xs" style={{ color: txt3 }}>
              Toggle dark/light mode from the sun/moon button in the top nav.
            </div>
          </div>
        </Section>
"@

# In PowerShell here-strings we escape ${...} by splitting. Clean up:
$appearanceBlock = $appearanceBlock -replace '\$\\\{', '${' -replace '\\\}', '}'

$marker1Norm = $appearanceInsertionMarker -replace "`r`n", "`n"
$replacementNorm = $appearanceBlock -replace "`r`n", "`n"
$contentNorm = $content -replace "`r`n", "`n"

if ($contentNorm -match '\{/\* Appearance \*/\}') {
    Write-Host "[OK] Appearance section already present" -ForegroundColor DarkGray
} elseif ($contentNorm.Contains($marker1Norm)) {
    $contentNorm = $contentNorm.Replace($marker1Norm, $replacementNorm)
    $content = $contentNorm -replace "`n", "`r`n"
    Write-Host "[+] Appearance section injected" -ForegroundColor Green
} else {
    Write-Host "[WARN] couldn't find Account section anchor to inject after" -ForegroundColor Yellow
    Write-Host "       Appearance section NOT added" -ForegroundColor Yellow
}

# ---- Write ----
$changed = $content -ne $originalContent

if (-not $changed) {
    Write-Host "`nNo changes needed." -ForegroundColor Cyan
    exit 0
}

if ($Apply) {
    [System.IO.File]::WriteAllText((Resolve-Path $file).Path, $content, [System.Text.UTF8Encoding]::new($false))
    Write-Host "`nWROTE $file" -ForegroundColor Green
} else {
    Write-Host "`n(dry run, not written)" -ForegroundColor Yellow
    Write-Host "To apply: .\apply-font-size.ps1 -Apply" -ForegroundColor White
}
