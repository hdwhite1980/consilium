#requires -Version 5.1
<#
.SYNOPSIS
Repairs UTF-8 mojibake across the repo. Pure ASCII source - safe to save.

.DESCRIPTION
The previous version failed because it embedded mojibake patterns as literal
string characters, which (1) could themselves get mangled when the script was
saved, and (2) contained apostrophes that broke PowerShell's string parser.

This version stores patterns as hex byte arrays (pure ASCII). Each mojibake
pattern is reconstructed at runtime from the UTF-8 bytes of the correct
character, which makes the script immune to encoding problems on disk.

Run from repo root:
    .\fix-mojibake.ps1          # Preview, no changes
    .\fix-mojibake.ps1 -Apply   # Write fixes
#>

[CmdletBinding()]
param(
    [switch]$Apply,
    [string]$RepoRoot = (Get-Location).Path
)

$ErrorActionPreference = 'Stop'

$utf8 = New-Object System.Text.UTF8Encoding $false
$win1252 = [System.Text.Encoding]::GetEncoding(1252)

# Each repair: Utf8 = the correct char's UTF-8 bytes, Correct = the char itself.
# Longer (4-byte) patterns FIRST to avoid prefix collisions.
$repairs = @(
    # 4-byte UTF-8 emoji
    @{ Name='email-emoji';       Correct=[char]::ConvertFromUtf32(0x1F4E7); Utf8=@(0xF0,0x9F,0x93,0xA7) }
    @{ Name='fire-emoji';        Correct=[char]::ConvertFromUtf32(0x1F525); Utf8=@(0xF0,0x9F,0x94,0xA5) }
    @{ Name='bulb-emoji';        Correct=[char]::ConvertFromUtf32(0x1F4A1); Utf8=@(0xF0,0x9F,0x92,0xA1) }
    @{ Name='chart-up-emoji';    Correct=[char]::ConvertFromUtf32(0x1F4C8); Utf8=@(0xF0,0x9F,0x93,0x88) }
    @{ Name='chart-down-emoji';  Correct=[char]::ConvertFromUtf32(0x1F4C9); Utf8=@(0xF0,0x9F,0x93,0x89) }
    @{ Name='bar-chart-emoji';   Correct=[char]::ConvertFromUtf32(0x1F4CA); Utf8=@(0xF0,0x9F,0x93,0x8A) }
    @{ Name='money-bag-emoji';   Correct=[char]::ConvertFromUtf32(0x1F4B0); Utf8=@(0xF0,0x9F,0x92,0xB0) }
    @{ Name='target-emoji';      Correct=[char]::ConvertFromUtf32(0x1F3AF); Utf8=@(0xF0,0x9F,0x8E,0xAF) }
    @{ Name='rocket-emoji';      Correct=[char]::ConvertFromUtf32(0x1F680); Utf8=@(0xF0,0x9F,0x9A,0x80) }

    # 6-byte (warn with variation selector) must come before 3-byte warn
    @{ Name='warn-emoji-vs16';   Correct=([char]::ConvertFromUtf32(0x26A0) + [char]::ConvertFromUtf32(0xFE0F)); Utf8=@(0xE2,0x9A,0xA0,0xEF,0xB8,0x8F) }

    # 3-byte UTF-8 symbols
    @{ Name='heavy-check';       Correct=[char]::ConvertFromUtf32(0x2705); Utf8=@(0xE2,0x9C,0x85) }
    @{ Name='cross-mark';        Correct=[char]::ConvertFromUtf32(0x274C); Utf8=@(0xE2,0x9D,0x8C) }
    @{ Name='sparkles';          Correct=[char]::ConvertFromUtf32(0x2728); Utf8=@(0xE2,0x9C,0xA8) }
    @{ Name='warn-plain';        Correct=[char]::ConvertFromUtf32(0x26A0); Utf8=@(0xE2,0x9A,0xA0) }
    @{ Name='check';             Correct=[char]::ConvertFromUtf32(0x2713); Utf8=@(0xE2,0x9C,0x93) }
    @{ Name='cross';             Correct=[char]::ConvertFromUtf32(0x2717); Utf8=@(0xE2,0x9C,0x97) }
    @{ Name='right-arrow';       Correct=[char]::ConvertFromUtf32(0x2192); Utf8=@(0xE2,0x86,0x92) }
    @{ Name='left-arrow';        Correct=[char]::ConvertFromUtf32(0x2190); Utf8=@(0xE2,0x86,0x90) }
    @{ Name='up-arrow';          Correct=[char]::ConvertFromUtf32(0x2191); Utf8=@(0xE2,0x86,0x91) }
    @{ Name='down-arrow';        Correct=[char]::ConvertFromUtf32(0x2193); Utf8=@(0xE2,0x86,0x93) }
    @{ Name='up-down-arrow';     Correct=[char]::ConvertFromUtf32(0x2195); Utf8=@(0xE2,0x86,0x95) }
    @{ Name='em-dash';           Correct=[char]0x2014; Utf8=@(0xE2,0x80,0x94) }
    @{ Name='en-dash';           Correct=[char]0x2013; Utf8=@(0xE2,0x80,0x93) }
    @{ Name='lquote-dbl';        Correct=[char]0x201C; Utf8=@(0xE2,0x80,0x9C) }
    @{ Name='rquote-dbl';        Correct=[char]0x201D; Utf8=@(0xE2,0x80,0x9D) }
    @{ Name='lquote-sgl';        Correct=[char]0x2018; Utf8=@(0xE2,0x80,0x98) }
    @{ Name='rquote-sgl';        Correct=[char]0x2019; Utf8=@(0xE2,0x80,0x99) }
    @{ Name='ellipsis';          Correct=[char]0x2026; Utf8=@(0xE2,0x80,0xA6) }
    @{ Name='bullet';            Correct=[char]0x2022; Utf8=@(0xE2,0x80,0xA2) }

    # 2-byte UTF-8 (Latin supplement)
    @{ Name='middot';            Correct=[char]0x00B7; Utf8=@(0xC2,0xB7) }
    @{ Name='degree';            Correct=[char]0x00B0; Utf8=@(0xC2,0xB0) }
    @{ Name='plus-minus';        Correct=[char]0x00B1; Utf8=@(0xC2,0xB1) }
    @{ Name='half';              Correct=[char]0x00BD; Utf8=@(0xC2,0xBD) }
    @{ Name='quarter';           Correct=[char]0x00BC; Utf8=@(0xC2,0xBC) }
    @{ Name='three-quarters';    Correct=[char]0x00BE; Utf8=@(0xC2,0xBE) }
    @{ Name='nbsp';              Correct=[char]0x00A0; Utf8=@(0xC2,0xA0) }
    @{ Name='e-acute';           Correct=[char]0x00E9; Utf8=@(0xC3,0xA9) }
    @{ Name='e-grave';           Correct=[char]0x00E8; Utf8=@(0xC3,0xA8) }
    @{ Name='a-circumflex';      Correct=[char]0x00E2; Utf8=@(0xC3,0xA2) }
    @{ Name='a-diaeresis';       Correct=[char]0x00E4; Utf8=@(0xC3,0xA4) }
    @{ Name='o-diaeresis';       Correct=[char]0x00F6; Utf8=@(0xC3,0xB6) }
    @{ Name='u-diaeresis';       Correct=[char]0x00FC; Utf8=@(0xC3,0xBC) }
    @{ Name='n-tilde';           Correct=[char]0x00F1; Utf8=@(0xC3,0xB1) }
)

