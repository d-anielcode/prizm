-- Feed announcements: standalone messages displayed in the feed
-- Types: light_slate, partial_slate, pass2_update
CREATE TABLE IF NOT EXISTS feed_announcements (
  id         uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  game_date  date NOT NULL,
  message    text NOT NULL,
  type       text NOT NULL DEFAULT 'info',
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_feed_announcements_date ON feed_announcements (game_date DESC);
