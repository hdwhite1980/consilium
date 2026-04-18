'use client'

import { useRouter } from 'next/navigation'
import { Lock } from 'lucide-react'

interface UpgradeGateProps {
  feature: string
  featureName: string
  description: string
  children: React.ReactNode
  allowed: boolean
  loaded: boolean
}

export function UpgradeGate({ feature, featureName, description, children, allowed, loaded }: UpgradeGateProps) {
  const router = useRouter()

  // While loading, show children (avoids flicker on Pro users)
  if (!loaded || allowed) return <>{children}</>

  return (
    <div className="relative min-h-screen flex flex-col" style={{ background: 'var(--bg)' }}>
      {/* Blurred content preview */}
      <div className="opacity-20 pointer-events-none select-none blur-sm flex-1 overflow-hidden max-h-96">
        {children}
      </div>

      {/* Upgrade overlay */}
      <div className="absolute inset-0 flex items-center justify-center p-6">
        <div className="w-full max-w-sm rounded-2xl p-8 text-center"
          style={{ background: 'var(--surface)', border: '1px solid rgba(167,139,250,0.3)' }}>
          <div className="w-12 h-12 rounded-full flex items-center justify-center mx-auto mb-4"
            style={{ background: 'rgba(167,139,250,0.12)', border: '1px solid rgba(167,139,250,0.25)' }}>
            <Lock size={20} style={{ color: '#a78bfa' }} />
          </div>

          <div className="text-[10px] font-mono uppercase tracking-widest mb-2" style={{ color: '#a78bfa' }}>
            Pro feature
          </div>
          <h2 className="text-lg font-bold text-white mb-2">{featureName}</h2>
          <p className="text-sm mb-6" style={{ color: 'var(--text3)' }}>{description}</p>

          <button
            onClick={() => router.push('/subscribe')}
            className="w-full py-3 rounded-xl text-sm font-bold text-white mb-3 transition-all hover:opacity-90"
            style={{ background: 'linear-gradient(135deg,#7c3aed,#4f46e5)' }}>
            Upgrade to Pro — $49/month
          </button>
          <button
            onClick={() => router.push('/')}
            className="w-full py-2 text-xs transition-all hover:opacity-70"
            style={{ color: 'var(--text3)' }}>
            Back to analysis
          </button>

          <p className="text-[11px] mt-4" style={{ color: 'var(--text3)' }}>
            7-day free trial includes full Pro access
          </p>
        </div>
      </div>
    </div>
  )
}
