/**
 * Wali-OS — SEC EDGAR Filing Intelligence
 *
 * Monitors and parses:
 * - 8-K  : Material events (earnings, M&A, leadership, lawsuits)
 * - Form 4: Insider transactions (open-market buys/sells)
 * - 13-F : Institutional holdings changes
 * - S-1/S-3: Dilution risk filings
 * - DEF 14A: Executive compensation structure
 *
 * All data from SEC EDGAR — free, no API key, authoritative source.
 */

import { createClient } from '@supabase/supabase-js'
import { GoogleGenerativeAI } from '@google/generative-ai'
import { getCIK } from './edgar'

const EDGAR_HEADERS = {
  'User-Agent': 'Wali-OS/1.0 support@wali-os.com',
  'Accept': 'application/json',
}
const EDGAR_BASE = 'https://data.sec.gov'
const EFTS_BASE = 'https://efts.sec.gov'

function getAdmin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

// ── 8-K Material Items ─────────────────────────────────────────────────────────

// 8-K item codes and their meaning
const ITEM_SIGNIFICANCE: Record<string, { label: string; significance: 'high' | 'medium' | 'low'; sentiment: 'bullish' | 'bearish' | 'neutral' }> = {
  '1.01': { label: 'Entry into Material Agreement', significance: 'high', sentiment: 'neutral' },
  '1.02': { label: 'Termination of Material Agreement', significance: 'high', sentiment: 'bearish' },
  '1.03': { label: 'Bankruptcy or Receivership', significance: 'high', sentiment: 'bearish' },
  '2.01': { label: 'Acquisition or Disposition of Assets', significance: 'high', sentiment: 'neutral' },
  '2.02': { label: 'Results of Operations (Earnings)', significance: 'high', sentiment: 'neutral' },
  '2.04': { label: 'Triggering Events for Acceleration', significance: 'high', sentiment: 'bearish' },
  '2.05': { label: 'Departure of Director/Officer', significance: 'medium', sentiment: 'bearish' },
  '2.06': { label: 'Material Impairment', significance: 'high', sentiment: 'bearish' },
  '3.01': { label: 'Notice of Delisting', significance: 'high', sentiment: 'bearish' },
  '4.01': { label: 'Changes in Registrant\'s Certifying Accountant', significance: 'medium', sentiment: 'neutral' },
  '5.01': { label: 'Changes in Control', significance: 'high', sentiment: 'neutral' },
  '5.02': { label: 'Departure/Election of Officers/Directors', significance: 'high', sentiment: 'neutral' },
  '5.03': { label: 'Amendments to Charter/Bylaws', significance: 'low', sentiment: 'neutral' },
  '7.01': { label: 'Regulation FD Disclosure', significance: 'medium', sentiment: 'neutral' },
  '8.01': { label: 'Other Events', significance: 'low', sentiment: 'neutral' },
  '9.01': { label: 'Financial Statements', significance: 'low', sentiment: 'neutral' },
}

