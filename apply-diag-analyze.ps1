# =============================================================
# apply-diag-analyze.ps1
#
# Adds diagnostic logging to app\api\analyze\route.ts so you can
# see exactly what happens when a client disconnects mid-analysis.
#
# Adds 13 instrumentation points using a per-request id (reqId)
# so each request can be traced through Railway logs even if many
# are running in parallel.
#
# WHAT YOU'LL SEE IN RAILWAY LOGS after applying:
#   [analyze:abc12345] +0.0s START ticker=AAPL tf=1W ...
#   [analyze:abc12345] +0.1s auth resolved userId=...
#   [analyze:abc12345] +1.2s LIVE pipeline starting (cache miss or stale)
#   [analyze:abc12345] +5.3s bundle built (price=$185.32), entering runPipeline
#   [analyze:abc12345] +47.8s !! CONTROLLER CLOSED at event=judge_done
#   [analyze:abc12345] +48.0s runPipeline RETURNED (signal=BULLISH confidence=72)
#   [analyze:abc12345] +48.1s starting analyses insert
#   [analyze:abc12345] +48.5s analyses inserted OK id=abc-def-...
#   [analyze:abc12345] +48.5s checking verdict_log for dup
#   [analyze:abc12345] +48.7s inserting verdict_log row
#   [analyze:abc12345] +48.9s verdict_log inserted OK
#   [analyze:abc12345] +49.0s DONE via live run (controllerClosed=true at stage=judge_done)
#
# If something fails, you'll see exactly which step and the error.
#
# This patch is purely additive - all original code paths still work.
# Logging overhead is negligible (<1ms per dlog call).
#
# Usage:
#   .\apply-diag-analyze.ps1          (dry run)
#   .\apply-diag-analyze.ps1 -Apply   (write changes)
# =============================================================

param([switch]$Apply)

$ErrorActionPreference = 'Stop'

$Target = 'app\api\analyze\route.ts'

if (-not (Test-Path $Target)) {
    Write-Host "ERROR: $Target not found. Run this script from the repo root." -ForegroundColor Red
    exit 1
}

# === Helpers ===================================================
function Bytes-IndexOf([byte[]]$haystack, [byte[]]$needle) {
    if ($needle.Length -gt $haystack.Length) { return -1 }
    for ($i = 0; $i -le ($haystack.Length - $needle.Length); $i++) {
        $match = $true
        for ($j = 0; $j -lt $needle.Length; $j++) {
            if ($haystack[$i + $j] -ne $needle[$j]) { $match = $false; break }
        }
        if ($match) { return $i }
    }
    return -1
}

function Bytes-CountOccurrences([byte[]]$haystack, [byte[]]$needle) {
    if ($needle.Length -gt $haystack.Length) { return 0 }
    $count = 0
    $i = 0
    while ($i -le ($haystack.Length - $needle.Length)) {
        $match = $true
        for ($j = 0; $j -lt $needle.Length; $j++) {
            if ($haystack[$i + $j] -ne $needle[$j]) { $match = $false; break }
        }
        if ($match) {
            $count++
            $i += $needle.Length
        } else {
            $i++
        }
    }
    return $count
}

function Bytes-ReplaceFirst([byte[]]$haystack, [byte[]]$needle, [byte[]]$replacement) {
    $idx = Bytes-IndexOf $haystack $needle
    if ($idx -lt 0) { return $null }

    $before = if ($idx -gt 0) { $haystack[0..($idx - 1)] } else { @() }
    $afterStart = $idx + $needle.Length
    $after = if ($afterStart -lt $haystack.Length) { $haystack[$afterStart..($haystack.Length - 1)] } else { @() }

    $result = New-Object byte[] ($before.Length + $replacement.Length + $after.Length)
    [Array]::Copy($before, 0, $result, 0, $before.Length)
    [Array]::Copy($replacement, 0, $result, $before.Length, $replacement.Length)
    if ($after.Length -gt 0) {
        [Array]::Copy($after, 0, $result, $before.Length + $replacement.Length, $after.Length)
    }
    return ,$result
}

# === Patches ===================================================
# Each patch: Name, Marker (idempotency check), Old (anchor), New (replacement).
# All anchors are pure ASCII so PS encoding is safe.
# In double-quoted PS strings:
#   `r`n  -> CRLF
#   `${x} -> literal ${x} (kept for TS template literals in the .ts output)
#   ``    -> literal backtick (kept for TS template literal start/end)

$encoder = [System.Text.Encoding]::UTF8
$patches = @()

