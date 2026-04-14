import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/app/lib/auth/server'
import { getStripe, getOrCreateCustomer, STRIPE_PRICE_ID, APP_URL } from '@/app/lib/stripe'

export async function POST(req: NextRequest) {
  try {
    // Check env vars first
    if (!process.env.STRIPE_SECRET_KEY) return NextResponse.json({ error: 'STRIPE_SECRET_KEY not configured' }, { status: 500 })
    if (!process.env.STRIPE_PRICE_ID) return NextResponse.json({ error: 'STRIPE_PRICE_ID not configured' }, { status: 500 })
    if (!process.env.NEXT_PUBLIC_APP_URL) return NextResponse.json({ error: 'NEXT_PUBLIC_APP_URL not configured' }, { status: 500 })

    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()

    if (!user) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

    const stripe = getStripe()
    const customerId = await getOrCreateCustomer(user.id, user.email!)

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      payment_method_types: ['card'],
      mode: 'subscription',
      line_items: [{
        price: STRIPE_PRICE_ID,
        quantity: 1,
      }],
      subscription_data: {
        trial_period_days: 7,
      },
      success_url: `${APP_URL}/?subscription=success`,
      cancel_url: `${APP_URL}/subscribe?canceled=true`,
      allow_promotion_codes: true,
    })

    return NextResponse.json({ url: session.url })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    console.error('Stripe checkout error:', message)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