export async function fetch8KFilings(ticker: string, sinceDate?: string): Promise<void> {
  const admin = getAdmin()
  const cikPadded = await getCIK(ticker)
  if (!cikPadded) return

  const since = sinceDate || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]

  try {
    // Get recent submissions
    const res = await fetch(`${EDGAR_BASE}/submissions/${cikPadded}.json`, { headers: EDGAR_HEADERS })
    if (!res.ok) return
    const data = await res.json()

    const filings = data.filings?.recent
    if (!filings) return

    const forms: string[] = filings.form || []
    const dates: string[] = filings.filingDate || []
    const accessions: string[] = filings.accessionNumber || []
    const primaryDocs: string[] = filings.primaryDocument || []

    for (let i = 0; i < forms.length; i++) {
      if (forms[i] !== '8-K' && forms[i] !== '8-K/A') continue
      if (dates[i] < since) break // sorted by date desc, stop when too old

      const accNo = accessions[i]
      if (!accNo) continue

      // Check if already processed
      const { data: existing } = await admin
        .from('sec_filings')
        .select('id')
        .eq('accession_no', accNo)
        .maybeSingle()
      if (existing) continue

      // Fetch the filing index to get item descriptions
      const accNoClean = accNo.replace(/-/g, '')
      const indexUrl = `https://www.sec.gov/Archives/edgar/data/${cikPadded.replace('CIK', '').replace(/^0+/, '')}/${accNoClean}/${accNo}-index.json`

      let items: string[] = []
      let description = ''
      try {
        const indexRes = await fetch(indexUrl, { headers: EDGAR_HEADERS })
        if (indexRes.ok) {
          const idx = await indexRes.json()
          description = idx.description || ''
        }
      } catch { /* skip */ }

      // Parse items from description
      const itemMatches = description.match(/Item\s+(\d+\.\d+)/gi) || []
      items = itemMatches.map(m => m.replace(/Item\s+/i, ''))

      // Determine significance
      let significance: 'high' | 'medium' | 'low' = 'low'
      let sentiment: 'bullish' | 'bearish' | 'neutral' = 'neutral'
      const itemLabels: string[] = []

      for (const item of items) {
        const meta = ITEM_SIGNIFICANCE[item]
        if (meta) {
          itemLabels.push(meta.label)
          if (meta.significance === 'high') significance = 'high'
          else if (meta.significance === 'medium' && significance !== 'high') significance = 'medium'
          if (meta.sentiment === 'bearish') sentiment = 'bearish'
          else if (meta.sentiment === 'bullish' && sentiment !== 'bearish') sentiment = 'bullish'
        }
      }

      // AI summary for high-significance filings
      let summary = itemLabels.length > 0 ? itemLabels.join('; ') : description || '8-K filing'
      if (significance === 'high' && process.env.GEMINI_API_KEY) {
        try {
          const genai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY)
          const model = genai.getGenerativeModel({ model: 'gemini-2.5-flash' })
          const result = await model.generateContent(
            `${ticker} filed an 8-K on ${dates[i]}. Items: ${itemLabels.join(', ')}. Description: ${description}. ` +
            `In 1-2 plain English sentences, explain what this means for investors. Be specific and direct.`
          )
          summary = result.response.text().trim().slice(0, 500)
        } catch { /* use item labels */ }
      }

      await admin.from('sec_filings').insert({
        ticker: ticker.toUpperCase(),
        cik: cikPadded,
        form_type: forms[i],
        filed_at: new Date(dates[i]).toISOString(),
        accession_no: accNo,
        filing_url: `https://www.sec.gov/Archives/edgar/data/${cikPadded.replace('CIK', '').replace(/^0+/, '')}/${accNoClean}/${primaryDocs[i]}`,
        title: itemLabels.length > 0 ? itemLabels[0] : '8-K Filing',
        summary,
        significance,
        sentiment,
        data: { items, item_labels: itemLabels, description },
      })

      await new Promise(r => setTimeout(r, 150)) // rate limit
    }
  } catch (e) {
    console.error('[sec-filings] 8-K error:', e)
  }
}

// ── Form 4 Insider Transactions ───────────────────────────────────────────────

