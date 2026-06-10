// =============================================================
// app/lib/data/sec-monitor.ts
//
// Real-time SEC filing monitor. Polls EDGAR atom feeds every
// 10 minutes (via GitHub Actions cron) for:
//   - Form 4    insider open-market trades
//   - 13D       activist 5%+ ownership disclosures
//   - 13G       passive 5%+ ownership (filtered for non-index-fund filers)
//   - 8-K       material event disclosures (filtered to high-signal items)
//
// Architecture:
//   1. Fetch the most recent filings of each type from EDGAR atom feed
//   2. Parse each filing's XML for the structured data
//   3. Filter based on signal thresholds (defined per type below)
//   4. Upsert into filing_alerts with accession_no as the dedup key
//
// Idempotent: re-polling is safe; ON CONFLICT DO NOTHING via the
// UNIQUE constraint on accession_no.
//
// Step 1 of 5: This file currently implements Form 4 only.
// Steps 2 (13D/G) and 3 (8-K) will add their respective fetchers.
// =============================================================

import { createClient, SupabaseClient } from '@supabase/supabase-js'

const EDGAR_BASE = 'https://www.sec.gov'
const EDGAR_HEADERS = {
  'User-Agent': 'Wali-OS/1.0 support@wali-os.com',
}

// Signal thresholds for Form 4 (Form 4 only filters by these — other
// filing types have their own thresholds enforced in their fetchers).
const FORM4_BUY_THRESHOLD_DOLLARS = 100_000
const FORM4_SELL_THRESHOLD_DOLLARS = 500_000

// ─────────────────────────────────────────────────────────────
// Supabase admin client (service role — bypasses RLS)
// ─────────────────────────────────────────────────────────────
function getAdmin(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    console.warn('[sec-monitor] Supabase env missing — operating in read-only/no-op mode')
    return null
  }
  return createClient(url, key)
}

// ─────────────────────────────────────────────────────────────
// CIK → ticker resolution
// ─────────────────────────────────────────────────────────────
//
// SEC filings reference companies by CIK (Central Index Key), a
// numeric identifier. To resolve to a tradable ticker we use SEC's
// public company_tickers.json which maps both directions.
//
// Cache the full map in memory — it's ~10K entries, fetched once
// per Node process, refreshed when the cache is cleared. SEC
// updates the file daily-ish, so a fresh process picks up new
// listings within ~24 hours.

interface CikTickerEntry {
  cik: string        // zero-padded 10-digit
  ticker: string
  name: string
}

let cikTickerCache: Map<string, CikTickerEntry> | null = null

export function clearCikTickerCache(): void {
  cikTickerCache = null
}

async function getCikTickerMap(): Promise<Map<string, CikTickerEntry>> {
  if (cikTickerCache) return cikTickerCache

  try {
    const res = await fetch(`${EDGAR_BASE}/files/company_tickers.json`, {
      headers: EDGAR_HEADERS,
    })
    if (!res.ok) {
      console.warn(`[sec-monitor] company_tickers.json fetch failed: ${res.status}`)
      cikTickerCache = new Map()
      return cikTickerCache
    }
    const data = await res.json() as Record<string, {
      cik_str: number
      ticker: string
      title: string
    }>

    const map = new Map<string, CikTickerEntry>()
    for (const entry of Object.values(data)) {
      const cik = String(entry.cik_str).padStart(10, '0')
      map.set(cik, {
        cik,
        ticker: entry.ticker.toUpperCase(),
        name: entry.title,
      })
    }
    cikTickerCache = map
    console.log(`[sec-monitor] cached ${map.size} CIK→ticker mappings`)
    return map
  } catch (e) {
    console.warn(`[sec-monitor] company_tickers fetch error: ${(e as Error).message}`)
    cikTickerCache = new Map()
    return cikTickerCache
  }
}

