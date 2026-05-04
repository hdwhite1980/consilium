// ════════════════════════════════════════════════════════════════
// app/components/MobileBottomNav.tsx
//
// Mobile-only bottom navigation. Renders 5 fixed-position icon buttons
// at the bottom of the viewport on screens narrower than `md` (768px).
// Hidden on auth/onboarding routes.
//
// Destinations:
//   Home (/)        → Council
//   Today (/news)   → today's market
//   Invest (/invest)
//   Portfolio (/portfolio)
//   More (/more)    → everything else
//
// Active state is computed from usePathname(). The "More" tab is also
// considered active for any descendant of the routes not covered by the
// other 4 tabs (so e.g. /scanner, /macro, /watchlist all light up "More").
// ════════════════════════════════════════════════════════════════

'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Home, Zap, Flame, Briefcase, MoreHorizontal } from 'lucide-react'
import type { ReactNode } from 'react'

interface NavItem {
  label: string
  href: string
  icon: ReactNode
  // A path matches this item if pathname === href OR pathname starts with `${href}/`.
  // For Home (`/`), only exact match counts — otherwise every page would highlight Home.
}

const NAV_ITEMS: NavItem[] = [
  { label: 'Home',      href: '/',          icon: <Home size={20} /> },
  { label: 'Today',     href: '/news',      icon: <Zap size={20} /> },
  { label: 'Invest',    href: '/invest',    icon: <Flame size={20} /> },
  { label: 'Portfolio', href: '/portfolio', icon: <Briefcase size={20} /> },
  { label: 'More',      href: '/more',      icon: <MoreHorizontal size={20} /> },
]

// Routes where the bottom nav should NOT render — auth + onboarding flows
const HIDDEN_PATHS = new Set<string>([
  '/login',
  '/signup',
  '/confirm',
  '/disclaimer',
])

// Paths that the 4 explicit tabs (excluding "More") match
const EXPLICIT_TAB_HREFS = new Set<string>(['/', '/news', '/invest', '/portfolio'])

function isItemActive(itemHref: string, pathname: string): boolean {
  // Home only matches exact /
  if (itemHref === '/') return pathname === '/'

  // "More" lights up for anything not covered by the other 4 tabs
  if (itemHref === '/more') {
    if (pathname === '/more' || pathname.startsWith('/more/')) return true
    // Active for any path that isn't / and isn't one of the explicit-tab roots
    if (pathname === '/') return false
    for (const root of EXPLICIT_TAB_HREFS) {
      if (root === '/') continue
      if (pathname === root || pathname.startsWith(`${root}/`)) return false
    }
    // Also don't light up "More" for hidden paths (the bar isn't shown anyway)
    if (HIDDEN_PATHS.has(pathname)) return false
    return true
  }

  // Other tabs: exact match or descendant
  return pathname === itemHref || pathname.startsWith(`${itemHref}/`)
}

export default function MobileBottomNav() {
  const pathname = usePathname() ?? '/'

  // Hide on auth/onboarding routes
  if (HIDDEN_PATHS.has(pathname)) return null

  return (
    <nav
      aria-label="Mobile primary navigation"
      className="md:hidden fixed bottom-0 inset-x-0 z-40"
      style={{
        background: 'var(--surface)',
        borderTop: '1px solid var(--border)',
        // Respect iOS safe area on notched devices
        paddingBottom: 'env(safe-area-inset-bottom)',
      }}
    >
      <ul className="flex items-stretch">
        {NAV_ITEMS.map(item => {
          const active = isItemActive(item.href, pathname)
          return (
            <li key={item.href} className="flex-1">
              <Link
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className="flex flex-col items-center justify-center gap-0.5 py-2 px-1 transition-colors"
                style={{
                  color: active ? 'var(--accent)' : 'var(--text3)',
                }}
              >
                <span
                  className="flex items-center justify-center w-12 h-7 rounded-full transition-colors"
                  style={{
                    background: active ? 'rgba(124,58,237,0.15)' : 'transparent',
                  }}
                >
                  {item.icon}
                </span>
                <span className="text-[10px] font-medium leading-none">
                  {item.label}
                </span>
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
