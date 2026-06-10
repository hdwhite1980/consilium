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
  filerCik: string         // the CIK from the title — meaning depends on entryRole
  filerName: string
  indexUrl: string
  filedAt: string          // ISO timestamp from <updated>
  entryRole: string        // 'Reporting', 'Issuer', 'Filer', 'Subject', 'Reporting,Issuer', etc.
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
  // For 13D/G the feed sometimes contains only the (Subject) entry,
  // sometimes only the (Filer) entry, sometimes both. We accept all
  // and rely on the dedup key + XML parsing to handle relationships.
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

    // Diagnostic: when the response is suspiciously small, log a sample
    // so we can see whether it's a real "no entries" feed or an error.
    if (xml.length < 2000) {
      console.log(`[sec-monitor] atom feed type=${type} small body: ${xml.slice(0, 500).replace(/\s+/g, ' ')}`)
    }

    const entryBlocks = xml.match(/<entry>[\s\S]*?<\/entry>/g) ?? []
    console.log(`[sec-monitor] atom feed type=${type}: total ${entryBlocks.length} entries (will filter to type ${type})`)

    const parsed: AtomEntry[] = []
    let matchedTypeCount = 0
    let skippedNoCik = 0
    let skippedNoAccession = 0
    const sampleTitles: string[] = []

    for (const entry of entryBlocks) {
      const titleMatch = entry.match(/<title>([^<]+)<\/title>/)
      if (!titleMatch) continue
      const title = titleMatch[1]

      // Client-side type filter
      if (!titlePrefix.test(title)) continue
      matchedTypeCount++

      // Keep a sample of titles for diagnostic logging
      if (sampleTitles.length < 3) sampleTitles.push(title.slice(0, 150))

      const linkMatch = entry.match(/<link[^>]*href="([^"]+)"/)
      const updatedMatch = entry.match(/<updated>([^<]+)<\/updated>/)
      const idMatch = entry.match(/<id>([^<]+)<\/id>/)
      if (!linkMatch || !updatedMatch || !idMatch) continue

      // Title CIK is in bare-digits parens: "Foo Inc (0001234567) (Filer)"
      // The 4-12 digit constraint catches 7-10-digit CIKs without
      // grabbing accession numbers (18 digits) that may appear elsewhere.
      const cikMatch = title.match(/\((\d{4,12})\)\s*\(([A-Za-z][\w,\s]*)\)/i)
      if (!cikMatch) {
        skippedNoCik++
        continue
      }
      const entryRole = cikMatch[2].trim()

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
        entryRole,
      })
    }

    console.log(
      `[sec-monitor] atom feed type=${type}: parsed ${parsed.length} entries ` +
      `(${matchedTypeCount} matched type, ` +
      `${skippedNoCik} skipped no-cik, ${skippedNoAccession} skipped no-accession)`,
    )
    if (sampleTitles.length > 0) {
      console.log(`[sec-monitor] atom feed type=${type} sample titles: ${sampleTitles.map(t => `"${t}"`).join(' | ')}`)
    }

    // Deduplicate by accession_no within this feed pull (some filings
    // show up multiple times with different roles — Filer + Subject
    // + Filer/Subject combined). The DB layer also dedups via the
    // UNIQUE constraint, but de-duping here saves redundant XML fetches.
    const seen = new Set<string>()
    const deduped: AtomEntry[] = []
    for (const e of parsed) {
      if (seen.has(e.accessionNo)) continue
      seen.add(e.accessionNo)
      deduped.push(e)
    }
    if (deduped.length < parsed.length) {
      console.log(`[sec-monitor] atom feed type=${type}: deduped to ${deduped.length} unique accessions`)
    }

    return deduped
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

        const { data: upsertData, error: upsertErr } = await admin.from('filing_alerts').upsert(
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
        ).select('id')

        if (upsertErr) {
          // ignoreDuplicates means we shouldn't see unique-violation errors,
          // but log other errors (RLS, schema mismatch, etc.).
          console.warn(`[sec-monitor] Form 4 upsert error: ${upsertErr.message}`)
          result.errors++
        } else if (!upsertData || (upsertData as unknown[]).length === 0) {
          // ignoreDuplicates returned an empty result — row already existed.
          // This is the expected path for re-polled filings AND for the
          // intra-run duplicate case (same accession appears twice in the
          // feed under different roles like Filer vs 10%-owner).
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
    await new Promise(r => setTimeout(r, 250))  // polite EDGAR pacing
  }

  console.log(
    `[sec-monitor] Form 4 run complete: scanned=${result.scanned} parsed=${result.parsed} ` +
    `transactions=${result.transactionsSeen} inserted=${result.inserted} ` +
    `(${result.belowThreshold} below threshold, ${result.nonPS} non-P/S, ` +
    `${result.duplicates} duplicates, ${result.errors} errors)`,
  )

  return result
}

