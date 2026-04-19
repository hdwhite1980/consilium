// ═════════════════════════════════════════════════════════════
// /altcoins — Standalone page showing upcoming altcoin launches
// (from Grok X buzz) + recently launched tokens (from CoinGecko).
//
// Two sections:
//   1. Launching Soon — upcoming launches Grok found on X
//   2. Recently Launched — tokens listed on CoinGecko in the last N days
//
// Styled to match Macro page conventions (var(--surface), rounded-2xl,
// hex colors, text-[10px] font-mono uppercase tracking-widest).
// ═════════════════════════════════════════════════════════════

'use client'

import { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowLeft, RefreshCw, TrendingUp, TrendingDown, ExternalLink, Minus, Calendar, AlertTriangle, CheckCircle2, HelpCircle } from 'lucide-react'

interface Altcoin {
  coingecko_id: string
  symbol: string
  name: string
  listed_date: string | null
  days_since_listed: number | null
  current_price_usd: number | null
  price_change_24h_pct: number | null
  market_cap_rank: number | null
  market_cap_usd: number | null
  volume_24h_usd: number | null
  image_url: string | null
  x_mention_count: number
  x_sentiment: string | null
  x_top_post_summary: string | null
  refreshed_at: string
  status: 'launched' | 'upcoming'
  launch_date: string | null
  launch_source_url: string | null
  launch_platform: string | null
  launch_confidence: 'verified' | 'user_reported' | 'rumor' | null
}

interface ApiResponse {
  ok: boolean
  days: number
  sort: string
  upcomingCount: number
  launchedCount: number
  lastRefreshed: string | null
  upcoming: Altcoin[]
  launched: Altcoin[]
  generatedAt: string
}

function fmtPrice(n: number | null): string {
  if (n === null || n === undefined) return '—'
  if (n >= 1) return '$' + n.toFixed(2)
  if (n >= 0.01) return '$' + n.toFixed(4)
  return '$' + n.toExponential(2)
}

function fmtMarketCap(n: number | null): string {
  if (n === null || n === undefined || n <= 0) return '—'
  if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B'
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M'
  if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K'
  return '$' + n.toFixed(0)
}

function fmtMentions(n: number): string {
  if (n === 0) return '—'
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K'
  return n.toString()
}

function sentimentColor(s: string | null): string {
  if (s === 'bullish') return '#34d399'
  if (s === 'bearish') return '#f87171'
  if (s === 'mixed') return '#fbbf24'
  return 'rgba(255,255,255,0.4)'
}

function sentimentBg(s: string | null): string {
  if (s === 'bullish') return 'rgba(52,211,153,0.1)'
  if (s === 'bearish') return 'rgba(248,113,113,0.1)'
  if (s === 'mixed') return 'rgba(251,191,36,0.1)'
  return 'rgba(255,255,255,0.04)'
}

function confidenceColor(c: string | null): string {
  if (c === 'verified') return '#34d399'
  if (c === 'user_reported') return '#60a5fa'
  if (c === 'rumor') return '#fbbf24'
  return 'rgba(255,255,255,0.4)'
}

function confidenceBg(c: string | null): string {
  if (c === 'verified') return 'rgba(52,211,153,0.1)'
  if (c === 'user_reported') return 'rgba(96,165,250,0.1)'
  if (c === 'rumor') return 'rgba(251,191,36,0.1)'
  return 'rgba(255,255,255,0.04)'
}

function ConfidenceIcon({ c }: { c: string | null }) {
  if (c === 'verified') return <CheckCircle2 size={10} />
  if (c === 'rumor') return <AlertTriangle size={10} />
  return <HelpCircle size={10} />
}