export async function fetchInsiderTransactions(ticker: string): Promise<void> {
  const admin = getAdmin()
  const cikPadded = await getCIK(ticker)
  if (!cikPadded) return

  const cikNum = cikPadded.replace('CIK', '').replace(/^0+/, '')
  const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]

  try {
    const res = await fetch(`${EDGAR_BASE}/submissions/${cikPadded}.json`, { headers: EDGAR_HEADERS })
    if (!res.ok) return
    const data = await res.json()

    const filings = data.filings?.recent
    if (!filings) return

    const forms: string[] = filings.form || []
    const dates: string[] = filings.filingDate || []
    const accessions: string[] = filings.accessionNumber || []

    for (let i = 0; i < forms.length; i++) {
      if (forms[i] !== '4' && forms[i] !== '4/A') continue
      if (dates[i] < since) break

      const accNo = accessions[i]
      if (!accNo) continue

      const { data: existing } = await admin
        .from('insider_transactions')
        .select('id')
        .eq('accession_no', accNo)
        .maybeSingle()
      if (existing) continue

      // Fetch the actual Form 4 XML via the filing index
      try {
        const accNoClean = accNo.replace(/-/g, '')
        // Get filing index to find the actual XML document name
        const indexUrl = `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cikNum}&type=4&dateb=&owner=include&count=40&search_text=&output=atom`
        // Try primary XML path first, then fall back to index lookup
        let xml = ''
        // Attempt 1: standard path
        const attempt1 = await fetch(
          `https://www.sec.gov/Archives/edgar/data/${cikNum}/${accNoClean}/${accNo}.xml`,
          { headers: { 'User-Agent': EDGAR_HEADERS['User-Agent'] } }
        )
        if (attempt1.ok) {
          xml = await attempt1.text()
        } else {
          // Attempt 2: fetch the filing index and find the .xml file
          const idxRes = await fetch(
            `https://www.sec.gov/Archives/edgar/data/${cikNum}/${accNoClean}/`,
            { headers: { 'User-Agent': EDGAR_HEADERS['User-Agent'] } }
          )
          if (idxRes.ok) {
            const idxHtml = await idxRes.text()
            const xmlMatch = idxHtml.match(/href="([^"]*\.xml)"/i)
            if (xmlMatch) {
              const xmlRes2 = await fetch(
                `https://www.sec.gov${xmlMatch[1]}`,
                { headers: { 'User-Agent': EDGAR_HEADERS['User-Agent'] } }
              )
              if (xmlRes2.ok) xml = await xmlRes2.text()
            }
          }
        }
        if (!xml) continue

        // Parse key fields from XML
        const insiderName = xml.match(/<rptOwnerName>(.*?)<\/rptOwnerName>/)?.[1] || 'Unknown'
        const insiderCik = xml.match(/<rptOwnerCik>(.*?)<\/rptOwnerCik>/)?.[1] || null
        const titleMatch = xml.match(/<officerTitle>(.*?)<\/officerTitle>/)?.[1] || null

        // Find all transactions
        const txBlocks = xml.match(/<nonDerivativeTransaction>([\s\S]*?)<\/nonDerivativeTransaction>/g) || []

        for (const block of txBlocks) {
          const txType = block.match(/<transactionCode>(.*?)<\/transactionCode>/)?.[1] || ''
          if (!['P', 'S'].includes(txType)) continue // only purchases and sales

          const txDate = block.match(/<transactionDate>[\s\S]*?<value>(.*?)<\/value>/)?.[1] || dates[i]
          const shares = parseInt(block.match(/<transactionShares>[\s\S]*?<value>(.*?)<\/value>/)?.[1] || '0')
          const price = parseFloat(block.match(/<transactionPricePerShare>[\s\S]*?<value>(.*?)<\/value>/)?.[1] || '0')
          const sharesAfter = parseInt(block.match(/<sharesOwnedFollowingTransaction>[\s\S]*?<value>(.*?)<\/value>/)?.[1] || '0')
          const acquisitionDisposition = block.match(/<transactionAcquiredDisposedCode>[\s\S]*?<value>(.*?)<\/value>/)?.[1] || ''

          const isOpenMarket = txType === 'P' || txType === 'S'
          const totalValue = shares * price

          await admin.from('insider_transactions').upsert({
            ticker: ticker.toUpperCase(),
            company_cik: cikPadded,
            insider_name: insiderName,
            insider_cik: insiderCik,
            title: titleMatch,
            transaction_date: txDate,
            transaction_type: txType,
            is_open_market: isOpenMarket,
            shares,
            price_per_share: price || null,
            total_value: totalValue || null,
            shares_owned_after: sharesAfter || null,
            filing_date: dates[i],
            accession_no: accNo,
          }, { onConflict: 'accession_no' })
        }

        // Also log to sec_filings for alert system
        const openMarketBuys = txBlocks.filter(b => b.includes('<transactionCode>P</transactionCode>'))
        if (openMarketBuys.length > 0) {
          const totalBuyValue = openMarketBuys.reduce((sum, b) => {
            const s = parseInt(b.match(/<transactionShares>[\s\S]*?<value>(.*?)<\/value>/)?.[1] || '0')
            const p = parseFloat(b.match(/<transactionPricePerShare>[\s\S]*?<value>(.*?)<\/value>/)?.[1] || '0')
            return sum + s * p
          }, 0)

          if (totalBuyValue > 50000) { // only flag significant buys >$50K
            await admin.from('sec_filings').upsert({
              ticker: ticker.toUpperCase(),
              cik: cikPadded,
              form_type: '4',
              filed_at: new Date(dates[i]).toISOString(),
              accession_no: `${accNo}-4`,
              title: `Insider Purchase: ${insiderName} (${titleMatch || 'Insider'})`,
              summary: `${insiderName}${titleMatch ? ` (${titleMatch})` : ''} purchased $${(totalBuyValue / 1000).toFixed(0)}K of ${ticker} stock in an open-market transaction.`,
              significance: totalBuyValue > 500000 ? 'high' : 'medium',
              sentiment: 'bullish',
              data: { insider_name: insiderName, title: titleMatch, value: totalBuyValue, type: 'purchase' },
            }, { onConflict: 'accession_no' })
          }
        }

      } catch { /* skip malformed XML */ }

      await new Promise(r => setTimeout(r, 200))
    }
  } catch (e) {
    console.error('[sec-filings] Form 4 error:', e)
  }
}