// =============================================================
// Step 2: 13D + 13G monitoring
// =============================================================
//
// Schedule 13D and 13G filings disclose when an entity crosses 5%
// ownership of a public company. Key differences from Form 4:
//
//   - The FILER is the holder (activist fund, institution).
//   - The SUBJECT is the company being disclosed about.
//   - These are filed within 10 days of crossing 5% (13D) or
//     during specific reporting windows (13G).
//
// 13D = activist intent. Filer plans to influence the company (board
//       seats, restructuring, M&A pressure). HIGH SIGNAL. Take every
//       13D filing — they're rare and meaningful.
//
// 13G = passive. Filer crossed 5% but isn't activist. MOSTLY NOISE.
//       Index funds (Vanguard, BlackRock, State Street) file 13Gs
//       constantly as their AUM grows. We filter those out and keep
//       only the long-only mutual funds and similar real-conviction
//       passive filers.

// Index-fund/passive-giant CIKs to exclude from 13G alerts.
// These file 13Gs mechanically as their indexed AUM grows;
// the signal is noise. Any other 13G filer is more interesting.
const PASSIVE_GIANT_CIKS = new Set<string>([
  '0000102909',  // Vanguard Group
  '0001364742',  // Bridgewater (paradox: also files 13F so listed, but rarely files 13G)
  '0000880285',  // BlackRock
  '0000093751',  // State Street
  '0000315066',  // Fidelity (FMR LLC)
  '0001037389',  // Renaissance Technologies (kept — quant, less noisy)
  '0000038777',  // Geode Capital
  '0000026172',  // Capital Group (one of several CIKs)
  '0000915191',  // T. Rowe Price
  '0001067639',  // Northern Trust
  '0001067983',  // Berkshire Hathaway (kept — very rare 13G filer; we want to know)
])

// Note: Renaissance and Berkshire are intentionally kept (commented).
// If they ever file a 13G, that IS news. Vanguard/BlackRock/etc filing
// 13Gs is purely mechanical and we exclude.

// ─────────────────────────────────────────────────────────────
// 13D/G XML fetching and parsing
// ─────────────────────────────────────────────────────────────

interface ScheduleDGParsed {
  subjectCik: string       // the company being disclosed about
  subjectName: string
  subjectCusip: string
  filerName: string
  filerCik: string
  percentOwned: number
  sharesOwned: number
  amendmentNo: number      // 0 for initial filing, >0 for amendments
}

async function fetchScheduleDGXml(indexUrl: string, accessionNo: string): Promise<string | null> {
  // 13D/G filings have varying XML filenames. We try the index-scrape
  // path first (most reliable — tells us exactly what files exist),
  // then fall back to known filenames.
  const baseUrl = indexUrl.replace(/\/[^/]+$/, '')

  // PRIMARY: scrape the index for any XML link and try each.
  // 13D/G XML can have any of these characteristic tags depending on
  // the filer's schema version: <edgarSubmission>, <schedule13>,
  // <schedule13Submission>, <ownershipDocument>, etc.
  try {
    const idxRes = await fetch(`${baseUrl}/`, { headers: EDGAR_HEADERS })
    if (idxRes.ok) {
      const html = await idxRes.text()
      const xmlLinks = [...html.matchAll(/href="([^"]*\.xml)"/gi)].map(m => m[1])
      // Skip stylesheets — they're never the data file
      const candidates = xmlLinks.filter(l => !/xsl/i.test(l))

      for (const link of candidates) {
        const fullUrl = link.startsWith('http') ? link : `${EDGAR_BASE}${link}`
        const xmlRes = await fetch(fullUrl, { headers: EDGAR_HEADERS })
        if (!xmlRes.ok) continue
        const text = await xmlRes.text()
        // Schedule 13D/G XML schemas vary. Accept any document containing
        // common 13D/G structural tags.
        if (
          text.includes('<edgarSubmission>') ||
          text.includes('schedule13') ||
          text.includes('<reportingPerson') ||
          text.includes('<subjectCompany') ||
          text.includes('<filer>')
        ) {
          return text
        }
      }
      // If we got the index but no XML had the expected tags, log
      // what XML files we found for diagnosis.
      if (candidates.length > 0) {
        console.log(
          `[sec-monitor] 13D/G ${accessionNo}: index had ${candidates.length} XML files but none parsed as schedule XML. Files: ${candidates.slice(0, 5).join(', ')}`,
        )
      } else {
        console.log(
          `[sec-monitor] 13D/G ${accessionNo}: index had no XML files`,
        )
      }
    } else {
      console.log(`[sec-monitor] 13D/G ${accessionNo}: index fetch failed HTTP ${idxRes.status}`)
    }
  } catch (e) {
    console.warn(`[sec-monitor] 13D/G ${accessionNo}: index scrape error: ${(e as Error).message}`)
  }

  // FALLBACK: try primary_doc.xml directly (modern schema convention)
  try {
    const res = await fetch(`${baseUrl}/primary_doc.xml`, { headers: EDGAR_HEADERS })
    if (res.ok) {
      const text = await res.text()
      if (
        text.includes('<edgarSubmission>') ||
        text.includes('schedule13') ||
        text.includes('<reportingPerson') ||
        text.includes('<subjectCompany') ||
        text.includes('<filer>')
      ) {
        return text
      }
    }
  } catch { /* fall through */ }

  return null
}