/**
 * Resolve a CIK (in any common format) to its ticker.
 * Returns null if the CIK isn't in SEC's company_tickers.json
 * (which excludes funds, trusts, foreign filers that don't trade,
 * etc.). Null tickers are still recorded in filing_alerts so we
 * have an audit trail; they just don't surface in per-ticker views.
 */
export async function resolveTicker(rawCik: string): Promise<{
  ticker: string | null
  name: string | null
}> {
  const cikPadded = String(rawCik).replace(/^CIK/i, '').replace(/^0+/, '').padStart(10, '0')
  const map = await getCikTickerMap()
  const entry = map.get(cikPadded)
  return entry
    ? { ticker: entry.ticker, name: entry.name }
    : { ticker: null, name: null }
}

// ─────────────────────────────────────────────────────────────
// EDGAR atom feed parsing
// ─────────────────────────────────────────────────────────────
//
// SEC's getcurrent endpoint returns an atom feed of recent filings
// of a given type. Each entry has:
//   <entry>
//     <title>4 - [Filer name] (CIK 0001234567) (Filing date: 2026-06-10)</title>
//     <link href=".../Archives/edgar/data/.../0001234567-26-000123-index.htm" />
//     <updated>2026-06-10T14:23:00-04:00</updated>
//     <id>urn:tag:sec.gov,2008:accession-number=0001234567-26-000123</id>
//   </entry>
//
// We extract accession_no, filer CIK, and the index URL — then fetch
// each filing's XML for the structured transaction data.

interface AtomEntry {
  accessionNo: string
  filerCik: string
  filerName: string
  indexUrl: string
  filedAt: string  // ISO timestamp from <updated>
}

