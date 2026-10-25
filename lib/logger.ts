/**
 * lib/logger.ts — Centralized structured logging for server-side API routes.
 *
 * Outputs newline-delimited JSON so Vercel log drains / Datadog / etc.
 * can parse fields without regexing plain text.
 *
 * Usage:
 *   import { logger } from '@/lib/logger'
 *   logger.info('[/api/grade] Graded 42 props', { route: '/api/grade', count: 42 })
 *   logger.warn('[/api/props] Unauthorized request', { ip: req.headers.get('x-forwarded-for') })
 *   logger.error('[/api/enrich] Fatal', { route: '/api/enrich', err: e.message })
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error'

interface LogEntry {
  level: LogLevel
  ts: string
  msg: string
  [key: string]: unknown
}

function emit(level: LogLevel, msg: string, meta?: Record<string, unknown>): void {
  const entry: LogEntry = {
    level,
    ts: new Date().toISOString(),
    msg,
    ...meta,
  }
  const serialized = JSON.stringify(entry)
  switch (level) {
    case 'error': console.error(serialized); break
    case 'warn':  console.warn(serialized);  break
    default:      console.log(serialized);   break
  }
}

export const logger = {
  debug: (msg: string, meta?: Record<string, unknown>) => emit('debug', msg, meta),
  info:  (msg: string, meta?: Record<string, unknown>) => emit('info',  msg, meta),
  warn:  (msg: string, meta?: Record<string, unknown>) => emit('warn',  msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => emit('error', msg, meta),
}

/** Log an API error + return a standard 500 response payload */
export function logAndError(route: string, err: unknown): { error: string } {
  const message = err instanceof Error ? err.message : String(err)
  logger.error(`[${route}] Unhandled error`, { route, err: message })
  return { error: message }
}