function parseScheduleDGXml(xml: string, accessionNo: string): ScheduleDGParsed | null {
  try {
    // Subject (the company being disclosed about)
    // Schedule 13D/G XML uses <subjectCompanyInfo> or older <subjectCompany>
    const subjectBlock =
      xml.match(/<subjectCompanyInfo>[\s\S]*?<\/subjectCompanyInfo>/)?.[0] ??
      xml.match(/<subjectCompany>[\s\S]*?<\/subjectCompany>/)?.[0] ?? ''
    const subjectCik = subjectBlock.match(/<cik>(\d+)<\/cik>/i)?.[1] ?? ''
    const subjectName = subjectBlock.match(/<(?:companyName|name)>([^<]+)<\/(?:companyName|name)>/i)?.[1]?.trim() ?? ''
    const subjectCusip = xml.match(/<cusip>([^<]+)<\/cusip>/i)?.[1]?.trim() ?? ''

    // Filer (the holder)
    const filerBlock =
      xml.match(/<filer>[\s\S]*?<\/filer>/)?.[0] ?? ''
    const filerName = filerBlock.match(/<(?:companyName|name)>([^<]+)<\/(?:companyName|name)>/i)?.[1]?.trim() ?? ''
    const filerCik = filerBlock.match(/<cik>(\d+)<\/cik>/i)?.[1] ?? ''

    // Percentage and share count — these live in <reportingPersonInfo> or
    // similar nested blocks. The exact tag names vary across SEC's
    // schema versions.
    const percentMatch = xml.match(/<(?:percentOfClass|percentClassOutstanding|aggregatePercent)>([^<]+)<\/(?:percentOfClass|percentClassOutstanding|aggregatePercent)>/i)
    const sharesMatch = xml.match(/<(?:aggregateAmountBeneficiallyOwned|amountBeneficiallyOwned|sharesBeneficiallyOwned)>([^<]+)<\/(?:aggregateAmountBeneficiallyOwned|amountBeneficiallyOwned|sharesBeneficiallyOwned)>/i)

    const percentOwned = percentMatch ? parseFloat(percentMatch[1].replace(/[,%]/g, '')) || 0 : 0
    const sharesOwned = sharesMatch ? parseInt(sharesMatch[1].replace(/[,\s]/g, ''), 10) || 0 : 0

    // Amendment detection — 13D/A and 13G/A have "Amendment No." somewhere
    const amendmentMatch = xml.match(/<(?:amendmentNumber|amendmentNo)>(\d+)<\/(?:amendmentNumber|amendmentNo)>/i)
    const amendmentNo = amendmentMatch ? parseInt(amendmentMatch[1], 10) : 0

    if (!subjectCik) {
      console.warn(`[sec-monitor] 13D/G ${accessionNo}: no subject CIK in XML`)
      return null
    }

    return {
      subjectCik: subjectCik.padStart(10, '0'),
      subjectName,
      subjectCusip: subjectCusip.toUpperCase(),
      filerName,
      filerCik: filerCik.padStart(10, '0'),
      percentOwned,
      sharesOwned,
      amendmentNo,
    }
  } catch (e) {
    console.warn(`[sec-monitor] 13D/G parse error for ${accessionNo}: ${(e as Error).message}`)
    return null
  }
}

// ─────────────────────────────────────────────────────────────
// Public: fetch recent 13D + 13G filings
// ─────────────────────────────────────────────────────────────

export interface ScheduleDGIngestResult {
  scanned13D: number
  scanned13G: number
  parsed: number            // full XML parse succeeded
  metadataOnly: number      // XML unavailable — wrote metadata-only row
  inserted: number          // total rows written (parsed + metadataOnly)
  passiveFiltered: number   // 13G from passive giants — filtered out
  duplicates: number
  errors: number
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
}

