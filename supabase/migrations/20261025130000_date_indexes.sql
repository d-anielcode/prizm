-- Date indexes for the columns every page, cron and pipeline step filters or sorts on.
-- 2026-10-24: `prop_history ... order by game_date desc` (151k rows) hit the statement
-- timeout; per-date reads (results, grading, status page) scan without these.
-- Additive and idempotent. Apply in the Supabase SQL editor (tables are small enough
-- that a plain CREATE INDEX finishes in seconds).
CREATE INDEX IF NOT EXISTS prop_history_game_date_idx     ON prop_history (game_date);
CREATE INDEX IF NOT EXISTS prop_grades_game_date_idx      ON prop_grades (game_date);
CREATE INDEX IF NOT EXISTS player_game_logs_game_date_idx ON player_game_logs (game_date);
CREATE INDEX IF NOT EXISTS props_commence_time_idx        ON props (commence_time);
CREATE INDEX IF NOT EXISTS curated_parlays_game_date_idx  ON curated_parlays (game_date);
CREATE INDEX IF NOT EXISTS prop_results_date_idx          ON prop_results (date);