# --- Patch 1: reqId + START log ---
$patches += @{
    Name = 'reqId + START log'
    Marker = 'const reqId = Math.random()'
    Old = "  const symbol = ticker.toUpperCase().trim()`r`n  const tf = timeframe || '1W'`r`n  const encoder = new TextEncoder()`r`n"
    New = "  const symbol = ticker.toUpperCase().trim()`r`n  const tf = timeframe || '1W'`r`n  const encoder = new TextEncoder()`r`n`r`n  // --- DIAG: per-request id for tracing through Railway logs ---`r`n  const reqId = Math.random().toString(36).slice(2, 10)`r`n  const startedAt = Date.now()`r`n  const dlog = (msg: string, extra?: unknown) => {`r`n    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1)`r`n    if (extra !== undefined) {`r`n      console.log(``[analyze:`${reqId}] +`${elapsed}s `${msg}``, extra)`r`n    } else {`r`n      console.log(``[analyze:`${reqId}] +`${elapsed}s `${msg}``)`r`n    }`r`n  }`r`n  dlog(``START ticker=`${symbol} tf=`${tf} forceRefresh=`${forceRefresh ?? false} persona=`${persona ?? 'balanced'}``)`r`n"
}

# --- Patch 2: auth resolved log ---
$patches += @{
    Name = 'auth resolved log'
    Marker = 'auth resolved userId='
    Old = "    currentUserId = user?.id ?? null`r`n  } catch { /* not blocking */ }`r`n"
    New = "    currentUserId = user?.id ?? null`r`n  } catch { /* not blocking */ }`r`n  dlog(``auth resolved userId=`${currentUserId ?? '(anonymous)'}``)`r`n"
}

# --- Patch 3: send() telemetry ---
$patches += @{
    Name = 'send() telemetry with controllerClosedAt'
    Marker = 'controllerClosedAt: { stage: string'
    Old = "      let controllerClosed = false`r`n      const send = (event: string, data: unknown) => {`r`n        if (controllerClosed) return`r`n        try {`r`n          controller.enqueue(encoder.encode(``event: `${event}\ndata: `${JSON.stringify(data)}\n\n``))`r`n        } catch { controllerClosed = true }`r`n      }`r`n"
    New = "      let controllerClosed = false`r`n      let controllerClosedAt: { stage: string; elapsedSec: string } | null = null`r`n      const send = (event: string, data: unknown) => {`r`n        if (controllerClosed) return`r`n        try {`r`n          controller.enqueue(encoder.encode(``event: `${event}\ndata: `${JSON.stringify(data)}\n\n``))`r`n        } catch {`r`n          controllerClosed = true`r`n          controllerClosedAt = { stage: event, elapsedSec: ((Date.now() - startedAt) / 1000).toFixed(1) }`r`n          dlog(``!! CONTROLLER CLOSED at event=`${event} (client disconnected, pipeline continues server-side)``)`r`n        }`r`n      }`r`n"
}

# --- Patch 4: cache HIT log ---
$patches += @{
    Name = 'cache HIT log'
    Marker = 'cache HIT (age'
    Old = "            if (!priceStale) {`r`n            const ageMinutes = Math.round(`r`n              (Date.now() - new Date(cached.created_at).getTime()) / 60000`r`n            )`r`n            // Stream cached results exactly like a live run`r`n"
    New = "            if (!priceStale) {`r`n            const ageMinutes = Math.round(`r`n              (Date.now() - new Date(cached.created_at).getTime()) / 60000`r`n            )`r`n            dlog(``cache HIT (age `${ageMinutes}m, will replay)``)`r`n            // Stream cached results exactly like a live run`r`n"
}

# --- Patch 5: DONE via cache hit log ---
$patches += @{
    Name = 'DONE via cache hit log'
    Marker = 'DONE via cache hit'
    Old = "              transcript: cached.transcript,`r`n            })`r`n            return`r`n            } // end !priceStale`r`n"
    New = "              transcript: cached.transcript,`r`n            })`r`n            dlog(``DONE via cache hit (controllerClosed=`${controllerClosed})``)`r`n            return`r`n            } // end !priceStale`r`n"
}

# --- Patch 6: LIVE pipeline starting log ---
# Anchor on the send() call (skip the Unicode comment above it)
$patches += @{
    Name = 'LIVE pipeline starting log'
    Marker = 'LIVE pipeline starting'
    Old = "        send('status', { stage: 'building_bundle', message: 'Gathering market data and computing signals...' })`r`n"
    New = "        dlog(``LIVE pipeline starting (cache miss or stale)``)`r`n        send('status', { stage: 'building_bundle', message: 'Gathering market data and computing signals...' })`r`n"
}

