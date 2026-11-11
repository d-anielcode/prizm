-- Run this in Supabase SQL Editor to create the system_locks table.
-- Used by /api/enrich to prevent concurrent enrichment runs.

CREATE TABLE IF NOT EXISTS system_locks (
  lock_name  TEXT PRIMARY KEY,
  locked_at  TIMESTAMPTZ,
  locked_by  TEXT  -- optional: identifier of the process holding the lock
);

-- Seed the enrichment lock row (unlocked state)
INSERT INTO system_locks (lock_name, locked_at, locked_by)
VALUES ('enrich', NULL, NULL)
ON CONFLICT (lock_name) DO NOTHING;