async function fetchAtomFeed(type: '4' | '13D' | '13G' | '8-K', count: number): Promise<AtomEntry[]> {
  // SEC's getcurrent endpoint accepts a type parameter but does NOT
  // actually filter results server-side — we get every recent filing
  // regardless of what we ask for. So we still pass the parameter
  // (to be polite), but the real filtering happens client-side below
  // by inspecting each entry's title prefix.
  const typeParam =
    type === '13D' ? 'SC%2013D' :
    type === '13G' ? 'SC%2013G' :
    type
  // Pull more entries when we'll be filtering client-side — most won't
  // be the type we want, so we need a bigger sample to find enough.
  const requestedCount = Math.min(count * 4, 100)
  const url = `${EDGAR_BASE}/cgi-bin/browse-edgar?action=getcurrent&type=${typeParam}&company=&dateb=&owner=include&count=${requestedCount}&output=atom`

  // Diagnostic: log the URL we're hitting
  console.log(`[sec-monitor] fetching atom feed: ${url}`)

  // Client-side filter prefix to match in title. Title format is:
  //   "{form-type} - {filer name} ({cik}) ({role})"
  // where role is "(Filer)", "(Subject)", or "(Filer, Subject)".
  // For 13D/G, the same filing may appear twice in the feed — once
  // for the filer (the holder) and once for the subject (the company
  // being disclosed about). We want the (Filer) row since that's
  // where the holder identity lives.
  const titlePrefix =
    type === '4'   ? /^4\s*-\s+/ :
    type === '13D' ? /^SC\s+13D(?:\/A)?\s*-\s+/ :
    type === '13G' ? /^SC\s+13G(?:\/A)?\s*-\s+/ :
                     /^8-K\s*-\s+/

  try {
    const res = await fetch(url, { headers: EDGAR_HEADERS })
    if (!res.ok) {
      console.warn(`[sec-monitor] atom feed fetch failed for type=${type}: HTTP ${res.status} ${res.statusText}`)
      return []
    }
    const xml = await res.text()
    console.log(`[sec-monitor] atom feed type=${type}: response ${xml.length} bytes`)

    const entryBlocks = xml.match(/<entry>[\s\S]*?<\/entry>/g) ?? []
    console.log(`[sec-monitor] atom feed type=${type}: total ${entryBlocks.length} entries (will filter to type ${type})`)

    const parsed: AtomEntry[] = []
    let matchedTypeCount = 0
    let skippedRole = 0
    let skippedNoCik = 0
    let skippedNoAccession = 0

    for (const entry of entryBlocks) {
      const titleMatch = entry.match(/<title>([^<]+)<\/title>/)
      if (!titleMatch) continue
      const title = titleMatch[1]

      // Client-side type filter
      if (!titlePrefix.test(title)) continue
      matchedTypeCount++

      // For 13D/G, prefer the (Filer) role. The (Subject) row is the
      // same filing viewed from the issuer's perspective and would
      // produce a duplicate accession_no upsert.
      if ((type === '13D' || type === '13G') && /\(Subject\)/i.test(title) && !/\(Filer\)/i.test(title)) {
        skippedRole++
        continue
      }

      const linkMatch = entry.match(/<link[^>]*href="([^"]+)"/)
      const updatedMatch = entry.match(/<updated>([^<]+)<\/updated>/)
      const idMatch = entry.match(/<id>([^<]+)<\/id>/)
      if (!linkMatch || !updatedMatch || !idMatch) continue

      // Title CIK is in bare-digits parens: "Foo Inc (0001234567) (Filer)"
      // The 4-12 digit constraint catches 7-10-digit CIKs without
      // grabbing accession numbers (18 digits) that may appear elsewhere.
      const cikMatch = title.match(/\((\d{4,12})\)\s*\([A-Za-z]/i)
      if (!cikMatch) {
        skippedNoCik++
        continue
      }

      // Strip the form prefix and trailing (cik) (role) to get filer name
      const filerName = title
        .replace(titlePrefix, '')
        .replace(/\s*\(\d{4,12}\).*$/i, '')
        .trim()

      const accessionFromId = idMatch[1].match(/accession-number=([\d-]+)/)?.[1] ?? ''
      if (!accessionFromId) {
        skippedNoAccession++
        continue
      }

      parsed.push({
        accessionNo: accessionFromId,
        filerCik: cikMatch[1].padStart(10, '0'),
        filerName,
        indexUrl: linkMatch[1],
        filedAt: updatedMatch[1],
      })
    }

    console.log(
      `[sec-monitor] atom feed type=${type}: filtered to ${parsed.length} parseable entries ` +
      `(${matchedTypeCount} matched type, ${skippedRole} skipped role, ` +
      `${skippedNoCik} skipped no-cik, ${skippedNoAccession} skipped no-accession)`,
    )

    return parsed
  } catch (e) {
    console.warn(`[sec-monitor] atom feed parse error for type=${type}: ${(e as Error).message}`)
    return []
  }
}

// ─────────────────────────────────────────────────────────────
// Form 4 XML fetching
// ─────────────────────────────────────────────────────────────

async function fetchForm4Xml(indexUrl: string, accessionNo: string): Promise<string | null> {
  // The atom feed gives us an *-index.htm URL. The actual Form 4
  // XML lives in the same directory as the index, with a filename
  // we have to discover by scraping the index page or trying the
  // accession-based name.

  // Derive the base directory from the index URL
  const baseUrl = indexUrl.replace(/\/[^/]+$/, '')
  const accNoClean = accessionNo.replace(/-/g, '')

  // Attempt 1: standard naming convention
  try {
    const res = await fetch(`${baseUrl}/${accessionNo}.xml`, { headers: EDGAR_HEADERS })
    if (res.ok) {
      const text = await res.text()
      if (text.includes('<ownershipDocument>')) return text
    }
  } catch { /* fall through */ }

  // Attempt 2: scrape index page for the .xml link
  try {
    const idxRes = await fetch(`${baseUrl}/`, { headers: EDGAR_HEADERS })
    if (!idxRes.ok) return null
    const html = await idxRes.text()
    const xmlLinks = [...html.matchAll(/href="([^"]*\.xml)"/gi)].map(m => m[1])
    // Form 4 XML files don't have a perfectly consistent name. Filter
    // out obvious non-ownership XML files (e.g. xslF345X05 stylesheet).
    const candidates = xmlLinks.filter(l => !/xsl/i.test(l) && !/primary_doc/i.test(l))
    for (const link of candidates) {
      const fullUrl = link.startsWith('http') ? link : `${EDGAR_BASE}${link}`
      const xmlRes = await fetch(fullUrl, { headers: EDGAR_HEADERS })
      if (!xmlRes.ok) continue
      const text = await xmlRes.text()
      if (text.includes('<ownershipDocument>')) return text
    }
  } catch { /* fall through */ }

  // Last resort: try primary_doc.xml even though it's usually a wrapper
  try {
    const res = await fetch(`${baseUrl}/primary_doc.xml`, { headers: EDGAR_HEADERS })
    if (res.ok) {
      const text = await res.text()
      if (text.includes('<ownershipDocument>')) return text
    }
  } catch { /* fall through */ }

  // Reference accNoClean to keep it from being flagged as unused
  // (it's part of the fallback URL pattern in some installations).
  void accNoClean
  return null
}

