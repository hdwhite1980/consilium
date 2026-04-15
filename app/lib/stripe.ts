import Stripe from 'stripe'
import { createClient } from '@supabase/supabase-js'

export function getStripe() {
  return new Stripe(process.env.STRIPE_SECRET_KEY!, {
    apiVersion: '2026-03-25.dahlia',
  })
}

function getAdmin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

export const APP_URL = process.env.NEXT_PUBLIC_APP_URL!

// ── Price IDs ─────────────────────────────────────────────────
export const PRICE_IDS = {
  standard: process.env.STRIPE_STANDARD_PRICE_ID!,
  pro:      process.env.STRIPE_PRO_PRICE_ID!,
}

// Legacy single-price support (existing subscribers)
export const STRIPE_PRICE_ID = process.env.STRIPE_PRICE_ID

// ── Feature gates ─────────────────────────────────────────────
// Maps features to the minimum tier required
export const FEATURE_TIERS: Record<string, 'standard' | 'pro'> = {
  analysis:       'standard',
  portfolio:      'standard',
  macro:          'standard',
  today:          'standard',
  tomorrow:       'standard',
  training:       'standard',
  compare:        'pro',
  reinvestment:   'pro',
  forex:          'pro',
  historyExport:  'pro',
}

const TIER_RANK: Record<string, number> = { standard: 1, pro: 2 }

export function tierHasFeature(tier: string, feature: string): boolean {
  const required = FEATURE_TIERS[feature]
  if (!required) return true // unknown feature = allowed
  return (TIER_RANK[tier] ?? 0) >= (TIER_RANK[required] ?? 999)
}

// ── Get or create Stripe customer ────────────────────────────
export async function getOrCreateCustomer(userId: string, email: string): Promise<string> {
  const admin = getAdmin()
  const { data } = await admin
    .from('subscriptions')
    .select('stripe_customer_id')
    .eq('user_id', userId)
    .single()

  if (data?.stripe_customer_id) return data.stripe_customer_id

  const stripe = getStripe()
  const customer = await stripe.customers.create({
    email,
    metadata: { supabase_user_id: userId },
  })

  await admin.from('subscriptions').upsert({
    user_id: userId,
    stripe_customer_id: customer.id,
    status: 'incomplete',
    tier: 'standard',
    updated_at: new Date().toISOString(),
  }, { onConflict: 'user_id' })

  return customer.id
}

// ── Check access + tier ───────────────────────────────────────
export async function hasActiveAccess(userId: string): Promise<{
  hasAccess: boolean
  status: string
  tier: 'standard' | 'pro'
  trialEndsAt: Date | null
  daysLeft: number | null
}> {
  const admin = getAdmin()
  const { data } = await admin
    .from('subscriptions')
    .select('status, tier, trial_ends_at, current_period_end')
    .eq('user_id', userId)
    .single()

  if (!data) {
    const trialEndsAt = new Date()
    trialEndsAt.setDate(trialEndsAt.getDate() + 7)
    await admin.from('subscriptions').insert({
      user_id: userId,
      status: 'trialing',
      tier: 'standard',
      trial_ends_at: trialEndsAt.toISOString(),
    })
    return { hasAccess: true, status: 'trialing', tier: 'standard', trialEndsAt, daysLeft: 7 }
  }

  const now = new Date()
  const tier = (data.tier ?? 'standard') as 'standard' | 'pro'

  if (data.status === 'trialing') {
    const trialEnd = data.trial_ends_at ? new Date(data.trial_ends_at) : null
    const hasAccess = trialEnd ? trialEnd > now : false
    const daysLeft = trialEnd
      ? Math.max(0, Math.ceil((trialEnd.getTime() - now.getTime()) / 86400000))
      : 0
    // During trial, give access to all features (pro trial)
    return { hasAccess, status: 'trialing', tier: 'pro', trialEndsAt: trialEnd, daysLeft }
  }

  if (data.status === 'active') {
    return { hasAccess: true, status: 'active', tier, trialEndsAt: null, daysLeft: null }
  }

  return { hasAccess: false, status: data.status, tier: 'standard', trialEndsAt: null, daysLeft: null }
}

// ── Feature check for a user ──────────────────────────────────
export async function userHasFeature(userId: string, feature: string): Promise<boolean> {
  const { hasAccess, tier } = await hasActiveAccess(userId)
  if (!hasAccess) return false
  return tierHasFeature(tier, feature)
}

// ── Sync subscription from Stripe webhook ────────────────────
export async function syncSubscription(stripeSubId: string) {
  const stripe = getStripe()
  const admin = getAdmin()

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sub = await stripe.subscriptions.retrieve(stripeSubId) as any
  const customerId = (sub.customer?.id ?? sub.customer) as string

  const { data: subRow } = await admin
    .from('subscriptions')
    .select('user_id')
    .eq('stripe_customer_id', customerId)
    .single()

  if (!subRow) return

  // Determine tier from the price ID on the subscription
  const priceId = sub.items?.data?.[0]?.price?.id ?? ''
  let tier = 'standard'
  if (priceId === process.env.STRIPE_PRO_PRICE_ID) tier = 'pro'
  // Legacy $19 price → standard
  if (priceId === process.env.STRIPE_PRICE_ID) tier = 'standard'

  const periodEnd = sub.current_period_end ?? sub.billing_cycle_anchor
  const trialEnd  = sub.trial_end ?? null

  await admin.from('subscriptions').update({
    stripe_sub_id: sub.id,
    status: sub.status,
    tier,
    current_period_end: periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
    trial_ends_at: trialEnd ? new Date(trialEnd * 1000).toISOString() : null,
    updated_at: new Date().toISOString(),
  }).eq('user_id', subRow.user_id)
}
