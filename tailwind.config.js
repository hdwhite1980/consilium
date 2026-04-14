/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './pages/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        bg: '#0a0d12',
        surface: '#111620',
        surface2: '#181e2a',
        border: 'rgba(255,255,255,0.08)',
        claude: '#a78bfa',
        gpt: '#34d399',
        gemini: '#60a5fa',
        consensus: '#fbbf24',
        bull: '#34d399',
        bear: '#f87171',
      },
      fontFamily: {
        mono: ['IBM Plex Mono', 'monospace'],
        sans: ['Space Grotesk', 'sans-serif'],
      },
    },
  },
  plugins: [],
}