// ─────────────────────────────────────────────────────────────
// Form 4 parsing
// ─────────────────────────────────────────────────────────────

interface Form4Transaction {
  code: string             // P, S, M, A, etc.
  date: string             // YYYY-MM-DD
  shares: number
  pricePerShare: number
  dollarValue: number
}

interface Form4Parsed {
  issuerCik: string
  issuerName: string
  issuerTradingSymbol: string  // sometimes empty
  filerName: string            // the insider's name
  filerCik: string
  filerTitle: string           // 'CEO', 'CFO', 'Director', etc.
  isOfficer: boolean
  isDirector: boolean
  isTenPercentOwner: boolean
  transactions: Form4Transaction[]
}

function parseForm4Xml(xml: string): Form4Parsed | null {
  try {
    const issuerCik = xml.match(/<issuerCik>(\d+)<\/issuerCik>/)?.[1] ?? ''
    const issuerName = xml.match(/<issuerName>([^<]+)<\/issuerName>/)?.[1]?.trim() ?? ''
    const issuerTradingSymbol = xml.match(/<issuerTradingSymbol>([^<]+)<\/issuerTradingSymbol>/)?.[1]?.trim() ?? ''
    if (!issuerCik) return null

    const filerName = xml.match(/<rptOwnerName>([^<]+)<\/rptOwnerName>/)?.[1]?.trim() ?? ''
    const filerCik = xml.match(/<rptOwnerCik>(\d+)<\/rptOwnerCik>/)?.[1] ?? ''
    const filerTitle = xml.match(/<officerTitle>([^<]+)<\/officerTitle>/)?.[1]?.trim() ?? ''

    const isOfficer = /<isOfficer>(?:1|true)<\/isOfficer>/i.test(xml)
    const isDirector = /<isDirector>(?:1|true)<\/isDirector>/i.test(xml)
    const isTenPercentOwner = /<isTenPercentOwner>(?:1|true)<\/isTenPercentOwner>/i.test(xml)

    // Only parse non-derivative (i.e. actual stock) transactions.
    // Derivative transactions (options exercises, etc.) are noise for
    // our P/S signal — leave them out.
    const txBlocks = xml.match(/<nonDerivativeTransaction>[\s\S]*?<\/nonDerivativeTransaction>/g) ?? []
    const transactions: Form4Transaction[] = []
    for (const block of txBlocks) {
      const code = block.match(/<transactionCode>([^<]+)<\/transactionCode>/)?.[1]?.trim() ?? ''
      if (!code) continue

      // Each leaf field in Form 4 XML is wrapped: <transactionShares><value>X</value></transactionShares>
      const date = block.match(/<transactionDate>[\s\S]*?<value>([^<]+)<\/value>/)?.[1]?.trim() ?? ''
      const sharesStr = block.match(/<transactionShares>[\s\S]*?<value>([^<]+)<\/value>/)?.[1] ?? '0'
      const priceStr = block.match(/<transactionPricePerShare>[\s\S]*?<value>([^<]+)<\/value>/)?.[1] ?? '0'
      const shares = parseInt(sharesStr.replace(/,/g, ''), 10) || 0
      const pricePerShare = parseFloat(priceStr.replace(/,/g, '')) || 0
      const dollarValue = shares * pricePerShare

      if (shares > 0) {
        transactions.push({ code, date, shares, pricePerShare, dollarValue })
      }
    }

    return {
      issuerCik: issuerCik.padStart(10, '0'),
      issuerName,
      issuerTradingSymbol: issuerTradingSymbol.toUpperCase(),
      filerName,
      filerCik,
      filerTitle,
      isOfficer,
      isDirector,
      isTenPercentOwner,
      transactions,
    }
  } catch (e) {
    console.warn(`[sec-monitor] Form 4 parse error: ${(e as Error).message}`)
    return null
  }
}

