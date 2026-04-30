# apply-scanner-page-screener.ps1
#
# Adds priceMin / priceMax numeric inputs to app/scanner/page.tsx
# alongside the existing tier chips. Plumbs them through state,
# runScan, applyPreset, savePreset, and filter clearing.
#
# 8 edits, all anchor-based, all-or-nothing.

param([switch]$Apply)
$ErrorActionPreference = 'Stop'

if (-not (Test-Path 'app\scanner\page.tsx')) {
    Write-Host "ERROR: app\scanner\page.tsx not found" -ForegroundColor Red
    exit 1
}

function Norm([string]$s) { $s -replace "`r`n", "`n" }

$path = 'app\scanner\page.tsx'
$abs = (Resolve-Path $path).Path
$work = [System.IO.File]::ReadAllText($abs, [System.Text.UTF8Encoding]::new($false))

if ($work -match "priceMin\?\s*:\s*number") {
    Write-Host "[ok] scanner page already patched" -ForegroundColor DarkGray
    exit 0
}

# ── Edit 1: Extend CustomFilter interface
$old1 = @"
interface CustomFilter {
  sectors: string[]
  caps: string[]
  priceTiers: string[]
  tagsIncludeAny: string[]
  tagsExcludeAny: string[]
}
"@
$new1 = @"
interface CustomFilter {
  sectors: string[]
  caps: string[]
  priceTiers: string[]
  priceMin?: number
  priceMax?: number
  tagsIncludeAny: string[]
  tagsExcludeAny: string[]
}
"@

# ── Edit 2: Initial filter state
$old2 = @"
  const [filter, setFilter] = useState<CustomFilter>({
    sectors: [], caps: [], priceTiers: [], tagsIncludeAny: [], tagsExcludeAny: [],
  })
"@
$new2 = @"
  const [filter, setFilter] = useState<CustomFilter>({
    sectors: [], caps: [], priceTiers: [], tagsIncludeAny: [], tagsExcludeAny: [],
    priceMin: undefined, priceMax: undefined,
  })
"@

# ── Edit 3: applyPreset restoration
$old3 = @"
    setFilter({
      sectors: preset.filter.sectors ?? [],
      caps: preset.filter.caps ?? [],
      priceTiers: preset.filter.priceTiers ?? [],
      tagsIncludeAny: preset.filter.tagsIncludeAny ?? [],
      tagsExcludeAny: preset.filter.tagsExcludeAny ?? [],
    })
"@
$new3 = @"
    setFilter({
      sectors: preset.filter.sectors ?? [],
      caps: preset.filter.caps ?? [],
      priceTiers: preset.filter.priceTiers ?? [],
      priceMin: preset.filter.priceMin,
      priceMax: preset.filter.priceMax,
      tagsIncludeAny: preset.filter.tagsIncludeAny ?? [],
      tagsExcludeAny: preset.filter.tagsExcludeAny ?? [],
    })
"@

# ── Edit 4: savePreset filter body (add priceMin/priceMax)
# Uses regex on a stable anchor — savePreset has the same shape as runScan
# but we only want the savePreset version. Anchor on its filter close `}`.
# Both savePreset and runScan have the SAME inline filter body, so we replace
# the FIRST occurrence. We do this by replacing both patterns at once.
$old4 = @"
          filter: {
            sectors: filter.sectors.length > 0 ? filter.sectors : undefined,
            caps: filter.caps.length > 0 ? filter.caps : undefined,
            priceTiers: filter.priceTiers.length > 0 ? filter.priceTiers : undefined,
            tagsIncludeAny: filter.tagsIncludeAny.length > 0 ? filter.tagsIncludeAny : undefined,
            tagsExcludeAny: filter.tagsExcludeAny.length > 0 ? filter.tagsExcludeAny : undefined,
          },
