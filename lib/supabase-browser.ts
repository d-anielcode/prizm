/**
 * lib/supabase-browser.ts — CLIENT-SAFE Supabase client (anon key only).
 *
 * Use this in any file that has `'use client'` at the top, or that may end up
 * bundled into the browser. RLS is enforced — write operations only succeed
 * for tables/policies that explicitly allow the anon role.
 *
 * For server components, API routes, and crons, use `lib/supabase.ts` instead.
 * That client uses `SUPABASE_SERVICE_KEY` and bypasses RLS — it must never be
 * imported from a `'use client'` file.
 */

import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const anonKey     = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

if (!supabaseUrl) {
  throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL environment variable')
}

if (!anonKey) {
  throw new Error('Missing NEXT_PUBLIC_SUPABASE_ANON_KEY environment variable')
}

export const supabaseBrowser = createClient(supabaseUrl, anonKey, {
  auth: { persistSession: false, autoRefreshToken: false },
})
