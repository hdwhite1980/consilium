// ════════════════════════════════════════════════════════════════
// app/more/page.tsx
//
// Mobile "More" surface. Lists every nav destination not in the
// bottom nav, grouped by category. Server component (no auth check
// required — all routes here are public or self-gate).
//
// Reachable from the MobileBottomNav "More" tab. On desktop this
// page also works but desktop users typically use the top nav.
// ════════════════════════════════════════════════════════════════

import Link from 'next/link'
import {
  ArrowLeft, Search, Target, LineChart, Globe, Coins,
  Calendar, Scale, Trophy, BookOpen, ClipboardList,
  Settings, CreditCard,
} from 'lucide-react'
import type { ReactNode } from 'react'

interface NavLink {
  label: string
  href: string
  icon: ReactNode
  description?: string
  color: string
}

interface NavSection {
  title: string
  items: NavLink[]
}

const SECTIONS: NavSection[] = [
  {
    title: 'Discover',
    items: [
      { label: 'Scanner',   href: '/scanner',   icon: <Target size={18} />,    color: '#a78bfa', description: 'Find setups across the market' },
      { label: 'Options',   href: '/options',   icon: <LineChart size={18} />, color: '#fbbf24', description: 'Options chain + strategy explorer' },
      { label: 'Macro',     href: '/macro',     icon: <Globe size={18} />,     color: '#60a5fa', description: 'Sector dashboard & macro flows' },
      { label: 'Altcoins',  href: '/altcoins',  icon: <Coins size={18} />,     color: '#a78bfa', description: 'Crypto coverage' },
    ],
  },
  {
    title: 'Daily Rhythm',
    items: [
      { label: 'Tomorrow',  href: '/tomorrow',  icon: <Calendar size={18} />,  color: '#a78bfa', description: "Tomorrow's playbook" },
      { label: 'Compare',   href: '/compare',   icon: <Scale size={18} />,     color: '#f87171', description: 'Head-to-head two stocks' },
    ],
  },
  {
    title: 'Track Record',
    items: [
      { label: 'Track Record', href: '/track-record', icon: <Trophy size={18} />,   color: '#fbbf24', description: 'Verdict accuracy & outcomes' },
      { label: 'Guide',        href: '/guide',        icon: <BookOpen size={18} />, color: '#94a3b8', description: 'How Wali-OS works' },
    ],
  },
  {
    title: 'Positions',
    items: [
      { label: 'Watchlist', href: '/watchlist', icon: <ClipboardList size={18} />, color: '#60a5fa', description: 'Tickers to keep an eye on' },
    ],
  },
  {
    title: 'Account',
    items: [
      { label: 'Settings',  href: '/settings',  icon: <Settings size={18} />,    color: '#94a3b8', description: 'Theme, font size, account' },
      { label: 'Pricing',   href: '/subscribe', icon: <CreditCard size={18} />,  color: '#34d399', description: 'View plans and upgrade' },
    ],
  },
]

export default function MorePage() {
  return (
    <div className="min-h-screen t-bg t-text">
      <div className="max-w-2xl mx-auto px-4 py-6">
        {/* Header */}
        <div className="flex items-center gap-3 mb-6">
          <Link
            href="/"
            className="text-sm hover:opacity-70 transition-opacity"
            style={{ color: 'var(--text2)' }}
          >
            <ArrowLeft size={18} />
          </Link>
          <h1 className="text-2xl font-bold">More</h1>
        </div>

        {/* Sections */}
        <div className="space-y-7">
          {SECTIONS.map(section => (
            <section key={section.title}>
              <h2
                className="text-[10px] font-mono uppercase tracking-widest mb-3 px-1"
                style={{ color: 'var(--text3)' }}
              >
                {section.title}
              </h2>
              <div
                className="rounded-2xl overflow-hidden"
                style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
              >
                {section.items.map((item, i) => (
                  <Link
                    key={item.href}
                    href={item.href}
                    className="flex items-center gap-3 px-4 py-3.5 transition-colors hover:opacity-90"
                    style={{
                      borderTop: i === 0 ? 'none' : '1px solid var(--border)',
                    }}
                  >
                    <span
                      className="flex items-center justify-center w-9 h-9 rounded-lg shrink-0"
                      style={{ background: `${item.color}15`, color: item.color }}
                    >
                      {item.icon}
                    </span>
                    <span className="flex-1 min-w-0">
                      <span className="block text-sm font-semibold" style={{ color: 'var(--text)' }}>
                        {item.label}
                      </span>
                      {item.description && (
                        <span className="block text-xs mt-0.5 truncate" style={{ color: 'var(--text3)' }}>
                          {item.description}
                        </span>
                      )}
                    </span>
                    <span style={{ color: 'var(--text3)' }} aria-hidden="true">
                      {'\u203A'}
                    </span>
                  </Link>
                ))}
              </div>
            </section>
          ))}
        </div>

        {/* Bottom padding to clear the bottom nav bar */}
        <div className="h-20 md:h-0" />
      </div>
    </div>
  )
}
