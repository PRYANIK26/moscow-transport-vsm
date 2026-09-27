INSERT INTO module_flags(id,enabled) VALUES('voice',true) ON CONFLICT(id) DO NOTHING;
CREATE TABLE IF NOT EXISTS dialogue_jobs (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES game_sessions(id),
  request_id uuid NOT NULL,
  request_text text NOT NULL,
  expected_version integer NOT NULL,
  waiting_version integer NOT NULL,
  phase_key text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending','done','failed')),
  mode text NOT NULL CHECK (mode IN ('local','yandex')),
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  lease_token uuid,
  lease_until timestamptz,
  warning text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(session_id,request_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS dialogue_jobs_active_idx ON dialogue_jobs(session_id) WHERE status='pending';
CREATE INDEX IF NOT EXISTS dialogue_jobs_ready_idx ON dialogue_jobs(available_at) WHERE status='pending';
CREATE TABLE IF NOT EXISTS dialogue_messages (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES game_sessions(id),
  job_id uuid REFERENCES dialogue_jobs(id),
  role text NOT NULL CHECK (role IN ('conductor','passenger')),
  text text NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(job_id,role)
);
CREATE INDEX IF NOT EXISTS dialogue_messages_session_idx ON dialogue_messages(session_id,at,id);
CREATE TABLE IF NOT EXISTS voice_requests (
  session_id uuid NOT NULL REFERENCES game_sessions(id),
  request_id uuid NOT NULL,
  audio_hash text NOT NULL,
  response_text text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(session_id,request_id)
);
CREATE TABLE IF NOT EXISTS speech_requests (
  session_id uuid NOT NULL REFERENCES game_sessions(id),
  message_id uuid NOT NULL REFERENCES dialogue_messages(id),
  requested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(session_id,message_id)
);
CREATE OR REPLACE VIEW active_scenario_bests AS
SELECT DISTINCT ON (r.user_id,s.scenario_id)
  r.id AS result_id,r.user_id,s.scenario_id,
  (r.detail->>'ratingPoints')::integer AS points,
  r.completed_at,r.completed_at+interval '720 hours' AS expires_at
FROM results r JOIN game_sessions s ON s.id=r.session_id
WHERE r.completed_at>now()-interval '720 hours' AND r.completed_at<=now()
  AND r.detail->>'ratingEligible' IS DISTINCT FROM 'false'
ORDER BY r.user_id,s.scenario_id,(r.detail->>'ratingPoints')::integer DESC,r.completed_at DESC,r.id DESC;
CREATE OR REPLACE VIEW active_scenario_metric_bests AS
SELECT r.user_id,s.scenario_id,
  max(CASE WHEN r.detail->>'loyalty' ~ '^[0-9]{1,3}$' THEN (r.detail->>'loyalty')::integer ELSE 0 END)::integer AS service_points,
  max(CASE WHEN r.detail->>'safety' ~ '^[0-9]{1,3}$' THEN (r.detail->>'safety')::integer ELSE 0 END)::integer AS safety_points
FROM results r JOIN game_sessions s ON s.id=r.session_id
WHERE r.completed_at>now()-interval '720 hours' AND r.completed_at<=now()
  AND r.detail->>'ratingEligible' IS DISTINCT FROM 'false'
GROUP BY r.user_id,s.scenario_id;
