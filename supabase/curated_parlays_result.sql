-- Add result tracking columns to curated_parlays
-- result: 'hit' | 'miss' | 'void' | null (null = pending / not yet graded)
-- graded_at: timestamp of last grading run

ALTER TABLE public.curated_parlays
  ADD COLUMN IF NOT EXISTS result    text        CHECK (result IN ('hit', 'miss', 'void')),
  ADD COLUMN IF NOT EXISTS graded_at timestamptz;
