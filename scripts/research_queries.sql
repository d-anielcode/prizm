-- =============================================================================
-- RESEARCH QUERIES FOR CONFIDENCE MODEL VALIDATION
-- Run these in Supabase SQL Editor to gather data for research items T1-T8.
-- =============================================================================


-- ─── T1: HELD-OUT WEIGHT VALIDATION ──────────────────────────────────────────
-- Split graded props into 80% train / 20% test by date (time-series split).
-- Use the train set to re-run weight optimizer; evaluate on test set.

-- Step 1: Find the 80th percentile date
SELECT game_date
FROM prop_grades
WHERE result IN ('hit', 'miss')
ORDER BY game_date
LIMIT 1
OFFSET (SELECT FLOOR(COUNT(*) * 0.80) FROM prop_grades WHERE result IN ('hit', 'miss'));

-- Step 2: Export train set (for Python optimizer)
-- Replace YYYY-MM-DD with the date from Step 1
-- COPY (
--   SELECT * FROM prop_grades
--   WHERE result IN ('hit', 'miss') AND game_date <= 'YYYY-MM-DD'
-- ) TO '/tmp/train_set.csv' WITH CSV HEADER;

-- Step 3: Export test set
-- COPY (
--   SELECT * FROM prop_grades
--   WHERE result IN ('hit', 'miss') AND game_date > 'YYYY-MM-DD'
-- ) TO '/tmp/test_set.csv' WITH CSV HEADER;


-- ─── T3: OVER-BIAS CALIBRATION ──────────────────────────────────────────────
-- For each stat type, compute actual over hit rate in the last 60 days.
-- If over_hit_rate <= 0.55, the over-bias penalty is destroying edge.

SELECT
  stat_type,
  direction,
  COUNT(*) AS total,
  COUNT(*) FILTER (WHERE result = 'hit') AS hits,
  ROUND(COUNT(*) FILTER (WHERE result = 'hit')::numeric / NULLIF(COUNT(*), 0), 4) AS hit_rate
FROM prop_grades
WHERE result IN ('hit', 'miss')
  AND game_date >= (CURRENT_DATE - INTERVAL '60 days')::text
GROUP BY stat_type, direction
ORDER BY stat_type, direction;


-- ─── T4: CONSENSUS BUCKET ANALYSIS ──────────────────────────────────────────
-- Bucket graded props by consensus count (from confidence_reason).
-- The consensus count is embedded in the reason string as "consensus:N".
-- If the 0-1 bucket still hits >50%, the -10 penalty is too harsh.

-- Note: confidence_reason is a string like "lineVal=0.62 matchup=0.48 hr20=0.71 ..."
-- We need to extract factor values and count how many are >= 0.55.
-- This is better done in Python. Here's the raw data export:

SELECT
  confidence_score,
  confidence_label,
  confidence_reason,
  result,
  stat_type,
  direction
FROM prop_grades pg
JOIN prop_history ph ON pg.game_date = ph.game_date
  AND pg.player_name = ph.player_name
  AND pg.stat_type = ph.stat_type
  AND pg.direction = ph.direction
WHERE pg.result IN ('hit', 'miss')
  AND pg.game_date >= (CURRENT_DATE - INTERVAL '90 days')::text
ORDER BY pg.game_date;


-- ─── T5: STAR BONUS EFFECTIVENESS ───────────────────────────────────────────
-- Compare hit rate of star-eligible props (36+ avg mins, LOCK, OVER)
-- WITH and WITHOUT the +3 bonus.
-- Star bonus props should have "star_bonus" in their confidence_reason.

SELECT
  CASE
    WHEN confidence_reason LIKE '%star%' THEN 'star_bonus'
    ELSE 'no_star_bonus'
  END AS star_group,
  confidence_label,
  COUNT(*) AS total,
  COUNT(*) FILTER (WHERE result = 'hit') AS hits,
  ROUND(COUNT(*) FILTER (WHERE result = 'hit')::numeric / NULLIF(COUNT(*), 0), 4) AS hit_rate,
  ROUND(AVG(confidence_score), 1) AS avg_score
FROM prop_grades
WHERE result IN ('hit', 'miss')
  AND confidence_label IN ('LOCK', 'PLAY')
  AND direction = 'over'
  AND game_date >= (CURRENT_DATE - INTERVAL '90 days')::text