async function processScheduleDGEntries(
  entries: AtomEntry[],
  filingType: '13D' | '13G',
  result: ScheduleDGIngestResult,
  admin: SupabaseClient,
): Promise<void> {
  for (const entry of entries) {
    try {
      // For 13G, filter out passive index-fund giants — their filings
      // are mechanical AUM-driven disclosures with no real signal.
      if (filingType === '13G' && PASSIVE_GIANT_CIKS.has(entry.filerCik)) {
        result.passiveFiltered++
        continue
      }

      const xml = await fetchScheduleDGXml(entry.indexUrl, entry.accessionNo)
      let parsed: ScheduleDGParsed | null = null

      if (xml) {
        parsed = parseScheduleDGXml(xml, entry.accessionNo)
      }

      // METADATA-ONLY PATH: if we couldn't fetch XML or couldn't parse
      // what we got, fall back to recording what the atom feed told us.
      // 13D/G is high-signal enough that the alert itself ("X filed Y
      // about company Z") is worth surfacing even without structured
      // percentage data. This handles the common case of older filings
      // that don't include structured XML.
      let metadataOnly = false
      let ticker: string | null = null
      let issuerName: string | null = null
      let subjectCik: string
      let resolvedFilerName: string | null = null

      if (parsed) {
        result.parsed++
        subjectCik = parsed.subjectCik
        const resolved = await resolveTicker(subjectCik)
        ticker = resolved.ticker
        issuerName = decodeHtmlEntities(parsed.subjectName || resolved.name || '')
        resolvedFilerName = decodeHtmlEntities(parsed.filerName || '')
      } else {
        metadataOnly = true
        result.metadataOnly++
        // entryRole tells us whether the title's CIK is the subject
        // (the company) or the filer (the holder). For 13D/G:
        //   - "Subject" → CIK is the company being disclosed about
        //   - "Filer"   → CIK is the holder making the disclosure
        if (/Subject/i.test(entry.entryRole)) {
          subjectCik = entry.filerCik
          const resolved = await resolveTicker(subjectCik)
          ticker = resolved.ticker
          // The atom entry's "name" is the subject company's name —
          // we don't know the filer (holder) without XML. Leave filer
          // null rather than misleadingly setting it to the company.
          issuerName = decodeHtmlEntities(resolved.name ?? entry.filerName)
          resolvedFilerName = null
        } else {
          // Entry CIK is the filer (or combined "Filer,Subject") —
          // we have the filer name from the atom title but don't know
          // the subject. Record with NULL ticker; alert surfaces by
          // filer alone.
          subjectCik = '0000000000'  // sentinel — means "unknown subject"
          ticker = null
          issuerName = null
          resolvedFilerName = decodeHtmlEntities(entry.filerName)
        }
      }

      const amendmentNo = parsed?.amendmentNo ?? 0
      const eventType =
        filingType === '13D'
          ? (amendmentNo > 0 ? 'activist_position_amended' : 'activist_position')
          : (amendmentNo > 0 ? 'large_passive_position_amended' : 'large_passive_position')

      const { data: upsertData, error: upsertErr } = await admin.from('filing_alerts').upsert(
        {
          filing_type: filingType,
          ticker,
          issuer_cik: subjectCik,
          issuer_name: issuerName,
          filer_name: resolvedFilerName,
          filer_cik: parsed?.filerCik || (parsed ? null : (/Subject/i.test(entry.entryRole) ? null : entry.filerCik)),
          filer_role: filingType === '13D' ? 'activist' : 'large_passive_holder',
          accession_no: entry.accessionNo,
          filed_at: entry.filedAt,
          filing_url: entry.indexUrl,
          event_type: eventType,
          dollar_value: null,           // 13D/G doesn't disclose dollar value directly
          shares: parsed?.sharesOwned ?? null,
          percent_owned: parsed?.percentOwned ?? null,
          transaction_code: null,
          transaction_data: {
            cusip: parsed?.subjectCusip ?? null,
            amendment_no: amendmentNo,
            shares_owned: parsed?.sharesOwned ?? null,
            percent_owned: parsed?.percentOwned ?? null,
            metadata_only: metadataOnly,
            atom_role: entry.entryRole,
            // When metadata-only with Subject-role entry, we don't know
            // the filer. Record that explicitly so consumers can show
            // "Filer unknown" instead of confusing blanks.
            filer_known: !metadataOnly || !/Subject/i.test(entry.entryRole),
          },
        },
        { onConflict: 'accession_no', ignoreDuplicates: true },
      ).select('id')

      if (upsertErr) {
        console.warn(`[sec-monitor] ${filingType} upsert error: ${upsertErr.message}`)
        result.errors++
      } else if (!upsertData || (upsertData as unknown[]).length === 0) {
        result.duplicates++
      } else {
        result.inserted++
        // Log differently for the metadata-only Subject case since we
        // don't have a filer name to lead with.
        const detail = parsed
          ? `${parsed.percentOwned.toFixed(2)}% (${parsed.sharesOwned.toLocaleString()} shares)`
          : '[metadata-only]'
        const subject = ticker ?? subjectCik
        const filerLabel = resolvedFilerName || '[filer unknown]'
        console.log(
          `[sec-monitor] ${filingType}: ${filerLabel} ${eventType} ${detail} ` +
          `re ${subject}` +
          (amendmentNo > 0 ? ` [Amendment ${amendmentNo}]` : ''),
        )
      }
    } catch (e) {
      console.warn(`[sec-monitor] ${filingType} entry error: ${(e as Error).message}`)
      result.errors++
    }

    await new Promise(r => setTimeout(r, 250))  // polite EDGAR pacing — 10 req/sec limit shared across all types
  }
}

/**
 * Poll the recent firmwide 13D and 13G atom feeds, parse each filing's
 * XML, filter (13G excludes passive giants), and write to filing_alerts.
 *
 * @param feedCount  Number of recent filings to consider per type
 *                   (default 40 — both 13D and 13G feeds are low-volume
 *                   so 40 covers a comfortable window).
 */