// ── 13-F Institutional Holdings ───────────────────────────────────────────────

// Top institutions to monitor (by CIK)
const MAJOR_INSTITUTIONS: Record<string, string> = {
  '0001067983': 'Berkshire Hathaway',
  '0001364742': 'Bridgewater Associates',
  '0000102909': 'Vanguard Group',
  '0000880285': 'BlackRock',
  '0000093751': 'State Street',
  '0001603466': 'Ark Investment Management',
  '0001037389': 'Renaissance Technologies',
  '0001336528': 'Two Sigma',
  '0001035674': 'D.E. Shaw',
  '0000906504': 'Baupost Group',
}

export async function fetch13FForTicker(ticker: string): Promise<void> {
  const admin = getAdmin()

  // Search for 13-F filings mentioning this ticker via EDGAR full-text search
  try {
    const quarter = getCurrentQuarter()
    const lastQ = getPriorQuarter(quarter)

    // Check if we already have recent data
    const { data: existing } = await admin
      .from('institutional_holdings')
      .select('id')
      .eq('ticker', ticker.toUpperCase())
      .eq('quarter', lastQ)
      .limit(1)
      .maybeSingle()

    if (existing) return // already have this quarter's data

    // Fetch 13-F from major institutions — run in parallel batches of 3
    console.log(`[13-F] Starting fetch for ${ticker}, checking ${Object.keys(MAJOR_INSTITUTIONS).length} institutions`)
    const instEntries = Object.entries(MAJOR_INSTITUTIONS)
    const batchSize = 3
    for (let b = 0; b < instEntries.length; b += batchSize) {
      const batch = instEntries.slice(b, b + batchSize)
      await Promise.all(batch.map(async ([instCik, instName]) => {
      try {
        const cikPadded = `CIK${instCik.replace('0x', '').padStart(10, '0')}`
        const res = await fetch(`${EDGAR_BASE}/submissions/${cikPadded}.json`, { headers: EDGAR_HEADERS })
        if (!res.ok) { console.log(`[13-F] ${instName} submissions fetch failed: ${res.status}`); return }

        const data = await res.json()
        const filings = data.filings?.recent
        if (!filings) return

        // Find most recent 13-F
        const forms: string[] = filings.form || []
        const dates: string[] = filings.filingDate || []
        const accessions: string[] = filings.accessionNumber || []

        for (let i = 0; i < forms.length; i++) {
          if (forms[i] !== '13F-HR') continue

          const accNo = accessions[i]
          const filingDate = dates[i]
          if (!accNo) break

          // Fetch the 13-F filing — try multiple known filename conventions
          const cikNum = instCik.replace(/^0+/, '')
          const accNoClean = accNo.replace(/-/g, '')
          const baseUrl = `https://www.sec.gov/Archives/edgar/data/${cikNum}/${accNoClean}`

          try {
            // EDGAR 13-F XML files have inconsistent naming across filers
            // Try the most common patterns in order
            const xmlFilenames = [
              'informationtable.xml',
              'form13fInfoTable.xml',
              'form13f.xml',
              `${accNo}.xml`,
              `${accNoClean}.xml`,
            ]

            let xml = ''
            let usedFilename = ''
            for (const fname of xmlFilenames) {
              const xmlUrl = `${baseUrl}/${fname}`
              const xmlRes = await fetch(xmlUrl, { headers: EDGAR_HEADERS })
              if (xmlRes.ok) {
                const text = await xmlRes.text()
                // Verify it actually looks like an information table
                if (text.includes('<informationTable>') || text.includes('<InfoTable>') || text.includes('<infoTable>')) {
                  xml = text
                  usedFilename = fname
                  break
                }
              }
            }

            if (!xml) {
              // Last resort: fetch the filing index HTML and scrape XML links
              const idxRes = await fetch(`${baseUrl}/`, { headers: EDGAR_HEADERS })
              if (idxRes.ok) {
                const html = await idxRes.text()
                const xmlLinks = [...html.matchAll(/href="([^"]*\.xml)"/gi)].map(m => m[1])
                for (const link of xmlLinks) {
                  const fullUrl = link.startsWith('http') ? link : `https://www.sec.gov${link}`
                  const xmlRes = await fetch(fullUrl, { headers: EDGAR_HEADERS })
                  if (xmlRes.ok) {
                    const text = await xmlRes.text()
                    if (text.includes('infoTable') || text.includes('informationTable')) {
                      xml = text; usedFilename = link; break
                    }
                  }
                }
              }
            }

            if (!xml) { console.log(`[13-F] ${instName}: could not find information table XML`); break }
            console.log(`[13-F] ${instName}: found XML using ${usedFilename} (${xml.length} bytes)`)

            // Find ticker in the XML
            const tickerRegex = new RegExp(`<nameOfIssuer>[^<]*${ticker}[^<]*<\\/nameOfIssuer>[\\s\\S]*?(?=<infoTable>|$)`, 'gi')
            const infoBlocks = xml.match(/<infoTable>[\s\S]*?<\/infoTable>/g) || []

            // Build name variants for flexible matching
            const nameVariants: Record<string, string[]> = {
              'NVDA': ['NVIDIA'], 'AAPL': ['APPLE INC'], 'MSFT': ['MICROSOFT'],
              'GOOGL': ['ALPHABET'], 'GOOG': ['ALPHABET'], 'META': ['META PLATFORM'],
              'AMZN': ['AMAZON'], 'TSLA': ['TESLA'], 'NFLX': ['NETFLIX'],
              'JPM': ['JPMORGAN','JP MORGAN'], 'BRK': ['BERKSHIRE'],
            }
            const tickerUpper = ticker.toUpperCase()
            const variants = nameVariants[tickerUpper] || []

            // Find ONLY the first (largest/most recent) match — avoid duplicate quarters
            let bestBlock: string | null = null
            let bestShares = 0
            for (const block of infoBlocks) {
              const nameMatch = block.match(/<nameOfIssuer>(.*?)<\/nameOfIssuer>/i)
              if (!nameMatch) continue
              const issuerUpper = nameMatch[1].toUpperCase()
              const matches = issuerUpper.includes(tickerUpper) ||
                variants.some(v => issuerUpper.includes(v))
              if (!matches) continue
              const shares = parseInt(block.match(/<sshPrnamt>(.*?)<\/sshPrnamt>/)?.[1] || '0')
              // Take the block with the most shares (primary position, not derivatives)
              if (shares > bestShares) { bestShares = shares; bestBlock = block }
            }

            if (!bestBlock || bestShares === 0) continue

            {
              const block = bestBlock
              const nameMatch = block.match(/<nameOfIssuer>(.*?)<\/nameOfIssuer>/i)
              const shares = bestShares
              // 13-F value is in thousands of dollars
              const valueThousands = parseInt(block.match(/<value>(.*?)<\/value>/)?.[1] || '0')
              const value = valueThousands * 1000 // convert to dollars
              console.log(`[13-F] ${instName}: MATCH — ${nameMatch?.[1]}, ${shares.toLocaleString()} shares, $${(value/1e9).toFixed(2)}B`)

              if (shares === 0) continue

              // Get prior quarter for comparison
              const { data: prior } = await admin
                .from('institutional_holdings')
                .select('shares_held')
                .eq('ticker', ticker.toUpperCase())
                .eq('institution_cik', instCik)
                .eq('quarter', getPriorQuarter(lastQ))
                .maybeSingle()

              const priorShares = prior?.shares_held || 0
              const changeShares = shares - priorShares
              const changePct = priorShares > 0 ? parseFloat(((changeShares / priorShares) * 100).toFixed(1)) : null
              const action = priorShares === 0 ? 'new' :
                changeShares > priorShares * 0.05 ? 'increased' :
                changeShares < -priorShares * 0.05 ? 'decreased' :
                shares === 0 ? 'sold_out' : 'maintained'

              await admin.from('institutional_holdings').upsert({
                ticker: ticker.toUpperCase(),
                institution: instName,
                institution_cik: instCik,
                quarter: lastQ,
                shares_held: shares,
                market_value: value,
                change_shares: changeShares,
                change_pct: changePct,
                action,
                filing_date: filingDate,
                accession_no: accNo,
              }, { onConflict: 'ticker,institution_cik,quarter' })

              // Log significant changes to sec_filings
              if (action === 'new' || (Math.abs(changePct || 0) > 20 && Math.abs(value) > 1000000)) {
                await admin.from('sec_filings').upsert({
                  ticker: ticker.toUpperCase(),
                  cik: `CIK${instCik}`,
                  form_type: '13-F',
                  filed_at: new Date(filingDate).toISOString(),
                  accession_no: `${accNo}-${instCik}`,
                  title: `${instName} ${action === 'new' ? 'Initiated' : action === 'increased' ? 'Increased' : 'Reduced'} Position`,
                  summary: `${instName} ${action === 'new' ? `initiated a new position of ${(shares / 1e6).toFixed(2)}M shares ($${(value / 1e9).toFixed(2)}B) in ${ticker}` :
                    `${action === 'increased' ? 'increased' : 'decreased'} their ${ticker} holding by ${changePct}% to ${(shares / 1e6).toFixed(2)}M shares`}.`,
                  significance: Math.abs(value) > 100000000 ? 'high' : 'medium',
                  sentiment: action === 'new' || action === 'increased' ? 'bullish' : 'bearish',
                  data: { institution: instName, shares, value, change_pct: changePct, action },
                }, { onConflict: 'accession_no' })
              }
            }
          } catch { /* skip */ }

          break // only process most recent 13-F per institution
        }

      } catch { /* skip this institution */ }
      })) // end Promise.all batch
      await new Promise(r => setTimeout(r, 200)) // brief pause between batches
    }
  } catch (e) {
    console.error('[sec-filings] 13-F error:', e)
  }
}