function formatLaunchDate(iso: string | null): string {
  if (!iso) return 'TBD'
  const d = new Date(iso + 'T12:00:00')
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const diff = Math.round((d.getTime() - today.getTime()) / 86400000)
  if (diff === 0) return 'Today'
  if (diff === 1) return 'Tomorrow'
  if (diff > 0 && diff <= 7) return `in ${diff}d`
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function formatTimeSince(iso: string | null): string {
  if (!iso) return 'never'
  const diff = Date.now() - new Date(iso).getTime()
  const minutes = Math.floor(diff / 60000)
  const hours = Math.floor(diff / 3600000)
  if (minutes < 60) return `${minutes}m ago`
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

export default function AltcoinsPage() {
  const router = useRouter()
  const [days, setDays] = useState<1 | 7 | 30>(7)
  const [sort, setSort] = useState<'mentions' | 'listed' | 'price_change' | 'market_cap'>('mentions')
  const [data, setData] = useState<ApiResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/altcoins?days=${days}&sort=${sort}&limit=100`)
      if (!res.ok) throw new Error(await res.text())
      const d = await res.json()
      setData(d)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load altcoins')
    } finally {
      setLoading(false)
    }
  }, [days, sort])

  useEffect(() => { load() }, [load])

  return (
    <div className="flex flex-col min-h-screen" style={{ background: 'var(--bg)', color: 'var(--text)' }}>
      {/* Header */}
      <div className="flex items-center gap-3 px-5 py-3 border-b" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
        <button onClick={() => router.push('/')} className="flex items-center gap-1.5 text-sm text-white/60 hover:text-white">
          <ArrowLeft size={16} /> Back
        </button>
        <div className="w-px h-4" style={{ background: 'var(--border)' }} />
        <div>
          <h1 className="text-sm font-bold text-white">Altcoin Tracker</h1>
          <div className="text-[10px] font-mono uppercase tracking-widest" style={{ color: 'var(--text3)' }}>
            Upcoming launches + new listings · X buzz scored
          </div>
        </div>

        <div className="flex-1" />

        <div className="text-[10px] font-mono uppercase tracking-widest" style={{ color: 'var(--text3)' }}>
          Updated {formatTimeSince(data?.lastRefreshed ?? null)}
        </div>

        <button
          onClick={load}
          disabled={loading}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs border disabled:opacity-40"
          style={{ background: 'var(--surface2)', borderColor: 'var(--border)', color: 'var(--text3)' }}
        >
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>

      <div className="max-w-6xl w-full mx-auto px-4 py-6 space-y-6">
        {/* Loading / error states */}
        {loading && !data && (
          <div className="rounded-2xl border p-8 text-center" style={{ background: 'var(--surface)', borderColor: 'var(--border)', color: 'var(--text3)' }}>
            <div className="inline-flex items-center gap-1.5">
              {[0, 1, 2].map((i) => (
                <span key={i} className="w-1.5 h-1.5 rounded-full thinking-dot" style={{ background: '#60a5fa', animationDelay: `${i * 0.15}s` }} />
              ))}
            </div>
            <div className="text-[10px] font-mono uppercase tracking-widest mt-2">Loading altcoins</div>
          </div>
        )}

        {error && (
          <div className="rounded-2xl border p-4 text-sm" style={{ background: 'rgba(248,113,113,0.08)', borderColor: 'rgba(248,113,113,0.25)', color: '#f87171' }}>
            {error}
          </div>
        )}

        {/* ══════════════════════════════════════════════════════ */}
        {/* SECTION 1: Launching Soon                              */}
        {/* ══════════════════════════════════════════════════════ */}
        {data && (
          <div className="rounded-2xl border overflow-hidden" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
            <div className="flex items-center gap-2.5 px-5 py-3.5 border-b" style={{ borderColor: 'var(--border)' }}>
              <Calendar size={16} style={{ color: '#a78bfa' }} />
              <div>
                <div className="text-sm font-bold text-white">Launching Soon</div>
                <div className="text-[10px] font-mono uppercase tracking-widest" style={{ color: 'var(--text3)' }}>
                  Upcoming launches sourced from X · {data.upcomingCount} found
                </div>
              </div>
            </div>

            {/* Disclaimer */}
            <div className="px-5 py-2.5 border-b text-[11px] flex items-start gap-2" style={{ borderColor: 'var(--border)', background: 'rgba(251,191,36,0.04)', color: '#fbbf24' }}>
              <AlertTriangle size={12} className="flex-shrink-0 mt-0.5" />
              <span>
                Data is user-reported from X and may be inaccurate. Always verify the contract address and launch platform before trading.
              </span>
            </div>

            {data.upcoming.length === 0 ? (
              <div className="px-5 py-6 text-center text-xs" style={{ color: 'var(--text3)' }}>
                No credible upcoming launches found in the last 48 hours.
              </div>
            ) : (
              <>
                {/* Upcoming table header */}
                <div className="grid grid-cols-12 items-center gap-2 px-4 py-2 border-b text-[10px] font-mono uppercase tracking-widest" style={{ borderColor: 'var(--border)', background: 'var(--surface2)', color: 'var(--text3)' }}>
                  <div className="col-span-3">Token</div>
                  <div className="col-span-2">Launch</div>
                  <div className="col-span-2">Platform</div>
                  <div className="col-span-1 text-right">X Buzz</div>
                  <div className="col-span-3">Confidence · Summary</div>
                  <div className="col-span-1 text-right">Source</div>
                </div>

                <div className="divide-y" style={{ borderColor: 'rgba(255,255,255,0.04)' }}>
                  {data.upcoming.map((coin) => (
                    <div
                      key={coin.coingecko_id}
                      className="grid grid-cols-12 items-center gap-2 px-4 py-2.5 text-sm hover:opacity-90 transition-opacity"
                    >
                      {/* Token */}
                      <div className="col-span-3 flex items-center gap-2 min-w-0">
                        <div className="w-5 h-5 rounded-full flex-shrink-0 flex items-center justify-center" style={{ background: 'rgba(167,139,250,0.15)' }}>
                          <span className="text-[9px] font-bold" style={{ color: '#a78bfa' }}>?</span>
                        </div>
                        <div className="min-w-0">
                          <div className="font-mono font-bold text-white truncate">{coin.symbol}</div>
                          <div className="text-[10px] truncate" style={{ color: 'var(--text3)' }}>{coin.name}</div>
                        </div>
                      </div>

                      {/* Launch date */}
                      <div className="col-span-2">
                        <span
                          className="inline-flex items-center gap-1 text-[11px] font-mono font-bold px-2 py-0.5 rounded"
                          style={{ background: 'rgba(167,139,250,0.1)', color: '#a78bfa' }}
                        >
                          <Calendar size={10} />
                          {formatLaunchDate(coin.launch_date)}
                        </span>
                      </div>

                      {/* Platform */}
                      <div className="col-span-2">
                        {coin.launch_platform ? (
                          <span className="text-[11px] font-mono text-white/70">{coin.launch_platform}</span>
                        ) : (
                          <span className="text-[10px]" style={{ color: 'var(--text3)' }}>unknown</span>
                        )}
                      </div>

                      {/* X Buzz */}
                      <div className="col-span-1 text-right">
                        <span
                          className="inline-block font-mono text-xs font-bold px-1.5 py-0.5 rounded"
                          style={{
                            background: coin.x_mention_count > 1000 ? 'rgba(167,139,250,0.15)' : coin.x_mention_count > 100 ? 'rgba(96,165,250,0.1)' : 'rgba(255,255,255,0.03)',
                            color: coin.x_mention_count > 1000 ? '#a78bfa' : coin.x_mention_count > 100 ? '#60a5fa' : 'var(--text3)',
                          }}
                        >
                          {fmtMentions(coin.x_mention_count)}
                        </span>
                      </div>

                      {/* Confidence + summary */}
                      <div className="col-span-3 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span
                            className="inline-flex items-center gap-1 text-[10px] font-mono uppercase tracking-widest px-1.5 py-0.5 rounded-full"
                            style={{
                              background: confidenceBg(coin.launch_confidence),
                              color: confidenceColor(coin.launch_confidence),
                              border: `1px solid ${confidenceColor(coin.launch_confidence)}30`,
                            }}
                          >
                            <ConfidenceIcon c={coin.launch_confidence} />
                            {coin.launch_confidence?.replace('_', ' ') ?? 'unknown'}
                          </span>
                        </div>
                        {coin.x_top_post_summary && (
                          <div className="text-[10px] truncate mt-0.5" style={{ color: 'var(--text3)' }} title={coin.x_top_post_summary}>
                            {coin.x_top_post_summary.slice(0, 80)}{coin.x_top_post_summary.length > 80 ? '…' : ''}
                          </div>
                        )}
                      </div>

                      {/* Source */}
                      <div className="col-span-1 text-right">
                        {coin.launch_source_url ? (
                          <a
                            href={coin.launch_source_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center justify-center w-6 h-6 rounded hover:opacity-80"
                            style={{ background: 'var(--surface2)', color: 'var(--text3)' }}
                            title="Open source post"
                          >
                            <ExternalLink size={10} />
                          </a>
                        ) : (
                          <span className="text-[10px]" style={{ color: 'var(--text3)' }}>—</span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        {/* ══════════════════════════════════════════════════════ */}
        {/* SECTION 2: Recently Launched                           */}
        {/* ══════════════════════════════════════════════════════ */}
        {data && (
          <>
            {/* Filter controls for launched section */}
            <div className="flex flex-wrap gap-3 items-center justify-between">
              <div className="flex gap-1.5 p-1 rounded-lg" style={{ background: 'var(--surface2)' }}>
                {[1, 7, 30].map((d) => (
                  <button
                    key={d}
                    onClick={() => setDays(d as 1 | 7 | 30)}
                    className="px-3 py-1 text-[10px] font-mono uppercase tracking-widest rounded-md"
                    style={{
                      background: days === d ? 'rgba(96,165,250,0.15)' : 'transparent',
                      color: days === d ? '#60a5fa' : 'var(--text3)',
                      border: days === d ? '1px solid rgba(96,165,250,0.3)' : '1px solid transparent',
                    }}
                  >
                    {d === 1 ? 'Last 24h' : `Last ${d}d`}
                  </button>
                ))}
              </div>

              <div className="flex gap-1.5 p-1 rounded-lg" style={{ background: 'var(--surface2)' }}>
                {([
                  { id: 'mentions', label: 'X Buzz' },
                  { id: 'listed', label: 'Newest' },
                  { id: 'price_change', label: '24h Change' },
                  { id: 'market_cap', label: 'Market Cap' },
                ] as const).map((opt) => (
                  <button
                    key={opt.id}
                    onClick={() => setSort(opt.id)}
                    className="px-3 py-1 text-[10px] font-mono uppercase tracking-widest rounded-md"
                    style={{
                      background: sort === opt.id ? 'rgba(167,139,250,0.15)' : 'transparent',
                      color: sort === opt.id ? '#a78bfa' : 'var(--text3)',
                      border: sort === opt.id ? '1px solid rgba(167,139,250,0.3)' : '1px solid transparent',
                    }}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="rounded-2xl border overflow-hidden" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
              <div className="flex items-center gap-2.5 px-5 py-3.5 border-b" style={{ borderColor: 'var(--border)' }}>
                <TrendingUp size={16} style={{ color: '#60a5fa' }} />
                <div>
                  <div className="text-sm font-bold text-white">Recently Launched</div>
                  <div className="text-[10px] font-mono uppercase tracking-widest" style={{ color: 'var(--text3)' }}>
                    Listed on CoinGecko in the last {days}d · {data.launchedCount} found
                  </div>
                </div>
              </div>

              {data.launched.length === 0 ? (
                <div className="px-5 py-6 text-center text-xs" style={{ color: 'var(--text3)' }}>
                  No tokens listed in the last {days}d. Try widening the time window.
                </div>
              ) : (
                <>
                  {/* Launched table header */}
                  <div className="grid grid-cols-12 items-center gap-2 px-4 py-2 border-b text-[10px] font-mono uppercase tracking-widest" style={{ borderColor: 'var(--border)', background: 'var(--surface2)', color: 'var(--text3)' }}>
                    <div className="col-span-3">Token</div>
                    <div className="col-span-1 text-right">Listed</div>
                    <div className="col-span-2 text-right">Price</div>
                    <div className="col-span-1 text-right">24h</div>
                    <div className="col-span-1 text-right">Mcap</div>
                    <div className="col-span-1 text-right">X Buzz</div>
                    <div className="col-span-2">Sentiment</div>
                    <div className="col-span-1 text-right">Link</div>
                  </div>

                  <div className="divide-y" style={{ borderColor: 'rgba(255,255,255,0.04)' }}>
                    {data.launched.map((coin) => {
                      const priceChange = coin.price_change_24h_pct ?? 0
                      const TrendIcon = priceChange > 0 ? TrendingUp : priceChange < 0 ? TrendingDown : Minus
                      return (
                        <div key={coin.coingecko_id} className="grid grid-cols-12 items-center gap-2 px-4 py-2.5 text-sm hover:opacity-90 transition-opacity">
                          {/* Token */}
                          <div className="col-span-3 flex items-center gap-2 min-w-0">
                            {coin.image_url ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img src={coin.image_url} alt="" className="w-5 h-5 rounded-full flex-shrink-0" loading="lazy" />
                            ) : (
                              <div className="w-5 h-5 rounded-full flex-shrink-0" style={{ background: 'var(--surface2)' }} />
                            )}
                            <div className="min-w-0">
                              <div className="font-mono font-bold text-white truncate">{coin.symbol}</div>
                              <div className="text-[10px] truncate" style={{ color: 'var(--text3)' }}>{coin.name}</div>
                            </div>
                          </div>

                          {/* Listed */}
                          <div className="col-span-1 text-right">
                            <div className="text-xs text-white/70">{coin.days_since_listed ?? '—'}d</div>
                            <div className="text-[9px]" style={{ color: 'var(--text3)' }}>{coin.listed_date?.slice(5) ?? ''}</div>
                          </div>

                          {/* Price */}
                          <div className="col-span-2 text-right font-mono text-xs text-white/90">
                            {fmtPrice(coin.current_price_usd)}
                          </div>

                          {/* 24h change */}
                          <div className="col-span-1 text-right">
                            <div
                              className="inline-flex items-center gap-0.5 font-mono text-xs font-bold"
                              style={{ color: priceChange > 0 ? '#34d399' : priceChange < 0 ? '#f87171' : 'var(--text3)' }}
                            >
                              <TrendIcon size={10} />
                              {priceChange !== null ? `${priceChange >= 0 ? '+' : ''}${priceChange.toFixed(1)}%` : '—'}
                            </div>
                          </div>

                          {/* Market cap */}
                          <div className="col-span-1 text-right font-mono text-xs text-white/70">
                            {fmtMarketCap(coin.market_cap_usd)}
                          </div>

                          {/* X Buzz */}
                          <div className="col-span-1 text-right">
                            <span
                              className="inline-block font-mono text-xs font-bold px-1.5 py-0.5 rounded"
                              style={{
                                background: coin.x_mention_count > 1000 ? 'rgba(167,139,250,0.15)' : coin.x_mention_count > 100 ? 'rgba(96,165,250,0.1)' : 'rgba(255,255,255,0.03)',
                                color: coin.x_mention_count > 1000 ? '#a78bfa' : coin.x_mention_count > 100 ? '#60a5fa' : 'var(--text3)',
                              }}
                            >
                              {fmtMentions(coin.x_mention_count)}
                            </span>
                          </div>

                          {/* Sentiment */}
                          <div className="col-span-2">
                            {coin.x_sentiment && coin.x_sentiment !== 'unknown' ? (
                              <div className="flex items-center gap-2">
                                <span
                                  className="text-[10px] font-mono uppercase tracking-widest px-2 py-0.5 rounded-full"
                                  style={{
                                    background: sentimentBg(coin.x_sentiment),
                                    color: sentimentColor(coin.x_sentiment),
                                    border: `1px solid ${sentimentColor(coin.x_sentiment)}30`,
                                  }}
                                >
                                  {coin.x_sentiment}
                                </span>
                                {coin.x_top_post_summary && coin.x_top_post_summary.length > 5 && (
                                  <span className="text-[10px] truncate" style={{ color: 'var(--text3)' }} title={coin.x_top_post_summary}>
                                    {coin.x_top_post_summary.slice(0, 50)}{coin.x_top_post_summary.length > 50 ? '…' : ''}
                                  </span>
                                )}
                              </div>
                            ) : (
                              <span className="text-[10px] font-mono" style={{ color: 'var(--text3)' }}>no data</span>
                            )}
                          </div>

                          {/* CoinGecko link */}
                          <div className="col-span-1 text-right">
                            <a
                              href={`https://www.coingecko.com/en/coins/${coin.coingecko_id}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center justify-center w-6 h-6 rounded hover:opacity-80"
                              style={{ background: 'var(--surface2)', color: 'var(--text3)' }}
                              title="Open on CoinGecko"
                            >
                              <ExternalLink size={10} />
                            </a>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </>
              )}
            </div>
          </>
        )}

        {/* Footer */}
        {data && (
          <p className="text-[10px] text-center pb-2" style={{ color: 'var(--text3)' }}>
            Upcoming from X via Grok · Launched from CoinGecko · Refreshed daily ·
            Copy a ticker to the main page for full analysis · For informational purposes only.
          </p>
        )}
      </div>
    </div>
  )
}
