-- WNBA props pipeline (SP1a): exact mirrors of the NBA prop tables.
-- CREATE TABLE ... LIKE ... INCLUDING ALL copies columns, defaults, indexes,
-- constraints. Purely additive — no NBA table is touched.
CREATE TABLE IF NOT EXISTS wnba_props        (LIKE props        INCLUDING ALL);
CREATE TABLE IF NOT EXISTS wnba_prop_alts    (LIKE prop_alts    INCLUDING ALL);
CREATE TABLE IF NOT EXISTS wnba_prop_history (LIKE prop_history INCLUDING ALL);

-- LIKE does NOT copy GRANTs, so PostgREST roles get no access by default.
-- Cron (service key) needs full read/write; the public API roles get read-only
-- (these tables are written server-side only). Tighten/loosen to match the NBA
-- tables' posture if it differs.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.wnba_props, public.wnba_prop_alts, public.wnba_prop_history TO service_role;
GRANT SELECT ON public.wnba_props, public.wnba_prop_alts, public.wnba_prop_history TO anon, authenticated;