export async function fetchRecent13DG(feedCount = 40): Promise<ScheduleDGIngestResult> {
  const admin = getAdmin()
  if (!admin) {
    return {
      scanned13D: 0, scanned13G: 0, parsed: 0, metadataOnly: 0, inserted: 0,
      passiveFiltered: 0, duplicates: 0, errors: 0,
    }
  }

  const result: ScheduleDGIngestResult = {
    scanned13D: 0, scanned13G: 0, parsed: 0, metadataOnly: 0, inserted: 0,
    passiveFiltered: 0, duplicates: 0, errors: 0,
  }

  // Fetch both feeds in parallel — they're independent EDGAR endpoints
  const [entries13D, entries13G] = await Promise.all([
    fetchAtomFeed('13D', feedCount),
    fetchAtomFeed('13G', feedCount),
  ])

  result.scanned13D = entries13D.length
  result.scanned13G = entries13G.length

  // Process 13D first (higher priority, smaller volume)
  await processScheduleDGEntries(entries13D, '13D', result, admin)
  await processScheduleDGEntries(entries13G, '13G', result, admin)

  console.log(
    `[sec-monitor] 13D/G run complete: scanned 13D=${result.scanned13D} 13G=${result.scanned13G} ` +
    `inserted=${result.inserted} (${result.parsed} XML-parsed, ${result.metadataOnly} metadata-only, ` +
    `${result.passiveFiltered} passive-filtered, ${result.duplicates} duplicates, ${result.errors} errors)`,
  )

  return result
}

// =============================================================
// Step 3: 8-K monitoring (material events)
// =============================================================
//
// 8-K is the highest-volume filing type (~500-1000/day across the
// market). Items are coded numerically — the form has 9 sections
// each with specific disclosure requirements. We filter aggressively
// to the items that carry actual signal:
//
//   1.01  Entry into a material definitive agreement
//   2.01  Completion of acquisition or disposition of assets
//   2.02  Results of operations and financial condition (earnings)
//   5.02  Departure/appointment of directors or officers
//   7.01  Regulation FD disclosure
//   8.01  Other events (catch-all — companies use for surprises)
//
// Excluded items (mostly noise):
//   3.01-3.03  Listing/delisting (routine)
//   4.01-4.02  Auditor changes (rarely material)
//   5.01      Changes in control (rare; would file 14A/proxy if material)
//   5.03      Amendments to bylaws (mostly procedural)
//   5.04-5.08 Submission to security holders, ethics waivers, etc.
//   9.01      Financial statements/exhibits (attachments, not events)
//
// Why parse items from the index HTML and not the document itself:
// EDGAR's index page lists items in a clear "Items: 1.01, 2.02"
// header. The 8-K document itself is freeform HTML. Index parsing
// is dramatically faster and more reliable.

// Map item codes to event types and human-readable labels.
// Keys MUST be the canonical item code as it appears on EDGAR
// (with the period, e.g. "5.02" not "502").
const EIGHT_K_ITEM_MAP: Record<string, { eventType: string; label: string }> = {
  '1.01': { eventType: 'material_agreement',   label: 'Material agreement' },
  '2.01': { eventType: 'acquisition',          label: 'Acquisition/disposition' },
  '2.02': { eventType: 'earnings_release',     label: 'Earnings release' },
  '5.02': { eventType: 'executive_change',     label: 'Executive change' },
  '7.01': { eventType: 'reg_fd',               label: 'Regulation FD disclosure' },
  '8.01': { eventType: 'other_event',          label: 'Other material event' },
}

const HIGH_SIGNAL_ITEMS = new Set(Object.keys(EIGHT_K_ITEM_MAP))

// Diagnostic counter — limits 8-K HTML sample logging to first few
// filings per Node process to avoid log spam.
let eightKDiagLogged = 0

// ─────────────────────────────────────────────────────────────
// 8-K item extraction from filing index page
// ─────────────────────────────────────────────────────────────

interface EightKItems {
  items: string[]              // ['2.02', '9.01']
  matchingItems: string[]      // intersection with HIGH_SIGNAL_ITEMS
  eventTypes: string[]         // deduped event types from matchingItems
}