# --- Patch 7: pipeline run telemetry ---
$patches += @{
    Name = 'runPipeline telemetry'
    Marker = 'runPipeline RETURNED'
    Old = "        const result = await runPipeline(bundle, (event, data) => send(event, data))`r`n"
    New = "        dlog(``bundle built (price=`$`${bundle.currentPrice.toFixed(2)}), entering runPipeline``)`r`n        const result = await runPipeline(bundle, (event, data) => send(event, data))`r`n        dlog(``runPipeline RETURNED (signal=`${result.judge?.signal} confidence=`${result.judge?.confidence})``)`r`n"
}

# --- Patch 8: analyses insert with error capture ---
# Anchor on the const line only (skip the Unicode comment above it)
$patches += @{
    Name = 'analyses insert with error capture'
    Marker = 'starting analyses insert'
    Old = "        const { data: saved } = await supabase.from('analyses').insert({`r`n"
    New = "        dlog(``starting analyses insert``)`r`n        const { data: saved, error: savedErr } = await supabase.from('analyses').insert({`r`n"
}

# --- Patch 9: analyses insert outcome ---
$patches += @{
    Name = 'analyses insert outcome log'
    Marker = 'analyses inserted OK id='
    Old = "          },`r`n        }).select().single()`r`n`r`n        // Auto-log to track record directly via service role (no HTTP round-trip)`r`n"
    New = "          },`r`n        }).select().single()`r`n        if (savedErr) {`r`n          dlog(``!! analyses INSERT FAILED: `${savedErr.message}``, { code: savedErr.code, details: savedErr.details })`r`n        } else {`r`n          dlog(``analyses inserted OK id=`${saved?.id ?? '(no id returned)'}``)`r`n        }`r`n`r`n        // Auto-log to track record directly via service role (no HTTP round-trip)`r`n"
}

# --- Patch 10: verdict_log dedup query log ---
# Anchor on the const line (skip the Unicode em-dash comment above it)
$patches += @{
    Name = 'verdict_log dedup query log'
    Marker = 'checking verdict_log for dup'
    Old = "          const { data: existing } = await supabase`r`n            .from('verdict_log')`r`n            .select('id')`r`n"
    New = "          dlog(``checking verdict_log for dup``)`r`n          const { data: existing } = await supabase`r`n            .from('verdict_log')`r`n            .select('id')`r`n"
}

# --- Patch 11: verdict_log insert with error capture ---
$patches += @{
    Name = 'verdict_log insert with error capture'
    Marker = 'inserting verdict_log row'
    Old = "          if (!existing) {`r`n            try {`r`n              await supabase.from('verdict_log').insert({`r`n"
    New = "          if (!existing) {`r`n            try {`r`n              dlog(``inserting verdict_log row``)`r`n              const { error: vlErr } = await supabase.from('verdict_log').insert({`r`n"
}

# --- Patch 12: verdict_log insert outcome ---
$patches += @{
    Name = 'verdict_log insert outcome log'
    Marker = 'verdict_log inserted OK'
    Old = "                trader_evaluated_at: result.trader?.evaluatedAt ?? null,`r`n              })`r`n            } catch { /* non-critical */ }`r`n          }`r`n        }`r`n`r`n        send('complete', {`r`n"
    New = "                trader_evaluated_at: result.trader?.evaluatedAt ?? null,`r`n              })`r`n              if (vlErr) {`r`n                dlog(``!! verdict_log INSERT FAILED: `${vlErr.message}``, { code: vlErr.code })`r`n              } else {`r`n                dlog(``verdict_log inserted OK``)`r`n              }`r`n            } catch (e) {`r`n              dlog(``!! verdict_log threw exception: `${(e as Error).message}``)`r`n            }`r`n          } else {`r`n            dlog(``verdict_log skipped (dup found, id=`${existing.id})``)`r`n          }`r`n        } else if (currentUserId) {`r`n          dlog(``verdict_log skipped (signal=`${result.judge?.signal ?? 'undefined'}, must be BULLISH/BEARISH and userId present)``)`r`n        }`r`n`r`n        send('complete', {`r`n"
}

