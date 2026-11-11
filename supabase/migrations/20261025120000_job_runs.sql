-- Pipeline step log (spec 2026-10-25-ordered-daily-pipeline-design). Additive.
-- Apply in the Supabase SQL editor.
CREATE TABLE IF NOT EXISTS job_runs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id      uuid        NOT NULL,           -- one pipeline invocation
  phase       text        NOT NULL,           -- overnight|midday|pretip|weekly|pc
  step        text        NOT NULL,
  game_date   date,
  source      text        NOT NULL DEFAULT 'github',  -- github|pc|manual
  status      text        NOT NULL CHECK (status IN ('running','ok','failed','skipped')),
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  duration_ms integer,
  http_status integer,
  summary     jsonb,
  error       text
);
CREATE INDEX IF NOT EXISTS job_runs_started_idx ON job_runs (started_at DESC);
CREATE INDEX IF NOT EXISTS job_runs_phase_date_idx ON job_runs (phase, game_date);
GRANT SELECT, INSERT, UPDATE ON public.job_runs TO service_role;
GRANT SELECT ON public.job_runs TO anon, authenticated;
