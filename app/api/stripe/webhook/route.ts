import { NextRequest, NextResponse } from 'next/server'
import { getStripe, syncSubscription } from '@/app/lib/stripe'

export async function POST(req: NextRequest) {
  const body = await req.text()
  const sig  = req.headers.get('stripe-signature')!

  let event
  try {
    const stripe = getStripe()
    event = stripe.webhooks.constructEvent(body, sig, process.env.STRIPE_WEBHOOK_SECRET!)
  } catch (err) {
    console.error('Webhook signature failed:', err)
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 })
  }

  // Sync on any subscription change
  const subEvents = [
    'customer.subscription.created',
    'customer.subscription.updated',
    'customer.subscription.deleted',
    'customer.subscription.trial_will_end',
  ]

  if (subEvents.includes(event.type)) {
    const sub = event.data.object as { id: string }
    await syncSubscription(sub.id)
  }

  return NextResponse.json({ received: true })
}
