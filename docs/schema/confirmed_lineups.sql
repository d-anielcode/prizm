-- confirmed_lineups: per-team starting lineup data scraped from rotowire.com.
--
-- Populated by /api/lineups/fetch (cron 22:30 UTC daily). One row per team
-- per game date. Upsert key (game_date, team).
--
-- Used by:
--   - lib/lineups.ts:lineupContextFor (planned Phase 2 — wire into ScoringContext)
--   - Future UI: show "confirmed/expected/projected" badge on prop cards
--
-- Run once in Supabase SQL editor.

create table if not exists confirmed_lineups (
  game_date    date not null,
  team         text not null,
  status       text not null check (status in ('confirmed','expected','projected','unknown')),
  starters     jsonb not null,           -- [{name, pos, player_url}]  — up to 5 entries
  may_not_play jsonb not null default '[]'::jsonb,  -- ["Player Name", ...]
  fetched_at   timestamptz not null default now(),
  primary key (game_date, team)
);

create index if not exists idx_lineups_team_date on confirmed_lineups (team, game_date desc);
create index if not exists idx_lineups_date on confirmed_lineups (game_date desc);

-- Optional: row-level retention (keep ~60 days)
-- delete from confirmed_lineups where game_date < current_date - interval '60 days';
