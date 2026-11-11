/**
 * lib/supabase.ts — SERVER-ONLY Supabase client
 *
 * ⚠️  This file MUST only be imported from server components and API routes.
 *     It uses SUPABASE_SERVICE_KEY which bypasses Row-Level Security (RLS)
 *     and must never be bundled into client-side JavaScript.
 *
 * For client components that need Supabase (e.g. real-time subscriptions),
 * create a separate client there using NEXT_PUBLIC_SUPABASE_ANON_KEY.
 */

import { createClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const serviceKey  = process.env.SUPABASE_SERVICE_KEY
const anonKey     = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

if (!supabaseUrl) {
  throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL environment variable')
}

if (!serviceKey) {
  // Warn loudly — the app can still limp along using the anon key, but
  // RLS will be enforced and write operations may fail.
  logger.warn('SUPABASE_SERVICE_KEY is not set — falling back to anon key. Write routes may fail.')
}

if (!anonKey && !serviceKey) {
  throw new Error('Neither SUPABASE_SERVICE_KEY nor NEXT_PUBLIC_SUPABASE_ANON_KEY is set')
}

// Use service key (bypasses RLS) for server-side operations.
// Falls back to anon key only if service key is missing (dev/misconfiguration).
export const supabase = createClient(
  supabaseUrl,
  serviceKey ?? anonKey!,
  { auth: { persistSession: false, autoRefreshToken: false } }
)

/**
 * safeQuery — unwrap a Supabase query, throwing on error instead of silently
 * returning null data.  Usage:
 *
 *   const rows = await safeQuery(
 *     supabase.from('props').select('*').eq('active', true),
 *     'load active props'
 *   )
 *
 * Returns `data` (typed as T) on success.  On error, logs the context string
 * and throws so the caller's try/catch can handle it uniformly.
 */
export async function safeQuery<T = Record<string, unknown>[]>(
  query: PromiseLike<{ data: T | null; error: { message: string; code?: string } | null }>,
  context: string,
): Promise<T> {
  const { data, error } = await query
  if (error) {
    // Let callers catch table-not-exists (42P01) gracefully if they want
    if (error.code === '42P01') {
      logger.warn(`safeQuery [${context}]: table does not exist — returning empty`, { code: error.code })
      return [] as unknown as T
    }
    logger.error(`safeQuery [${context}]: ${error.message}`, { code: error.code })
    throw new Error(`Supabase query failed (${context}): ${error.message}`)
  }
  return (data ?? []) as T
}

/**
 * paginatedSelect — drains a Supabase query past the 1000-row PostgREST cap.
 *
 * Supabase silently truncates `.select()` at 1000 rows. Every call site that
 * needs a full-table scan has to loop with `.range(from, from + PAGE - 1)` and
 * stop when a page returns less than the page size. This helper centralizes
 * that loop so we can't accidentally use the wrong page size again (the
 * historical PAGE=2000 bug that silently dropped half the rows).
 *
 * Pass a builder that takes (from, to) and returns the supabase query — the
 * builder is invoked once per page so each call gets a fresh range.
 *
 *   const rows = await paginatedSelect<MyRow>(
 *     (from, to) => supabase.from('player_game_logs')
 *       .select('player_name, game_date, points')
 *       .gte('game_date', cutoff)
 *       .order('game_date', { ascending: false })
 *       .range(from, to),
 *     { context: 'load logs since cutoff' }
 *   )
 */
export async function paginatedSelect<T = Record<string, unknown>>(
  buildQuery: (from: number, to: number) => PromiseLike<{
    data: T[] | null
    error: { message: string; code?: string } | null
  }>,
  opts: { pageSize?: number; maxPages?: number; context?: string } = {},
): Promise<T[]> {
  const pageSize = opts.pageSize ?? 1000
  const maxPages = opts.maxPages ?? 100  // 100k row safety cap by default
  const context  = opts.context  ?? 'paginatedSelect'

  const out: T[] = []
  for (let page = 0; page < maxPages; page++) {
    const from = page * pageSize
    const to   = from + pageSize - 1
    const { data, error } = await buildQuery(from, to)
    if (error) {
      logger.error(`paginatedSelect [${context}]: ${error.message}`, { code: error.code })
      throw new Error(`Supabase query failed (${context}): ${error.message}`)
    }
    if (!data || data.length === 0) break
    out.push(...data)
    if (data.length < pageSize) break
    if (page === maxPages - 1) {
      logger.warn(`paginatedSelect [${context}]: hit maxPages=${maxPages} cap — results may be truncated`)
    }
  }
  return out
}

// Cache TTL: 1 hour in milliseconds — matches odds-api.io rate limit window
export const CACHE_TTL_MS = 1 * 60 * 60 * 1000

export function isCacheStale(cachedAt: string): boolean {
  const age = Date.now() - new Date(cachedAt).getTime()
  return age > CACHE_TTL_MS
}
