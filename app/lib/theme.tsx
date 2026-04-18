'use client'

import { createContext, useContext, useEffect, useState } from 'react'

type Theme = 'dark' | 'light'
type FontSize = 'sm' | 'md' | 'lg' | 'xl'

const ThemeContext = createContext<{
  theme: Theme
  toggle: () => void
  fontSize: FontSize
  setFontSize: (size: FontSize) => void
}>({
  theme: 'dark',
  toggle: () => {},
  fontSize: 'md',
  setFontSize: () => {},
})

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setTheme] = useState<Theme>('dark')
  const [fontSize, setFontSizeState] = useState<FontSize>('md')

  useEffect(() => {
    // Theme
    const savedTheme = localStorage.getItem('wali_os_theme') as Theme | null
    const t = savedTheme ?? 'dark'
    setTheme(t)
    document.documentElement.setAttribute('data-theme', t)

    // Font size
    const savedSize = localStorage.getItem('wali_os_font_size') as FontSize | null
    const s = savedSize ?? 'md'
    setFontSizeState(s)
    document.documentElement.setAttribute('data-font-size', s)
  }, [])

  const toggle = () => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark'
    setTheme(next)
    localStorage.setItem('wali_os_theme', next)
    document.documentElement.setAttribute('data-theme', next)
  }

  const setFontSize = (size: FontSize) => {
    setFontSizeState(size)
    localStorage.setItem('wali_os_font_size', size)
    document.documentElement.setAttribute('data-font-size', size)
  }

  return (
    <ThemeContext.Provider value={{ theme, toggle, fontSize, setFontSize }}>
      {children}
    </ThemeContext.Provider>
  )
}

export const useTheme = () => useContext(ThemeContext)
