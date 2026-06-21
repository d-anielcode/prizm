// /api/grade — grades NBA props (prop_history + player_game_logs -> prop_grades).
// League-agnostic implementation lives in lib/grade.ts; this binds it to NBA.
import { gradeLeague, GRADE_CONFIGS } from '@/lib/grade'

export const maxDuration = 120

export async function POST(req: Request) {
  return gradeLeague(req, GRADE_CONFIGS.nba)
}
export async function GET(req: Request) {
  return gradeLeague(req, GRADE_CONFIGS.nba)
}
