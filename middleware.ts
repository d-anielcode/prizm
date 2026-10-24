/**
 * middleware.ts — Edge middleware for Prizm
 *
 * Runs on every request BEFORE it reaches a route handler.
 * Responsibilities:
 *  1. Log all API requests (method, path, IP) for audit trail
 *  2. Block obviously malformed requests early
 *  3. Add request-ID header for log correlation
 *
 * NOTE: Auth for cron/admin endpoints is enforced IN the route handlers
 * via requireCronAuth() from lib/api-auth.ts — not here — because middleware
 * runs on the Edge runtime which does not have access to all Node.js APIs.
 */

import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

export function middleware(req: NextRequest): NextResponse {
  const { pathname, search } = req.nextUrl
  const method   = req.method
  const ip       = req.headers.get('x-forwarded-for') ?? req.headers.get('x-real-ip') ?? 'unknown'
  const ua       = req.headers.get('user-agent') ?? ''

  // Generate a short request ID for log correlation
  const reqId = Math.random().toString(36).slice(2, 10)

  // ── Log API requests ─────────────────────────────────────────────────────────
  if (pathname.startsWith('/api/')) {
    const isCron = req.headers.get('x-vercel-cron') === '1'

    // Structured JSON log — parsed by Vercel log drains
    const entry = JSON.stringify({
      level:   'info',
      ts:      new Date().toISOString(),
      msg:     'api_request',
      reqId,
      method,
      path:    pathname + search,
      ip,
      isCron,
      ua:      ua.slice(0, 120), // truncate long UAs
    })
    console.log(entry)

    // Warn on suspicious write-method requests coming from non-cron sources
    if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(method) && !isCron) {
      const warnEntry = JSON.stringify({
        level:  'warn',
        ts:     new Date().toISOString(),
        msg:    'non_cron_write_attempt',
        reqId,
        method,
        path:   pathname + search,
        ip,
        ua:     ua.slice(0, 120),
      })
      console.warn(warnEntry)
    }
  }

  const res = NextResponse.next()

  // Attach request ID to response headers for log correlation
  res.headers.set('x-request-id', reqId)

  return res
}

export const config = {
  // Match all paths except static assets and Next.js internals
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
