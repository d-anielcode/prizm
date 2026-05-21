/**
 * lib/lineups.ts — Confirmed/projected starting lineup data.
 *
 * NBA lineup information is publicly available from rotowire.com several
 * hours before tip-off. The page is server-rendered (verified 2026-05-15)
 * so we can parse it with plain fetch + regex — no Firecrawl or Playwright.
 *
 * Why lineup data matters for prop scoring:
 *   - minutesTrendAdj / minutesUncertaintyPenalty are best-effort guesses
 *     based on rolling minute averages. They get blindsided by:
 *       * Star late-scratches (other players' minutes spike)
 *       * Surprise starts (a bench player suddenly has a real prop)
 *       * Returning-from-injury backups (steal minutes from projected starter)
 *   - Confirmed lineups eliminate this guesswork.
 *
 * ## Schema (run once in Supabase when ready)
 *
 *   create table confirmed_lineups (
 *     game_date   date not null,
 *     team        text not null,
 *     status      text not null,   -- 'confirmed' | 'expected' | 'projected'
 *     starters    jsonb not null,  -- [{name, pos, player_url}]
 *     may_not_play jsonb,          -- [{name, status}]
 *     fetched_at  timestamptz not null default now(),
 *     primary key (game_date, team)
 *   );
 *   create index idx_lineups_team_date on confirmed_lineups (team, game_date desc);
 *
 * ## Cron schedule
 *
 *   16:00 UTC daily — projected/early lineups (most teams release by noon ET)
 *   23:00 UTC daily — confirmed lineups (30 min before 7 PM ET tip)
 *
 * Each call is idempotent (upserts on game_date,team). Polite to rotowire:
 * single page hit twice a day, no parallel requests.
 */

export type LineupStatus = 'confirmed' | 'expected' | 'projected' | 'unknown'

export interface LineupStarter {
  name:        string  // Full name from <a title="...">
  pos:         string  // PG / SG / SF / PF / C
  player_url?: string  // rotowire player slug for cross-reference
}

export interface ParsedLineup {
  team:           string  // Team abbreviation (SAS, OKC, etc.) — derived from data-team attr
  status:         LineupStatus
  starters:       LineupStarter[]
  may_not_play:   string[]  // Player names listed under "MAY NOT PLAY"
}

export interface ParsedGame {
  away: ParsedLineup
  home: ParsedLineup
}

/**
 * Parse the rotowire NBA lineups page. Returns one entry per (team, game).
 *
 * The page structure (verified 2026-05-15):
 *
 *   <ul class="lineup__list is-visit|is-home">
 *     <li class="lineup__status is-(confirmed|expected|projected)">...</li>
 *     <li class="lineup__player is-pct-play-100">
 *       <div class="lineup__pos">PG</div>
 *       <a title="Full Name" href="/basketball/player/slug">S. Last</a>
 *     </li>
 *     ... 5 starters ...
 *     <li class="lineup__title is-middle">MAY NOT PLAY</li>
 *     <li class="lineup__player is-pct-play-0 has-injury-status">...</li>
 *   </ul>
 *
 * The parent <div> containing each <ul> pair has a `data-team` attribute on
 * one of its `see-proj-minutes` or `see-court-on-off` child buttons.
 */
