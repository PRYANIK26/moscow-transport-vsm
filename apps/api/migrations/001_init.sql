CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY, email text NOT NULL UNIQUE, name text NOT NULL,
  role text NOT NULL CHECK (role IN ('student','author','admin')),
  brigade text NOT NULL, depot text NOT NULL, company text NOT NULL,
  password_hash text NOT NULL, joined_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auth_sessions_user_idx ON auth_sessions(user_id);
CREATE TABLE IF NOT EXISTS login_attempts (
  email text PRIMARY KEY, attempts integer NOT NULL DEFAULT 0, locked_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS module_flags (
  id text PRIMARY KEY, enabled boolean NOT NULL DEFAULT true
);
CREATE TABLE IF NOT EXISTS scenarios (
  id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES users(id), title text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('scenario','mega')),
  draft jsonb NOT NULL, revision integer NOT NULL DEFAULT 1,
  published_version integer, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS scenarios_owner_idx ON scenarios(owner_id);
CREATE TABLE IF NOT EXISTS scenario_versions (
  scenario_id uuid NOT NULL REFERENCES scenarios(id) ON DELETE CASCADE,
  version integer NOT NULL, definition jsonb NOT NULL, published_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(scenario_id,version)
);
CREATE TABLE IF NOT EXISTS game_sessions (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), scenario_id uuid NOT NULL REFERENCES scenarios(id),
  status text NOT NULL CHECK (status IN ('active','completed')), version integer NOT NULL DEFAULT 1,
  state jsonb NOT NULL, deadline_at timestamptz, started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz, result_id uuid
);
CREATE INDEX IF NOT EXISTS game_sessions_user_idx ON game_sessions(user_id,started_at DESC);
CREATE INDEX IF NOT EXISTS game_sessions_deadline_idx ON game_sessions(deadline_at) WHERE status='active';
CREATE TABLE IF NOT EXISTS commands (
  user_id uuid NOT NULL REFERENCES users(id), operation text NOT NULL, request_id uuid NOT NULL,
  payload jsonb NOT NULL, response jsonb NOT NULL, PRIMARY KEY(user_id,operation,request_id)
);
CREATE TABLE IF NOT EXISTS results (
  id uuid PRIMARY KEY, session_id uuid NOT NULL UNIQUE REFERENCES game_sessions(id),
  user_id uuid NOT NULL REFERENCES users(id), detail jsonb NOT NULL,
  completed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS results_user_idx ON results(user_id,completed_at DESC);
CREATE TABLE IF NOT EXISTS outbox (
  id uuid PRIMARY KEY, event_key text NOT NULL UNIQUE, module text NOT NULL,
  kind text NOT NULL, payload jsonb NOT NULL,
  attempts integer NOT NULL DEFAULT 0, next_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz, failed_at timestamptz, last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS outbox_ready_idx ON outbox(module,next_at) WHERE processed_at IS NULL AND failed_at IS NULL;
CREATE TABLE IF NOT EXISTS user_progress (
  user_id uuid PRIMARY KEY REFERENCES users(id), xp integer NOT NULL DEFAULT 0,
  completed_sessions integer NOT NULL DEFAULT 0,
  competencies jsonb NOT NULL DEFAULT '{"communication":0,"service":0,"safety":0,"conflict":0}',
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS progress_applied (
  result_id uuid PRIMARY KEY REFERENCES results(id), user_id uuid NOT NULL REFERENCES users(id),
  xp integer NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS rating_ledger (
  result_id uuid PRIMARY KEY REFERENCES results(id), user_id uuid NOT NULL REFERENCES users(id),
  points integer NOT NULL, expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS rating_ledger_active_idx ON rating_ledger(user_id,expires_at);
CREATE TABLE IF NOT EXISTS achievements (
  user_id uuid NOT NULL REFERENCES users(id), id text NOT NULL, earned_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id,id)
);
CREATE TABLE IF NOT EXISTS challenge_awards (
  user_id uuid NOT NULL REFERENCES users(id), week_start date NOT NULL,
  xp integer NOT NULL, PRIMARY KEY(user_id,week_start)
);
CREATE TABLE IF NOT EXISTS notifications (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), event_key text NOT NULL,
  type text NOT NULL, title text NOT NULL, body text NOT NULL, href text,
  created_at timestamptz NOT NULL DEFAULT now(), read_at timestamptz,
  UNIQUE(user_id,event_key)
);
CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications(user_id,created_at DESC);
