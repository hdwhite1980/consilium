import Stripe from 'stripe'
import { createClient } from '@supabase/supabase-js'

export function getStripe() {
  return new Stripe(process.env.STRIPE_SECRET_KEY!, {
    apiVersion: '2024-11-20.acacia',
  })
}

// Admin Supabase client (bypasses RLS)
function getAdmin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

export const STRIPE_PRICE_ID = process.env.STRIPE_PRICE_ID!
export const APP_URL = process.env.NEXT_PUBLIC_APP_URL!

// ── Get or create a Stripe customer for a user ────────────────
export async function getOrCreateCustomer(userId: string, email: string): Promise<string> {
  const admin = getAdmin()

  // Check if already has a customer ID
  const { data } = await admin
    .from('subscriptions')
    .select('stripe_customer_id')
    .eq('user_id', userId)
    .single()

  if (data?.stripe_customer_id) return data.stripe_customer_id

  // Create new Stripe customer
  const stripe = getStripe()
  const customer = await stripe.customers.create({
    email,
    metadata: { supabase_user_id: userId },
  })

  // Upsert subscription row
  await admin.from('subscriptions').upsert({
    user_id: userId,
    stripe_customer_id: customer.id,
    status: 'incomplete',
    updated_at: new Date().toISOString(),
  }, { onConflict: 'user_id' })

  return customer.id
}

// ── Check if user has active access (trial or paid) ───────────
export async function hasActiveAccess(userId: string): Promise<{
  hasAccess: boolean
  status: string
  trialEndsAt: Date | null
  daysLeft: number | null
}> {
  const admin = getAdmin()
  const { data } = await admin
    .from('subscriptions')
    .select('status, trial_ends_at, current_period_end')
    .eq('user_id', userId)
    .single()

  if (!data) {
    // New user — create a trial
    const trialEndsAt = new Date()
    trialEndsAt.setDate(trialEndsAt.getDate() + 7)

    await admin.from('subscriptions').insert({
      user_id: userId,
      status: 'trialing',
      trial_ends_at: trialEndsAt.toISOString(),
    })

    return {
      hasAccess: true,
      status: 'trialing',
      trialEndsAt,
      daysLeft: 7,
    }
  }

  const now = new Date()

  if (data.status === 'trialing') {
    const trialEnd = data.trial_ends_at ? new Date(data.trial_ends_at) : null
    const hasAccess = trialEnd ? trialEnd > now : false
    const daysLeft = trialEnd
      ? Math.max(0, Math.ceil((trialEnd.getTime() - now.getTime()) / 86400000))
      : 0
    return { hasAccess, status: 'trialing', trialEndsAt: trialEnd, daysLeft }
  }

  if (data.status === 'active') {
    return { hasAccess: true, status: 'active', trialEndsAt: null, daysLeft: null }
  }

  return { hasAccess: false, status: data.status, trialEndsAt: null, daysLeft: null }
}

// ── Sync subscription from Stripe webhook ────────────────────
export async function syncSubscription(stripeSubId: string) {
  const stripe = getStripe()
  const admin = getAdmin()

  const sub = await stripe.subscriptions.retrieve(stripeSubId)
  const customerId = sub.customer as string

  // Find user by customer ID
  const { data: subRow } = await admin
    .from('subscriptions')
    .select('user_id')
    .eq('stripe_customer_id', customerId)
    .single()

  if (!subRow) return

  await admin.from('subscriptions').update({
    stripe_sub_id: sub.id,
    status: sub.status,
    current_period_end: new Date(sub.current_period_end * 1000).toISOString(),
    trial_ends_at: sub.trial_end
      ? new Date(sub.trial_end * 1000).toISOString()
      : null,
    updated_at: new Date().toISOString(),
  }).eq('user_id', subRow.user_id)
}
