-- Add 'value' and 'jackpot' to the curated_parlays parlay_type check constraint
-- Run this in Supabase SQL editor

ALTER TABLE curated_parlays
  DROP CONSTRAINT IF EXISTS curated_parlays_parlay_type_check;

ALTER TABLE curated_parlays
  ADD CONSTRAINT curated_parlays_parlay_type_check
  CHECK (parlay_type IN ('sgp', 'multi', 'premium', 'value', 'jackpot'));
