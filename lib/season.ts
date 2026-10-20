// Helpers for NBA season ids like '2026-27' (see CURRENT_SEASON in ./constants).

/** Shift a season id by whole seasons: shiftSeason('2026-27', -1) → '2025-26'. */
export function shiftSeason(season: string, offset: number): string {
  const start = parseInt(season.slice(0, 4), 10) + offset
  return `${start}-${String(start + 1).slice(-2)}`
}

/** Inclusive game_date window for a season id (Oct 1 → Sep 30), as YYYY-MM-DD. */
export function seasonDateRange(season: string): { start: string; end: string } {
  const start = parseInt(season.slice(0, 4), 10)
  return { start: `${start}-10-01`, end: `${start + 1}-09-30` }
}

export const SEASON_ID_RE = /^\d{4}-\d{2}$/

/** Below this many current-season games, season averages are too noisy to trust;
 *  fall back to last season's row until the player has a real sample. */
export const MIN_CURRENT_SEASON_GAMES = 5

/**
 * Pick one season-stats row per player: the current season once it has
 * MIN_CURRENT_SEASON_GAMES games, otherwise the previous season if present,
 * otherwise whatever current-season row exists. Rows from other seasons are ignored.
 */
export function pickSeasonRows<T extends { player_name: string; season: string; games_played: number | null }>(
  rows: T[],
  currentSeason: string,
): Map<string, T> {
  const prevSeason = shiftSeason(currentSeason, -1)
  const cur = new Map<string, T>()
  const prev = new Map<string, T>()
  for (const r of rows) {
    if (r.season === currentSeason) cur.set(r.player_name, r)
    else if (r.season === prevSeason) prev.set(r.player_name, r)
  }
  const out = new Map<string, T>()
  for (const name of new Set([...cur.keys(), ...prev.keys()])) {
    const c = cur.get(name)
    const p = prev.get(name)
    if (c && (c.games_played ?? 0) >= MIN_CURRENT_SEASON_GAMES) out.set(name, c)
    else if (p) out.set(name, p)
    else if (c) out.set(name, c)
  }
  return out
}
