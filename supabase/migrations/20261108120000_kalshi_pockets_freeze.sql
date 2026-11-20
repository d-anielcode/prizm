-- Kalshi study review fixes:
-- * freeze confirmation / forward verdicts (decided once, never re-decided on later looks)
-- * calibration chart plots the mid ((bid+ask)/2) instead of the ask

ALTER TABLE kalshi_pockets
  ADD COLUMN IF NOT EXISTS conf_verdict    text,          -- pass | fail, null while undecided
  ADD COLUMN IF NOT EXISTS conf_decided_at timestamptz,
  ADD COLUMN IF NOT EXISTS fwd_verdict     text,          -- pass | fail, null while undecided
  ADD COLUMN IF NOT EXISTS fwd_decided_at  timestamptz;

ALTER TABLE kalshi_calibration ADD COLUMN IF NOT EXISTS mean_mid numeric;