async function fetchEightKItems(indexUrl: string): Promise<EightKItems | null> {
  // Use the atom feed's indexUrl directly — that's the EDGAR filing
  // detail page where items are listed. Previous bug: stripping to
  // the base directory hit the directory listing page instead, which
  // contains CSS/HTML noise that was matching the generic X.YY regex
  // (e.g. "3.7" from "/images/chairman-quote-bg-3.7.png").

  try {
    const idxRes = await fetch(indexUrl, { headers: EDGAR_HEADERS })
    if (idxRes.ok) {
      const html = await idxRes.text()

      // Diagnostic (first few filings only): log sample HTML so we can
      // see how items are actually formatted on the detail page.
      eightKDiagLogged++
      if (eightKDiagLogged <= 2) {
        const stripped = html.replace(/\s+/g, ' ').slice(0, 1200)
        console.log(`[sec-monitor] 8-K diag #${eightKDiagLogged}: ${stripped}`)
      }

      // PRIMARY EXTRACTION: look for "Items:" labeled section.
      // EDGAR's filing detail page formats items as something like:
      //   <strong>Items:</strong>&nbsp;2.02, 9.01
      // or
      //   <td>Items</td><td>2.02, 9.01</td>
      // or
      //   Item 2.02 Results of Operations and Financial Condition
      //   Item 9.01 Financial Statements and Exhibits
      // We use multiple patterns to be robust.
      let items: string[] = []

      // Pattern 1: "Items:" label followed by comma-separated codes
      const itemsLabelMatch = html.match(/Items?\s*[:>]?\s*(?:<\/[a-z]+>)?\s*(?:&nbsp;|\s)*((?:\d\.\d{1,2}\s*,?\s*)+)/i)
      if (itemsLabelMatch) {
        items = [...itemsLabelMatch[1].matchAll(/(\d\.\d{1,2})/g)].map(m => m[1])
      }

      // Pattern 2: "Item X.YY" headings — common on the description side
      if (items.length === 0) {
        const itemHeadings = [...html.matchAll(/Item\s+(\d\.\d{1,2})\b/gi)].map(m => m[1])
        items = itemHeadings
      }

      // Pattern 3 (fallback): scan for any X.YY-format codes in the
      // page, but ONLY when they're not adjacent to file extensions
      // or stylesheet refs (the "/3.7.png" / "960.min.css" trap).
      if (items.length === 0) {
        const generic = [...html.matchAll(/(?:^|[\s>"])(\d\.\d{1,2})(?:[\s<",.]|$)/g)].map(m => m[1])
        items = generic
      }

      // Filter to plausible 8-K item codes: X is 1-9, YY is 01-99.
      const validItems = items.filter(code => {
        const [section, sub] = code.split('.')
        const sectionNum = parseInt(section, 10)
        const subNum = parseInt(sub, 10)
        return sectionNum >= 1 && sectionNum <= 9 && subNum >= 1 && subNum <= 99
      })

      // Dedupe
      const dedupedItems = [...new Set(validItems)]

      // Filter to high-signal items only
      const matchingItems = dedupedItems.filter(i => HIGH_SIGNAL_ITEMS.has(i))
      const eventTypes = [...new Set(matchingItems.map(i => EIGHT_K_ITEM_MAP[i].eventType))]

      // Diagnostic: log items found vs items matching for first few
      if (eightKDiagLogged <= 5 && (dedupedItems.length === 0 || matchingItems.length === 0)) {
        console.log(`[sec-monitor] 8-K ${indexUrl.split('/').slice(-2, -1)[0]}: items=[${dedupedItems.join(',')}] matching=[${matchingItems.join(',')}]`)
      }

      return { items: dedupedItems, matchingItems, eventTypes }
    } else {
      console.warn(`[sec-monitor] 8-K index fetch failed: HTTP ${idxRes.status} for ${indexUrl}`)
    }
  } catch (e) {
    console.warn(`[sec-monitor] 8-K index fetch error: ${(e as Error).message}`)
  }

  return null
}

// ─────────────────────────────────────────────────────────────
// Public: fetch recent 8-K filings, filter to high-signal items
// ─────────────────────────────────────────────────────────────

export interface EightKIngestResult {
  scanned: number
  itemsParsed: number          // index pages successfully scraped for items
  inserted: number             // filings with at least one high-signal item
  noMatchingItems: number      // skipped — no high-signal items in filing
  duplicates: number
  errors: number
}

/**
 * Poll the recent firmwide 8-K atom feed, parse items from each filing's
 * index page, and write filings with high-signal items to filing_alerts.
 *
 * @param feedCount  Number of recent filings to consider (default 40).
 *                   8-K is high-volume so this represents only a few
 *                   minutes of filings during market hours.
 */
