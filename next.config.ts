import type { NextConfig } from 'next'

// Security headers applied to every response
const securityHeaders = [
  // Prevent clickjacking — page cannot be embedded in an iframe
  { key: 'X-Frame-Options', value: 'DENY' },

  // Prevent MIME-type sniffing attacks
  { key: 'X-Content-Type-Options', value: 'nosniff' },

  // Legacy XSS filter for older browsers
  { key: 'X-XSS-Protection', value: '1; mode=block' },

  // Tell browsers to always use HTTPS (1 year, include sub-domains)
  { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains; preload' },

  // Control referrer info sent to other sites
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },

  // Disable access to browser features not needed by this app
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
  },

  // Content Security Policy
  // - default-src 'self': only load resources from our own origin by default
  // - script-src: allow Next.js inline scripts (needed for hydration)
  // - img-src: allow data: URIs (for inline charts) + our own origin
  // - connect-src: allow fetch to Supabase and The Odds API (server-side only, but belt+suspenders)
  {
    key: 'Content-Security-Policy',
    value: [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'", // unsafe-eval needed by Next.js dev
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https://a.espncdn.com",
      "font-src 'self'",
      "connect-src 'self' https://*.supabase.co wss://*.supabase.co",
      "frame-ancestors 'none'",
    ].join('; '),
  },
]

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        // Apply to all routes
        source: '/:path*',
        headers: securityHeaders,
      },
    ]
  },
}

export default nextConfig
