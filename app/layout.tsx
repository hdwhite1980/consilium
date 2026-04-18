import type { Metadata } from 'next'
import './globals.css'
import { ThemeProvider } from './lib/theme'

export const metadata: Metadata = {
  title: 'Wali-OS — AI Stock Analysis',
  description: 'Three AI models debate stock direction and converge on a consensus verdict.',
  icons: {
    icon: [
      { url: '/favicon.ico', sizes: 'any' },
      { url: '/wali-os-logo.png', type: 'image/png', sizes: '256x256' },
    ],
    apple: '/apple-touch-icon.png',
  },
  openGraph: {
    title: 'Wali-OS — AI Stock Analysis',
    description: 'Three AI models debate stock direction and converge on a consensus verdict.',
    url: 'https://wali-os.com',
    siteName: 'Wali-OS',
    images: [
      {
        url: '/og-image.png',
        width: 1200,
        height: 630,
        alt: 'Wali-OS — Stop guessing. Start knowing.',
      },
    ],
    locale: 'en_US',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Wali-OS — AI Stock Analysis',
    description: 'Three AI models debate stock direction and converge on a consensus verdict.',
    images: ['/og-image.png'],
  },
  metadataBase: new URL('https://wali-os.com'),
}

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  themeColor: '#0a0d12',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=Space+Grotesk:wght@400;500;600;700&display=swap" rel="stylesheet" />
        {/* Apply theme + font-size before hydration to prevent flash */}
        <script dangerouslySetInnerHTML={{ __html: `
          (function(){
            try {
              var t = localStorage.getItem('wali_os_theme') || 'dark';
              document.documentElement.setAttribute('data-theme', t);
              var s = localStorage.getItem('wali_os_font_size') || 'md';
              document.documentElement.setAttribute('data-font-size', s);
            } catch(e){}
          })();
        `}} />
      </head>
      <body className="antialiased">
        <ThemeProvider>
          {children}
        </ThemeProvider>
      </body>
    </html>
  )
}
