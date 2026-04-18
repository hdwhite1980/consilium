'use client'

import Image from 'next/image'
import Link from 'next/link'

/* ─────────────────────────────────────────────────────────────
 * WaliLogo — single source of truth for the brand lockup.
 *
 * Examples:
 *   <WaliLogo />                          // md, full lockup, links to /
 *   <WaliLogo size="sm" />                // small nav version
 *   <WaliLogo size="lg" />                // auth pages
 *   <WaliLogo variant="icon-only" />      // just the shield
 *   <WaliLogo noLink />                   // plain, no anchor
 *   <WaliLogo href="/dashboard" />        // link elsewhere
 *
 * The uploaded logo already contains "WALI-OS" text inside the art,
 * so the component renders it by itself — no accompanying text node
 * is layered on top by default.
 * ─────────────────────────────────────────────────────────────── */

type LogoSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl' | 'xxl'

interface WaliLogoProps {
  size?: LogoSize
  /** `lockup` (default) shows the full shield + WALI-OS wordmark from the PNG.
   *  `icon-only` renders the same image but cropped square (still the full art,
   *  just at a tight 1:1 box — visually the same file but fits square slots). */
  variant?: 'lockup' | 'icon-only'
  /** When true, the image is not wrapped in an anchor. Useful inside buttons or
   *  places that already manage navigation. */
  noLink?: boolean
  /** Override the destination. Defaults to `/`. */
  href?: string
  /** Priority hint for above-the-fold usage (e.g. login/signup). */
  priority?: boolean
  /** Extra classes for the outer wrapper. */
  className?: string
}

const SIZE_MAP: Record<LogoSize, { px: number; className: string }> = {
  xs:  { px: 28,  className: 'h-7 w-7' },
  sm:  { px: 36,  className: 'h-9 w-9' },
  md:  { px: 48,  className: 'h-12 w-12' },
  lg:  { px: 64,  className: 'h-16 w-16' },
  xl:  { px: 160, className: 'h-40 w-40' },
  xxl: { px: 288, className: 'h-72 w-72' },
}

export default function WaliLogo({
  size = 'md',
  variant = 'lockup',
  noLink = false,
  href = '/',
  priority = false,
  className = '',
}: WaliLogoProps) {
  const { px, className: sizeClass } = SIZE_MAP[size]

  const img = (
    <Image
      src="/wali-os-logo.png"
      alt="Wali-OS"
      width={px}
      height={px}
      priority={priority}
      draggable={false}
      className={`${sizeClass} object-contain select-none`}
      style={{
        // The image itself has the wordmark. If variant is icon-only, crop a bit
        // from the bottom where the text sits so it reads as pure icon.
        objectPosition: variant === 'icon-only' ? 'center top' : 'center',
      }}
    />
  )

  if (noLink) {
    return <span className={`inline-flex items-center ${className}`}>{img}</span>
  }

  return (
    <Link
      href={href}
      aria-label="Wali-OS home"
      className={`inline-flex items-center rounded-lg focus:outline focus:outline-2 focus:outline-offset-2 ${className}`}
      style={{ outlineColor: '#38bdf8' }}>
      {img}
    </Link>
  )
}
