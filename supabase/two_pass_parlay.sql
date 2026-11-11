-- Two-Pass Parlay System
-- Adds columns to support midday re-evaluation of morning parlays.
--
-- pass = 1 (morning, 5 AM ET) or 2 (midday update, 11 AM ET)
-- replaces_id = points to the Pass 1 parlay this row supersedes
-- change_summary = human-readable explanation shown in the feed banner
-- superseded = true on Pass 1 rows that have been replaced by a Pass 2 update

ALTER TABLE public.curated_parlays
  ADD COLUMN IF NOT EXISTS pass            smallint    DEFAULT 1 CHECK (pass IN (1, 2)),
  ADD COLUMN IF NOT EXISTS replaces_id     uuid        REFERENCES public.curated_parlays(id),
  ADD COLUMN IF NOT EXISTS change_summary  text,
  ADD COLUMN IF NOT EXISTS superseded      boolean     DEFAULT false;

-- Index for fast feed queries (only show non-superseded)
CREATE INDEX IF NOT EXISTS idx_curated_parlays_superseded
  ON public.curated_parlays(game_date, active, superseded);

-- Index for looking up what a Pass 2 row replaced
CREATE INDEX IF NOT EXISTS idx_curated_parlays_replaces
  ON public.curated_parlays(replaces_id) WHERE replaces_id IS NOT NULL;
