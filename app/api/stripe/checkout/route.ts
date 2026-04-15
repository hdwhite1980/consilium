import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/app/lib/auth/server'
import { getStripe, getOrCreateCustomer, PRICE_IDS, APP_URL } from '@/app/lib/stripe'

export async function POST(req: NextRequest) {
  try {
    if (!process.env.STRIPE_SECRET_KEY)         return NextResponse.json({ error: 'STRIPE_SECRET_KEY not configured' }, { status: 500 })
    if (!process.env.STRIPE_STANDARD_PRICE_ID)  return NextResponse.json({ error: 'STRIPE_STANDARD_PRICE_ID not configured' }, { status: 500 })
    if (!process.env.STRIPE_PRO_PRICE_ID)        return NextResponse.json({ error: 'STRIPE_PRO_PRICE_ID not configured' }, { status: 500 })
    if (!process.env.NEXT_PUBLIC_APP_URL)        return NextResponse.json({ error: 'NEXT_PUBLIC_APP_URL not configured' }, { status: 500 })

    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

    const body = await req.json().catch(() => ({}))
    const tier = body.tier === 'pro' ? 'pro' : 'standard'
    const priceId = PRICE_IDS[tier]

    const stripe = getStripe()
    const customerId = await getOrCreateCustomer(user.id, user.email!)

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      payment_method_types: ['card'],
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      subscription_data: { trial_period_days: 7 },
      success_url: `${APP_URL}/?subscription=success&tier=${tier}`,
      cancel_url: `${APP_URL}/subscribe?canceled=true`,
      allow_promotion_codes: true,
      metadata: { tier },
    })

    return NextResponse.json({ url: session.url })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    console.error('Stripe checkout error:', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
