-- Migration: add prop_features table + props.score_factors column
-- prop_features: one row per graded prop with reconstructed factor contributions

CREATE TABLE IF NOT EXISTS public.prop_features (
  prop_grade_id     uuid PRIMARY KEY REFERENCES public.prop_grades(id) ON DELETE CASCADE,
  stat_type         text NOT NULL,
  direction         text NOT NULL,
  line              numeric NOT NULL,
  hit               boolean NOT NULL,
  -- Factor columns (12 reconstructable factors)
  line_value        numeric,
  matchup_edge      numeric,
  last20_hit_rate   numeric,
  trend             numeric,
  season_cushion    numeric,
  pace              numeric,
  rest_days         numeric,
  blowout           numeric,
  home_away         numeric,
  vs_opponent       numeric,
  opponent_leak     numeric,
  player_bias       numeric,
  -- Metadata
  feature_version   text NOT NULL DEFAULT 'v1',
  computed_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_prop_features_stat
  ON public.prop_features (stat_type);

-- score_factors: per-prop factor breakdown written by lib/confidence.ts on every score
ALTER TABLE public.props
  ADD COLUMN IF NOT EXISTS score_factors jsonb;

GRANT ALL ON TABLE public.prop_features TO service_role, authenticated;
