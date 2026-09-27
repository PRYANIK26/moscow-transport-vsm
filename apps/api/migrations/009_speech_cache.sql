CREATE TABLE IF NOT EXISTS speech_audio_cache (
  session_id uuid NOT NULL REFERENCES game_sessions(id) ON DELETE CASCADE,
  utterance_key text NOT NULL,
  audio bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(session_id, utterance_key)
);
