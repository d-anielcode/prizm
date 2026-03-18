import { NextResponse } from 'next/server'

export async function GET() {
  const apiKey = process.env.ODDS_API_IO_KEY
  if (!apiKey) return NextResponse.json({ error: 'ODDS_API_IO_KEY not loaded' }, { status: 500 })

  // Fetch available leagues for basketball
  const res = await fetch(
    `https://api.odds-api.io/v3/leagues?apiKey=${apiKey}&sport=basketball`,
    { cache: 'no-store' }
  )
  const body = await res.text()

  return NextResponse.json({ status: res.status, body: JSON.parse(body) })
}
