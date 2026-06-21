// /api/grade/wnba — grades WNBA props (wnba_prop_history + wnba_player_game_logs
// -> wnba_prop_grades). Same implementation as /api/grade, bound to WNBA (no
// confidence-label requirement — WNBA props are unscored).
import { gradeLeague, GRADE_CONFIGS } from '@/lib/grade'

export const maxDuration = 120

export async function POST(req: Request) {
  return gradeLeague(req, GRADE_CONFIGS.wnba)
}
export async function GET(req: Request) {
  return gradeLeague(req, GRADE_CONFIGS.wnba)
}
