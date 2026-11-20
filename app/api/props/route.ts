// /api/props — NBA player props (fetch + cache + snapshot). The league-agnostic
// implementation lives in lib/props-refresh.ts; this route binds it to the NBA config.
import { handlePropsRequest, LEAGUE_PROP_CONFIGS } from '@/lib/props-refresh'

export const maxDuration = 60

export async function GET(req: Request) {
  return handlePropsRequest(req, LEAGUE_PROP_CONFIGS.nba)
}