function deriveFilerRole(parsed: Form4Parsed): string {
  const title = parsed.filerTitle.toUpperCase()
  // Try to extract a role from the officer title field. Common
  // values: "CHIEF EXECUTIVE OFFICER", "CFO", "PRESIDENT", "DIRECTOR".
  if (/CEO|CHIEF\s+EXEC/i.test(title)) return 'CEO'
  if (/CFO|CHIEF\s+FIN/i.test(title)) return 'CFO'
  if (/COO|CHIEF\s+OPER/i.test(title)) return 'COO'
  if (/CTO|CHIEF\s+TECH/i.test(title)) return 'CTO'
  if (/PRESIDENT/i.test(title)) return 'President'
  if (/CHAIRMAN/i.test(title)) return 'Chairman'
  if (/GENERAL\s+COUNSEL/i.test(title)) return 'General Counsel'
  if (parsed.isOfficer && title) return title  // some unique role
  if (parsed.isOfficer) return 'Officer'
  if (parsed.isDirector) return 'Director'
  if (parsed.isTenPercentOwner) return '10%-owner'
  return 'Insider'
}

// ─────────────────────────────────────────────────────────────
// Public: fetch recent Form 4 filings, write filtered to filing_alerts
// ─────────────────────────────────────────────────────────────

export interface Form4IngestResult {
  scanned: number             // total filings seen in the feed
  parsed: number              // successfully parsed
  transactionsSeen: number    // total transactions in parsed filings
  inserted: number            // transactions written to filing_alerts (after filtering)
  belowThreshold: number      // P/S transactions filtered by dollar threshold
  nonPS: number               // transactions skipped (not code P or S)
  duplicates: number          // accession already in DB
  errors: number              // parsing/network failures
}

/**
 * Poll the recent firmwide Form 4 atom feed, parse each filing's XML,
 * and write open-market transactions above threshold to filing_alerts.
 *
 * @param feedCount  How many recent filings to pull from the atom feed
 *                   (default 40 — SEC's feed maxes around 100 per request).
 *                   At 10-min polling intervals, 40 covers normal volume
 *                   comfortably; bump higher if backlog builds.
 */