# --- Patch 13: final DONE + UNCAUGHT log ---
$patches += @{
    Name = 'final DONE + UNCAUGHT log'
    Marker = 'DONE via live run'
    Old = "        send('complete', {`r`n          analysisId: saved?.id,`r`n          cached: false,`r`n          ...result,`r`n        })`r`n`r`n`r`n      } catch (err) {`r`n        console.error('Pipeline error:', err)`r`n        send('error', { message: err instanceof Error ? err.message : 'Pipeline failed' })`r`n"
    New = "        send('complete', {`r`n          analysisId: saved?.id,`r`n          cached: false,`r`n          ...result,`r`n        })`r`n        dlog(``DONE via live run (controllerClosed=`${controllerClosed}`${controllerClosedAt ? `` at stage=`${controllerClosedAt.stage}`` : ''})``)`r`n`r`n`r`n      } catch (err) {`r`n        dlog(``!! UNCAUGHT pipeline error: `${err instanceof Error ? err.message : String(err)}``)`r`n        console.error('Pipeline error:', err)`r`n        send('error', { message: err instanceof Error ? err.message : 'Pipeline failed' })`r`n"
}

# === Apply =====================================================
Write-Host "Patching $Target" -ForegroundColor Cyan
Write-Host ""

$bytes = [System.IO.File]::ReadAllBytes($Target)
$originalLength = $bytes.Length

$applied = 0
$alreadyPatched = 0
$failed = @()

foreach ($p in $patches) {
    # Idempotency: if marker is already present, skip this patch
    $markerBytes = $encoder.GetBytes($p.Marker)
    $markerCount = Bytes-CountOccurrences $bytes $markerBytes
    if ($markerCount -ge 1) {
        Write-Host "  [skip] $($p.Name) (marker already present)" -ForegroundColor DarkGray
        $alreadyPatched++
        continue
    }

    $oldBytes = $encoder.GetBytes($p.Old)
    $newBytes = $encoder.GetBytes($p.New)

    $count = Bytes-CountOccurrences $bytes $oldBytes
    if ($count -ne 1) {
        Write-Host "  [FAIL] $($p.Name) - anchor count = $count (expected 1)" -ForegroundColor Red
        $failed += $p.Name
        continue
    }

    $bytes = Bytes-ReplaceFirst $bytes $oldBytes $newBytes
    if ($null -eq $bytes) {
        Write-Host "  [FAIL] $($p.Name) - replace returned null" -ForegroundColor Red
        $failed += $p.Name
        continue
    }
    Write-Host "  [+]    $($p.Name)" -ForegroundColor Green
    $applied++
}

Write-Host ""
Write-Host "Summary:" -ForegroundColor Cyan
Write-Host "  $applied applied, $alreadyPatched already-patched, $($failed.Count) failed" -ForegroundColor White
Write-Host "  Original size: $originalLength bytes, new size: $($bytes.Length) bytes (delta +$($bytes.Length - $originalLength))" -ForegroundColor DarkGray

if ($failed.Count -gt 0) {
    Write-Host ""
    Write-Host "Failed patches: $($failed -join ', ')" -ForegroundColor Red
    Write-Host "Aborting without writing changes." -ForegroundColor Red
    exit 1
}

if ($Apply) {
    if ($applied -gt 0) {
        [System.IO.File]::WriteAllBytes($Target, $bytes)
        Write-Host ""
        Write-Host "Wrote $Target" -ForegroundColor Green
        Write-Host ""
        Write-Host "Next steps:" -ForegroundColor Cyan
        Write-Host "  1. npm run build" -ForegroundColor Gray
        Write-Host "  2. git add -A && git commit -m 'diag: instrument analyze route to find bg-completion bug'" -ForegroundColor Gray
        Write-Host "  3. git push (Railway auto-deploys)" -ForegroundColor Gray
        Write-Host "  4. Reproduce the bug:" -ForegroundColor Gray
        Write-Host "       a. Open / in incognito" -ForegroundColor Gray
        Write-Host "       b. Type a fresh ticker (one not in cache)" -ForegroundColor Gray
        Write-Host "       c. Click Analyze" -ForegroundColor Gray
        Write-Host "       d. After Lead Analyst stage, close the tab" -ForegroundColor Gray
        Write-Host "       e. Wait 60 seconds" -ForegroundColor Gray
        Write-Host "       f. Reopen / and look at the analysis state" -ForegroundColor Gray
        Write-Host "  5. Open Railway dashboard -> Logs, filter for 'analyze:'" -ForegroundColor Gray
        Write-Host "  6. Find your reqId (matches one of the START lines), follow it through" -ForegroundColor Gray
        Write-Host "  7. Send me what you see and we'll write the fix" -ForegroundColor Gray
    } else {
        Write-Host ""
        Write-Host "Nothing to write - all patches already applied." -ForegroundColor DarkGray
    }
} else {
    Write-Host ""
    Write-Host "Dry run complete. Re-run with -Apply to write changes." -ForegroundColor Yellow
}