GROUP BY star_group, confidence_label
ORDER BY star_group, confidence_label;


-- ─── T6: PARLAY CORRELATION ANALYSIS ────────────────────────────────────────
-- For each graded parlay, compute:
--   actual_hit = did all legs hit?
--   expected_probability = product of individual leg hit rates
-- If actual < expected consistently, there's hidden correlation.

-- Step 1: Get parlay legs with their results
SELECT
  cp.id AS parlay_id,
  cp.parlay_type,
  cp.game_date,
  cp.legs,
  cp.combined_confidence,
  cp.result,
  cp.estimated_multiplier
FROM curated_parlays cp
WHERE cp.result IS NOT NULL
  AND cp.superseded = false
  AND cp.game_date >= (CURRENT_DATE - INTERVAL '90 days')::text
ORDER BY cp.game_date DESC;

-- Step 2: Summary by tier
SELECT
  parlay_type,
  COUNT(*) AS total,
  COUNT(*) FILTER (WHERE result = 'hit') AS hits,
  ROUND(COUNT(*) FILTER (WHERE result = 'hit')::numeric / NULLIF(COUNT(*), 0), 4) AS actual_hit_rate,
  ROUND(AVG(combined_confidence), 1) AS avg_combined_confidence,
  ROUND(AVG(estimated_multiplier), 2) AS avg_multiplier
FROM curated_parlays
WHERE result IS NOT NULL
  AND superseded = false
  AND game_date >= (CURRENT_DATE - INTERVAL '90 days')::text
GROUP BY parlay_type
ORDER BY parlay_type;


-- ─── T7: LINE MOVEMENT SIGNAL VALIDATION ────────────────────────────────────
-- Does the lineMovAdj actually predict?
-- Compare hit rates for props where line moved WITH vs AGAINST the pick.

SELECT
  CASE
    WHEN confidence_reason LIKE '%lineMov:+%' THEN 'confirming'
    WHEN confidence_reason LIKE '%lineMov:-%' THEN 'counter'
    ELSE 'no_movement'
  END AS movement_direction,
  COUNT(*) AS total,
  COUNT(*) FILTER (WHERE result = 'hit') AS hits,
  ROUND(COUNT(*) FILTER (WHERE result = 'hit')::numeric / NULLIF(COUNT(*), 0), 4) AS hit_rate
FROM prop_grades
WHERE result IN ('hit', 'miss')
  AND confidence_label IN ('LOCK', 'PLAY')
  AND game_date >= (CURRENT_DATE - INTERVAL '90 days')::text
GROUP BY movement_direction
ORDER BY movement_direction;


-- ─── T8: FRESHNESS STEP FUNCTION ANALYSIS ───────────────────────────────────
-- Plot hit rate by days_since_last_game in 1-day buckets.
-- If smooth, replace the step function with continuous decay.

-- We need game logs to compute days_since_last_game per prop.
-- This join is heavy — run during off-peak hours.

WITH player_gaps AS (
  SELECT
    pg.player_name,
    pg.game_date,
    pg.stat_type,
    pg.direction,
    pg.result,
    pg.confidence_score,
    (pg.game_date::date - MAX(gl.game_date::date)) AS days_since_last_game
  FROM prop_grades pg
  LEFT JOIN player_game_logs gl
    ON pg.player_name = gl.player_name
    AND gl.game_date < pg.game_date
  WHERE pg.result IN ('hit', 'miss')
    AND pg.game_date >= (CURRENT_DATE - INTERVAL '120 days')::text
  GROUP BY pg.player_name, pg.game_date, pg.stat_type, pg.direction, pg.result, pg.confidence_score
)
SELECT
  days_since_last_game,
  COUNT(*) AS total,
  COUNT(*) FILTER (WHERE result = 'hit') AS hits,
  ROUND(COUNT(*) FILTER (WHERE result = 'hit')::numeric / NULLIF(COUNT(*), 0), 4) AS hit_rate,
  ROUND(AVG(confidence_score), 1) AS avg_confidence
FROM player_gaps
WHERE days_since_last_game IS NOT NULL
  AND days_since_last_game BETWEEN 0 AND 30
GROUP BY days_since_last_game
ORDER BY days_since_last_game;
