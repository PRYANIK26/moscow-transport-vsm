ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_version text;

CREATE TABLE IF NOT EXISTS user_avatars (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  image bytea NOT NULL,
  etag text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint_hash text PRIMARY KEY,
  endpoint text NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_hash text NOT NULL REFERENCES auth_sessions(token_hash) ON DELETE CASCADE,
  p256dh text NOT NULL,
  auth text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS push_subscriptions_session_idx ON push_subscriptions(session_hash);
CREATE INDEX IF NOT EXISTS push_subscriptions_user_idx ON push_subscriptions(user_id);

CREATE TABLE IF NOT EXISTS push_deliveries (
  id uuid PRIMARY KEY,
  notification_id uuid NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint_hash text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  next_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  delivered_at timestamptz,
  failed_at timestamptz,
  last_error text,
  UNIQUE(notification_id, endpoint_hash)
);
CREATE INDEX IF NOT EXISTS push_deliveries_ready_idx ON push_deliveries(next_at)
  WHERE delivered_at IS NULL AND failed_at IS NULL;

-- The existing results_completed_at_idx and results_user_idx cover the rolling-window read.

CREATE OR REPLACE VIEW active_scenario_metric_bests AS
SELECT r.user_id,s.scenario_id,
  max(CASE WHEN r.detail->>'loyalty' ~ '^[0-9]{1,3}$' THEN (r.detail->>'loyalty')::integer ELSE 0 END)::integer AS service_points,
  max(CASE WHEN r.detail->>'safety' ~ '^[0-9]{1,3}$' THEN (r.detail->>'safety')::integer ELSE 0 END)::integer AS safety_points
FROM results r JOIN game_sessions s ON s.id=r.session_id
WHERE r.completed_at>now()-interval '720 hours' AND r.completed_at<=now()
GROUP BY r.user_id,s.scenario_id;
