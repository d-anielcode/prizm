-- WNBA grading (SP2): mirror of prop_grades. Additive — no NBA table touched.
-- LIKE doesn't copy GRANTs, so grant explicitly.
CREATE TABLE IF NOT EXISTS wnba_prop_grades (LIKE prop_grades INCLUDING ALL);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.wnba_prop_grades TO service_role;
GRANT SELECT ON public.wnba_prop_grades TO anon, authenticated;