"@
$new4 = @"
          filter: {
            sectors: filter.sectors.length > 0 ? filter.sectors : undefined,
            caps: filter.caps.length > 0 ? filter.caps : undefined,
            priceTiers: filter.priceTiers.length > 0 ? filter.priceTiers : undefined,
            priceMin: typeof filter.priceMin === 'number' ? filter.priceMin : undefined,
            priceMax: typeof filter.priceMax === 'number' ? filter.priceMax : undefined,
            tagsIncludeAny: filter.tagsIncludeAny.length > 0 ? filter.tagsIncludeAny : undefined,
            tagsExcludeAny: filter.tagsExcludeAny.length > 0 ? filter.tagsExcludeAny : undefined,
          },
"@

# ── Edit 5: runScan filter body (different indent — 8 spaces vs 10 in savePreset)
$old5 = @"
        filter: {
          sectors: filter.sectors.length > 0 ? filter.sectors : undefined,
          caps: filter.caps.length > 0 ? filter.caps : undefined,
          priceTiers: filter.priceTiers.length > 0 ? filter.priceTiers : undefined,
          tagsIncludeAny: filter.tagsIncludeAny.length > 0 ? filter.tagsIncludeAny : undefined,
          tagsExcludeAny: filter.tagsExcludeAny.length > 0 ? filter.tagsExcludeAny : undefined,
        },
"@
$new5 = @"
        filter: {
          sectors: filter.sectors.length > 0 ? filter.sectors : undefined,
          caps: filter.caps.length > 0 ? filter.caps : undefined,
          priceTiers: filter.priceTiers.length > 0 ? filter.priceTiers : undefined,
          priceMin: typeof filter.priceMin === 'number' ? filter.priceMin : undefined,
          priceMax: typeof filter.priceMax === 'number' ? filter.priceMax : undefined,
          tagsIncludeAny: filter.tagsIncludeAny.length > 0 ? filter.tagsIncludeAny : undefined,
          tagsExcludeAny: filter.tagsExcludeAny.length > 0 ? filter.tagsExcludeAny : undefined,
        },
"@

# ── Edit 6: clear-all-filters reset
$old6 = @"
          onClick={() => onChange({ sectors: [], caps: [], priceTiers: [], tagsIncludeAny: [], tagsExcludeAny: [] })}
"@
$new6 = @"
          onClick={() => onChange({ sectors: [], caps: [], priceTiers: [], priceMin: undefined, priceMax: undefined, tagsIncludeAny: [], tagsExcludeAny: [] })}
"@

# ── Edit 7: filterActive + filterChipCount detection
$old7 = @"
  const filterActive = filter.sectors.length > 0 || filter.caps.length > 0
    || filter.priceTiers.length > 0 || filter.tagsIncludeAny.length > 0 || filter.tagsExcludeAny.length > 0
  const filterChipCount = filter.sectors.length + filter.caps.length + filter.priceTiers.length
    + filter.tagsIncludeAny.length + filter.tagsExcludeAny.length
"@
$new7 = @"
  const priceRangeActive = typeof filter.priceMin === 'number' || typeof filter.priceMax === 'number'
  const filterActive = filter.sectors.length > 0 || filter.caps.length > 0
    || filter.priceTiers.length > 0 || priceRangeActive
    || filter.tagsIncludeAny.length > 0 || filter.tagsExcludeAny.length > 0
  const filterChipCount = filter.sectors.length + filter.caps.length + filter.priceTiers.length
    + (priceRangeActive ? 1 : 0)
    + filter.tagsIncludeAny.length + filter.tagsExcludeAny.length
"@

# ── Edit 8: Insert price range inputs in FilterPanel (after Price tier block)
# Anchor on the existing Price tier block close, before the Tags include block
$old8 = @"
        <div className="text-[10px] font-mono uppercase tracking-widest text-white/40 mb-1.5">Price tier</div>
        <div className="flex flex-wrap gap-1.5">
          {schema.priceTiers.map(p => (
            <Chip key={p}
              label={p.replace('sub', '< `$').replace('under', '< `$').replace('over', '> `$')}
              active={filter.priceTiers.includes(p)}
              onClick={() => onChange({ ...filter, priceTiers: toggleItem(filter.priceTiers, p) })} />
          ))}
        </div>
      </div>

      <div>
        <div className="text-[10px] font-mono uppercase tracking-widest text-white/40 mb-1.5">
          Tags <span className="text-white/30">(must include any)</span>
        </div>