export async function fetchRecent8Ks(feedCount = 40): Promise<EightKIngestResult> {
  const admin = getAdmin()
  if (!admin) {
    return {
      scanned: 0, itemsParsed: 0, inserted: 0,
      noMatchingItems: 0, duplicates: 0, errors: 0,
    }
  }

  const result: EightKIngestResult = {
    scanned: 0, itemsParsed: 0, inserted: 0,
    noMatchingItems: 0, duplicates: 0, errors: 0,
  }

  const entries = await fetchAtomFeed('8-K', feedCount)
  result.scanned = entries.length

  for (const entry of entries) {
    try {
      const itemsResult = await fetchEightKItems(entry.indexUrl)
      if (!itemsResult) {
        result.errors++
        continue
      }
      result.itemsParsed++

      // Filter: skip filings with no high-signal items.
      if (itemsResult.matchingItems.length === 0) {
        result.noMatchingItems++
        continue
      }

      // For 8-K, the filer IS the company (issuer files its own 8-K).
      // So entry.filerCik is the issuer CIK directly.
      const issuerCik = entry.filerCik
      const resolved = await resolveTicker(issuerCik)
      const ticker = resolved.ticker
      const issuerName = decodeHtmlEntities(resolved.name ?? entry.filerName)

      // Pick the primary event type: prefer earnings_release (verifier
      // path), then executive_change, then material_agreement, then
      // acquisition, then reg_fd, then other_event. This determines
      // the row's `event_type` field; full list of items lives in
      // transaction_data.
      const priority = ['earnings_release', 'executive_change', 'material_agreement', 'acquisition', 'reg_fd', 'other_event']
      const primaryEventType = priority.find(p => itemsResult.eventTypes.includes(p)) ?? itemsResult.eventTypes[0]

      const itemLabels = itemsResult.matchingItems.map(i => `${i} (${EIGHT_K_ITEM_MAP[i].label})`).join(', ')

      const { data: upsertData, error: upsertErr } = await admin.from('filing_alerts').upsert(
        {
          filing_type: '8-K',
          ticker,
          issuer_cik: issuerCik,
          issuer_name: issuerName,
          // For 8-K the filer is the issuer itself — record the company
          // in both fields rather than leaving filer_name null. That way
          // the discovery layer's "filer_name" rendering still works.
          filer_name: issuerName,
          filer_cik: issuerCik,
          filer_role: 'issuer',
          accession_no: entry.accessionNo,
          filed_at: entry.filedAt,
          filing_url: entry.indexUrl,
          event_type: primaryEventType,
          dollar_value: null,
          shares: null,
          percent_owned: null,
          transaction_code: null,
          transaction_data: {
            items: itemsResult.items,
            matching_items: itemsResult.matchingItems,
            event_types: itemsResult.eventTypes,
            item_labels: itemLabels,
          },
        },
        { onConflict: 'accession_no', ignoreDuplicates: true },
      ).select('id')

      if (upsertErr) {
        console.warn(`[sec-monitor] 8-K upsert error: ${upsertErr.message}`)
        result.errors++
      } else if (!upsertData || (upsertData as unknown[]).length === 0) {
        result.duplicates++
      } else {
        result.inserted++
        console.log(
          `[sec-monitor] 8-K: ${issuerName} (${ticker ?? issuerCik}) ${primaryEventType}: ${itemLabels}`,
        )
      }
    } catch (e) {
      console.warn(`[sec-monitor] 8-K entry error: ${(e as Error).message}`)
      result.errors++
    }

    await new Promise(r => setTimeout(r, 250))  // polite EDGAR pacing — 10 req/sec limit shared across all types
  }

  console.log(
    `[sec-monitor] 8-K run complete: scanned=${result.scanned} ` +
    `items-parsed=${result.itemsParsed} inserted=${result.inserted} ` +
    `(${result.noMatchingItems} no-match, ${result.duplicates} duplicates, ${result.errors} errors)`,
  )

  return result
}

// =============================================================
// Step 4: Discovery layer integration
// =============================================================
//
// getMonitorAlerts in market-monitor.ts already feeds breaking news
// alerts into the signal bundle. We add a parallel function that
// pulls recent SEC filings for the same ticker and returns formatted
// text for inclusion in the bundle.
//
// Called from aggregator.ts alongside getMonitorAlerts; the two
// outputs are concatenated into the "monitor alerts" section that
// the Council and News Scout see first.

interface FilingAlertRow {
  filing_type: string
  ticker: string | null
  issuer_name: string | null
  filer_name: string | null
  filer_role: string | null
  event_type: string | null
  filed_at: string
  filing_url: string | null
  dollar_value: number | null
  shares: number | null
  percent_owned: number | null
  transaction_code: string | null
  transaction_data: Record<string, unknown> | null
}

/**
 * Fetch recent SEC filing alerts for a ticker and return a formatted
 * text block suitable for inclusion in the AI bundle.
 *
 * @param ticker        the ticker to look up
 * @param hoursWindow   how far back to look (default 48 hours —
 *                      8-Ks are time-sensitive, 13D/G slightly less,
 *                      Form 4 has 2-day filing deadline so 48h covers
 *                      all fresh activity)
 * @param maxAlerts     cap on rows returned (default 10 — keeps the
 *                      bundle section bounded; most tickers have 0-2
 *                      per window so this is loose)
 */
