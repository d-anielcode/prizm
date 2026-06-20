-- WNBA stats pipeline (SP1b): mirrors of the NBA stat tables. Additive — no NBA
-- table is touched. LIKE does NOT copy GRANTs, so they are granted explicitly.
CREATE TABLE IF NOT EXISTS wnba_player_game_logs  (LIKE player_game_logs  INCLUDING ALL);
CREATE TABLE IF NOT EXISTS wnba_team_defense_stats (LIKE team_defense_stats INCLUDING ALL);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.wnba_player_game_logs, public.wnba_team_defense_stats TO service_role;
GRANT SELECT ON public.wnba_player_game_logs, public.wnba_team_defense_stats TO anon, authenticated;
