'use client'

import { useState, useEffect } from 'react'
import { createClient } from '@/app/lib/auth/client'
import { tierHasFeature } from '@/app/lib/stripe'

interface SubInfo {
  hasAccess: boolean
  tier: 'standard' | 'pro'
  status: string
  daysLeft: number | null
  loaded: boolean
}

export function useSubscription(): SubInfo {
  const [info, setInfo] = useState<SubInfo>({
    hasAccess: false, tier: 'standard', status: 'unknown', daysLeft: null, loaded: false,
  })

  useEffect(() => {
    const supabase = createClient()
    supabase.auth.getUser().then(async ({ data: { user } }) => {
      if (!user) { setInfo(prev => ({ ...prev, loaded: true })); return }
      try {
        const res = await fetch('/api/auth/session')
        const data = await res.json()
        setInfo({
          hasAccess: data.hasAccess ?? false,
          tier: data.tier ?? 'standard',
          status: data.status ?? 'unknown',
          daysLeft: data.daysLeft ?? null,
          loaded: true,
        })
      } catch {
        setInfo(prev => ({ ...prev, loaded: true }))
      }
    })
  }, [])

  return info
}

export function useFeature(feature: string): { allowed: boolean; loaded: boolean; tier: 'standard' | 'pro' } {
  const sub = useSubscription()
  const allowed = sub.hasAccess && tierHasFeature(sub.tier, feature)
  return { allowed, loaded: sub.loaded, tier: sub.tier }
}