// ── S-1 / S-3 Dilution Monitoring ────────────────────────────────────────────

export async function fetchDilutionFilings(ticker: string): Promise<void> {
  const admin = getAdmin()
  const cikPadded = await getCIK(ticker)
  if (!cikPadded) return

  const since = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]

  try {
    const res = await fetch(`${EDGAR_BASE}/submissions/${cikPadded}.json`, { headers: EDGAR_HEADERS })
    if (!res.ok) return
    const data = await res.json()

    const filings = data.filings?.recent
    if (!filings) return

    const dilutionForms = ['S-1', 'S-1/A', 'S-3', 'S-3/A', '424B4', '424B3', 'S-11']
    const forms: string[] = filings.form || []
    const dates: string[] = filings.filingDate || []
    const accessions: string[] = filings.accessionNumber || []

    for (let i = 0; i < forms.length; i++) {
      if (!dilutionForms.includes(forms[i])) continue
      if (dates[i] < since) break

      const accNo = accessions[i]
      if (!accNo) continue

      const { data: existing } = await admin
        .from('sec_filings')
        .select('id')
        .eq('accession_no', accNo)
        .maybeSingle()
      if (existing) continue

      const isProspectus = forms[i].startsWith('424')
      const significance = isProspectus ? 'high' : 'medium' // actual offering vs shelf
      const title = forms[i] === 'S-1' ? 'IPO Registration Filed' :
        forms[i] === 'S-3' ? 'Shelf Registration (Potential Dilution)' :
        forms[i].startsWith('424') ? 'Prospectus Filed — Offering Imminent' :
        `${forms[i]} Registration`

      await admin.from('sec_filings').insert({
        ticker: ticker.toUpperCase(),
        cik: cikPadded,
        form_type: forms[i],
        filed_at: new Date(dates[i]).toISOString(),
        accession_no: accNo,
        filing_url: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cikPadded}&type=${forms[i]}`,
        title,
        summary: `${ticker} filed a ${forms[i]} ${isProspectus ? '— a securities offering is actively underway, watch for dilution.' : '— this is a shelf registration that may precede a future stock offering. Potential dilution risk.'}`,
        significance,
        sentiment: 'bearish',
        data: { form_type: forms[i], is_prospectus: isProspectus },
      })
    }
  } catch (e) {
    console.error('[sec-filings] dilution error:', e)
  }
}

// ── DEF 14A Executive Compensation ────────────────────────────────────────────

export async function fetchExecutiveComp(ticker: string): Promise<{
  executives: Array<{ name: string; title: string; total_comp: number; stock_awards: number; cash_bonus: number }>
  performance_metrics: string[]
  summary: string
} | null> {
  const cikPadded = await getCIK(ticker)
  if (!cikPadded) return null

  try {
    const res = await fetch(`${EDGAR_BASE}/submissions/${cikPadded}.json`, { headers: EDGAR_HEADERS })
    if (!res.ok) return null
    const data = await res.json()

    const filings = data.filings?.recent
    if (!filings) return null

    const forms: string[] = filings.form || []
    const accessions: string[] = filings.accessionNumber || []
    const dates: string[] = filings.filingDate || []

    // Find most recent DEF 14A
    const idx = forms.findIndex(f => f === 'DEF 14A')
    if (idx === -1) return null

    const accNo = accessions[idx]
    const filingDate = dates[idx]
    const cikNum = cikPadded.replace('CIK', '').replace(/^0+/, '')
    const accNoClean = accNo.replace(/-/g, '')

    // DEF 14A is HTML — use EDGAR full text search to find compensation table
    const docUrl = `https://www.sec.gov/Archives/edgar/data/${cikNum}/${accNoClean}/${accNo}-index.json`
    const indexRes = await fetch(docUrl, { headers: EDGAR_HEADERS })
    if (!indexRes.ok) return null

    // Return summary from sec_filings if already processed
    const admin = getAdmin()
    const { data: cached } = await admin
      .from('sec_filings')
      .select('data, summary')
      .eq('ticker', ticker.toUpperCase())
      .eq('form_type', 'DEF 14A')
      .order('filed_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (cached?.data) return cached.data as any

    // Store a placeholder noting it exists
    await admin.from('sec_filings').upsert({
      ticker: ticker.toUpperCase(),
      cik: cikPadded,
      form_type: 'DEF 14A',
      filed_at: new Date(filingDate).toISOString(),
      accession_no: `${accNo}-proxy`,
      title: 'Proxy Statement — Executive Compensation',
      summary: `${ticker} filed its annual proxy statement on ${filingDate}. Contains executive compensation details and performance metrics that management is incentivized to hit.`,
      significance: 'medium',
      sentiment: 'neutral',
      data: { filing_date: filingDate, accession_no: accNo },
    }, { onConflict: 'accession_no' })

    return null // Full DEF 14A parsing requires more complex HTML extraction
  } catch (e) {
    console.error('[sec-filings] DEF 14A error:', e)
    return null
  }
}

// ── Master fetch — runs all filing types for a ticker ─────────────────────────

export async function fetchAllFilingsForTicker(ticker: string): Promise<void> {
  console.log(`[sec-filings] Fetching all filing types for ${ticker}`)

  // Run sequentially to respect rate limits
  await fetch8KFilings(ticker)
  await new Promise(r => setTimeout(r, 500))
  await fetchInsiderTransactions(ticker)
  await new Promise(r => setTimeout(r, 500))
  await fetchDilutionFilings(ticker)
  await new Promise(r => setTimeout(r, 500))
  await fetch13FForTicker(ticker)
  await new Promise(r => setTimeout(r, 500))
  await fetchExecutiveComp(ticker)

  console.log(`[sec-filings] Done fetching filings for ${ticker}`)
}

// ── Query helpers ─────────────────────────────────────────────────────────────

export async function getRecentFilings(ticker: string, limit = 10) {
  const admin = getAdmin()
  const { data } = await admin
    .from('sec_filings')
    .select('*')
    .eq('ticker', ticker.toUpperCase())
    .order('filed_at', { ascending: false })
    .limit(limit)
  return data || []
}

export async function getInstitutionalSummary(ticker: string) {
  const admin = getAdmin()
  const quarter = getPriorQuarter(getCurrentQuarter())

  const { data } = await admin
    .from('institutional_holdings')
    .select('*')
    .eq('ticker', ticker.toUpperCase())
    .eq('quarter', quarter)
    .order('market_value', { ascending: false })
    .limit(10)

  return data || []
}

export async function getInsiderActivity(ticker: string, days = 90) {
  const admin = getAdmin()
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split('T')[0]

  const { data } = await admin
    .from('insider_transactions')
    .select('*')
    .eq('ticker', ticker.toUpperCase())
    .gte('transaction_date', since)
    .eq('is_open_market', true)
    .order('transaction_date', { ascending: false })
    .limit(20)

  return data || []
}

// ── Build context string for AI pipeline ─────────────────────────────────────

export async function buildSecFilingsContext(ticker: string): Promise<string> {
  const [recentFilings, insiders, institutions] = await Promise.all([
    getRecentFilings(ticker, 5),
    getInsiderActivity(ticker, 90),
    getInstitutionalSummary(ticker),
  ])

  if (recentFilings.length === 0 && insiders.length === 0 && institutions.length === 0) {
    return ''
  }

  const lines: string[] = ['=== SEC EDGAR FILING INTELLIGENCE (Verified Source Data) ===']

  if (recentFilings.length > 0) {
    lines.push('\nRECENT SEC FILINGS:')
    for (const f of recentFilings) {
      const date = f.filed_at.split('T')[0]
      lines.push(`• [${f.form_type}] ${date} — ${f.title}`)
      if (f.summary) lines.push(`  ${f.summary}`)
    }
  }

  if (insiders.length > 0) {
    const buys = insiders.filter((t: any) => t.transaction_type === 'P')
    const sells = insiders.filter((t: any) => t.transaction_type === 'S')
    const totalBuyValue = buys.reduce((s: number, t: any) => s + (t.total_value || 0), 0)
    const totalSellValue = sells.reduce((s: number, t: any) => s + (t.total_value || 0), 0)

    lines.push('\nINSIDER TRANSACTIONS (Last 90 Days, Open-Market Only):')
    if (buys.length > 0) {
      lines.push(`  Purchases: ${buys.length} transactions, total $${(totalBuyValue / 1000).toFixed(0)}K`)
      for (const b of buys.slice(0, 3)) {
        lines.push(`  • ${b.insider_name} (${b.title || 'Insider'}): Bought ${b.shares?.toLocaleString()} shares @ $${b.price_per_share} = $${((b.total_value || 0) / 1000).toFixed(0)}K on ${b.transaction_date}`)
      }
    }
    if (sells.length > 0) {
      lines.push(`  Sales: ${sells.length} transactions, total $${(totalSellValue / 1000).toFixed(0)}K`)
    }
    if (buys.length > 0 && sells.length === 0) lines.push('  ⭐ Net insider BUYING — no sales in this period')
    if (sells.length > buys.length * 2) lines.push('  ⚠ Net insider SELLING — more selling than buying')
  }

  if (institutions.length > 0) {
    lines.push('\nINSTITUTIONAL POSITIONS (Latest 13-F):')
    const newPositions = institutions.filter((h: any) => h.action === 'new')
    const increased = institutions.filter((h: any) => h.action === 'increased')
    const decreased = institutions.filter((h: any) => h.action === 'decreased')

    if (newPositions.length > 0) {
      lines.push(`  New positions: ${newPositions.map((h: any) => h.institution).join(', ')}`)
    }
    if (increased.length > 0) {
      lines.push(`  Increased: ${increased.map((h: any) => `${h.institution} +${h.change_pct}%`).join(', ')}`)
    }
    if (decreased.length > 0) {
      lines.push(`  Reduced: ${decreased.map((h: any) => `${h.institution} ${h.change_pct}%`).join(', ')}`)
    }

    const topHolder = institutions[0]
    if (topHolder) {
      lines.push(`  Largest known holder: ${topHolder.institution} — ${(topHolder.shares_held / 1e6).toFixed(2)}M shares ($${((topHolder.market_value || 0) / 1e9).toFixed(2)}B)`)
    }
  }

  lines.push('\nINSTRUCTION: Weight this SEC-verified data heavily. Open-market insider purchases are among the most reliable bullish signals. Significant institutional position changes indicate smart money conviction.')

  return lines.join('\n')
}

// ── Utility ───────────────────────────────────────────────────────────────────

function getCurrentQuarter(): string {
  const now = new Date()
  const q = Math.ceil((now.getMonth() + 1) / 3)
  return `${now.getFullYear()}-Q${q}`
}

function getPriorQuarter(quarter: string): string {
  const [year, q] = quarter.split('-Q').map(Number)
  if (q === 1) return `${year - 1}-Q4`
  return `${year}-Q${q - 1}`
}