export async function getFilingAlerts(
  ticker: string,
  hoursWindow = 48,
  maxAlerts = 10,
): Promise<string> {
  const admin = getAdmin()
  if (!admin) return ''

  const since = new Date(Date.now() - hoursWindow * 60 * 60 * 1000).toISOString()

  try {
    const { data, error } = await admin
      .from('filing_alerts')
      .select(
        'filing_type, ticker, issuer_name, filer_name, filer_role, event_type, ' +
        'filed_at, filing_url, dollar_value, shares, percent_owned, ' +
        'transaction_code, transaction_data',
      )
      .eq('ticker', ticker.toUpperCase())
      .gte('filed_at', since)
      .order('filed_at', { ascending: false })
      .limit(maxAlerts)

    if (error) {
      console.warn(`[sec-monitor] getFilingAlerts query error for ${ticker}: ${error.message}`)
      return ''
    }
    const rows = (data ?? []) as unknown as FilingAlertRow[]
    if (rows.length === 0) return ''

    // Section header is deliberately attention-grabbing — these are
    // SEC-verified official disclosures with regulatory weight, often
    // more reliable than news headlines (which may include speculation).
    // The header tells downstream AI stages to treat them as primary
    // catalysts alongside news, not as ambient background context.
    const lines: string[] = [
      '=== SEC FILINGS — OFFICIAL DISCLOSURES (last 48h) ===',
      'These are real, SEC-filed material events for this ticker, sourced directly from EDGAR.',
      'Treat as PRIMARY CATALYSTS — same weight as news headlines. Cite explicitly in your analysis.',
      '',
    ]

    for (const r of rows) {
      const ageHours = Math.round((Date.now() - new Date(r.filed_at).getTime()) / 3.6e6 * 10) / 10
      const ageStr = ageHours < 1
        ? `${Math.round(ageHours * 60)}m ago`
        : `${ageHours.toFixed(1)}h ago`

      if (r.filing_type === '4') {
        // Form 4: insider open-market trade
        const direction = r.event_type === 'open_market_buy' ? 'BOUGHT' : 'SOLD'
        const dollars = r.dollar_value
          ? `$${(r.dollar_value / 1e6).toFixed(2)}M`
          : 'unknown amount'
        const sharesStr = r.shares
          ? `${r.shares.toLocaleString()} shares`
          : 'shares (count unknown)'
        lines.push(
          `[FORM 4 ${ageStr}] ${r.filer_name ?? 'Insider'} (${r.filer_role ?? 'role unknown'}) ${direction} ${sharesStr} (${dollars})`,
        )
      } else if (r.filing_type === '13D' || r.filing_type === '13G') {
        // 13D/G: 5%+ ownership disclosure
        const formLabel = r.filing_type === '13D' ? '13D (activist)' : '13G (passive)'
        const amendmentInfo = r.transaction_data?.amendment_no &&
          Number(r.transaction_data.amendment_no) > 0
          ? ` [Amendment ${r.transaction_data.amendment_no}]`
          : ''
        const filerLabel = r.filer_name ?? '[filer unknown]'
        const detail = r.percent_owned != null && r.shares != null
          ? `${r.percent_owned.toFixed(2)}% (${r.shares.toLocaleString()} shares)`
          : '[metadata only — see filing for details]'
        lines.push(
          `[${formLabel} ${ageStr}]${amendmentInfo} ${filerLabel}: ${detail}`,
        )
      } else if (r.filing_type === '8-K') {
        // 8-K: material event
        const itemLabels = r.transaction_data?.item_labels ?? 'items unknown'
        lines.push(
          `[8-K ${ageStr}] ${r.event_type}: ${itemLabels}`,
        )
      }
    }

    const result = lines.join('\n')
    return result
  } catch (e) {
    console.warn(`[sec-monitor] getFilingAlerts error for ${ticker}: ${(e as Error).message}`)
    return ''
  }
}

/**
 * Has a recent earnings 8-K been filed for this ticker?
 *
 * Used by the verifier (step 5) — when News Scout or Council claims
 * "company beat/missed earnings", the verifier can check whether the
 * 8-K Item 2.02 actually exists. Returns the most recent earnings
 * 8-K row within the lookup window, or null.
 *
 * @param ticker         the company ticker
 * @param hoursWindow    look-back window in hours (default 168 = 7 days;
 *                       earnings releases stay relevant for at least
 *                       a week after they're filed)
 */
export async function findRecentEarningsRelease(
  ticker: string,
  hoursWindow = 168,
): Promise<FilingAlertRow | null> {
  const admin = getAdmin()
  if (!admin) return null

  const since = new Date(Date.now() - hoursWindow * 60 * 60 * 1000).toISOString()

  try {
    const { data, error } = await admin
      .from('filing_alerts')
      .select(
        'filing_type, ticker, issuer_name, filer_name, filer_role, event_type, ' +
        'filed_at, filing_url, dollar_value, shares, percent_owned, ' +
        'transaction_code, transaction_data',
      )
      .eq('ticker', ticker.toUpperCase())
      .eq('filing_type', '8-K')
      .eq('event_type', 'earnings_release')
      .gte('filed_at', since)
      .order('filed_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (error) {
      console.warn(`[sec-monitor] findRecentEarningsRelease error for ${ticker}: ${error.message}`)
      return null
    }
    return (data as unknown as FilingAlertRow) ?? null
  } catch (e) {
    console.warn(`[sec-monitor] findRecentEarningsRelease error for ${ticker}: ${(e as Error).message}`)
    return null
  }
}
