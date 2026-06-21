// /api/props/wnba — WNBA player props. Same implementation as /api/props,
// bound to the WNBA league config (writes wnba_props / wnba_prop_alts).
import { handlePropsRequest, LEAGUE_PROP_CONFIGS } from '@/lib/props-refresh'

export const maxDuration = 60

export async function GET(req: Request) {
  return handlePropsRequest(req, LEAGUE_PROP_CONFIGS.wnba)
}
