/**
 * lib/api-auth.ts — Server-side authentication helpers for API routes.
 *
 * ## Cron / Admin route protection
 *
 * All routes that mutate data (props refresh, grade, enrich, gamelogs, etc.)
 * must call `requireCronAuth(req)` before doing any work.
 *
 * Vercel automatically sends `Authorization: Bearer <CRON_SECRET>` on every
 * scheduled cron request when CRON_SECRET is set in the Vercel environment.
 * Internal server-to-server fetch calls must pass the same header.
 *
 * Setup:
 *   1. Generate a secret:  openssl rand -base64 32
 *   2. Add to Vercel env:  CRON_SECRET=<value>  (server-only — no NEXT_PUBLIC_ prefix)
 *   3. Add to .env.local:  CRON_SECRET=<value>  (for local dev)
 *
 * ## Usage
 *
 *   import { requireCronAuth } from '@/lib/api-auth'
 *
 *   export async function GET(req: Request) {
 *     const authError = requireCronAuth(req)
 *     if (authError) return authError
 *     // ... your handler
 *   }
 */

import { NextResponse } from 'next/server'
import { logger } from '@/lib/logger'

/**
 * Returns a 401 NextResponse if the request lacks a valid CRON_SECRET bearer
 * token, or null if the request is authorized.
 *
 * Behaviour:
 * - If CRON_SECRET is not configured, every request is REJECTED to fail-closed.
 *   This prevents accidentally unprotected endpoints during misconfiguration.
 * - Timing-safe comparison is used to prevent timing attacks.
 */
export function requireCronAuth(req: Request): NextResponse | null {
  const secret = process.env.CRON_SECRET

  if (!secret) {
    // CRON_SECRET not configured — fail closed
    logger.error('CRON_SECRET env var is not set; rejecting all cron requests', {
      route: new URL(req.url).pathname,
    })
    return NextResponse.json(
      { error: 'Server misconfiguration: CRON_SECRET not set' },
      { status: 503 }
    )
  }

  const authHeader = req.headers.get('authorization') ?? ''
  const expected   = `Bearer ${secret}`

  // Constant-time comparison to prevent timing attacks
  if (!timingSafeEqual(authHeader, expected)) {
    const ip  = req.headers.get('x-forwarded-for') ?? req.headers.get('x-real-ip') ?? 'unknown'
    const path = new URL(req.url).pathname
    logger.warn('Unauthorized API request', { route: path, ip })
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  return null // authorized
}

/**
 * Constant-time string comparison — prevents timing-based secret extraction.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    // Still iterate to avoid early-exit timing signal
    let _dummy = 0
    for (let i = 0; i < b.length; i++) _dummy |= b.charCodeAt(i)
    return false
  }
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}

/**
 * Build an Authorization header value for internal server-to-server fetch
 * calls between API routes that require cron auth.
 *
 *   const headers = internalAuthHeaders()
 *   fetch('/api/feed/generate/streak', { headers })
 */
export function internalAuthHeaders(): Record<string, string> {
  const secret = process.env.CRON_SECRET
  if (!secret) return {}
  return { Authorization: `Bearer ${secret}` }
}
