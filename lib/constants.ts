/** The current NBA season identifier, used across routes and pages.
 *  NBA seasons start in October — e.g. Oct 2025 through Jun 2026 = '2025-26'. */
function getNbaSeason(): string {
  const now = new Date()
  const year = now.getFullYear()
  const month = now.getMonth() + 1 // 1-indexed
  // Before October → still the previous season (e.g. Apr 2026 → '2025-26')
  const startYear = month >= 10 ? year : year - 1
  return `${startYear}-${String(startYear + 1).slice(-2)}`
}
export const CURRENT_SEASON = getNbaSeason()
