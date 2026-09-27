ALTER TABLE users ADD COLUMN IF NOT EXISTS first_name text NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_name text NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_demo boolean NOT NULL DEFAULT false;
UPDATE users SET first_name=split_part(name,' ',1),
  last_name=trim(substr(name,length(split_part(name,' ',1))+1))
WHERE first_name='';
UPDATE users SET is_demo=true WHERE id IN (
 '33333333-3333-4333-8333-333333333301','33333333-3333-4333-8333-333333333302',
 '33333333-3333-4333-8333-333333333303','33333333-3333-4333-8333-333333333304',
 '33333333-3333-4333-8333-333333333305');
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_idx ON users(lower(email));
CREATE TABLE IF NOT EXISTS registration_attempts (
  key text PRIMARY KEY, attempts integer NOT NULL, window_start timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS registration_attempts_window_idx ON registration_attempts(window_start);
INSERT INTO module_flags(id,enabled) VALUES('leaderboard',true) ON CONFLICT(id) DO NOTHING;

-- Core read model: it depends on saved results, never on optional projections.
CREATE OR REPLACE VIEW active_scenario_bests AS
SELECT DISTINCT ON (r.user_id,s.scenario_id)
  r.id AS result_id,r.user_id,s.scenario_id,
  (r.detail->>'ratingPoints')::integer AS points,
  r.completed_at,r.completed_at+interval '720 hours' AS expires_at
FROM results r JOIN game_sessions s ON s.id=r.session_id
WHERE r.completed_at>now()-interval '720 hours' AND r.completed_at<=now()
ORDER BY r.user_id,s.scenario_id,(r.detail->>'ratingPoints')::integer DESC,
  r.completed_at DESC,r.id DESC;