# Reconstruct each mojibake pattern at runtime from the UTF-8 bytes.
# This is the core trick: the correct char has UTF-8 bytes X1 X2 X3.
# During corruption, those bytes were interpreted as Windows-1252 chars
# (each byte became a separate Latin-1 character), and those chars were
# then re-encoded to UTF-8 (which made them 2-3 bytes each).
# So: Mojibake string = Win1252.Decode(original UTF-8 bytes).
foreach ($r in $repairs) {
    $r.Mojibake = $win1252.GetString([byte[]]$r.Utf8)
}

$extensions = @('*.ts','*.tsx','*.js','*.jsx','*.json','*.md','*.css','*.html','*.sql','*.txt')
$skipDirs = @('node_modules','.next','.git','out','dist','build','.vercel','.turbo')

Write-Host ""
Write-Host "=========================================================" -ForegroundColor Cyan
Write-Host "  Mojibake repair scanner" -ForegroundColor Cyan
Write-Host "=========================================================" -ForegroundColor Cyan
Write-Host "  Mode: " -NoNewline
if ($Apply) { Write-Host "APPLY (files will be modified)" -ForegroundColor Yellow }
else        { Write-Host "PREVIEW (no files modified). Use -Apply to fix." -ForegroundColor Green }
Write-Host "  Repo: $RepoRoot"
Write-Host ""