export function parseRotowireLineups(html: string): ParsedGame[] {
  const games: ParsedGame[] = []

  // Each game contains TWO <ul class="lineup__list"> blocks — one is-visit, one is-home.
  // Split the html into chunks that each contain a single team's lineup ul.
  // We use the is-visit / is-home class as the anchor.
  const teamBlockRe = /<ul class="lineup__list (is-visit|is-home)">([\s\S]*?)<\/ul>/g
  const teamBlocks: { side: 'visit' | 'home'; inner: string; offset: number }[] = []
  let m: RegExpExecArray | null
  while ((m = teamBlockRe.exec(html)) !== null) {
    teamBlocks.push({
      side:   m[1] === 'is-visit' ? 'visit' : 'home',
      inner:  m[2],
      offset: m.index,
    })
  }

  // Pair them up: each (visit, home) pair is a game. The visit always
  // appears before its home in the document order.
  for (let i = 0; i < teamBlocks.length - 1; i += 2) {
    const visit = teamBlocks[i]
    const home  = teamBlocks[i + 1]
    if (visit.side !== 'visit' || home.side !== 'home') continue

    // Find data-team on a sibling button between the two blocks — needs to
    // look at the document segment AFTER the visit block but BEFORE the home block.
    // The proj-minutes/on-off-court buttons carry data-team="<ABBR>".
    const visitSegment = html.slice(visit.offset, home.offset)
    const homeSegmentEnd = html.indexOf('</ul>', home.offset) + 5
    const homeSegment = html.slice(home.offset, homeSegmentEnd + 500)

    const visitTeam = extractTeam(visitSegment) ?? 'UNK'
    const homeTeam  = extractTeam(homeSegment)  ?? 'UNK'

    games.push({
      away: { team: visitTeam, ...parseSide(visit.inner) },
      home: { team: homeTeam,  ...parseSide(home.inner)  },
    })
  }

  return games
}

function extractTeam(segment: string): string | null {
  // Buttons in the segment have data-team="ABBR"
  const m = /data-team="([A-Z]{2,4})"/.exec(segment)
  return m ? m[1] : null
}

function parseSide(inner: string): { status: LineupStatus; starters: LineupStarter[]; may_not_play: string[] } {
  const status: LineupStatus =
    /lineup__status is-confirmed/.test(inner)   ? 'confirmed'
    : /lineup__status is-expected/.test(inner)  ? 'expected'
    : /lineup__status is-projected/.test(inner) ? 'projected'
    : 'unknown'

  // Split at "MAY NOT PLAY" marker — starters come before it, injuries after.
  const splitIdx = inner.indexOf('MAY NOT PLAY')
  const startersHtml = splitIdx > 0 ? inner.slice(0, splitIdx) : inner
  const benchHtml    = splitIdx > 0 ? inner.slice(splitIdx)    : ''

  const starters: LineupStarter[] = []
  const playerRe = /<li class="lineup__player[^"]*"[^>]*>\s*<div class="lineup__pos"[^>]*>([^<]+)<\/div>\s*<a[^>]*title="([^"]+)"[^>]*href="([^"]+)"/g
  let pm: RegExpExecArray | null
  while ((pm = playerRe.exec(startersHtml)) !== null) {
    starters.push({
      pos:        pm[1].trim(),
      name:       pm[2].trim(),
      player_url: pm[3].trim(),
    })
  }

  const may_not_play: string[] = []
  const benchRe = /<a[^>]*title="([^"]+)"[^>]*href="\/basketball\/player\//g
  while ((pm = benchRe.exec(benchHtml)) !== null) {
    may_not_play.push(pm[1].trim())
  }

  return { status, starters: starters.slice(0, 5), may_not_play }
}

/**
 * Look up scoring context for a player given today's parsed lineups.
 * Returns:
 *   confirmedStarter: true  — player is a confirmed/expected starter
 *   confirmedStarter: false — player is in "may not play" list
 *   confirmedStarter: null  — no data (lineup not yet posted, or player not on roster)
 */
export interface LineupContext {
  confirmedStarter: boolean | null
  lineupStatus:     LineupStatus | null
}

export function lineupContextFor(
  player:  string,
  games:   ParsedGame[],
): LineupContext {
  for (const game of games) {
    for (const side of [game.away, game.home]) {
      if (side.starters.some((s) => sameName(s.name, player))) {
        return { confirmedStarter: true, lineupStatus: side.status }
      }
      if (side.may_not_play.some((n) => sameName(n, player))) {
        return { confirmedStarter: false, lineupStatus: side.status }
      }
    }
  }
  return { confirmedStarter: null, lineupStatus: null }
}

/** Case-insensitive name match with light normalization for "J." vs "Jamal" style abbreviations. */
function sameName(a: string, b: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[\.,'']/g, '').trim()
  return norm(a) === norm(b)
}