export async function fetchRecentForm4s(feedCount = 40): Promise<Form4IngestResult> {
  const admin = getAdmin()
  if (!admin) {
    return {
      scanned: 0, parsed: 0, transactionsSeen: 0, inserted: 0,
      belowThreshold: 0, nonPS: 0, duplicates: 0, errors: 0,
    }
  }

  const result: Form4IngestResult = {
    scanned: 0, parsed: 0, transactionsSeen: 0, inserted: 0,
    belowThreshold: 0, nonPS: 0, duplicates: 0, errors: 0,
  }

  const entries = await fetchAtomFeed('4', feedCount)
  result.scanned = entries.length

  for (const entry of entries) {
    try {
      const xml = await fetchForm4Xml(entry.indexUrl, entry.accessionNo)
      if (!xml) {
        result.errors++
        continue
      }
      const parsed = parseForm4Xml(xml)
      if (!parsed) {
        result.errors++
        continue
      }
      result.parsed++

      // Resolve the issuer CIK to a ticker. If parsed XML had a
      // trading symbol, prefer that; otherwise look up via SEC's
      // company_tickers map.
      let ticker: string | null = parsed.issuerTradingSymbol || null
      let issuerName: string | null = parsed.issuerName || null
      if (!ticker) {
        const resolved = await resolveTicker(parsed.issuerCik)
        ticker = resolved.ticker
        if (!issuerName && resolved.name) issuerName = resolved.name
      }

      const filerRole = deriveFilerRole(parsed)

      for (const tx of parsed.transactions) {
        result.transactionsSeen++

        // Filter: only P (open-market purchase) and S (open-market sale)
        if (tx.code !== 'P' && tx.code !== 'S') {
          result.nonPS++
          continue
        }

        // Dollar thresholds
        const threshold = tx.code === 'P' ? FORM4_BUY_THRESHOLD_DOLLARS : FORM4_SELL_THRESHOLD_DOLLARS
        if (tx.dollarValue < threshold) {
          result.belowThreshold++
          continue
        }

        const eventType = tx.code === 'P' ? 'open_market_buy' : 'open_market_sell'

        // Use accession_no + transaction code + date as the dedup key,
        // since a single filing can have multiple transactions. We
        // distinguish them with a suffix on accession_no.
        const dedupKey = `${entry.accessionNo}-${tx.code}-${tx.date}`

        const { error: upsertErr } = await admin.from('filing_alerts').upsert(
          {
            filing_type: '4',
            ticker,
            issuer_cik: parsed.issuerCik,
            issuer_name: issuerName,
            filer_name: parsed.filerName,
            filer_cik: parsed.filerCik || null,
            filer_role: filerRole,
            accession_no: dedupKey,
            filed_at: entry.filedAt,
            filing_url: entry.indexUrl,
            event_type: eventType,
            dollar_value: tx.dollarValue,
            shares: tx.shares,
            percent_owned: null,
            transaction_code: tx.code,
            transaction_data: {
              date: tx.date,
              shares: tx.shares,
              price_per_share: tx.pricePerShare,
              dollar_value: tx.dollarValue,
              is_officer: parsed.isOfficer,
              is_director: parsed.isDirector,
              is_ten_percent_owner: parsed.isTenPercentOwner,
              officer_title: parsed.filerTitle,
              original_accession: entry.accessionNo,
            },
          },
          { onConflict: 'accession_no', ignoreDuplicates: true },
        )

        if (upsertErr) {
          // Most expected error: unique violation on accession_no for
          // re-polled filings. That's fine. Other errors warrant a log.
          if (!/duplicate|unique/i.test(upsertErr.message)) {
            console.warn(`[sec-monitor] Form 4 upsert error: ${upsertErr.message}`)
          }
          result.duplicates++
        } else {
          result.inserted++
          console.log(
            `[sec-monitor] Form 4: ${parsed.filerName} (${filerRole}) ${eventType} ` +
            `${tx.shares.toLocaleString()} shares of ${ticker ?? parsed.issuerCik} ` +
            `@ $${tx.pricePerShare.toFixed(2)} = $${(tx.dollarValue / 1e6).toFixed(2)}M`,
          )
        }
      }
    } catch (e) {
      console.warn(`[sec-monitor] Form 4 entry error: ${(e as Error).message}`)
      result.errors++
    }

    // Polite EDGAR pacing — ~100ms between filings = 10/sec max
    await new Promise(r => setTimeout(r, 100))
  }

  console.log(
    `[sec-monitor] Form 4 run complete: scanned=${result.scanned} parsed=${result.parsed} ` +
    `transactions=${result.transactionsSeen} inserted=${result.inserted} ` +
    `(${result.belowThreshold} below threshold, ${result.nonPS} non-P/S, ` +
    `${result.duplicates} duplicates, ${result.errors} errors)`,
  )

  return result
}
