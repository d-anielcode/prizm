-- WNBA props pipeline (SP1a): exact mirrors of the NBA prop tables.
-- CREATE TABLE ... LIKE ... INCLUDING ALL copies columns, defaults, indexes,
-- constraints. Purely additive — no NBA table is touched.
CREATE TABLE IF NOT EXISTS wnba_props        (LIKE props        INCLUDING ALL);
CREATE TABLE IF NOT EXISTS wnba_prop_alts    (LIKE prop_alts    INCLUDING ALL);
CREATE TABLE IF NOT EXISTS wnba_prop_history (LIKE prop_history INCLUDING ALL);