$allFiles = Get-ChildItem -Path $RepoRoot -Recurse -File -Include $extensions |
    Where-Object {
        $path = $_.FullName
        $skip = $false
        foreach ($d in $skipDirs) {
            if ($path.Contains("\$d\") -or $path.Contains("/$d/")) { $skip = $true; break }
        }
        -not $skip
    }

Write-Host ("Scanning {0} files..." -f $allFiles.Count) -ForegroundColor DarkGray
Write-Host ""

$filesFixed = 0
$totalReplacements = 0
$perPatternCount = @{}

foreach ($file in $allFiles) {
    $bytes = [System.IO.File]::ReadAllBytes($file.FullName)
    $content = $utf8.GetString($bytes)
    $fileReplacements = 0
    $fileHits = New-Object System.Collections.ArrayList

    foreach ($r in $repairs) {
        if ($content.Contains($r.Mojibake)) {
            $count = ([regex]::Matches($content, [regex]::Escape($r.Mojibake))).Count
            $content = $content.Replace($r.Mojibake, $r.Correct)
            $fileReplacements += $count
            [void]$fileHits.Add(("  {0,-22} x {1}" -f $r.Name, $count))
            if (-not $perPatternCount.ContainsKey($r.Name)) { $perPatternCount[$r.Name] = 0 }
            $perPatternCount[$r.Name] += $count
        }
    }

    if ($fileReplacements -gt 0) {
        $rel = $file.FullName.Replace($RepoRoot, '').TrimStart('\','/')
        Write-Host ("  {0}  ({1} fixes)" -f $rel, $fileReplacements) -ForegroundColor White
        foreach ($h in $fileHits) { Write-Host $h -ForegroundColor DarkYellow }
        $filesFixed++
        $totalReplacements += $fileReplacements

        if ($Apply) {
            $backup = "$($file.FullName).bak-encoding-fix"
            if (-not (Test-Path $backup)) {
                [System.IO.File]::WriteAllBytes($backup, $bytes)
            }
            [System.IO.File]::WriteAllText($file.FullName, $content, $utf8)
        }
    }
}

Write-Host ""
Write-Host "=========================================================" -ForegroundColor Cyan
Write-Host "  Summary" -ForegroundColor Cyan
Write-Host "=========================================================" -ForegroundColor Cyan
Write-Host ("  Files affected:   {0}" -f $filesFixed)
Write-Host ("  Total characters: {0}" -f $totalReplacements)
Write-Host ""

if ($perPatternCount.Count -gt 0) {
    Write-Host "  Pattern breakdown:" -ForegroundColor DarkGray
    $perPatternCount.GetEnumerator() | Sort-Object Value -Descending | ForEach-Object {
        Write-Host ("    {0,-22} {1,6}" -f $_.Key, $_.Value)
    }
    Write-Host ""
}

if (-not $Apply) {
    if ($filesFixed -gt 0) {
        Write-Host "To apply these fixes, run:" -ForegroundColor Yellow
        Write-Host "  .\fix-mojibake.ps1 -Apply" -ForegroundColor Yellow
        Write-Host ""
        Write-Host "A .bak-encoding-fix copy is saved next to each modified file." -ForegroundColor DarkGray
    } else {
        Write-Host "No mojibake detected. Repo is clean." -ForegroundColor Green
    }
} else {
    Write-Host "Done. Review with git diff, then commit." -ForegroundColor Green
    Write-Host ""
    Write-Host "To remove backups after verifying:" -ForegroundColor DarkGray
    Write-Host "  Get-ChildItem -Recurse -Filter *.bak-encoding-fix | Remove-Item"
}
Write-Host ""
