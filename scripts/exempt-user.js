#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
// Consilium — Account exemption manager
// Usage:
//   node scripts/exempt-user.js add email@example.com
//   node scripts/exempt-user.js remove email@example.com
//   node scripts/exempt-user.js list
// ─────────────────────────────────────────────────────────────

const { createClient } = require('@supabase/supabase-js')

const SUPABASE_URL         = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('❌  Missing env vars: NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required')
  console.error('   Run: NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/exempt-user.js list')
  process.exit(1)
}

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
})

const [,, command, email] = process.argv

async function getUserByEmail(email) {
  const { data, error } = await admin.auth.admin.listUsers()
  if (error) throw new Error(`Failed to list users: ${error.message}`)
  const user = data.users.find(u => u.email === email)
  if (!user) throw new Error(`No user found with email: ${email}`)
  return user
}

async function exemptUser(email) {
  const user = await getUserByEmail(email)

  // Upsert subscription with exempt flag and Pro tier
  const { error } = await admin.from('subscriptions').upsert({
    user_id:    user.id,
    status:     'active',
    tier:       'pro',
    is_exempt:  true,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'user_id' })

  if (error) throw new Error(`Failed to exempt user: ${error.message}`)

  console.log(`✅  ${email} is now exempt — full Pro access, no payment required`)
}

async function unexemptUser(email) {
  const user = await getUserByEmail(email)

  const { error } = await admin.from('subscriptions').update({
    is_exempt:  false,
    tier:       'standard',
    updated_at: new Date().toISOString(),
  }).eq('user_id', user.id)

  if (error) throw new Error(`Failed to remove exemption: ${error.message}`)

  console.log(`✅  ${email} exemption removed — will need a paid subscription`)
}

async function listExempt() {
  const { data, error } = await admin
    .from('subscriptions')
    .select('user_id, tier, status, is_exempt, updated_at')
    .eq('is_exempt', true)

  if (error) throw new Error(`Failed to list exempt users: ${error.message}`)

  if (!data || data.length === 0) {
    console.log('No exempt users found.')
    return
  }

  // Get emails for all exempt user IDs
  const { data: users } = await admin.auth.admin.listUsers()
  const emailMap = Object.fromEntries((users?.users ?? []).map(u => [u.id, u.email]))

  console.log('\n── Exempt accounts ──────────────────────────────────────────')
  console.log(`${'Email'.padEnd(35)} ${'Tier'.padEnd(10)} ${'Status'.padEnd(12)} Updated`)
  console.log('─'.repeat(75))

  for (const row of data) {
    const email  = emailMap[row.user_id] ?? '(unknown)'
    const date   = new Date(row.updated_at).toLocaleDateString()
    console.log(`${email.padEnd(35)} ${(row.tier ?? '?').padEnd(10)} ${(row.status ?? '?').padEnd(12)} ${date}`)
  }
  console.log(`\nTotal: ${data.length} exempt account${data.length === 1 ? '' : 's'}`)
}

async function main() {
  if (!command) {
    console.log('Usage:')
    console.log('  node scripts/exempt-user.js add <email>      — Grant free Pro access')
    console.log('  node scripts/exempt-user.js remove <email>   — Remove exemption')
    console.log('  node scripts/exempt-user.js list              — Show all exempt accounts')
    process.exit(0)
  }

  try {
    switch (command) {
      case 'add':
        if (!email) { console.error('❌  Email required: node scripts/exempt-user.js add email@example.com'); process.exit(1) }
        await exemptUser(email)
        break
      case 'remove':
        if (!email) { console.error('❌  Email required: node scripts/exempt-user.js remove email@example.com'); process.exit(1) }
        await unexemptUser(email)
        break
      case 'list':
        await listExempt()
        break
      default:
        console.error(`❌  Unknown command: ${command}. Use add, remove, or list`)
        process.exit(1)
    }
  } catch (err) {
    console.error(`❌  ${err.message}`)
    process.exit(1)
  }
}

main()