"@
$new8 = @"
        <div className="text-[10px] font-mono uppercase tracking-widest text-white/40 mb-1.5">Price tier</div>
        <div className="flex flex-wrap gap-1.5">
          {schema.priceTiers.map(p => (
            <Chip key={p}
              label={p.replace('sub', '< `$').replace('under', '< `$').replace('over', '> `$')}
              active={filter.priceTiers.includes(p)}
              onClick={() => onChange({ ...filter, priceTiers: toggleItem(filter.priceTiers, p) })} />
          ))}
        </div>
      </div>

      <div>
        <div className="text-[10px] font-mono uppercase tracking-widest text-white/40 mb-1.5">Live price range</div>
        <div className="flex items-center gap-2">
          <input
            type="number"
            placeholder="Min"
            min={0}
            step="0.01"
            value={filter.priceMin ?? ''}
            onChange={e => {
              const v = e.target.value
              onChange({ ...filter, priceMin: v === '' ? undefined : parseFloat(v) })
            }}
            className="w-24 px-2 py-1 text-[11px] font-mono rounded"
            style={{ background: 'rgba(148,163,184,0.08)', color: '#a78bfa', border: '1px solid rgba(148,163,184,0.2)' }}
          />
          <span className="text-[10px] font-mono text-white/40">to</span>
          <input
            type="number"
            placeholder="Max"
            min={0}
            step="0.01"
            value={filter.priceMax ?? ''}
            onChange={e => {
              const v = e.target.value
              onChange({ ...filter, priceMax: v === '' ? undefined : parseFloat(v) })
            }}
            className="w-24 px-2 py-1 text-[11px] font-mono rounded"
            style={{ background: 'rgba(148,163,184,0.08)', color: '#a78bfa', border: '1px solid rgba(148,163,184,0.2)' }}
          />
          {(typeof filter.priceMin === 'number' || typeof filter.priceMax === 'number') && (
            <button
              onClick={() => onChange({ ...filter, priceMin: undefined, priceMax: undefined })}
              className="text-[10px] font-mono text-white/40 hover:text-white/70 transition-all">
              clear
            </button>
          )}
        </div>
        <p className="text-[10px] mt-1 text-white/40">
          Filters by actual current price (works on any universe, including live screener movers)
        </p>
      </div>

      <div>
        <div className="text-[10px] font-mono uppercase tracking-widest text-white/40 mb-1.5">
          Tags <span className="text-white/30">(must include any)</span>
        </div>
"@

# Apply all edits
$workNorm = Norm $work
$edits = @(
    @{ old = (Norm $old1); new = (Norm $new1); name = '1. CustomFilter interface' }
    @{ old = (Norm $old2); new = (Norm $new2); name = '2. filter initial state' }
    @{ old = (Norm $old3); new = (Norm $new3); name = '3. applyPreset restoration' }
    @{ old = (Norm $old4); new = (Norm $new4); name = '4. savePreset filter body' }
    @{ old = (Norm $old5); new = (Norm $new5); name = '5. runScan filter body' }
    @{ old = (Norm $old6); new = (Norm $new6); name = '6. clear-all-filters reset' }
    @{ old = (Norm $old7); new = (Norm $new7); name = '7. filterActive + chipCount' }
    @{ old = (Norm $old8); new = (Norm $new8); name = '8. price range UI inputs' }
)

foreach ($e in $edits) {
    if (-not $workNorm.Contains($e.old)) {
        Write-Host "[FAIL] anchor missed: $($e.name)" -ForegroundColor Red
        Write-Host "  Open $path and search for the start of the missing anchor." -ForegroundColor Yellow
        exit 1
    }
    $workNorm = $workNorm.Replace($e.old, $e.new)
    Write-Host "[+] $($e.name)" -ForegroundColor Green
}

$newWork = $workNorm -replace "`n", "`r`n"

if ($Apply) {
    [System.IO.File]::WriteAllText($abs, $newWork, [System.Text.UTF8Encoding]::new($false))
    Write-Host "  Wrote $path" -ForegroundColor Green
} else {
    Write-Host "DRY RUN — re-run with -Apply to write." -ForegroundColor Yellow
}
